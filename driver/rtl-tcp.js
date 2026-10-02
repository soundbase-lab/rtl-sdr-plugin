// Owns one rtl_tcp child process and speaks its wire protocol.
//
// rtl_tcp is librtlsdr's own I/Q server: it holds the dongle, streams
// unsigned 8-bit I/Q over a socket, and takes five-byte commands to retune and
// set gain. Running it as a child rather than binding libusb in-process is the
// isolation docs/native-runtimes.md asks for — a dongle pulled mid-transfer
// can wedge libusb for good, and a child can always be killed.
//
// Nothing here knows what SoundBase is. Set SB_RTLSDR_MOCK=1 and the same code
// drives driver/fake-rtl-sdr.js instead, so the process plumbing is under test
// with no dongle attached.

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAMPLE_RATE_HZ, TRANSFER_BYTES } from './tuners.js';

const FAKE = fileURLToPath(new URL('./fake-rtl-sdr.js', import.meta.url));
// SoundBase launched from the Finder inherits a PATH without Homebrew on it
const USUAL_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'];

const LIST_TIMEOUT_MS = 4_000;
const OPEN_TIMEOUT_MS = 10_000;
const CONNECT_RETRY_MS = 100;
const STALL_TIMEOUT_MS = 2_500;
const KILL_GRACE_MS = 500;

const TRANSFER_MS = (TRANSFER_BYTES / 2 / SAMPLE_RATE_HZ) * 1000;
// how long after a retune command the tuner's PLL is taken to have settled
const SETTLE_MS = 10;

// A gain or correction change is a string of I2C writes that rtl_tcp works
// through before it gets to the retune queued behind it, and samples taken
// meanwhile are at neither setting. This many extra transfers are dropped
// after one.
const SETTING_SETTLE_TRANSFERS = 2;

const CMD_FREQUENCY = 0x01;
const CMD_GAIN_MODE = 0x03;
const CMD_GAIN = 0x04;
const CMD_PPM = 0x05;
const CMD_AGC = 0x08;

const HEADER_BYTES = 12;

/** every rtl_tcp child this process has running; a test kills one to stage a dead transport */
export const liveWorkers = new Set();

// a plugin that exits must not leave a child holding the dongle
process.on('exit', () => {
  for (const child of liveWorkers) child.kill('SIGKILL');
});

/** Where a librtlsdr tool lives, as `{ command, args }`, or null when it is not installed. */
function tool(name, binDir) {
  if (process.env.SB_RTLSDR_MOCK === '1') {
    return { command: process.execPath, args: [FAKE, name] };
  }
  const file = process.platform === 'win32' ? `${name}.exe` : name;
  const dirs = [
    binDir,
    process.env.SB_RTLSDR_BIN_DIR,
    ...(process.env.PATH ?? '').split(delimiter),
    ...USUAL_DIRS,
  ];
  for (const dir of dirs) {
    if (typeof dir !== 'string' || !dir.trim()) continue;
    const candidate = join(dir.trim(), file);
    if (existsSync(candidate)) return { command: candidate, args: [] };
  }
  return null;
}

/**
 * The dongles attached right now, as `[{ index, vendor, product, serial }]`,
 * or null when the librtlsdr tools are not installed.
 *
 * Asks rtl_test for a device that cannot exist: it prints what it found and
 * exits without opening anything, so a dongle another program is using is
 * listed and left alone.
 */
export async function listDongles({ binDir } = {}) {
  const rtlTest = tool('rtl_test', binDir);
  if (!rtlTest) return null;
  const output = await new Promise((resolve) => {
    execFile(
      rtlTest.command,
      [...rtlTest.args, '-d', 'soundbase-probe'],
      { timeout: LIST_TIMEOUT_MS, killSignal: 'SIGKILL' },
      // exits non-zero by design, so the error is not interesting
      (_err, stdout, stderr) => resolve(`${stdout}\n${stderr}`)
    );
  });
  const dongles = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+):\s+(.*),\s+(.*),\s+SN:\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    dongles.push({
      index: Number(match[1]),
      vendor: match[2].trim(),
      product: match[3].trim(),
      serial: match[4],
    });
  }
  return dongles;
}

