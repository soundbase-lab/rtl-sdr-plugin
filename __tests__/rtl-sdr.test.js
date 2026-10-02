// Contract tests for the adapter, driven through the real shell over real HTTP
// against a fake dongle (driver/fake-rtl-sdr.js). The whole stack is under
// test — shell, adapter, driver, the rtl_tcp child process, its socket — with
// nothing plugged in.
//
// Nothing here hardcodes the plugin's id: everything that could change when you
// run `npm run rename` is read from soundbase-plugin.json.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HANDSHAKE_PREFIX } from '@soundbase/plugin-contract';

// The fake dongle's band: two carriers the default gain reads comfortably, and
// one strong enough to clip the converter once the gain is turned up.
const CARRIER_A = { hz: 518_100_000, dbm: -70 };
const CARRIER_B = { hz: 542_350_000, dbm: -85 };
const STRONG = { hz: 530_000_000, dbm: -45 };
process.env.SB_RTLSDR_MOCK = '1';
process.env.SB_RTLSDR_MOCK_CARRIERS = [CARRIER_A, CARRIER_B, STRONG]
  .map((c) => `${c.hz}:${c.dbm}`)
  .join(',');

const { PRODUCT } = await import('../adapter.js');
const { listDongles, liveWorkers } = await import('../driver/rtl-tcp.js');

const manifest = JSON.parse(
  readFileSync(new URL('../soundbase-plugin.json', import.meta.url), 'utf8')
);

const DEVICE_ID = 'usb:MOCK0001';
const DEVICE_PATH = `/devices/${encodeURIComponent(DEVICE_ID)}`;
// a span narrow enough to sweep in half a second: every hop costs real time,
// because the fake streams at the dongle's real sample rate
const START_HZ = 514_000_000;
const STOP_HZ = 522_000_000;
const POINT_COUNT = 401;
// leaves the strong carrier below full scale
const GAIN_DB = 20.7;

// boots under the real shell, exactly as the host spawns it
const handle = await (await import('../main.js')).default;

const request = async (method, path, body) => {
  const res = await fetch(`${handle.url}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const configure = (body) =>
  request('POST', `${DEVICE_PATH}/configuration`, body);
const device = async () => {
  const { body } = await request('GET', '/devices');
  return body.devices.find((d) => d.id === DEVICE_ID);
};
/** The first trace of a sweep started now — never one left from an earlier test. */
const sweepOnce = async (t) => {
  const before = (await request('POST', `${DEVICE_PATH}/sweep/start`)).body;
  t.after(() => request('POST', `${DEVICE_PATH}/sweep/stop`));
  const trace = await request(
    'GET',
    `${DEVICE_PATH}/trace?sinceSweepId=${before.sweepId ?? 0}`
  );
  assert.equal(trace.status, 200, JSON.stringify(trace.body));
  return trace.body;
};
const hzAt = (trace, i) =>
  trace.startHz + (i * (trace.stopHz - trace.startHz)) / (trace.pointCount - 1);
const peakNear = (trace, hz, withinHz) => {
  let best = { dbm: -Infinity, hz: null };
  trace.amplitudesDbm.forEach((dbm, i) => {
    const at = hzAt(trace, i);
    if (Math.abs(at - hz) <= withinHz && dbm > best.dbm) best = { dbm, hz: at };
  });
  return best;
};
const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

test.after(() => handle.close());

test('the manifest is valid and the handshake reports a real port', () => {
  assert.equal(handle.manifest.id, manifest.id);
  assert.ok(handle.port > 0);
  assert.equal(HANDSHAKE_PREFIX, 'SB_PLUGIN_READY ');
});

// The rename trap: an adapter that announces a product the manifest does not
// declare produces a device the host silently ignores, and the only clue is one
// warning line in the plugin log. Catch it here instead.
test('the product the adapter announces is declared in the manifest', () => {
  const declared = manifest.products.map((p) => p.deviceTypeId);
  assert.ok(
    declared.includes(PRODUCT),
    `adapter.js announces ${PRODUCT}, but soundbase-plugin.json declares only ` +
      `${declared.join(', ')}. Run \`npm run rename <id>\` to change both at once.`
  );
  assert.ok(PRODUCT.startsWith(`plugin:${manifest.id}/`));
});

