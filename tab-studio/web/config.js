/* ============================================================================
 * config.js — runtime app mode. Loaded FIRST, before every other script.
 *
 *   mode 'desktop'  full app, served by the local FastAPI backend: the AI
 *                   pipeline (Demucs / basic-pitch / ADTOF / yt-dlp), plus the
 *                   on-disk project library (the committed projects/ folder) with
 *                   auto-save — edits persist in place and ship with the web build.
 *   mode 'web'      the static web build — the offline editor with the bundled
 *                   project library (read-only here, editable once opened). No
 *                   backend AI; edits persist as local .studio.json files the
 *                   user saves/opens. build.js sets this when assembling dist/.
 *
 * The committed default is 'desktop', so local dev and the packaged desktop app
 * get the full experience with no extra config.
 * ========================================================================== */
(function () {
  'use strict';
  var cfg = window.STUDIO_CONFIG || {};
  cfg.mode = (cfg.mode === 'web') ? 'web' : 'desktop';
  window.STUDIO_CONFIG = cfg;
})();