/** rtl_tcp's last words, as something a person can act on. */
function explain(stderr, code) {
  if (/usb_claim_interface error|usb_open error -3/i.test(stderr)) {
    return 'The RTL-SDR is in use by another program. Close it and try again.';
  }
  if (/No supported devices found|No matching devices found/i.test(stderr)) {
    return 'No RTL-SDR dongle is attached.';
  }
  const last = stderr.trim().split('\n').filter(Boolean).pop();
  return `rtl_tcp exited (code ${code})${last ? `: ${last.trim()}` : ''}`;
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

export class RtlTcp {
  #child = null;
  #socket = null;
  #closed = false;
  #stderr = '';
  #header = Buffer.alloc(0);
  #headerWaiter = null;
  #streamBytes = 0;
  #lastDataAt = 0;
  #watchdog = null;
  #capture = null;
  #settleTransfers = 0;

  constructor({ index, binDir }) {
    this.index = index;
    this.binDir = binDir;
    /** set by the adapter; called when the dongle or rtl_tcp dies unprompted */
    this.onFatal = null;
  }

  /** Start rtl_tcp on the dongle and connect. Resolves `{ tunerType, gainCount }`. */
  async open() {
    const rtlTcp = tool('rtl_tcp', this.binDir);
    if (!rtlTcp) {
      throw new Error(
        'rtl_tcp was not found. Install it with `brew install librtlsdr`, or ' +
          'set "RTL-SDR tools folder" in the plugin settings.'
      );
    }
    const port = await freePort();
    const child = spawn(
      rtlTcp.command,
      [
        ...rtlTcp.args,
        '-a',
        '127.0.0.1',
        '-p',
        String(port),
        '-d',
        String(this.index),
        '-s',
        String(SAMPLE_RATE_HZ),
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    this.#child = child;
    liveWorkers.add(child);
    let exited = null;
    child.stderr.on('data', (chunk) => {
      this.#stderr = (this.#stderr + chunk).slice(-4_000);
    });
    child.on('error', (err) => {
      exited = { code: null, err };
      liveWorkers.delete(child);
    });
    child.on('exit', (code) => {
      exited = { code };
      liveWorkers.delete(child);
      this.#die(new Error(explain(this.#stderr, code)));
    });

    try {
      // rtl_tcp listens only once it has opened and initialised the dongle,
      // which takes a second or two; until then the connection is refused
      const deadline = Date.now() + OPEN_TIMEOUT_MS;
      while (!this.#socket) {
        if (exited) {
          throw exited.err ?? new Error(explain(this.#stderr, exited.code));
        }
        if (Date.now() > deadline) {
          throw new Error(
            `rtl_tcp did not start listening within ${OPEN_TIMEOUT_MS / 1000}s`
          );
        }
        this.#socket = await this.#connect(port);
        if (!this.#socket) {
          await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_MS));
        }
      }
      const header = await this.#readHeader();
      if (header.toString('latin1', 0, 4) !== 'RTL0') {
        throw new Error('rtl_tcp sent an unexpected greeting');
      }
      this.#lastDataAt = Date.now();
      this.#watchdog = setInterval(() => this.#checkStall(), 500);
      this.#watchdog.unref?.();
      return {
        tunerType: header.readUInt32BE(4),
        gainCount: header.readUInt32BE(8),
      };
    } catch (err) {
      this.close();
      throw err;
    }
  }

  #connect(port) {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.removeAllListeners('error');
        socket.on('data', (chunk) => this.#consume(chunk));
        socket.on('error', () => {});
        socket.on('close', () =>
          this.#die(new Error('The connection to rtl_tcp closed.'))
        );
        resolve(socket);
      });
      socket.once('error', () => resolve(null));
    });
  }

  #readHeader() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('rtl_tcp connected but sent no greeting')),
        OPEN_TIMEOUT_MS
      );
      this.#headerWaiter = {
        resolve: (header) => {
          clearTimeout(timer);
          resolve(header);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      this.#deliverHeader();
    });
  }

  #deliverHeader() {
    if (this.#headerWaiter && this.#header.length >= HEADER_BYTES) {
      this.#headerWaiter.resolve(this.#header);
      this.#headerWaiter = null;
    }
  }

  #consume(chunk) {
    this.#lastDataAt = Date.now();
    if (this.#header.length < HEADER_BYTES) {
      const need = HEADER_BYTES - this.#header.length;
      this.#header = Buffer.concat([this.#header, chunk.subarray(0, need)]);
      chunk = chunk.subarray(need);
      this.#deliverHeader();
    }
    // The stream is a run of whole USB transfers, so the byte count alone says
    // where each one starts. Samples are consumed a transfer at a time.
    while (chunk.length > 0) {
      const room = TRANSFER_BYTES - (this.#streamBytes % TRANSFER_BYTES);
      const piece = chunk.subarray(0, room);
      chunk = chunk.subarray(piece.length);
      const capture = this.#capture;
      if (capture && capture.skip === 0) {
        piece.copy(capture.buffer, capture.filled);
        capture.filled += piece.length;
      }
      this.#streamBytes += piece.length;
      if (capture && piece.length === room) this.#transferComplete(capture);
    }
  }

  #transferComplete(capture) {
    if (capture.skip > 0) {
      capture.skip -= 1;
      return;
    }
    // A transfer that finished arriving this soon after the retune was at
    // least partly sampled before the tuner settled — which happens when this
    // process fell behind and rtl_tcp had transfers queued. Take the next one.
    if (
      capture.filled < TRANSFER_BYTES ||
      Date.now() < capture.sentAt + TRANSFER_MS + SETTLE_MS
    ) {
      capture.filled = 0;
      return;
    }
    this.#capture = null;
    capture.resolve(capture.buffer);
  }

  #checkStall() {
    if (Date.now() - this.#lastDataAt < STALL_TIMEOUT_MS) return;
    this.#die(
      new Error(
        'The RTL-SDR stopped delivering samples. Check that it is still plugged in.'
      )
    );
  }

  #command(command, value) {
    if (!this.#socket || this.#socket.destroyed) {
      throw new Error('The RTL-SDR is not open.');
    }
    const packet = Buffer.alloc(5);
    packet.writeUInt8(command, 0);
    packet.writeUInt32BE(value >>> 0, 1);
    this.#socket.write(packet);
  }

  /** Manual tuner gain, in dB. librtlsdr snaps it to the nearest step the tuner has. */
  setGain(gainDb) {
    this.#command(CMD_AGC, 0);
    this.#command(CMD_GAIN_MODE, 1);
    this.#command(CMD_GAIN, Math.round(gainDb * 10));
    this.#settleTransfers = SETTING_SETTLE_TRANSFERS;
  }

  /** Crystal error correction, in parts per million. */
  setPpm(ppm) {
    this.#command(CMD_PPM, Math.round(ppm));
    this.#settleTransfers = SETTING_SETTLE_TRANSFERS;
  }

  /**
   * Retune to `centerHz` and resolve one whole USB transfer of interleaved
   * unsigned 8-bit I/Q sampled entirely at that frequency — or null if
   * `abortCapture()` was called first.
   *
   * rtl_tcp has no marker for where in the stream a retune took effect. What
   * is certain is that the transfer being filled when the command goes out is
   * part old frequency and part new, so the rest of the current transfer and
   * all of the next are dropped and the one after is kept.
   */
  capture(centerHz) {
    if (this.#capture) throw new Error('a capture is already in flight');
    this.#command(CMD_FREQUENCY, Math.round(centerHz));
    const settle = this.#settleTransfers;
    this.#settleTransfers = 0;
    return new Promise((resolve, reject) => {
      this.#capture = {
        // the transfer in flight (when partly delivered) and the one after it
        skip: (this.#streamBytes % TRANSFER_BYTES === 0 ? 1 : 2) + settle,
        buffer: Buffer.allocUnsafe(TRANSFER_BYTES),
        filled: 0,
        sentAt: Date.now(),
        resolve,
        reject,
      };
    });
  }

  /** Resolve a pending `capture()` with null, without touching the transport. */
  abortCapture() {
    const capture = this.#capture;
    this.#capture = null;
    capture?.resolve(null);
  }

  /** The transport died on its own: tear down, then tell the adapter once. */
  #die(err) {
    if (this.#closed) return;
    const onFatal = this.onFatal;
    const capture = this.#capture;
    const headerWaiter = this.#headerWaiter;
    this.#capture = null;
    this.close();
    capture?.reject(err);
    headerWaiter?.reject(err);
    onFatal?.(err);
  }

  /** Stop rtl_tcp and release the dongle. Idempotent; never throws. */
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.onFatal = null; // a close we asked for is not a fatal error
    clearInterval(this.#watchdog);
    this.#capture?.resolve(null);
    this.#capture = null;
    this.#headerWaiter = null;
    this.#socket?.destroy();
    this.#socket = null;
    const child = this.#child;
    this.#child = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      // rtl_tcp blocked inside libusb ignores SIGTERM; SIGKILL cannot be ignored
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }, KILL_GRACE_MS);
      timer.unref?.();
    }
  }
}