test('an attached dongle is discovered under an id built from its serial', async () => {
  const found = await device();
  assert.ok(found, 'discovered');
  assert.equal(found.product, PRODUCT);
  assert.equal(found.discovered, true);
  assert.deepEqual(found.transport, { kind: 'usb', serial: 'MOCK0001' });
});

test('no dongle attached is a normal, empty result', async (t) => {
  process.env.SB_RTLSDR_MOCK_DONGLES = '0';
  t.after(() => delete process.env.SB_RTLSDR_MOCK_DONGLES);
  assert.deepEqual(await listDongles(), []);
});

test('several dongles are listed with the index rtl_tcp knows them by', async (t) => {
  process.env.SB_RTLSDR_MOCK_DONGLES = '2';
  t.after(() => delete process.env.SB_RTLSDR_MOCK_DONGLES);
  assert.deepEqual(await listDongles(), [
    { index: 0, vendor: 'Realtek', product: 'RTL2838UHIDIR', serial: 'MOCK0001' },
    { index: 1, vendor: 'Realtek', product: 'RTL2838UHIDIR', serial: 'MOCK0002' },
  ]);
});

// A *discovered* device is not opened until something asks it to do work — an
// idle plugin must not hold the dongle. So `capabilities` appears after the
// first operation on it.
test('open() reports what this tuner can do', async () => {
  await configure({ startHz: START_HZ, stopHz: STOP_HZ });
  const { capabilities: caps, status } = await device();
  assert.ok(caps, 'capabilities appear once the device has been opened');
  assert.equal(caps.minFrequencyHz, 24_000_000);
  assert.equal(caps.maxFrequencyHz, 1_766_000_000);
  assert.ok(caps.rbwHz.length > 0);
  assert.deepEqual(caps.rbwHz, [...caps.rbwHz].sort((a, b) => a - b));
  assert.deepEqual([...caps.traceModes].sort(), [
    'average',
    'clear-write',
    'max-hold',
    'min-hold',
  ]);
  assert.deepEqual(
    caps.controls.map((c) => c.id),
    ['gainDb', 'detector', 'levelOffsetDb', 'ppm']
  );
  const gain = caps.controls[0];
  assert.equal(gain.min, 0);
  assert.equal(gain.max, 49.6);
  // an uncalibrated receiver says so, without claiming to be unhealthy
  assert.equal(status.status, 'ok');
  assert.deepEqual(
    status.warnings.map((w) => [w.id, w.severity]),
    [['uncalibrated', 'info']]
  );
});

