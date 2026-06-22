# 🎚️ Studio

One app that takes a song from **YouTube / an audio file / a MIDI file** all the way
to an **editable MIDI part** and three readable views — a **piano-roll editor**, an
**ergonomic bass tab**, and a **drum tab** — with playback against the original,
the isolated stem, or a synth so you can A/B the transcription.

```
YouTube ─┐
audio  ──┼─▶ [yt-dlp] ─▶ Demucs v4 ─▶ isolated stem ─▶ basic-pitch / ADTLib ─▶ MIDI / drum hits
.mid  ───┘                                                     │
                                       ┌──────────────────────┼──────────────────────┐
                                  Piano-roll editor       Bass tab               Drum tab
                                  (edit · quantize)   (fingering · rhythm)   (multi-lane grid)
                                       └──────────── shared transport: Synth · Original · Stem ───┘
```

## What it does (single entry point — open `http://localhost:8000/`)

1. **YouTube → audio** — paste a link, `yt-dlp` downloads + transcodes to mp3.
2. **Audio in** — drop `mp3 / wav / flac / m4a / ogg`.
3. **MIDI in** — drop or *Open* a `.mid` (melodic → piano-roll; GM-drum → drum tab).
4. **Stem isolation** — Demucs v4 (`Separate`).
5. **Audio → MIDI** — basic-pitch (`Transcribe`); drums via ADTLib (librosa fallback).
6. **MIDI → bass tab** — ergonomic fingering (Viterbi), rhythm notation, viewing options.
7. **MIDI → piano-roll** — full DAW-style editor.
8. **MIDI → drum tab** — quantized multi-lane grid.
9. **MIDI editing** — draw / move / resize / quantize / transpose / undo, plus `→ Mono`.
10. **Bass-tab viewing options** — monophonic reduce, avoid-open, max fret, octave, grid,
    bars/line, finger numbers; click a note to change its fretboard position.
11. **Piano-roll / editor playback** — Synth · Original · Stem under one playhead.
12. **Tab playback** — the same transport drives the bass-tab and drum-tab playheads.

**Targets** (the *target* dropdown) drive which Demucs stem + model + transcription range
are used: **Bass · Piano · Guitar · Vocals · Keys/other · Drums**.

## Projects (save / load)

Everything lives in a **project** — the app's document. A project bundles the **YouTube
link**, the **song audio**, the isolated **stem** per instrument, the editable **MIDI/drum
tracks** (one per instrument), and **all per-track view options** (bass-tab octave, offset,
max-fret, monophonic, avoid-open, finger numbers, and your manual fingering choices).

- **Multi-track, no timeline** — each extracted instrument becomes a *track* (chips under the
  toolbar). Click a track to edit/view it in its instrument tab (bass→bass tab, drums→drum
  tab, others→piano-roll). The available view tabs follow the active track.
- **Save + auto-update** — name it and hit **Save** (header); it's created server-side and
  every later edit auto-saves. **New** starts fresh; **📁 Library** lists all saved projects
  (search by name, open, delete).
- **Stored as the app's database** — under a git-ignored `projects/<id>/` folder
  (`project.json` + `song.<ext>` + `stems/<inst>.<ext>`), served back via `/api/projects`.
  Audio is kept so projects reopen fully offline with no re-processing.

## Run

```bash
cd tab-studio/server
# one-time setup — see server/README.md (GPU torch, ffmpeg, basic-pitch, yt-dlp)
.venv\Scripts\python -m uvicorn app:app --port 8000      # Windows
# or from the repo root:  start-studio.bat
```
Open **http://localhost:8000/**. The editor, MIDI I/O and tab rendering work offline;
the stem / transcription / YouTube steps need the backend.

## Files

```
web/   index.html · app.js · studio.css
       midi-io.js · player.js · drum-synth.js · transport.js          (engines)
       piano-roll.js · bass-tab.js · bass-tab-core.js · drum-roll.js · drum-tab-core.js  (views)
       workflow.js                                                    (backend client)
server/ app.py · requirements.txt · README.md
test-core.js   (node tab-studio/test-core.js — engine + regression tests)
```

`midi-io.js` is a self-contained Standard MIDI File reader **and writer**.
