/* ============================================================================
 * tempo-core.js  —  auto-detect tempo (BPM) and bar-grid alignment from a bare
 * set of note / drum-hit onsets. DOM-free; runs in the browser and in Node.
 *
 * Why this exists:  a transcription arrives as raw onsets (drum hits in seconds,
 * MIDI notes in ticks) with no reliable tempo and no idea where bar 1 begins.
 * The drum tab draws its bar grid straight from { tempo, gridOffset }, and the
 * melodic tabs shift their bar lines by an offset — so both need those two
 * numbers to lay the music out in correct, readable bars. This module recovers
 * them so the editor can present a tab that lines up out of the box.
 *
 *   TempoCore.detectTempo(onsets, opts)        -> { bpm, confidence, periodSec }
 *   TempoCore.detectGridOffset(onsets, opts)   -> { offsetSec, beatPhaseSec, ... }
 *   TempoCore.analyze(onsets, opts)            -> { bpm, offsetSec, confidence, ... }
 *   TempoCore.detectBarOffsetTicks(starts, o)  -> { offsetTicks, confidence }
 *
 * `onsets` is an array of times (seconds for the drum/seconds API, MIDI ticks
 * for the melodic helper). Each entry may be a plain number or an object
 * { t, w } / { time_sec, velocity } where the weight pulls the grid harder
 * (heavier hits / accents matter more).
 *
 * Method:
 *   • Tempo  — autocorrelation of a weighted onset envelope over the lag range
 *     spanning [minBpm, maxBpm], scored against a log-normal tempo prior centred
 *     on ~120 BPM to fold the octave (half / double) ambiguity, then parabolically
 *     interpolated for sub-bin precision. (The same shape librosa's tempo estimator
 *     uses.) Sparse inputs (< 8 onsets) report low confidence so callers can defer.
 *   • Phase  — the weighted circular mean of every onset's position within one
 *     beat gives the beat offset exactly, with no search; the bar offset (which
 *     beat is "1") is the beat class carrying the most onset weight — i.e. the
 *     downbeat, where the kick tends to land.
 * ========================================================================== */