test('a sweep puts a carrier at its frequency and its level', async (t) => {
  const applied = await configure({
    startHz: START_HZ,
    stopHz: STOP_HZ,
    pointCount: POINT_COUNT,
    controls: { gainDb: GAIN_DB },
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.startHz, START_HZ);
  assert.equal(applied.body.stopHz, STOP_HZ);
  assert.equal(applied.body.pointCount, POINT_COUNT);

  const trace = await sweepOnce(t);
  assert.equal(trace.pointCount, POINT_COUNT);
  assert.equal(trace.amplitudesDbm.length, POINT_COUNT);
  assert.equal(trace.startHz, START_HZ);
  assert.equal(trace.stopHz, STOP_HZ);
  assert.equal(trace.stepHz, (STOP_HZ - START_HZ) / (POINT_COUNT - 1));
  assert.equal(trace.unit, 'dBm');

  const peak = peakNear(trace, CARRIER_A.hz, 4_000_000);
  assert.ok(
    Math.abs(peak.hz - CARRIER_A.hz) <= trace.stepHz,
    `the carrier at ${CARRIER_A.hz} Hz was drawn at ${peak.hz} Hz`
  );
  assert.ok(
    Math.abs(peak.dbm - CARRIER_A.dbm) <= 2,
    `a ${CARRIER_A.dbm} dBm carrier read ${peak.dbm} dBm`
  );
  // one carrier in the span and nothing else: no spike at a hop's centre, no
  // step where two hops meet
  const floor = median(trace.amplitudesDbm);
  assert.ok(peak.dbm - floor > 25, `floor at ${floor} dBm`);
  const away = trace.amplitudesDbm.filter(
    (_, i) => Math.abs(hzAt(trace, i) - CARRIER_A.hz) > 200_000
  );
  assert.ok(
    Math.max(...away) - floor < 8,
    `something ${Math.max(...away) - floor} dB above the floor away from the carrier`
  );
});

test('a span wider than the dongle sees is stitched from hops, in order', async (t) => {
  const applied = await configure({
    startHz: 510_000_000,
    stopHz: 550_000_000,
    pointCount: 801,
    controls: { gainDb: GAIN_DB },
  });
  // twenty-odd hops, and the host is told how long they take
  assert.ok(applied.body.resolved.sweepTimeMs > 2_000);

  const trace = await sweepOnce(t);
  assert.equal(trace.amplitudesDbm.length, 801);
  for (const carrier of [CARRIER_A, STRONG, CARRIER_B]) {
    const peak = peakNear(trace, carrier.hz, 3_000_000);
    assert.ok(
      Math.abs(peak.hz - carrier.hz) <= trace.stepHz,
      `the carrier at ${carrier.hz} Hz was drawn at ${peak.hz} Hz`
    );
    assert.ok(
      Math.abs(peak.dbm - carrier.dbm) <= 2,
      `a ${carrier.dbm} dBm carrier read ${peak.dbm} dBm`
    );
  }
});

test('out-of-range configuration is clamped, not rejected', async () => {
  const { capabilities: caps } = await device();
  const applied = await configure({
    startHz: 0,
    stopHz: caps.maxFrequencyHz * 10,
    pointCount: 99_999,
  });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.startHz, caps.minFrequencyHz);
  assert.equal(applied.body.stopHz, caps.maxFrequencyHz);
  assert.equal(applied.body.pointCount, 4001);
});

test('RBW snaps to a supported value, and auto reports what it chose', async () => {
  const { capabilities: caps } = await device();
  const range = { startHz: START_HZ, stopHz: STOP_HZ, pointCount: POINT_COUNT };

  const fixed = await configure({ ...range, rbwHz: 12_345 });
  assert.equal(fixed.body.rbwHz, 14_063);
  assert.ok(caps.rbwHz.includes(fixed.body.rbwHz));

  // a range-only request leaves the bandwidth alone
  const retuned = await configure({ startHz: START_HZ + 1_000_000 });
  assert.equal(retuned.body.rbwHz, 14_063);

  const auto = await configure({ ...range, rbwHz: null });
  assert.equal(auto.body.rbwHz, undefined, 'the field stays auto');
  assert.ok(caps.rbwHz.includes(auto.body.resolved.rbwHz));
  const read = await request('GET', `${DEVICE_PATH}/configuration`);
  assert.deepEqual(read.body, auto.body, 'the echo is what is reported');
});

test('controls are clamped, merged by id, and echoed as they settled', async () => {
  // beyond the tuner's top step; the echo is what it managed
  const high = await configure({ controls: { gainDb: 999 } });
  assert.equal(high.status, 200);
  assert.equal(high.body.controls.gainDb, 49.6);

  // between two steps: the nearest one the tuner has
  const snapped = await configure({ controls: { gainDb: 21 } });
  assert.equal(snapped.body.controls.gainDb, 20.7);

  const detector = await configure({ controls: { detector: 'average' } });
  assert.equal(detector.body.controls.detector, 'average');
  assert.equal(detector.body.controls.gainDb, 20.7, 'the untouched gain survived');

  const offset = await configure({ controls: { levelOffsetDb: -500, ppm: 7.4 } });
  assert.equal(offset.body.controls.levelOffsetDb, -60);
  assert.equal(offset.body.controls.ppm, 7);
  assert.equal(offset.body.controls.detector, 'average');

  await configure({ controls: { detector: 'peak', levelOffsetDb: 0, ppm: 0 } });
});

