# Bass Studio backend

FastAPI service that runs **Demucs v4** (bass isolation) and **Spotify basic-pitch**
(audio→MIDI) locally, and serves the editor + the Bass Tab Creator from one origin.

## Prerequisites

- **Python 3.10 or 3.11**
- **ffmpeg** on your `PATH` — required to decode `mp3` / `m4a` (Demucs/torchaudio).
  - Windows: `winget install Gyan.FFmpeg` (or `choco install ffmpeg`)
  - macOS: `brew install ffmpeg`  ·  Debian/Ubuntu: `sudo apt install ffmpeg`
- *(optional)* an NVIDIA GPU for much faster separation.

## Install (three steps)

`basic-pitch` hard-pins an old TensorFlow that has no Python-3.12 wheel, and we
don't need TensorFlow anyway (it ships an ONNX model), so it's installed last with
`--no-deps`. From `tab-studio/server`:

```bash
python -m venv .venv
# Windows:  .venv\Scripts\activate     macOS/Linux:  source .venv/bin/activate

# 1) PyTorch for Demucs.  GPU (NVIDIA, big speed-up):
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124
#    CPU-only fallback:   pip install torch torchaudio

# 2) the rest of the stack:
pip install -r requirements.txt

# 3) basic-pitch without its TensorFlow dependency (uses the bundled ONNX model):
pip install basic-pitch --no-deps

# 4) YouTube ingest:
pip install yt-dlp
```

Verify the GPU is seen: `python -c "import torch; print(torch.cuda.is_available())"` → `True`.

> First run of each Demucs model downloads its weights (`htdemucs` ~80 MB,
> `htdemucs_6s` larger) into your torch hub cache. basic-pitch's model ships with the package.

## Run

Use the venv's Python so the Demucs subprocess uses the GPU build:

```bash
# Windows:
.venv\Scripts\python -m uvicorn app:app --port 8000
# macOS/Linux (after `source .venv/bin/activate`):
uvicorn app:app --port 8000
```
then open **http://localhost:8000/** — the single unified Studio app. (`/studio` and
`/drums` redirect here for old bookmarks.) The `web/` folder is served at the root.
The project library lives in the committed `projects/` folder, which the backend
reads and writes in place (no first-run copy) — edits persist there and ship with the
web build.

## API

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET  | `/api/health` | `{ok, demucs, basic_pitch, adtlib, yt_dlp, device}` |
| POST | `/api/youtube` | form `url` → `{job_id}`; artifact `song.mp3` (+ `title`) |
| POST | `/api/jobs` | multipart `file`, `pipeline` (`song-to-midi`\|`separate`\|`transcribe`\|`song-to-drums`\|`drum-transcribe`), `stem` (`bass`\|`piano`\|`guitar`\|`vocals`\|`drums`\|`other`), `model`, `min_freq`, `max_freq`, `min_note_len`, `onset_threshold`, `frame_threshold`, `shifts` → `{job_id}` |
| GET  | `/api/jobs/{id}` | `{status, stage, progress, elapsed, error, title, artifacts}` |
| GET  | `/api/jobs/{id}/artifacts/{name}` | `song.mp3` · `stem.wav` · `notes.mid` · `drums.json` · `drums.mid` |
| GET  | `/api/projects` | list saved projects `{id, name, updated, instruments, hasSong, youtubeUrl}` |
| POST | `/api/projects` | form `name` → `{id, project}` (creates the folder) |
| GET / PUT / DELETE | `/api/projects/{id}` | read / save (`project.json` body) / delete a project |
| POST | `/api/projects/{id}/audio` | multipart `file`, `role` (`song`\|`stem`), `instrument` → `{file}` |
| GET  | `/api/projects/{id}/audio/{name}` | serve a project's stored song / stem audio |

Projects are the app's "database": each lives in a git-ignored `projects/<id>/` folder
(`project.json` + `song.<ext>` + `stems/<inst>.<ext>`).

`stem=piano` or `guitar` automatically uses the 6-source model `htdemucs_6s` (first
run downloads its weights separately). Other stems use `htdemucs` (or `htdemucs_ft`).

Jobs run on a background thread; artifacts live in a temp folder
(`<tmp>/tab-studio-jobs/<id>/`). Audio never leaves your machine.

## Notes

- The transcription range is set per target by the frontend (bass ≈ 30–400 Hz;
  piano = full range). Override via the `min_freq` / `max_freq` / `min_note_len` form
  fields (empty = no limit).
- `htdemucs` is fast; `htdemucs_ft` gives the best 4-stem SDR but is ~4× slower;
  `htdemucs_6s` is required for piano/guitar.
- The server is single-user and unauthenticated — run it locally, not exposed.
