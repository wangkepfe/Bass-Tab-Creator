# Studio — song → stem → MIDI → bass / piano-roll / drum tab

Turn a song into editable **MIDI** and render it as an **ergonomic bass tab**, a
**piano-roll**, or a **multi-lane drum grid**, with original/stem/synth playback.

It ships as **two things**:

| | What it is | Needs |
|---|---|---|
| 🌐 **Web app** | The offline **editor + bundled starter projects** — open a project, edit it, play it, save/open it as a local file, export MIDI/`.txt`. No AI, no accounts, no upload. | A browser |
| 🖥️ **Desktop app** | The **full local-GPU pipeline**: drop a song (or a YouTube link) → isolate a stem → transcribe to MIDI/drums → edit. Runs entirely on your machine. | Windows + Python + (ideally) an NVIDIA GPU |

> This replaced the earlier Cloudflare-Tunnel setup. There is **no public backend,
> no tunnel, and no auth token** any more — the AI runs locally in the desktop app,
> and the web app has no backend at all.

---

## 🌐 Web app (offline editor + library)

A static site — the full in-browser editor plus the bundled **starter projects**. It
has **no backend**: no transcription/AI, no save-to-server. You can open a starter
project (or **Open MIDI**), edit, play, **Save** it to a local `.studio.json` file,
re-open it later with **Open file**, and **Export MIDI / .txt**.

```bash
npm run build      # node build.js  ->  dist/   (config.js forced to mode: 'web')
npx serve dist     # or any static server; then open the printed URL
```

It deploys as Cloudflare **Workers static assets** (`wrangler.jsonc` → `./dist`;
build command `node build.js`). `dist/_headers` sets caching/security headers.

---

## 🖥️ Desktop app (local AI)

The full pipeline — **Demucs** (stem isolation) · Spotify **basic-pitch** (melodic
transcription) · **ADTOF** (neural drum transcription) · **yt-dlp** (YouTube) — runs
locally and serves the editor at `http://127.0.0.1:8000`. The Demucs model weights
are **bundled in the release**, so the end user doesn't download them at runtime.

**Run a packaged release** (in the `release/` folder or unzipped `studio-release.zip`):

1. Install the prerequisites if missing: **Python 3.10–3.12** (tick *Add to PATH*),
   **ffmpeg** (on PATH), and ideally an **NVIDIA GPU** (CUDA; CPU works but is slow).
2. Double-click **`setup.bat`** once — creates the venv and installs the deps
   (torch+CUDA, with a CPU fallback).
3. Double-click **`run.bat`** — starts the app on `127.0.0.1:8000` and opens your
   browser. Saved projects live in the release folder under `projects/`.

Nothing is uploaded anywhere; the server binds loopback only.

---

## 📦 Build a desktop release

From the **repo root**, with the dev backend venv set up (see *Dev* below):

```bat
release.bat
```

It assembles `release/` (backend without its venv, the web frontend pinned to
desktop mode, the `seed-projects/` starter projects, and the **pre-downloaded Demucs
weights** under `release/models/`), writes `setup.bat` + `run.bat` +
`README-RELEASE.txt`, and zips it to `studio-release.zip`. Ship either the folder or
the zip. (On first launch the starter projects are copied into the user's `projects/`.)

---

## 🛠️ Dev / run locally

The desktop backend, for development:

```bat
cd tab-studio\server
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\pip install basic-pitch --no-deps yt-dlp
```

Then run **`start-studio.bat`** (or `npm start`) and open <http://localhost:8000/>.
Served same-origin, the frontend defaults to **desktop** mode (full features).

`npm test` runs the bass-tab engine regressions (`node tab-studio/test-core.js`).

---

## Repo layout

```
build.js                 # builds the WEB app -> dist/  (mode='web')
wrangler.jsonc           # Cloudflare Workers static-assets config for dist/
release.bat              # builds the DESKTOP release -> release/ (+ .zip)
start-studio.bat         # dev launcher for the local backend
seed-projects/           # committed starter projects (seeded into projects/ on first run)
seed-sources/            # generation input: manifest.json + source MIDIs
tab-studio/
  web/                   # the frontend (config.js mode switch, app.js, …)
  server/app.py          # FastAPI backend: AI pipelines + local project store
  server/requirements.txt
  tools/build-seeds.js   # regenerates seed-projects/ from seed-sources/
```

The frontend is one codebase; `tab-studio/web/config.js` selects **`web`** (static,
no backend) vs **`desktop`** (full, local backend) mode.
