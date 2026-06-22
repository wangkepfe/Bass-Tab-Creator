/* ============================================================================
 * build.js — assemble dist/ for the WEB build (Cloudflare Workers static assets
 * or Pages). Node >= 18, zero dependencies.
 *
 * The web build is the OFFLINE editor + the bundled project library: full in-browser
 * editor, no backend (no AI; the bundled projects open read-only and edits are kept
 * via "Save file" — a downloaded .studio.json). It is the desktop app's frontend with
 * config.js forced to mode='web'.
 *
 *   dist/
 *     <web app files>     <- copied from tab-studio/web/
 *     config.js           <- generated: window.STUDIO_CONFIG = { mode: 'web' }
 *     projects/           <- the project-library bundle (see below)
 *       index.json        <-   the library list (same shape as GET /api/projects)
 *       <id>.json         <-   each project (full project.json)
 *     _headers
 *
 * The library is bundled from the committed projects/ folder — the SAME folder the
 * desktop backend reads and writes in place, so an edit made on desktop is exactly
 * what the web build ships.
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'dist');
const WEB = path.join(ROOT, 'tab-studio', 'web');
const PROJECTS = path.join(ROOT, 'projects');

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

// 2. project-library bundle — the web build has no backend, so it ships the committed
//    projects/ folder as a static read-only library: projects/<id>.json (full project)
//    + projects/index.json (same shape as GET /api/projects). Only each project.json is
//    read; the per-project audio (stems/, song.*) is left out of the web build.
let projectCount = 0;
if (fs.existsSync(PROJECTS)) {
  const outLib = path.join(OUT, 'projects');
  fs.mkdirSync(outLib, { recursive: true });
  const index = [];
  for (const e of fs.readdirSync(PROJECTS, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const pj = path.join(PROJECTS, e.name, 'project.json');
    if (!fs.existsSync(pj)) continue;
    const meta = JSON.parse(fs.readFileSync(pj, 'utf8'));
    const id = meta.id || e.name;
    fs.copyFileSync(pj, path.join(outLib, id + '.json'));
    const tracks = meta.tracks || [];
    index.push({
      id: id, name: meta.name || id, updated: meta.updated || 0,
      youtubeUrl: meta.youtubeUrl || '', hasSong: !!meta.song,
      instruments: tracks.map(t => t.instrument), trackCount: tracks.length,
    });
  }
  index.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  fs.writeFileSync(path.join(outLib, 'index.json'), JSON.stringify({ projects: index }));
  projectCount = index.length;
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
/projects/*
  Cache-Control: no-cache
`);
// No _redirects file: a `/* /index.html 200` SPA rule is rejected by Cloudflare
// Workers static assets as an "infinite loop". Unknown-path handling is done via
// not_found_handling in wrangler.jsonc (Workers); a single-page app needs nothing
// extra on Pages.

console.log('Built dist/  mode=web  projects=' + projectCount);
