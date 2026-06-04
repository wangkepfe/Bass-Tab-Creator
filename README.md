# Bass Tab Creator

Convert a MIDI file into ergonomic **bass guitar tablature** (standard 4‑string tuning, E A D G),
with **traditional rhythm notation** drawn under the tab. It reads everything it can from the MIDI
(tempo, time signature, note grid) but **applies nothing silently** — you confirm the grid, octave
and timing, and it shows you what it detected as hints.

A zero‑dependency static site — ready to deploy on **Cloudflare Pages**.

🎸 Live demo: connect this repo to Cloudflare Pages (see **Deploy** below).

## Run locally

- **Easiest:** double‑click `index.html`. The example loads from the embedded fallback.
- **Recommended** (so the `.mid` asset and `fetch` work exactly like production):

  ```bash
  npm run dev          # = python -m http.server 8777
  # then open http://localhost:8777/
  ```

Then click **Load example** (the bundled *Too Many Kicks Bass*) or **Open MIDI…** for your own file.

## Deploy to Cloudflare Pages

This is a static site with **no build step**. In the Cloudflare dashboard → Workers & Pages →
*Create* → *Pages* → *Connect to Git*, pick this repo and use:

| Setting | Value |
|---|---|
| Framework preset | **None** |
| Build command | *(leave empty)* |
| Build output directory | **`/`** |

Cloudflare serves `index.html` at `/`; `bass-tab-core.js`, `example-midi.js` and
`assets/Too Many Kicks Bass.mid` are served as static assets next to it.

## What the controls do

| Control | Purpose |
|---|---|
| **Quantization grid** | Rhythmic resolution notes snap to. Hint shows the grid detected in the file (e.g. *onsets align to 1/16*). |
| **Time signature** | Pre‑filled from the file; editable. Sets bar length. |
| **Tempo (BPM)** | *Difficulty only*, not layout. Blank = use the file's tempo map. A fast tempo turns big jumps between close notes into flagged "hard" spots. |
| **Octave shift (−2…+2)** | Bass MIDI is often written an octave high. The hint maps your lowest/highest note to a string+fret and **suggests** the octave that sits the line lowest on the neck. |
| **Fine transpose** | Semitone nudge, rarely needed. |
| **Timing shift** | Fixes pickups / lead‑ins. Nudge by bar / beat / grid step, or **Trim lead bars**, **First note → 1·1**, **Reset**. Readout shows where the first note lands. |
| **Fretboard** | Fret count (reachability) and tuning (standard E A D G). |
| **Bars per line** | Layout width. |

## The three requested functions

1. **Shift notes left/right** — *Timing shift* nudges + quick actions, so a riff that starts mid‑bar
   no longer confuses the bar grid.
2. **Octave adjust** — *Octave shift* with a live fret‑mapping readout and a recommendation.
3. **Ergonomic analysis** — a fretting path is chosen by minimising hand travel + string changes
   (a shortest‑path search over every possible string+fret for each note), annotated with
   one‑finger‑per‑fret fingerings. The report gives a difficulty rating, fret range, position‑shift
   count, biggest jump (with bar·beat), and **tempo‑aware** flags for fast position shifts. Each
   note in the tab is coloured easy / moderate / hard.

## The tab view

- **Tablature** — string lines, bar numbers, fret badges coloured by difficulty, suggested finger
  above each note, and a faint line showing how long each note is held.
- **Rhythm lane** (below the staff) — traditional timing notation built from each note's duration
  and the gaps between notes: note **stems** with **flags** (1 bar = eighth, 2 = sixteenth), hollow
  vs filled **noteheads** (whole/half vs quarter and shorter), **dots** for dotted values, and
  **rest** glyphs (whole / half / quarter / eighth / sixteenth) for silences. A small key is shown
  under the tab.

## Files

- `index.html` — the app (UI + SVG tab/rhythm renderer).
- `bass-tab-core.js` — the engine: MIDI parser, transforms, ergonomic fingering, rhythm
  decomposition, analysis. No DOM; runs in the browser **and** Node.
- `assets/Too Many Kicks Bass.mid` — bundled example, loaded as a real static asset.
- `example-midi.js` — the same file embedded as base64, used only as a `file://` fallback.
- `test-core.js` — `npm test` runs the engine over the example and prints the analysis.

## Notes / assumptions

- Standard 4‑string bass tuning only, for now (the engine takes a tuning array, so 5‑string / drop
  tunings are a small later addition).
- Tempo does not move fret/string choices — bass tab is positioned by beats — so a tempo change
  only affects the difficulty estimate (read from each note's original position, so trimming across
  a tempo change doesn't mislabel it).
- The rhythm lane uses one glyph per note (nearest standard value) and fills gaps with rests; it
  does not split notes across beats with ties — accurate enough to read, not full engraving.
- SMPTE‑timed MIDI isn't supported (PPQ division only). The bundled example is monophonic; chords
  are placed on separate strings by the renderer.
