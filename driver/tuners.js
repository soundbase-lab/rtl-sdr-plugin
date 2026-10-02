// What each tuner chip an RTL2832U dongle may carry can do, and how raw
// samples relate to power at the antenna.
//
// rtl_tcp reports the tuner type and the *number* of gain steps in its
// greeting, but not the steps themselves; these tables are librtlsdr's own
// (tuner_*.c), so a gain picked here is one the library will land on exactly.

export const SAMPLE_RATE_HZ = 2_400_000;

// rtl_tcp reads the dongle in USB transfers of this many bytes (librtlsdr's
// default, which rtl_tcp does not let a client change). A transfer is
// delivered whole, so it is also the granularity at which a retune can be
// located in the sample stream.
export const TRANSFER_BYTES = 16 * 32 * 512;

// Input power, in dBm, that reads 0 dBFS with the tuner gain at 0 dB. An
// RTL-SDR is not a calibrated instrument: this and the per-step gains below
// put levels within a few dB, and the adapter's level-offset control trims
// the rest against a reference.
export const FULL_SCALE_DBM_AT_0DB_GAIN = -20;

const R82XX_GAINS_DB = [
  0.0, 0.9, 1.4, 2.7, 3.7, 7.7, 8.7, 12.5, 14.4, 15.7, 16.6, 19.7, 20.7, 22.9,
  25.4, 28.0, 29.7, 32.8, 33.8, 36.4, 37.2, 38.6, 40.2, 42.1, 43.4, 43.9, 44.5,
  48.0, 49.6,
];

// What each R82xx step actually contributes, as opposed to what librtlsdr
// calls it: the names are up to 4 dB out, and not evenly. Measured on one
// NESDR SMArt v5 (R820T) at 470 MHz against a tinySA Ultra+ generator, cabled,
// repeatable to half a dB. One dongle at one frequency — other units and
// other bands will differ by a few dB, which is what the level offset is for.
const R82XX_MEASURED_GAINS_DB = [
  -2.4, 1.3, 2.5, 6.2, 8.1, 11.3, 12.8, 15.3, 16.8, 18.2, 19.6, 22.3, 23.6,
  26.5, 28.1, 31.0, 32.3, 35.2, 36.6, 38.9, 40.2, 41.8, 43.1, 43.2, 44.5, 45.9,
  45.9, 48.3, 50.9,
];

const UNKNOWN = {
  name: 'unknown tuner',
  minHz: 24_000_000,
  maxHz: 1_766_000_000,
  gainsDb: R82XX_GAINS_DB,
};

// keyed by the tuner type in rtl_tcp's greeting (enum rtlsdr_tuner)
const TUNERS = {
  1: {
    name: 'E4000',
    minHz: 52_000_000,
    maxHz: 2_200_000_000,
    gainsDb: [-1.0, 1.5, 4.0, 6.5, 9.0, 11.5, 14.0, 16.5, 19.0, 21.5, 24.0, 29.0, 34.0, 42.0],
  },
  2: {
    name: 'FC0012',
    minHz: 22_000_000,
    maxHz: 948_600_000,
    gainsDb: [-9.9, -4.0, 7.1, 17.9, 19.2],
  },
  3: {
    name: 'FC0013',
    minHz: 22_000_000,
    maxHz: 1_100_000_000,
    gainsDb: [
      -9.9, -7.3, -6.5, -6.3, -6.0, -5.8, -5.4, 5.8, 6.1, 6.3, 6.5, 6.7, 6.8,
      7.0, 7.1, 17.9, 18.1, 18.2, 18.4, 18.6, 18.8, 19.1, 19.7,
    ],
  },
  4: {
    name: 'FC2580',
    minHz: 146_000_000,
    maxHz: 924_000_000,
    gainsDb: [0.0],
  },
  5: {
    name: 'R820T',
    minHz: 24_000_000,
    maxHz: 1_766_000_000,
    gainsDb: R82XX_GAINS_DB,
    measuredGainsDb: R82XX_MEASURED_GAINS_DB,
  },
  6: {
    name: 'R828D',
    minHz: 24_000_000,
    maxHz: 1_766_000_000,
    gainsDb: R82XX_GAINS_DB,
    measuredGainsDb: R82XX_MEASURED_GAINS_DB,
  },
};

export const tunerInfo = (type) => TUNERS[type] ?? UNKNOWN;

/**
 * The gain to correct a reading by when the tuner is set to `gainDb`, one of
 * its own steps: the measured figure where there is one, the nominal one
 * otherwise.
 */
export const levelGainDb = (tuner, gainDb) =>
  tuner.measuredGainsDb?.[tuner.gainsDb.indexOf(gainDb)] ?? gainDb;

export const nearest = (value, list) =>
  list.reduce((best, candidate) =>
    Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best
  );
