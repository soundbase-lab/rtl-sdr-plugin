// Turning raw RTL2832U samples into power per frequency bin.
//
// Pure arithmetic: nothing here knows about rtl_tcp, the tuner or SoundBase,
// so it can be tested on synthetic samples alone.

/** In-place radix-2 FFT of a complex signal held as two Float64Arrays. */
function fft(re, im, tables) {
  const n = re.length;
  const { cos, sin, reversed } = tables;
  for (let i = 0; i < n; i += 1) {
    const j = reversed[i];
    if (j > i) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const stride = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k += 1) {
        const wr = cos[k * stride];
        const wi = sin[k * stride];
        const a = start + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

const tableCache = new Map();

function tablesFor(n) {
  let tables = tableCache.get(n);
  if (tables) return tables;
  const bits = Math.log2(n);
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k += 1) {
    cos[k] = Math.cos((-2 * Math.PI * k) / n);
    sin[k] = Math.sin((-2 * Math.PI * k) / n);
  }
  const reversed = new Uint32Array(n);
  for (let i = 0; i < n; i += 1) {
    let r = 0;
    for (let b = 0; b < bits; b += 1) r |= ((i >> b) & 1) << (bits - 1 - b);
    reversed[i] = r;
  }
  // Hann: its 1.5-bin noise bandwidth is what the adapter reports as RBW
  const window = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    sum += window[i];
  }
  tables = { cos, sin, reversed, window, windowSum: sum };
  tableCache.set(n, tables);
  return tables;
}

/** Noise bandwidth of the Hann window, in bins. */
export const WINDOW_ENBW_BINS = 1.5;

/**
 * What a block of interleaved unsigned 8-bit I/Q looks like before any FFT:
 * the mean of each channel, and `clipped`, the fraction of samples pinned at
 * either rail.
 */
export function blockStats(iq) {
  let sumI = 0;
  let sumQ = 0;
  let clipped = 0;
  for (let s = 0; s < iq.length; s += 2) {
    const i = iq[s];
    const q = iq[s + 1];
    sumI += i;
    sumQ += q;
    if (i === 0 || i === 255) clipped += 1;
    if (q === 0 || q === 255) clipped += 1;
  }
  const samples = iq.length / 2;
  return {
    meanI: sumI / samples,
    meanQ: sumQ / samples,
    clipped: clipped / iq.length,
  };
}

/**
 * Averaged power spectrum of interleaved unsigned 8-bit I/Q, as rtl_tcp
 * streams it. `zeroI` and `zeroQ` are the converter's resting values, taken
 * out before the FFT.
 *
 * Returns power, linear and relative to full scale — a sine that just fills
 * the ADC reads 1.0 — ordered from the lowest frequency to the highest, so
 * bin `i` sits at `center + (i - fftSize / 2) * sampleRate / fftSize`.
 */
export function powerSpectrum(iq, fftSize, zeroI = 127.5, zeroQ = 127.5) {
  const tables = tablesFor(fftSize);
  const { window, windowSum } = tables;
  const frames = Math.floor(iq.length / 2 / fftSize);

  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const sum = new Float64Array(fftSize);
  for (let frame = 0; frame < frames; frame += 1) {
    const base = 2 * frame * fftSize;
    for (let n = 0; n < fftSize; n += 1) {
      re[n] = ((iq[base + 2 * n] - zeroI) / 127.5) * window[n];
      im[n] = ((iq[base + 2 * n + 1] - zeroQ) / 127.5) * window[n];
    }
    fft(re, im, tables);
    for (let n = 0; n < fftSize; n += 1) {
      sum[n] += re[n] * re[n] + im[n] * im[n];
    }
  }

  // normalise so a full-scale tone reads 1.0, and rotate negative frequencies
  // to the front
  const scale = 1 / (frames * windowSum * windowSum);
  const half = fftSize / 2;
  const power = new Float64Array(fftSize);
  for (let n = 0; n < fftSize; n += 1) {
    power[n] = sum[(n + half) % fftSize] * scale;
  }
  return power;
}
