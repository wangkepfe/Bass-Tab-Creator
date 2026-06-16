/* ============================================================================
 * config.js — runtime backend configuration. Loaded FIRST (before every other
 * script) so window.STUDIO_CONFIG is fully populated before app.js / workflow.js
 * run.
 *
 *   apiBase  the ORIGIN of the backend (no trailing /api). '' = same-origin,
 *            which is the local-dev case where FastAPI serves this page itself.
 *            For the Cloudflare deployment this is your Cloudflare Tunnel host,
 *            e.g. 'https://api.example.com' or 'https://<name>.trycloudflare.com'.
 *   token    the shared secret that matches the backend's STUDIO_API_TOKEN.
 *            Sent as 'Authorization: Bearer <token>' on fetches and '?token=' on
 *            <audio>/download URLs (media elements can't set headers).
 *
 * The Cloudflare Pages build (build.js) OVERWRITES this file in dist/, baking
 * apiBase + token in from the Pages environment variables — so the committed
 * copy below stays empty (same-origin, no auth) and never carries a real token.
 * ========================================================================== */
(function () {
  'use strict';
  function normBase(b) {
    if (!b) return '';                                  // '' => same-origin '/api'
    b = String(b).trim().replace(/\/+$/, '');           // strip trailing slash(es)
    b = b.replace(/\/api$/i, '');                        // tolerate a base given with /api
    // Mixed-content guard: an https Pages page cannot call an http origin. Force
    // https for everything except loopback (a secure context even over http).
    if (/^http:\/\/(?!localhost|127\.0\.0\.1)/i.test(b)) b = b.replace(/^http:/i, 'https:');
    return b;
  }
  var cfg = window.STUDIO_CONFIG || {};
  cfg.apiBase = normBase(cfg.apiBase || '');
  cfg.token = (cfg.token || '').trim();
  // Probe candidates: the configured base first. Localhost fallbacks only when no
  // base is set (local dev) — from a hosted frontend they'd just add CORS noise.
  cfg.apiCandidates = (cfg.apiCandidates && cfg.apiCandidates.length)
    ? cfg.apiCandidates.map(normBase)
    : (cfg.apiBase ? [cfg.apiBase] : ['', 'http://localhost:8000', 'http://127.0.0.1:8000']);
  window.STUDIO_CONFIG = cfg;
})();
