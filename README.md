# RTL-SDR plugin for SoundBase

Turns an RTL-SDR dongle (RTL2832U) into a SoundBase spectrum analyzer: the
dongle appears in the live-scan picker and its sweeps become the trace on the
plot.

> **Requires librtlsdr.** `brew install librtlsdr` on macOS. The plugin runs
> the `rtl_tcp` and `rtl_test` tools that formula installs; it finds them on
> `PATH` and in the usual Homebrew folders. If yours are somewhere else, set
> **RTL-SDR tools folder** in the plugin's settings, or `SB_RTLSDR_BIN_DIR`.
>
> Only one program can hold a dongle. Close SDR++, GQRX or anything else using
> it before sweeping.

```sh
npm install
npm run doctor      # is everything wired up?
npm test            # the contract, against a fake dongle — nothing plugged in
npm run smoke       # boots as SoundBase does, and sweeps the dongle if one is attached
```

## What to expect from it

An RTL-SDR is a receiver, not an analyzer, and three things follow from that.

**It sees about 2 MHz at a time.** A sweep is a walk: tune, capture, FFT, move
on. Each hop costs about 110 ms, so sweep time grows with span and with nothing
else:

| Span | Hops | Sweep time |
|---|---|---|
| one 8 MHz TV channel | 5 | 0.5 s |
| 470–616 MHz | 74 | 8 s |
| 24–1766 MHz (everything an R820T tunes) | 872 | 95 s |

The plugin reports the figure for the current settings as
`resolved.sweepTimeMs`, so SoundBase does not mistake a slow sweep for a
stalled device. Resolution bandwidth and point count do not change it.

**Levels are approximate.** The dongle has no absolute reference. For R820T
and R828D tuners, readings are corrected with a per-gain-step table measured on
one NESDR SMArt v5 at 470 MHz against a tinySA Ultra+ generator; on that dongle
at that frequency every gain step then reads within half a dB of the generator.
Other units and other bands will be a few dB out, other tuner chips use
librtlsdr's nominal gains, and the device carries a standing *uncalibrated*
notice saying so. Trim **Level offset** against a known source where absolute
readings matter.

**It overloads easily.** Eight bits of converter is about 45 dB of range at any
one gain setting. A strong transmitter nearby clips it and draws signals that
are not there; the plugin watches for clipped samples and raises an *overload*
warning. Lower **Tuner gain** when it appears.

## Controls

Declared from the dongle's own tuner when it is opened, and shown beside RBW
and point count:

| | |
|---|---|
| **Tuner gain** | Snaps to the nearest step the tuner has (0–49.6 dB on an R820T). Readings are corrected for it, so changing gain moves the noise floor and the overload point, not the level of a carrier. |
| **Detector** | `Peak` or `Average` — how the FFT bins that land on one trace point are combined. Peak never hides a narrow carrier between points. |
| **Level offset** | Added to every reading, ±60 dB. |
| **Frequency correction** | Crystal error in ppm, ±200. |

RBW is one of seven values from 879 Hz to 56 kHz (the FFT sizes available at
2.4 MS/s); left on auto it follows the point spacing.

## How it is put together

```
adapter.js               plans the hops, assembles the trace, speaks the adapter contract
driver/rtl-tcp.js        owns one rtl_tcp child process and its socket
driver/spectrum.js       the FFT
driver/tuners.js         per-tuner frequency range and gain steps, and the level constant
driver/fake-rtl-sdr.js   a fake dongle, standing in for rtl_tcp and rtl_test
```

`rtl_tcp` runs as a **child process** rather than libusb being loaded into the
plugin. A dongle pulled mid-transfer can wedge libusb for good; a child can
always be killed, and the plugin reports the device failed and stays up. See
[docs/native-runtimes.md](docs/native-runtimes.md).

A dongle's id is its serial number — `usb:00000001` — because that is the one
thing about it that is the same on every machine. Dongles sold with identical
serials get an ordinal (`usb:00000001:2`); `rtl_eeprom -s` gives one a serial of
its own.

Two details worth knowing before changing the sweep:

- `rtl_tcp` does not mark where in the sample stream a retune took effect. The
  driver drops the USB transfer the retune lands in and keeps the next whole
  one, which is where the 110 ms per hop comes from.
- The converter's resting value shows as a false carrier at the centre of every
  capture. It is estimated across many captures rather than from each one —
  per-capture removal deletes a real carrier that happens to sit on a hop's
  centre — and every sweep shifts its hop centres slightly.

## Working without a dongle

```sh
SB_RTLSDR_MOCK=1 npm start
SB_RTLSDR_MOCK=1 npm run smoke
```

Mock mode swaps the librtlsdr tools for `driver/fake-rtl-sdr.js`: one dongle,
serial `MOCK0001`, streaming at the real rate with a few carriers in a quiet
band. Everything else — the child process, the socket, the retune timing — is
the real code. `SB_RTLSDR_MOCK_CARRIERS="518100000:-70,530000000:-45"` places
carriers; `SB_RTLSDR_MOCK_DONGLES=0` unplugs it.

## Limits

- **macOS on Apple silicon only**, because that is the only place it has been
  run. `platforms` in the manifest says so, and SoundBase enforces it.
- While a dongle is sweeping, newly attached dongles are not discovered: asking
  libusb to enumerate risks disturbing the stream. Stop the sweep to add
  another.
- Tuner gaps (the E4000's around 1.1–1.25 GHz, the FC2580's between its two
  bands) are not modelled; a sweep across one shows noise.

## Documentation

The plugin model, the contract and the scripts are documented in
[docs/](docs/README.md); [CLAUDE.md](CLAUDE.md) is the short version. The
normative specification installs with the dependencies, under
`node_modules/@soundbase/plugin-contract/spec/`.

## Licence

Business Source License 1.1 — see `LICENSE`.
