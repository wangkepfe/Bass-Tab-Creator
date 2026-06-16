# Studio — song → stem → MIDI → bass / piano-roll / drum tab

Drop in a song (YouTube link, audio file, or MIDI), isolate a stem, transcribe it
to MIDI, and edit it as a **piano roll**, an **ergonomic bass tab**, or a
**multi-lane drum grid** — all over one shared transport with original/stem/synth
A/B playback.

The heavy lifting (Demucs stem separation, Spotify **basic-pitch** transcription,
**ADTOF** neural drum transcription, **yt-dlp**) runs **locally on your GPU**. The
UI is a dependency-free static web app.

---

## Two ways to run

### 1. Local only (simplest)
Everything on one machine, same origin, no auth. This is the original workflow and
is unchanged.

```
cd bass-studio/server
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\pip install basic-pitch --no-deps yt-dlp
```
Then from the repo root run **`start-studio.bat`** (or
`cd bass-studio/server && .venv\Scripts\python -m uvicorn app:app --port 8000`) and
open <http://localhost:8000/>.

### 2. Hosted frontend + your local machine as the backend
Host the **static frontend on Cloudflare Pages** and keep the **GPU backend on your
own machine**, reached through a **Cloudflare Tunnel**. You get a public URL you can
open from anywhere (phone, laptop, a friend's browser) while all processing — and
all your saved projects — stay on your box.

```
            HTTPS                         outbound tunnel
Browser ───────────────▶ Cloudflare ───────────────────▶ cloudflared ──▶ FastAPI
(Pages: your-app          edge          (no open ports)    (localhost)   127.0.0.1:8000
 .pages.dev)                                                              Demucs/basic-pitch/
   │  fetch + <audio>  ────────────────────────────────────────────────▶ ADTOF/yt-dlp + GPU
   └─ Authorization: Bearer <token>  /  ?token=<token>
```

**Why a tunnel and not your home IP?** The Pages site is HTTPS, and browsers
hard-block an HTTPS page from calling a plain `http://<your-ip>:8000` (mixed
content) — there's no override. A Cloudflare Tunnel gives the backend a real HTTPS
hostname, needs no port-forwarding or firewall changes (the connection is
outbound-only), and works behind CGNAT / a dynamic IP.

---

## Setting up the hosted deployment

### A. Backend (your machine)

1. **Pick a secret token** (this is what authenticates your frontend to your
   backend). Generate one:
   ```
   python -c "import secrets; print(secrets.token_hex(32))"
   ```
2. **Set the two env vars, then start the backend.** In the *same* shell:
   ```bat
   set STUDIO_API_TOKEN=<the token from step 1>
   set STUDIO_ALLOWED_ORIGINS=https://<your-project>.pages.dev
   start-studio.bat
   ```
   - `STUDIO_API_TOKEN` — required on every `/api` call. Unset ⇒ auth disabled
     (local mode).
   - `STUDIO_ALLOWED_ORIGINS` — comma-separated **exact** origins allowed by CORS
     (your Pages URL, plus any custom domain). Never `*`.
3. **Start the tunnel** (install once with `winget install --id Cloudflare.cloudflared`):
   ```
   start-tunnel.bat
   ```
   It prints a URL like `https://random-words.trycloudflare.com`. **Copy it.**
   (This quick-tunnel URL changes every restart — see *Stable URL* below for a
   permanent one.)

### B. Frontend (Cloudflare Pages)

Connect this repo to a Cloudflare Pages project with:

| Setting | Value |
|---|---|
| Framework preset | **None** |
| Build command | `node build.js` |
| Build output directory | `dist` |
| Root directory | repo root |

Add these **environment variables** (Production *and* Preview):

| Variable | Value |
|---|---|
| `STUDIO_API_BASE` | the tunnel URL from step A3, e.g. `https://random-words.trycloudflare.com` |
| `STUDIO_TOKEN` | the **same** secret as the backend's `STUDIO_API_TOKEN` |

Deploy. `build.js` bakes `apiBase` + `token` into `dist/config.js`; the token lives
only in Pages' env and your backend's env — **never in the repo**.

> Each time the quick-tunnel URL changes, update `STUDIO_API_BASE` in Pages and
> re-deploy (or just rebuild locally with the new value). A named tunnel avoids
> this churn.

---

## Stable URL — a named tunnel (optional)

For a permanent `https://api.example.com` (needs a domain on Cloudflare):

```
cloudflared tunnel login
cloudflared tunnel create studio
cloudflared tunnel route dns studio api.example.com
```
Create `%USERPROFILE%\.cloudflared\config.yml`:
```yaml
tunnel: <TUNNEL-UUID>
credentials-file: C:\Users\<you>\.cloudflared\<TUNNEL-UUID>.json   # absolute path
ingress:
  - hostname: api.example.com
    service: http://localhost:8000
  - service: http_status:404            # required catch-all
```
Test with `cloudflared tunnel run studio`, then install it as a Windows service so
it survives reboots:
```
cloudflared service install
```
Set `STUDIO_API_BASE=https://api.example.com` in Pages **once**.

---

## Security notes

The backend is the app's **database** (saved projects, songs, stems) *and* runs
`yt-dlp` + native media decoders. Exposing it carelessly is exposing your machine.

> ⚠️ **Know what the token is and isn't.** `STUDIO_TOKEN` is baked into the public
> `config.js` that Cloudflare serves to *every* visitor — so it is **readable by
> anyone who opens your Pages URL**. It stops drive-by scanners that never load the
> page; it does **not** keep your backend private from someone who visits the site.
> For a personal tool that you're okay with "anyone who has the link can use my
> GPU," that's fine. To actually restrict access, put **Cloudflare Access** (Zero
> Trust) in front of the tunnel hostname so unauthenticated requests never reach
> your machine. Either way, generate a high-entropy token and rotate it.

