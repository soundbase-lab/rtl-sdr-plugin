// An RTL-SDR dongle (RTL2832U) as a SoundBase spectrum analyzer.
//
// The dongle is a receiver, not an analyzer: it sees about 2 MHz at a time.
// A sweep is therefore a walk — tune, capture, FFT, move on — stitched into
// one trace. driver/rtl-tcp.js owns the dongle (through an rtl_tcp child
// process) and driver/spectrum.js does the FFT; this file plans the walk and
// speaks the adapter contract.

import { RtlTcp, listDongles } from './driver/rtl-tcp.js';
import {
  WINDOW_ENBW_BINS,
  blockStats,
  powerSpectrum,
} from './driver/spectrum.js';
import {
  FULL_SCALE_DBM_AT_0DB_GAIN,
  SAMPLE_RATE_HZ,
  TRANSFER_BYTES,
  levelGainDb,
  nearest,
  tunerInfo,
} from './driver/tuners.js';

// The product this adapter announces its devices as. It MUST be a
// `deviceTypeId` declared in soundbase-plugin.json — the shell warns and the
// host ignores a device naming a product the manifest never declared.
// `npm run rename` keeps them in step; a test asserts they agree.
export const PRODUCT = 'plugin:rtl-sdr/rtl2832u';

// The part of each capture that is kept. The edges of the sampled bandwidth
// roll off and alias, so hops overlap and only the middle of each is used.
const HOP_WIDTH_HZ = 2_000_000;
// a hop costs the transfer the retune lands in plus the one that is kept
const HOP_MS = 2 * (TRANSFER_BYTES / 2 / SAMPLE_RATE_HZ) * 1000;

// Every sweep moves all its hop centres by the next of these. The converter's
// resting value shows up as a false carrier at the exact centre of a capture;
// moving the centre is what tells that apart from a real carrier there, and
// keeps whatever is left of it from sitting on one trace point for ever. The
// shifts fit inside the margin between a hop's width and the sampled bandwidth.
const CENTER_SHIFTS_HZ = [0, 60_000, -60_000, 30_000, -30_000];
// how many recent captures the resting value is estimated from
const ZERO_HISTORY = 15;

const FFT_SIZES = [4096, 2048, 1024, 512, 256, 128, 64];
const AUTO_MIN_FFT_SIZE = 256;
const rbwOf = (fftSize) =>
  Math.round((WINDOW_ENBW_BINS * SAMPLE_RATE_HZ) / fftSize);
const RBW_HZ = FFT_SIZES.map(rbwOf);

const DEFAULT_START_HZ = 470_000_000;
const DEFAULT_STOP_HZ = 616_000_000;
const DEFAULT_POINT_COUNT = 451;
const MAX_POINTS = 4001;
const MIN_SPAN_HZ = 1_000;

const DEFAULT_GAIN_DB = 30;
const MAX_LEVEL_OFFSET_DB = 60;
const MAX_PPM = 200;
// fraction of samples pinned at a rail before a sweep is called overloaded
const OVERLOAD_CLIP_FRACTION = 0.002;
const FLOOR_POWER = 1e-14;

const LIST_MAX_AGE_MS = 2_000;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round1 = (v) => Math.round(v * 10) / 10;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

// A dongle's serial is the only thing about it that is the same on every
// machine and after every restart, so it is the device id. Cheap dongles ship
// with identical serials (`00000001`); the second and later of a kind get an
// ordinal, `usb:00000001:2`.
function toDevices(dongles) {
  const seen = new Map();
  return dongles.map((dongle) => {
    const serial = dongle.serial || 'unset';
    const ordinal = (seen.get(serial) ?? 0) + 1;
    seen.set(serial, ordinal);
    return {
      id: ordinal === 1 ? `usb:${serial}` : `usb:${serial}:${ordinal}`,
      name: `RTL-SDR ${serial}${ordinal === 1 ? '' : ` (${ordinal})`}`,
      product: PRODUCT,
      transport: { kind: 'usb', serial },
      // rtl_tcp's index for it: true on this machine, right now, and nowhere
      // else, so it is looked up at open() and never reported
      index: dongle.index,
    };
  });
}