var TempoCore = (function () {
  'use strict';

  // ---- input normalisation -------------------------------------------------
  // -> [{ t, w }] sorted ascending; non-finite times dropped, bad weights -> 1.
  function norm(onsets) {
    var out = [];
    for (var i = 0; i < (onsets ? onsets.length : 0); i++) {
      var o = onsets[i];
      var t = (typeof o === 'number') ? o : (o && (o.t != null ? o.t : o.time_sec));
      var w = (typeof o === 'number') ? 1 : (o && (o.w != null ? o.w : (o.velocity != null ? o.velocity / 100 : 1)));
      if (t == null || !isFinite(t)) continue;
      if (!isFinite(w) || w <= 0) w = 1;
      out.push({ t: t, w: w });
    }
    out.sort(function (a, b) { return a.t - b.t; });
    return out;
  }

  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

  // ===========================================================================
  // TEMPO  (autocorrelation of an onset envelope + log-normal octave prior)
  // ===========================================================================
  function detectTempo(onsets, opts) {
    opts = opts || {};
    var pts = norm(onsets);
    var fallback = opts.fallbackBpm || 120;
    var fail = { bpm: fallback, confidence: 0, periodSec: 60 / fallback };
    if (pts.length < 4) return fail;

    var minBpm    = opts.minBpm || 50;
    var maxBpm    = opts.maxBpm || 210;
    var preferBpm = opts.preferBpm || 120;
    var sigma     = opts.priorSigma || 0.9;      // prior width, in octaves (log2)
    var dt        = opts.dt || 0.005;            // envelope bin = 5 ms (≈1 BPM resolution)

    var t0 = pts[0].t, span = pts[pts.length - 1].t - t0;
    if (!(span > 0)) return fail;

    // weighted onset envelope, one bin per dt, with a 1-bin triangular spread so
    // a near-miss still correlates with the grid.
    var n = Math.floor(span / dt) + 1;
    var MAXN = 300000;                            // cap work on very long inputs
    if (n > MAXN) { dt = span / (MAXN - 1); n = MAXN; }
    var env = new Float64Array(n);
    for (var i = 0; i < pts.length; i++) {
      var x = (pts[i].t - t0) / dt, b = Math.floor(x), f = x - b, w = pts[i].w;
      if (b >= 0 && b < n) env[b] += w * (1 - f);
      if (b + 1 < n)       env[b + 1] += w * f;
    }

    var lagMin = Math.max(1, Math.round((60 / maxBpm) / dt));
    var lagMax = Math.min(n - 1, Math.round((60 / minBpm) / dt));
    if (lagMax <= lagMin) return fail;

    // autocorrelation over the candidate beat periods, each weighted by the
    // octave prior; keep the values for a parabolic refine.
    var ac = new Float64Array(lagMax + 1);
    var bestLag = -1, bestScore = -Infinity, acAtBest = 0, acSum = 0, acCnt = 0;
    for (var lag = lagMin; lag <= lagMax; lag++) {
      var s = 0;
      for (var j = 0; j + lag < n; j++) s += env[j] * env[j + lag];
      // Biased estimator (÷ n, a constant) — NOT the unbiased ÷(n−lag). For a
      // dense whole-track signal the two are identical (lagMax ≪ n), but ÷(n−lag)
      // divides a long lag by a tiny overlap count on SHORT inputs, inflating it
      // enough to beat the octave prior and report half the true tempo (sparse
      // 4–7-onset clips). ÷ n leaves long lags mildly suppressed, which is safe.
      s /= n;
      ac[lag] = s; acSum += s; acCnt++;
      var bpm = 60 / (lag * dt);
      var lr = Math.log(bpm / preferBpm) / Math.LN2;
      var prior = Math.exp(-0.5 * (lr / sigma) * (lr / sigma));
      var score = s * prior;
      if (score > bestScore) { bestScore = score; bestLag = lag; acAtBest = s; }
    }
    if (bestLag < 0) return fail;

    // parabolic interpolation around the peak for sub-bin (sub-10 ms) precision.
    var lagRef = bestLag;
    if (bestLag > lagMin && bestLag < lagMax) {
      var a = ac[bestLag - 1], c = ac[bestLag + 1], denom = a - 2 * acAtBest + c;
      if (denom !== 0) { var d = 0.5 * (a - c) / denom; if (d > -1 && d < 1) lagRef = bestLag + d; }
    }
    var periodSec = lagRef * dt, finalBpm = 60 / periodSec;
    var mean = acCnt ? acSum / acCnt : 0;
    var confidence = (acAtBest + mean > 0) ? clamp01((acAtBest - mean) / (acAtBest + mean)) : 0;
    // Autocorrelation tempo from only a handful of onsets is inherently shaky —
    // one unlucky jitter pattern can still slip an octave. Flag that as
    // low-confidence so callers defer to a known prior (the file / backend tempo)
    // rather than trusting a guess. Real tracks carry hundreds of onsets.
    if (pts.length < 8) confidence = Math.min(confidence, 0.2);
    return { bpm: Math.round(finalBpm * 10) / 10, confidence: confidence, periodSec: periodSec };
  }

  // ===========================================================================
  // GRID ALIGNMENT  (unit-agnostic: works in seconds OR ticks)
  // ===========================================================================
  // pts: [{t, w}], period: one beat (same unit as t), groups: beats per bar.
  // Returns the beat phase, the bar origin (time of a downbeat, folded into one
  // bar) and a 0..1 confidence built from the phase coherence × downbeat lift.
  function alignGrid(pts, period, groups) {
    var dud = { phase: 0, barOrigin: 0, confidence: 0, downbeatClass: 0 };
    if (!pts.length || !(period > 0)) return dud;
    groups = Math.max(1, Math.round(groups || 1));

    // beat phase = weighted circular mean of each onset's position within a beat.
    var C = 0, S = 0, wsum = 0, i;
    for (i = 0; i < pts.length; i++) {
      var th = 2 * Math.PI * (pts[i].t / period);
      C += pts[i].w * Math.cos(th); S += pts[i].w * Math.sin(th); wsum += pts[i].w;
    }
    if (!(wsum > 0)) return dud;
    // beat phase as the representative NEAREST 0 (in (-period/2, period/2]) — a
    // small ± nudge. Folding into [0, period) instead would wrap a phase of 0⁻
    // up to ≈ one whole beat, throwing the grid off by a beat.
    var ang = Math.atan2(S, C);                               // (-π, π]
    var phase = ang / (2 * Math.PI) * period;                 // (-period/2, period/2]
    var R = clamp01(Math.sqrt(C * C + S * S) / wsum);         // phase coherence 0..1

    // downbeat = the beat class (mod groups) carrying the most onset weight…
    var classW = new Float64Array(groups);
    for (i = 0; i < pts.length; i++) {
      var nb = Math.round((pts[i].t - phase) / period);
      classW[(((nb % groups) + groups) % groups)] += pts[i].w;
    }
    // …with a start-anchor tiebreaker: a song almost always begins on its
    // downbeat, so nudge the count toward the FIRST onset's beat class. The
    // nudge (5% of total weight) breaks the half-bar symmetry of a plain rock
    // beat (kick on 1 & 3) without overriding a genuine kick-on-1 asymmetry.
    var f0 = Math.round((pts[0].t - phase) / period);
    var firstClass = (((f0 % groups) + groups) % groups);
    var totW = 0; for (var t1 = 0; t1 < groups; t1++) totW += classW[t1];
    var best = 0, bestS = -Infinity, bestW = 0;
    for (var c = 0; c < groups; c++) {
      var sc = classW[c] + (c === firstClass ? 0.05 * totW : 0);
      if (sc > bestS) { bestS = sc; best = c; bestW = classW[c]; }
    }
    var barLen = period * groups;
    // a downbeat time, folded to the representative nearest 0 (the grid is
    // periodic, so any representative draws the same bars — small reads cleaner).
    var origin = phase + best * period;
    origin = origin - barLen * Math.round(origin / barLen);
    var even = 1 / groups;
    var lift = (groups > 1 && totW > 0) ? clamp01((bestW / totW - even) / (1 - even)) : 0;
    var confidence = clamp01(R * (0.5 + 0.5 * lift));
    return { phase: phase, barOrigin: origin, confidence: confidence, downbeatClass: best };
  }

  // Bar-grid offset in SECONDS (drum tab): time, within one bar, of a downbeat.
  function detectGridOffset(onsets, opts) {
    opts = opts || {};
    var pts = norm(onsets);
    var tsNum = opts.tsNum || 4;
    var bpm = opts.bpm || detectTempo(onsets, opts).bpm;
    var beat = 60 / bpm;
    if (pts.length < 3 || !(beat > 0)) return { offsetSec: 0, beatPhaseSec: 0, confidence: 0, bpm: bpm, downbeatClass: 0 };
    var a = alignGrid(pts, beat, tsNum);
    return { offsetSec: a.barOrigin, beatPhaseSec: a.phase, confidence: a.confidence, bpm: bpm, downbeatClass: a.downbeatClass };
  }

  // Tempo + bar-grid offset in one pass (drum tab).
  function analyze(onsets, opts) {
    opts = opts || {};
    var t = detectTempo(onsets, opts);
    var g = detectGridOffset(onsets, { tsNum: opts.tsNum, bpm: t.bpm });
    return {
      bpm: t.bpm, periodSec: t.periodSec, offsetSec: g.offsetSec, beatPhaseSec: g.beatPhaseSec,
      tempoConfidence: t.confidence, offsetConfidence: g.confidence,
      confidence: Math.min(t.confidence, g.confidence), downbeatClass: g.downbeatClass
    };
  }

  // ===========================================================================
  // MELODIC BAR OFFSET  (in MIDI ticks)
  // ===========================================================================
  // Find the time-shift (ticks) that lands the detected downbeat on a bar line.
  // The melodic tabs nudge notes by +offsetTicks against a fixed grid at tick 0,
  // so we return the smaller-magnitude shift that pulls a downbeat onto a barline.
  // (Only meaningful when the notes carry a real tempo — i.e. an imported MIDI.)
  function detectBarOffsetTicks(starts, opts) {
    opts = opts || {};
    var ppq = opts.ppq || 480, tsNum = opts.tsNum || 4, den = opts.den || 4;
    var beat = ppq;                                  // a quarter note
    var barTicks = ppq * 4 * tsNum / den;
    var groups = Math.max(1, Math.round(barTicks / beat));
    var pts = norm(starts);
    if (pts.length < 3 || !(barTicks > 0)) return { offsetTicks: 0, confidence: 0, barOrigin: 0 };
    var a = alignGrid(pts, beat, groups);
    // alignGrid already folds barOrigin to nearest 0, so −barOrigin is the
    // smallest shift that lands the downbeat on a bar line. It can be negative;
    // the caller flips it to the equivalent rightward shift when a leftward move
    // would push notes before tick 0.
    return { offsetTicks: Math.round(-a.barOrigin), confidence: a.confidence, barOrigin: a.barOrigin };
  }

  var api = {
    detectTempo: detectTempo,
    detectGridOffset: detectGridOffset,
    detectBarOffsetTicks: detectBarOffsetTicks,
    analyze: analyze,
    alignGrid: alignGrid,
    norm: norm
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
