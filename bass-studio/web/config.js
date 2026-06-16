/* ============================================================================
 * config.js — runtime app mode. Loaded FIRST, before every other script.
 *
 *   mode 'desktop'  full app, served by the local FastAPI backend: the AI
 *                   pipeline (Demucs / basic-pitch / ADTOF / yt-dlp), plus save
 *                   and the on-disk project library.
 *   mode 'web'      the static web build — the offline editor + the bundled
 *                   asset library only. No backend: no AI, no save, no project
 *                   library. build.js sets this when assembling dist/.
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