const withoutIndex = ({ index, ...device }) => device;

/** devices this plugin holds open right now, by id */
const held = new Map();
let listing = { at: 0, devices: [], pending: null };

/**
 * Dongles attached right now.
 *
 * Called once a second while SoundBase is enumerating — which includes the
 * whole time a dongle is sweeping. Asking libusb about a dongle that is
 * streaming risks disturbing the stream, so while this plugin holds one the
 * last listing is reused, and the held dongles are always reported.
 */
export async function discoverDevices(pluginConfig = {}) {
  if (held.size === 0 && Date.now() - listing.at > LIST_MAX_AGE_MS) {
    listing.pending ??= listDongles({ binDir: pluginConfig.rtlSdrBinDir })
      .then((dongles) => {
        // no tools installed is, like no dongle, an empty result
        listing = { at: Date.now(), devices: toDevices(dongles ?? []) };
      })
      .catch(() => {
        listing = { at: Date.now(), devices: [] };
      });
    await listing.pending;
  }
  const devices = new Map(listing.devices.map((d) => [d.id, d]));
  for (const [id, device] of held) devices.set(id, device);
  return [...devices.values()].map(withoutIndex);
}

/**
 * Which dongle a device means. `device.config.serial` is the manifest's
 * `deviceConfigFields`, filled in from the SoundBase project; the id fallback
 * covers a device this plugin discovered, whose id already carries the serial.
 */
function targetOf(device) {
  const serial = String(device.config?.serial ?? '').trim();
  if (serial) return { serial, ordinal: 1 };
  const match = /^usb:(.+?)(?::(\d+))?$/.exec(device.id ?? '');
  if (match) return { serial: match[1], ordinal: Number(match[2] ?? 1) };
  return { serial: null, ordinal: 1 };
}

// ---------------------------------------------------------------------------
// the adapter
// ---------------------------------------------------------------------------

export function createSpectrumAnalyzerAdapter(device, pluginConfig) {
  return new RtlSdrAdapter(device, pluginConfig);
}

class RtlSdrAdapter {
  constructor(device, pluginConfig = {}) {
    this.device = device;
    this.binDir = pluginConfig.rtlSdrBinDir;
    this.worker = null;
    this.tuner = tunerInfo(0);
    this.config = {
      startHz: DEFAULT_START_HZ,
      stopHz: DEFAULT_STOP_HZ,
      pointCount: DEFAULT_POINT_COUNT,
    };
    this.controls = null;
    this.plan = null;
    this.sweeping = false;
    this.loop = null;
    this.sweepCount = 0;
    this.zeros = [];
    // assigned by the shell
    this.onFatal = null;
    this.onWarnings = null;
  }

