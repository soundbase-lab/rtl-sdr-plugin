# RTL-SDR plugin for SoundBase

Turns a cheap RTL-SDR USB dongle into a spectrum analyzer for
[SoundBase](docs/soundbase.md): the dongle appears in the live-scan picker and
its sweeps become the live trace on the coordination plot.

It is a scouting tool, not a measurement instrument — a way to see what is
on the air in a venue with hardware that fits on a keyring. What it does well
and where it runs out are both set out below.

Maintained by matt dale at
[soundbase-lab/rtl-sdr-plugin](https://github.com/soundbase-lab/rtl-sdr-plugin).

> **Requires librtlsdr.** `brew install librtlsdr` on macOS. The plugin runs
> the `rtl_tcp` and `rtl_test` tools that formula installs; it finds them on
> `PATH` and in the usual Homebrew folders. If yours are somewhere else, set
> **RTL-SDR tools folder** in the plugin's settings, or `SB_RTLSDR_BIN_DIR`.
>
> Only one program can hold a dongle. Close SDR++, GQRX or anything else using
> it before sweeping.

## Supported hardware

Any dongle built on the **Realtek RTL2832U** that librtlsdr can open. The
RTL2832U is the half that digitises; what a dongle can tune depends on the
tuner chip beside it, which the plugin identifies when it opens the dongle and
reports capabilities for.

| Tuner chip | Tunes | Gain steps | Found in | Status |
|---|---|---|---|---|
| Rafael Micro **R820T / R820T2** | 24–1766 MHz | 29, 0–49.6 dB | Nooelec NESDR SMArt, RTL-SDR Blog V3, most current dongles | **Tested**, levels corrected |
| Rafael Micro **R828D** | 24–1766 MHz | 29, 0–49.6 dB | RTL-SDR Blog V4, Astrometa | Untested; uses the R820T level table |
| Elonics **E4000** | 52–2200 MHz | 14, −1–42 dB | Older dongles, Nooelec NESDR XTR | Untested |
| Fitipower **FC0013** | 22–1100 MHz | 23, −9.9–19.7 dB | Older generic dongles | Untested |
| Fitipower **FC0012** | 22–948.6 MHz | 5, −9.9–19.2 dB | Older generic dongles | Untested |
| FCI **FC2580** | 146–924 MHz | fixed | Rare | Untested |

**Tested** means one unit: a Nooelec NESDR SMArt v5 (R820T2), on macOS with
librtlsdr 2.0.2. The others are supported by construction — their ranges and
gain steps are librtlsdr's own — but nobody has swept one through this plugin.
An R828D needs librtlsdr 2.0 or later.

Wireless microphones and in-ear monitors live in 470–700 MHz, with some
systems around 900 MHz and 1.2 GHz. Every tuner above covers the UHF part;
the R820T and R828D reach all of it up to 1766 MHz.

**Not supported:**

- Anything that is not an RTL2832U: HackRF, Airspy, SDRplay, USRP.
- Below the tuner's range. The direct-sampling mode some dongles use for HF
  is not used.
- The bias tee on dongles that have one. It stays off.

## Using it in SoundBase

SoundBase Desktop runs plugins from its plugins folder — on macOS,
`~/Library/Application Support/SoundBase Desktop/plugins` — and the plugin
system has to be enabled for your account.
[docs/running-in-soundbase.md](docs/running-in-soundbase.md) has the details.

1. Put this folder, with `node_modules/` installed, in the plugins folder.
2. Enable **RTL-SDR** under **Settings → Plugins**.
3. Plug in the dongle. In a Coord project, open the plot's **Live Scan Data
   Settings**; the dongle is listed as **RTL-SDR** followed by its serial.

These dongles run hot in normal use. A short USB extension lead gets one away
from the computer and into free air.

## Developing

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
one NESDR SMArt v5 at 470 MHz against a tinySA Ultra+ generator, cabled. How
that dongle then compares with the generator:

| Frequency | Low and mid gain | Above about 33 dB gain |
|---|---|---|
| 100 MHz | about 1.8 dB low | 3 to 3.7 dB low |
| 470 MHz | within 0.3 dB | within 0.5 dB |
| 600 MHz | about 0.5 dB low | 1 to 2 dB low |
| 1000 MHz | about 2 dB low | 2.5 to 5 dB low |

No frequency correction is applied: away from 470 MHz the differences are
about the size of the generator's own accuracy. Other units will differ by a
few dB, other tuner chips use librtlsdr's nominal gains, and the device
carries a standing *uncalibrated* notice saying so. Stay at mid gain for
readings you want to trust, and trim **Level offset** against a known source
where absolute level matters.

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
