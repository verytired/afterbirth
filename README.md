# AfterBirth AB-3389

An acid groovebox that runs in the browser: two TB-303-style bass lines, 808- and 909-style drum machines, a mixer and effects, all built on the Web Audio API alone. No external libraries, a single `index.html`.

**▶ Play in your browser: https://verytired.github.io/afterbirth/**

![screenshot](docs/screenshot.png)

## Getting started

```sh
open index.html   # or drag it into a browser
```

Press ▶ to start (browsers keep audio suspended until the first click). Chrome / Edge recommended.

## Units

| Unit | What it does |
|---|---|
| **AB-303 #1 / #2** | SAW / SQUARE, TUNE / CUTOFF / RESO / ENV MOD / DECAY / ACCENT. 16 steps with note, UP / DN, ACC (accent) and SLD (slide) |
| **AB-808** | BD / SD / CH / OH / CP. Fully synthesized; CH chokes OH |
| **AB-909** | BD / SD / LT / HT / RS / CP / CH / OH / CR |
| **PATTERN** | 32 patterns per machine (1-8 × A-D). Switching while playing waits for the next bar. SHUFFLE on/off per pattern |
| **MIX** | Mute, PAN, DELAY send, fader, DIST / PCF / COMP inserts |
| **MASTER** | Meter, master fader, master COMP |
| **PCF** | Pattern-controlled filter. 32 patterns, LP / BP, FREQ / Q / AMT / DEC |
| **DELAY** | Tempo-synced (steps, straight / triplet), PAN, F.BACK |
| **DIST** | AMOUNT, SHAPE (soft clip to wavefold) |
| **COMP** | RATIO, THRES |

- Drag knobs up/down to turn them, double-click to reset. Arrow keys work when a knob has focus
- LED displays such as TEMPO change with −/+, the mouse wheel, or a vertical drag
- Patterns autosave to localStorage (knob and mixer values are not saved)

## Using it with Ableton Live

### MIDI clock sync (Live → AB)

1. Enable the IAC Driver in Audio MIDI Setup
2. In Live's Preferences → Link/Tempo/MIDI, turn on **Sync** for the IAC output
3. Press **EXT SYNC** in AB and allow MIDI access
4. Hit play in Live and AB follows (Start / Stop / Continue / Song Position supported, tempo follows automatically)

If timing drifts, adjust Live's **MIDI Clock Sync Delay**.

### Recording audio into a DAW (AB → Live)

1. Install [BlackHole 16ch](https://github.com/ExistentialAudio/BlackHole) (`brew install blackhole-16ch`)
2. Choose BlackHole 16ch under **OUTPUT** in AB (the first time, the browser asks for microphone permission just to show device names; nothing is recorded)
3. Turn on **MULTI OUT**

| ch | Content |
|---|---|
| 1/2 | MASTER (including DELAY and master COMP) |
| 3/4 | AB-303 #1 |
| 5/6 | AB-303 #2 |
| 7/8 | AB-808 |
| 9/10 | AB-909 |

4. In Live, set the input device to BlackHole 16ch, route each track's input to Ext. In 3/4 and so on, and record

Per-machine outputs are taken after the fader and inserts (DIST / PCF / COMP). DELAY and master COMP are only on 1/2. Output device switching works in Chrome / Edge only.

## Recording and video

From **REC** in the top bar.

- **● WAV**: records MASTER (post-fader) as a 16-bit stereo WAV. Press again to stop and download `afterbirth-YYYYMMDD-HHMMSS.wav`, ready to drop into a DAW
- **● VIDEO**: pick the AB tab in the screen-share dialog to record the screen together with MASTER audio. Press again, or stop sharing, to finish. mp4 in Chrome, webm elsewhere
- Recordings are buffered in memory, so long takes are not a good fit (about 200MB per 10 minutes)

## License

[MIT](LICENSE)

## Disclaimer

An unofficial fan project inspired by ReBirth RB-338. Not affiliated with Reason Studios (formerly Propellerhead Software) or Roland. 303 / 808 / 909 are used only to describe the style of each machine.