  async open() {
    const { serial, ordinal } = targetOf(this.device);
    const dongles = await listDongles({ binDir: this.binDir });
    if (dongles === null) {
      throw new Error(
        'The RTL-SDR tools were not found. Install them with ' +
          '`brew install librtlsdr`, or set "RTL-SDR tools folder" in the ' +
          'plugin settings.'
      );
    }
    const found = toDevices(dongles).filter(
      (d) => serial === null || d.transport.serial === serial
    )[ordinal - 1];
    if (!found) {
      throw new Error(
        serial === null
          ? 'No RTL-SDR dongle is attached.'
          : `No RTL-SDR dongle with serial ${serial} is attached.`
      );
    }

    const worker = new RtlTcp({ index: found.index, binDir: this.binDir });
    const { tunerType } = await worker.open();
    worker.onFatal = (err) => {
      held.delete(this.device.id);
      this.worker = null;
      this.sweeping = false;
      this.onFatal?.(err);
    };
    this.worker = worker;
    held.set(this.device.id, { ...found, id: this.device.id });

    // Report what this dongle's tuner can do, not what dongles in general can.
    this.tuner = tunerInfo(tunerType);
    const gains = this.tuner.gainsDb;
    this.controls = {
      gainDb: nearest(this.controls?.gainDb ?? DEFAULT_GAIN_DB, gains),
      detector: this.controls?.detector ?? 'peak',
      levelOffsetDb: this.controls?.levelOffsetDb ?? 0,
      ppm: this.controls?.ppm ?? 0,
    };
    worker.setGain(this.controls.gainDb);
    worker.setPpm(this.controls.ppm);
    this.#reportWarnings(false);

    return {
      capabilities: {
        minFrequencyHz: this.tuner.minHz,
        maxFrequencyHz: this.tuner.maxHz,
        rbwHz: [...RBW_HZ],
        controls: [
          {
            id: 'gainDb',
            type: 'number',
            label: 'Tuner gain',
            unit: 'dB',
            default: nearest(DEFAULT_GAIN_DB, gains),
            min: gains[0],
            max: gains[gains.length - 1],
            step: 0.1,
            help: 'Snaps to the nearest step the tuner has. Lower it if the overload warning appears.',
          },
          {
            id: 'detector',
            type: 'dropdown',
            label: 'Detector',
            default: 'peak',
            choices: [
              { id: 'peak', label: 'Peak' },
              { id: 'average', label: 'Average' },
            ],
            help: 'How the FFT bins that fall on one trace point are combined.',
          },
          {
            id: 'levelOffsetDb',
            type: 'number',
            label: 'Level offset',
            unit: 'dB',
            default: 0,
            min: -MAX_LEVEL_OFFSET_DB,
            max: MAX_LEVEL_OFFSET_DB,
            step: 0.1,
            help: 'Added to every reading. Trim it against a known source: the dongle is not calibrated.',
          },
          {
            id: 'ppm',
            type: 'number',
            label: 'Frequency correction',
            unit: 'ppm',
            default: 0,
            min: -MAX_PPM,
            max: MAX_PPM,
            step: 1,
          },
        ],
      },
      identity: {
        model: `RTL2832U / ${this.tuner.name}`,
        serialNumber: found.transport.serial,
      },
    };
  }

  /**
   * Apply what was asked for and return what is actually in force. Everything
   * is clamped or snapped, never rejected, and the echo is what the next
   * sweep will use.
   */
  async applyConfig(cfg = {}) {
    const { minHz, maxHz } = this.tuner;
    const startHz = clamp(
      isNum(cfg.startHz) ? cfg.startHz : this.config.startHz,
      minHz,
      maxHz - MIN_SPAN_HZ
    );
    const stopHz = clamp(
      isNum(cfg.stopHz) ? cfg.stopHz : this.config.stopHz,
      startHz + MIN_SPAN_HZ,
      maxHz
    );
    const span = stopHz - startHz;
    let pointCount = this.config.pointCount;
    if (isNum(cfg.pointCount)) pointCount = Math.round(cfg.pointCount);
    else if (isNum(cfg.stepHz) && cfg.stepHz > 0)
      pointCount = Math.round(span / cfg.stepHz) + 1;
    pointCount = clamp(pointCount, 2, MAX_POINTS);

    // The shell hands over the whole desired configuration each time, so an
    // absent rbwHz is a request for auto rather than "unchanged".
    const rbwHz = isNum(cfg.rbwHz) ? nearest(cfg.rbwHz, RBW_HZ) : undefined;
    const fftSize =
      rbwHz === undefined
        ? autoFftSize(span / (pointCount - 1))
        : FFT_SIZES[RBW_HZ.indexOf(rbwHz)];

    const controls = { ...this.controls };
    const asked = cfg.controls ?? {};
    if (isNum(asked.gainDb))
      controls.gainDb = nearest(asked.gainDb, this.tuner.gainsDb);
    if (asked.detector === 'peak' || asked.detector === 'average')
      controls.detector = asked.detector;
    if (isNum(asked.levelOffsetDb))
      controls.levelOffsetDb = round1(
        clamp(asked.levelOffsetDb, -MAX_LEVEL_OFFSET_DB, MAX_LEVEL_OFFSET_DB)
      );
    if (isNum(asked.ppm))
      controls.ppm = Math.round(clamp(asked.ppm, -MAX_PPM, MAX_PPM));

    if (controls.gainDb !== this.controls.gainDb)
      this.worker.setGain(controls.gainDb);
    if (controls.ppm !== this.controls.ppm) this.worker.setPpm(controls.ppm);

    this.controls = controls;
    this.config = { startHz, stopHz, pointCount };
    // a new plan object is what tells a sweep in progress to start over
    this.plan = buildPlan({ startHz, stopHz, pointCount, fftSize });
    this.worker.abortCapture();

    const resolved = {
      sweepTimeMs: Math.round(this.plan.centers.length * HOP_MS),
    };
    if (rbwHz === undefined) resolved.rbwHz = rbwOf(fftSize);
    const effective = {
      startHz,
      stopHz,
      pointCount,
      controls: { ...controls },
      resolved,
    };
    if (rbwHz !== undefined) effective.rbwHz = rbwHz;
    return effective;
  }

