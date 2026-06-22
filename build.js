/* ============================================================================
 * build.js — assemble dist/ for the WEB build (Cloudflare Workers static assets
 * or Pages). Node >= 18, zero dependencies.
 *
 * The web build is the OFFLINE editor + bundled starter projects: full in-browser
 * editor, no backend (no AI; projects persist as local .studio.json files). It is
 * the desktop app's frontend with config.js forced to mode='web'.
 *
 *   dist/
 *     <web app files>     <- copied from tab-studio/web/
 *     config.js           <- generated: window.STUDIO_CONFIG = { mode: 'web' }
 *     seed/               <- the starter-project bundle (see below)
 *       index.json        <-   the library list (same shape as GET /api/projects)
 *       <id>.json         <-   each starter project (full project.json)
 *     _headers
 *
 * Starter projects: the web build has no backend, so its library is the static
 * seed bundle generated from seed-projects/ (run tools/build-seeds.js to refresh
 * those from their source MIDIs). The app opens them read-only and the user keeps
 * edits via "Save file" (a downloaded .studio.json).
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'dist');
const WEB = path.join(ROOT, 'tab-studio', 'web');
const SEEDS = path.join(ROOT, 'seed-projects');

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

// 2. starter-project bundle — the web build's library reads this static "seed"
//    folder (it has no backend). Emits seed/<id>.json (full project) + a
//    seed/index.json summary list with the SAME shape as GET /api/projects.
let seedCount = 0;
if (fs.existsSync(SEEDS)) {
  const outSeed = path.join(OUT, 'seed');
  fs.mkdirSync(outSeed, { recursive: true });
  const index = [];
  for (const e of fs.readdirSync(SEEDS, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const pj = path.join(SEEDS, e.name, 'project.json');
    if (!fs.existsSync(pj)) continue;
    const meta = JSON.parse(fs.readFileSync(pj, 'utf8'));
    const id = meta.id || e.name;
    fs.copyFileSync(pj, path.join(outSeed, id + '.json'));
    const tracks = meta.tracks || [];
    index.push({
      id: id, name: meta.name || id, updated: meta.updated || 0,
      youtubeUrl: meta.youtubeUrl || '', hasSong: !!meta.song,
      instruments: tracks.map(t => t.instrument), trackCount: tracks.length,
    });
  }
  index.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  fs.writeFileSync(path.join(outSeed, 'index.json'), JSON.stringify({ projects: index }));
  seedCount = index.length;
}

// 3. config.js — force web mode (overwrites the committed mode='desktop' default).
fs.writeFileSync(path.join(OUT, 'config.js'),
  'window.STUDIO_CONFIG = { mode: "web" };\n' +
  fs.readFileSync(path.join(WEB, 'config.js'), 'utf8'));

// 4. _headers (security + asset caching). Honored by both Pages and Workers static assets.
fs.writeFileSync(path.join(OUT, '_headers'),
`/*
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Cache-Control: no-cache
/config.js
  Cache-Control: no-store
/seed/*
  Cache-Control: no-cache
`);
// No _redirects file: a `/* /index.html 200` SPA rule is rejected by Cloudflare
// Workers static assets as an "infinite loop". Unknown-path handling is done via
// not_found_handling in wrangler.jsonc (Workers); a single-page app needs nothing
// extra on Pages.

console.log('Built dist/  mode=web  seedProjects=' + seedCount);
