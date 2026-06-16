/* ============================================================================
 * build.js — assemble dist/ for Cloudflare Pages OR Workers static assets.
 * Node >= 18, zero dependencies.
 *
 *   dist/                 <- published (Pages output dir, or Workers assets.directory)
 *     <web app files>     <- copied from bass-studio/web/
 *     config.js           <- generated: bakes in STUDIO_API_BASE + STUDIO_TOKEN
 *     assets/             <- the static "asset library" (MIDI/JSON only; see below)
 *     _headers
 *
 * The backend (your local machine behind a Cloudflare Tunnel) is configured via
 * build-time environment variables, NOT committed into the repo:
 *   STUDIO_API_BASE   the tunnel ORIGIN, e.g. https://api.example.com
 *                     (no trailing /api). Empty => same-origin (local serving).
 *   STUDIO_TOKEN      the shared secret matching the backend's STUDIO_API_TOKEN.
 *
 * Asset library: only MIDI/JSON ship to Pages (audio is skipped to keep the
 * deploy lean and avoid publishing large/source media). Override with
 *   STUDIO_ASSET_EXTS=".mid,.midi,.json,.mp3"
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'dist');
const WEB = path.join(ROOT, 'bass-studio', 'web');
const ASSETS = path.join(ROOT, 'assets');

const ASSET_EXTS = (process.env.STUDIO_ASSET_EXTS || '.mid,.midi,.json')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

function copyDir(src, dst, filter) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d, filter);
    else if (!filter || filter(e.name)) fs.copyFileSync(s, d);
  }
}

// 1. fresh dist/ + the web app
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
copyDir(WEB, OUT);

// 2. asset library (MIDI/JSON by default — never the big/source audio)
if (fs.existsSync(ASSETS)) {
  copyDir(ASSETS, path.join(OUT, 'assets'),
    name => ASSET_EXTS.includes(path.extname(name).toLowerCase()));
}

// 3. config.js — pre-seed window.STUDIO_CONFIG, then reuse web/config.js's
//    normalization so the mixed-content/base-cleanup logic lives in one place.
const apiBase = (process.env.STUDIO_API_BASE || '').replace(/\/+$/, '');
const token = process.env.STUDIO_TOKEN || '';
const seed = 'window.STUDIO_CONFIG = ' + JSON.stringify({ apiBase, token }) + ';\n';
fs.writeFileSync(path.join(OUT, 'config.js'),
  seed + fs.readFileSync(path.join(WEB, 'config.js'), 'utf8'));

// 4. _headers (security + asset caching). Honored by both Pages and Workers static
//    assets. NOTE: CORS is enforced by the FastAPI backend on the tunnel origin.
fs.writeFileSync(path.join(OUT, '_headers'),
`/*
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
/config.js
  Cache-Control: no-store
/assets/*
  Cache-Control: public, max-age=31536000, immutable
`);
// No _redirects file: a `/* /index.html 200` SPA rule is rejected by Cloudflare
// Workers static assets as an "infinite loop". Unknown-path handling is done via
// not_found_handling in wrangler.jsonc (Workers); a single-page app needs nothing
// extra on Pages.

console.log('Built dist/  apiBase=' + (apiBase || '(same-origin)') +
  '  token=' + (token ? '(set)' : '(none)') + '  assetExts=' + ASSET_EXTS.join(','));