  async startSweep(onTrace) {
    if (this.sweeping) return;
    this.sweeping = true;
    this.loop = this.#sweepLoop(this.worker, onTrace);
  }

  async #sweepLoop(worker, onTrace) {
    try {
      while (this.sweeping) {
        const plan = this.plan;
        const controls = this.controls;
        const trace = newAccumulator(plan);
        const shiftHz =
          CENTER_SHIFTS_HZ[this.sweepCount % CENTER_SHIFTS_HZ.length];
        let clipped = 0;
        let complete = true;
        for (let hop = 0; hop < plan.centers.length; hop += 1) {
          const centerHz = clamp(
            plan.centers[hop] + shiftHz,
            this.tuner.minHz,
            this.tuner.maxHz
          );
          const iq = await worker.capture(centerHz);
          if (!this.sweeping) return;
          // reconfigured mid-sweep: what was gathered belongs to no
          // configuration, so drop it and start again
          if (!iq || this.plan !== plan) {
            complete = false;
            break;
          }
          const stats = blockStats(iq);
          clipped = Math.max(clipped, stats.clipped);
          const zero = this.#restingValue(stats);
          const power = powerSpectrum(iq, plan.fftSize, zero.i, zero.q);
          accumulate(trace, plan, hop, centerHz, power);
        }
        if (!complete) continue;
        this.sweepCount += 1;
        onTrace(toDbm(trace, controls, this.tuner));
        this.#reportWarnings(clipped > OVERLOAD_CLIP_FRACTION);
      }
    } catch {
      // the transport died; the driver has already called onFatal
    }
  }

  /**
   * The converter's resting value, to take out of a capture before its FFT.
   *
   * One capture's mean cannot be used for this: an unmodulated carrier exactly
   * at the capture's centre is a constant too, and would be removed with it.
   * The resting value belongs to the hardware and the carrier to one
   * frequency, so the median over recent captures — taken at different
   * centres — keeps the first and ignores the second.
   */
  #restingValue({ meanI, meanQ }) {
    this.zeros.push({ i: meanI, q: meanQ });
    if (this.zeros.length > ZERO_HISTORY) this.zeros.shift();
    const middle = (values) =>
      values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
    return {
      i: middle(this.zeros.map((z) => z.i)),
      q: middle(this.zeros.map((z) => z.q)),
    };
  }

  async stopSweep() {
    this.sweeping = false;
    this.worker?.abortCapture();
    await this.loop;
    this.loop = null;
  }

  /** Release the dongle. Called on removal, teardown, and after a fatal. */
  async close() {
    this.sweeping = false;
    held.delete(this.device.id);
    this.worker?.close();
    this.worker = null;
  }

  /** The complete current set, every time: a cleared overload simply stops being listed. */
  #reportWarnings(overloaded) {
    const warnings = [
      {
        id: 'uncalibrated',
        severity: 'info',
        message:
          'Levels are estimated, not calibrated: an RTL-SDR has no absolute ' +
          'reference. Relative readings are fine; trim "Level offset" against ' +
          'a known source for absolute ones.',
      },
    ];
    if (overloaded) {
      warnings.push({
        id: 'overload',
        severity: 'warning',
        message:
          'Input overload: the RTL-SDR is clipping, which draws signals on ' +
          'the trace that are not there. Lower "Tuner gain".',
      });
    }
    this.onWarnings?.(warnings);
  }
}