test('the level offset moves every reading, and gain moves none', async (t) => {
  const range = { startHz: START_HZ, stopHz: STOP_HZ, pointCount: POINT_COUNT };
  await configure({ ...range, controls: { gainDb: GAIN_DB, levelOffsetDb: 0 } });
  const reference = peakNear(await sweepOnce(t), CARRIER_A.hz, 500_000).dbm;
  await request('POST', `${DEVICE_PATH}/sweep/stop`);

  // more gain is a bigger number from the converter and the same power at
  // the antenna (to within what a carrier loses by falling between two bins)
  await configure({ controls: { gainDb: 40.2 } });
  const louder = peakNear(await sweepOnce(t), CARRIER_A.hz, 500_000).dbm;
  assert.ok(Math.abs(louder - reference) <= 2, `${reference} then ${louder}`);
  await request('POST', `${DEVICE_PATH}/sweep/stop`);

  await configure({ controls: { gainDb: GAIN_DB, levelOffsetDb: 10 } });
  const offset = peakNear(await sweepOnce(t), CARRIER_A.hz, 500_000).dbm;
  assert.ok(Math.abs(offset - reference - 10) <= 2, `${reference} then ${offset}`);
  await configure({ controls: { levelOffsetDb: 0 } });
});

test('a clipping converter raises an overload warning that clears with the gain', async (t) => {
  const warningIds = async () =>
    ((await device()).status.warnings ?? []).map((w) => w.id);

  await configure({
    startHz: 529_000_000,
    stopHz: 531_000_000,
    pointCount: 201,
    controls: { gainDb: 49.6 },
  });
  await sweepOnce(t);
  assert.ok((await warningIds()).includes('overload'));
  assert.equal((await device()).status.status, 'ok', 'a warning is not a failure');
  await request('POST', `${DEVICE_PATH}/sweep/stop`);

  await configure({ controls: { gainDb: GAIN_DB } });
  await sweepOnce(t);
  assert.deepEqual(await warningIds(), ['uncalibrated']);
});

test('successive polls see successive sweeps', async (t) => {
  await configure({
    startHz: START_HZ,
    stopHz: STOP_HZ,
    pointCount: POINT_COUNT,
  });
  const first = await sweepOnce(t);
  const startedAt = Date.now();
  const second = (await request('GET', `${DEVICE_PATH}/trace`)).body;
  const elapsed = Date.now() - startedAt;
  assert.ok(second.sweepId > first.sweepId);
  // the long poll returns on the next sweep rather than after the hold cap
  assert.ok(elapsed < 2000, `waited ${elapsed}ms for the next sweep`);
});

test('a dongle that dies mid-sweep marks the device failed, and it reopens', async () => {
  await configure({ startHz: START_HZ, stopHz: STOP_HZ, pointCount: POINT_COUNT });
  await request('POST', `${DEVICE_PATH}/sweep/start`);
  assert.equal(liveWorkers.size, 1, 'one rtl_tcp child holds the dongle');

  // what an unplugged dongle looks like from here: rtl_tcp goes away
  for (const child of liveWorkers) child.kill('SIGKILL');

  const deadline = Date.now() + 5_000;
  let status = null;
  while (Date.now() < deadline) {
    status = (await device())?.status;
    if (status?.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(status?.status, 'failed');
  assert.equal(liveWorkers.size, 0, 'no child is left behind');

  // the next operation opens it again
  const again = await configure({ startHz: START_HZ, stopHz: STOP_HZ });
  assert.equal(again.status, 200);
  assert.equal((await device()).status.status, 'ok');
});
