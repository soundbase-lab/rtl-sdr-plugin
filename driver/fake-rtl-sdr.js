#!/usr/bin/env node
// A fake dongle, standing in for librtlsdr's command-line tools so the whole
// stack — shell, adapter, driver, child process, socket — runs with nothing
// plugged in. The driver spawns this instead of the real tools when
// SB_RTLSDR_MOCK=1:
//
//   node fake-rtl-sdr.js rtl_test -d <anything>     lists one dongle and exits
//   node fake-rtl-sdr.js rtl_tcp -a <host> -p <port> -d 0 -s <rate>
//
// It imitates an R820T dongle looking at a quiet band with a few carriers in
// it, at the real sample rate and in real USB-transfer-sized pieces, because
// the driver's retune timing depends on both.
//
//   SB_RTLSDR_MOCK_DONGLES   how many dongles rtl_test lists (default 1)
//   SB_RTLSDR_MOCK_CARRIERS  "hz:dBm,hz:dBm" replacing the default carriers

import net from 'node:net';
import {
  FULL_SCALE_DBM_AT_0DB_GAIN,
  SAMPLE_RATE_HZ,
  TRANSFER_BYTES,
  levelGainDb,
  nearest,
  tunerInfo,
} from './tuners.js';

const [toolName, ...args] = process.argv.slice(2);
const option = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
};

const DONGLES = Number(process.env.SB_RTLSDR_MOCK_DONGLES ?? 1);
const serialOf = (index) => `MOCK${String(index + 1).padStart(4, '0')}`;

const DEFAULT_CARRIERS = [
  { hz: 100_000_000, dbm: -75 },
  { hz: 518_100_000, dbm: -70 },
  { hz: 542_350_000, dbm: -85 },
];
const CARRIERS = process.env.SB_RTLSDR_MOCK_CARRIERS
  ? process.env.SB_RTLSDR_MOCK_CARRIERS.split(',').map((entry) => {
      const [hz, dbm] = entry.split(':').map(Number);
      return { hz, dbm };
    })
  : DEFAULT_CARRIERS;

// thermal noise at the antenna across the sampled bandwidth, with a 6 dB
// noise figure, and the converter's own noise in LSB
const THERMAL_DBM = -174 + 6 + 10 * Math.log10(SAMPLE_RATE_HZ);
const ADC_NOISE_LSB = 0.5;
// a real dongle's converter sits slightly off centre, which shows as a spike
// at the middle of every hop unless the driver removes it
const DC_OFFSET_LSB = 1.5;

if (toolName === 'rtl_test') {
  if (DONGLES < 1) {
    process.stderr.write('No supported devices found.\n');
  } else {
    process.stderr.write(`Found ${DONGLES} device(s):\n`);
    for (let i = 0; i < DONGLES; i += 1) {
      process.stderr.write(`  ${i}:  Realtek, RTL2838UHIDIR, SN: ${serialOf(i)}\n`);
    }
    process.stderr.write('\nNo matching devices found.\n');
  }
  process.exit(1);
} else if (toolName === 'rtl_tcp') {
  serve();
} else {
  process.stderr.write(`fake-rtl-sdr: unknown tool ${toolName}\n`);
  process.exit(2);
}

function serve() {
  const index = Number(option('-d', 0));
  if (!(index >= 0 && index < DONGLES)) {
    process.stderr.write('No supported devices found.\n');
    process.exit(1);
  }

  const tuner = tunerInfo(5); // R820T
  const state = { centerHz: 100_000_000, gainDb: 0 };
  const phases = CARRIERS.map(() => 0);

  // unit-variance gaussian noise, drawn once and indexed at random: generating
  // it per sample would cost more than the real-time budget allows
  const noise = new Float32Array(65_536);
  for (let i = 0; i < noise.length; i += 2) {
    const r = Math.sqrt(-2 * Math.log(1 - Math.random()));
    const a = 2 * Math.PI * Math.random();
    noise[i] = r * Math.cos(a);
    noise[i + 1] = r * Math.sin(a);
  }

  function transfer() {
    const out = Buffer.allocUnsafe(TRANSFER_BYTES);
    const samples = TRANSFER_BYTES / 2;
    // input power that reads 0 dBFS at this gain; amplitudes below are in LSB
    const fullScaleDbm =
      FULL_SCALE_DBM_AT_0DB_GAIN - levelGainDb(tuner, state.gainDb);
    const lsb = (dbm) => 127.5 * 10 ** ((dbm - fullScaleDbm) / 20);
    // per-component standard deviation: half the noise power in each of I and Q
    const sigma = Math.hypot(lsb(THERMAL_DBM) / Math.SQRT2, ADC_NOISE_LSB);
    const tones = [];
    CARRIERS.forEach((carrier, c) => {
      const offset = carrier.hz - state.centerHz;
      if (Math.abs(offset) >= SAMPLE_RATE_HZ / 2) return;
      tones.push({
        c,
        amplitude: lsb(carrier.dbm),
        step: (2 * Math.PI * offset) / SAMPLE_RATE_HZ,
      });
    });
    let seed = (Math.random() * 65_536) | 0;
    for (let n = 0; n < samples; n += 1) {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      let i = 127.5 + DC_OFFSET_LSB + sigma * noise[(seed >> 8) & 0xffff];
      let q = 127.5 + sigma * noise[(seed >> 12) & 0xffff];
      for (const tone of tones) {
        const phase = phases[tone.c] + tone.step * n;
        i += tone.amplitude * Math.cos(phase);
        q += tone.amplitude * Math.sin(phase);
      }
      out[2 * n] = i < 0 ? 0 : i > 255 ? 255 : Math.round(i);
      out[2 * n + 1] = q < 0 ? 0 : q > 255 ? 255 : Math.round(q);
    }
    for (const tone of tones) {
      phases[tone.c] = (phases[tone.c] + tone.step * samples) % (2 * Math.PI);
    }
    return out;
  }

  function command(code, value) {
    if (code === 0x01) state.centerHz = value;
    // as librtlsdr does: the nearest step the tuner has
    if (code === 0x04) state.gainDb = nearest(value / 10, tuner.gainsDb);
  }

  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    const greeting = Buffer.alloc(12);
    greeting.write('RTL0', 'latin1');
    greeting.writeUInt32BE(5, 4); // R820T
    greeting.writeUInt32BE(29, 8);
    socket.write(greeting);

    let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 5) {
        command(pending.readUInt8(0), pending.readUInt32BE(1));
        pending = pending.subarray(5);
      }
    });

    // one transfer per transfer period, on a clock rather than an interval so
    // a late tick does not slow the stream down
    const periodMs = (TRANSFER_BYTES / 2 / SAMPLE_RATE_HZ) * 1000;
    let due = Date.now() + periodMs;
    let timer = null;
    const tick = () => {
      socket.write(transfer());
      due += periodMs;
      timer = setTimeout(tick, Math.max(0, due - Date.now()));
    };
    timer = setTimeout(tick, periodMs);
    socket.on('close', () => clearTimeout(timer));
  });

  server.listen(Number(option('-p', 1234)), option('-a', '127.0.0.1'), () => {
    process.stderr.write('listening...\n');
  });
  process.on('SIGTERM', () => process.exit(0));
}