// ---------------------------------------------------------------------------
// planning a sweep and assembling its trace
// ---------------------------------------------------------------------------

// Auto RBW: bins at least twice as fine as the point spacing, so the detector
// has something to choose between, and never coarser than a wireless
// microphone channel needs. The capture is the same length whatever the FFT
// size, so a finer RBW costs processor time but not sweep time.
function autoFftSize(stepHz) {
  const wanted = (2 * SAMPLE_RATE_HZ) / stepHz;
  const fftSize = 2 ** Math.ceil(Math.log2(wanted));
  return clamp(fftSize, AUTO_MIN_FFT_SIZE, FFT_SIZES[0]);
}

/**
 * The hops that cover a sweep. Each trace point owns the frequencies within
 * half a step of it, so the walk covers half a step beyond each end — capped
 * at half a hop, for a sweep whose points are further apart than a hop is
 * wide.
 */
function buildPlan({ startHz, stopHz, pointCount, fftSize }) {
  const stepHz = (stopHz - startHz) / (pointCount - 1);
  const edge = Math.min(stepHz, HOP_WIDTH_HZ) / 2;
  const lowHz = startHz - edge;
  const highHz = stopHz + edge;
  const hopCount = Math.max(1, Math.ceil((highHz - lowHz) / HOP_WIDTH_HZ));
  const hopHz = (highHz - lowHz) / hopCount;
  const centers = [];
  for (let hop = 0; hop < hopCount; hop += 1) {
    centers.push(Math.round(lowHz + (hop + 0.5) * hopHz));
  }
  return { startHz, stepHz, pointCount, fftSize, lowHz, hopHz, centers };
}

const newAccumulator = (plan) => ({
  peak: new Float64Array(plan.pointCount),
  sum: new Float64Array(plan.pointCount),
  count: new Uint32Array(plan.pointCount),
});

/** Fold one hop's FFT bins into the trace points they fall on. */
function accumulate(trace, plan, hop, centerHz, power) {
  const { startHz, stepHz, pointCount, fftSize, lowHz, hopHz } = plan;
  const binHz = SAMPLE_RATE_HZ / fftSize;
  // the slice of the sweep this hop is responsible for; neighbours overlap it
  // but each frequency is taken from exactly one hop
  const fromHz = lowHz + hop * hopHz;
  const toHz = fromHz + hopHz;
  for (let bin = 0; bin < fftSize; bin += 1) {
    const hz = centerHz + (bin - fftSize / 2) * binHz;
    if (hz < fromHz || hz >= toHz) continue;
    const point = clamp(Math.round((hz - startHz) / stepHz), 0, pointCount - 1);
    if (power[bin] > trace.peak[point]) trace.peak[point] = power[bin];
    trace.sum[point] += power[bin];
    trace.count[point] += 1;
  }
}

/** The finished trace: `pointCount` amplitudes in dBm, startHz first. */
function toDbm(trace, controls, tuner) {
  const { peak, sum, count } = trace;
  const offsetDb =
    FULL_SCALE_DBM_AT_0DB_GAIN -
    levelGainDb(tuner, controls.gainDb) +
    controls.levelOffsetDb;
  const amps = new Array(peak.length).fill(null);
  for (let i = 0; i < peak.length; i += 1) {
    if (count[i] === 0) continue;
    const power = controls.detector === 'average' ? sum[i] / count[i] : peak[i];
    amps[i] = 10 * Math.log10(Math.max(power, FLOOR_POWER)) + offsetDb;
  }
  // Points closer together than the FFT bins are get no bin of their own;
  // they take a straight line between the neighbours that did.
  let last = -1;
  for (let i = 0; i < amps.length; i += 1) {
    if (amps[i] === null) continue;
    for (let gap = last + 1; gap < i; gap += 1) {
      amps[gap] =
        last < 0
          ? amps[i]
          : amps[last] + ((amps[i] - amps[last]) * (gap - last)) / (i - last);
    }
    last = i;
  }
  for (let gap = last + 1; gap < amps.length; gap += 1) amps[gap] = amps[last];
  return amps.map(round1);
}