This release adds the controls that make it safe to tunnel:

- **Token auth** on every `/api` route (`Authorization: Bearer`, or `?token=` for
  `<audio>`/download URLs which can't set headers). Off only when
  `STUDIO_API_TOKEN` is unset (local mode). Compared with `hmac.compare_digest`.
- **Exact-origin CORS** (`STUDIO_ALLOWED_ORIGINS`) — never `*`.
- **yt-dlp host allowlist** (`STUDIO_YT_HOSTS`, default YouTube) — closes the
  open-SSRF-proxy hole. Plus `--max-filesize`.
- **Upload size caps** (`STUDIO_MAX_UPLOAD_MB`, default 200) and **subprocess
  timeouts** on Demucs / yt-dlp.
- **Path-traversal containment** on both media endpoints.
- **127.0.0.1 bind kept** — cloudflared connects to loopback; never bind `0.0.0.0`.
- **Startup fail-safe** — the server **refuses to start** if `STUDIO_ALLOWED_ORIGINS`
  allows a non-loopback origin but `STUDIO_API_TOKEN` is empty (the open-door state),
  and warns if a token is set without any remote origin (which would CORS-block your
  Pages frontend — works in `curl`, fails in the browser).

---

## Lock it down with Cloudflare Access

The embedded token **cannot** be kept secret in a public SPA, so it only deters
scanners. To actually limit *who* can use your backend, put **Cloudflare Access**
(Zero Trust, free tier) in front — it authenticates requests at Cloudflare's edge,
so unauthenticated traffic never reaches your machine.

**Prerequisite:** a **named tunnel on a domain in your Cloudflare account** (the
random `trycloudflare.com` URL can't carry an Access policy). See *Stable URL* above.

### Recommended: same-origin (serve the whole app through the tunnel)

The cleanest setup is to **not** use Pages and instead serve the UI *and* API from
the one tunnel hostname. The backend already serves the editor at `/`, so this works
out of the box and sidesteps every cross-origin cookie/CORS headache.

1. Point the tunnel at `localhost:8000` (serves both `/` and `/api`):
   ```yaml
   # %USERPROFILE%\.cloudflared\config.yml
   tunnel: <UUID>
   credentials-file: C:\Users\WK\.cloudflared\<UUID>.json
   ingress:
     - hostname: studio.example.com
       service: http://localhost:8000
     - service: http_status:404
   ```
   `cloudflared tunnel route dns <name> studio.example.com` and run it. Now the app
   is `https://studio.example.com`. **Leave `STUDIO_API_TOKEN` and
   `STUDIO_ALLOWED_ORIGINS` unset** — same-origin + Access is the gate.
2. Open **one.dash.cloudflare.com** → on first use pick a team name
   (`<team>.cloudflareaccess.com`) and the **Free** plan.
3. **Access → Applications → Add an application → Self-hosted.**
   - Application domain: `studio.example.com`. Session duration: e.g. 24h.
4. **Add a policy:** Action **Allow**; Include → **Emails** → your email (add any
   others you want to let in).
5. **Authentication:** the built-in **One-time PIN** needs no identity provider —
   Access emails a login code. (Or wire up Google/GitHub.)
6. Save. Now every visitor must pass Access before reaching your machine, and the
   session cookie covers the UI, the API, *and* `<audio>`/downloads automatically
   (same-origin) — no CORS, no public token.
7. *(Optional, defense-in-depth)* Validate the Access JWT in FastAPI: each request
   carries `Cf-Access-Jwt-Assertion`; verify it against
   `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` so a leaked tunnel URL
   alone can't get in.

### Keeping the Pages frontend (cross-origin) with Access

Doable but fiddlier — the browser must already hold an Access cookie for the API
host: (a) put Access on `api.example.com`; (b) switch the frontend fetches to
`credentials:'include'`; (c) in the Access app's **CORS settings** allow the Pages
origin with **Allow-Credentials** *and* enable **"Bypass OPTIONS requests to
origin"** (cookies aren't sent on preflight); (d) the user visits `api.example.com`
once to log in. The same-origin route above avoids all of this.

---

## Asset library

`assets/manifest.json` lists bundled **example tabs** (MIDI). `build.js` copies the
MIDI/JSON into `dist/assets/` and they appear under **📁 Library → examples** —
served same-origin from Pages, so they load with **no backend and no token**, even
when your machine is off. Audio files in `assets/` are skipped by the build by
default (keeps the deploy lean / avoids publishing source media); override with
`STUDIO_ASSET_EXTS`.

---

## Project layout

```
build.js                 # assembles dist/ for Cloudflare Pages (zero deps)
start-studio.bat         # run the local FastAPI backend (loopback)
start-tunnel.bat         # expose it via a Cloudflare quick tunnel
assets/                  # static asset library (manifest.json + example MIDIs)
bass-studio/
  web/                   # the static frontend (config.js, app.js, …)
  server/app.py          # FastAPI backend: pipelines + projects API + auth
  server/requirements.txt
```

Run `npm test` (`node bass-studio/test-core.js`) for the bass-tab engine
regressions.
