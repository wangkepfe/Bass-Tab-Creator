/* ============================================================================
 * chord-core.js  —  guitar chord engine (TAB TYPE 1).
 *
 *   • detect()      — beat-level chord recognition from MIDI notes (chroma +
 *                     template matching), merged into chord segments.
 *   • shapeFor()    — a playable guitar chord-diagram shape (open chords table +
 *                     movable E/A-shape barre derivation) for a root+quality.
 *
 * Pure, dependency-free, works in the browser. The audio-based madmom path
 * (see research/GUITAR_DOSSIER.md) can later replace detect() by supplying
 * segments in the same {startTick,endTick,label,root,quality} shape.
 * ========================================================================== */
var ChordCore = (function () {
  'use strict';

  var NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  // chord-quality templates: pitch classes relative to the root.
  // Order matters — earlier = preferred on ties (simpler chords first).
  var QUAL = [
    { q: 'maj',  pcs: [0, 4, 7],        suffix: '' },
    { q: 'min',  pcs: [0, 3, 7],        suffix: 'm' },
    { q: '7',    pcs: [0, 4, 7, 10],    suffix: '7' },
    { q: 'm7',   pcs: [0, 3, 7, 10],    suffix: 'm7' },
    { q: 'maj7', pcs: [0, 4, 7, 11],    suffix: 'maj7' },
    { q: 'sus4', pcs: [0, 5, 7],        suffix: 'sus4' },
    { q: 'sus2', pcs: [0, 2, 7],        suffix: 'sus2' },
    { q: 'dim',  pcs: [0, 3, 6],        suffix: 'dim' },
    { q: 'aug',  pcs: [0, 4, 8],        suffix: 'aug' },
    { q: 'm7b5', pcs: [0, 3, 6, 10],    suffix: 'm7b5' },
    { q: '6',    pcs: [0, 4, 7, 9],     suffix: '6' },
    { q: 'm6',   pcs: [0, 3, 7, 9],     suffix: 'm6' }
  ];

  function label(root, quality) {
    var qd = QUAL.filter(function (x) { return x.q === quality; })[0];
    return NAMES[((root % 12) + 12) % 12] + (qd ? qd.suffix : '');
  }

  // Score a 12-bin chroma against each (root,quality); return the best match or null.
  // score = (in-template weight) - penalty*(out-of-template weight) - size*(template size).
  function matchChroma(chroma, opts) {
    opts = opts || {};
    var total = 0; for (var i = 0; i < 12; i++) total += chroma[i];
    if (total < 1e-6) return null;
    var penalty = opts.penalty != null ? opts.penalty : 0.55;
    var sizeBias = opts.sizeBias != null ? opts.sizeBias : 0.02;
    var best = null, bestScore = -Infinity;
    for (var root = 0; root < 12; root++) {
      for (var t = 0; t < QUAL.length; t++) {
        var tmpl = QUAL[t], inSet = {}; tmpl.pcs.forEach(function (p) { inSet[(root + p) % 12] = 1; });
        var inW = 0, outW = 0;
        for (var pc = 0; pc < 12; pc++) { if (inSet[pc]) inW += chroma[pc]; else outW += chroma[pc]; }
        // require the root to carry some weight (avoids rootless mismatches)
        var rootW = chroma[root % 12];
        var score = (inW / total) - penalty * (outW / total) - sizeBias * tmpl.pcs.length + 0.08 * (rootW / total);
        if (score > bestScore) { bestScore = score; best = { root: root, quality: tmpl.q, score: score }; }
      }
    }
    if (!best || bestScore < (opts.minScore != null ? opts.minScore : 0.18)) return null;
    best.label = label(best.root, best.quality);
    return best;
  }

  // Detect a chord progression from MIDI notes. Segments at the beat grid, then
  // merges consecutive beats sharing a label. Returns
  // [{startTick,endTick,startBeat,label,root,quality}], plus 'N' for no-chord beats.
  function detect(notes, ppq, timeSig, opts) {
    opts = opts || {};
    ppq = ppq || 480;
    var ts = timeSig || { num: 4, den: 4 };
    var beatTicks = Math.round(ppq * 4 / ts.den);     // ticks per notated beat
    if (!notes || !notes.length) return [];
    var end = notes.reduce(function (m, n) { return Math.max(m, n.end); }, 0);
    var nBeats = Math.ceil(end / beatTicks);

    // per-beat duration-weighted chroma
    var raw = [];
    for (var b = 0; b < nBeats; b++) {
      var bs = b * beatTicks, be = bs + beatTicks, ch = new Array(12).fill(0);
      for (var i = 0; i < notes.length; i++) {
        var n = notes[i]; if (n.end <= bs || n.start >= be) continue;
        var ov = Math.min(n.end, be) - Math.max(n.start, bs); if (ov <= 0) continue;
        ch[((n.pitch % 12) + 12) % 12] += ov * (n.velocity ? (0.5 + n.velocity / 254) : 1);
      }
      var m = matchChroma(ch, opts);
      raw.push(m ? m : { label: 'N', root: -1, quality: 'N', score: 0 });
    }
    // merge consecutive equal labels into segments
    var segs = [];
    for (var k = 0; k < raw.length; k++) {
      var cur = raw[k];
      if (segs.length && segs[segs.length - 1].label === cur.label) {
        segs[segs.length - 1].endTick = (k + 1) * beatTicks;
      } else {
        segs.push({ startTick: k * beatTicks, endTick: (k + 1) * beatTicks, startBeat: k,
                    label: cur.label, root: cur.root, quality: cur.quality });
      }
    }
    return opts.keepNoChord ? segs : segs.filter(function (s) { return s.label !== 'N'; });
  }

  // Split a (polyphonic) guitar transcription into two parts: a monophonic LEAD
  // line (the top voice / skyline melody) and the RHYTHM remainder (the chordal
  // notes below it). Used to turn one guitar stem — which often carries a rhythm
  // part AND a lead line at once — into two guitar tracks.
  function splitLeadRhythm(notes, ppq, opts) {
    opts = opts || {};
    ppq = ppq || 480;
    var eps = opts.eps != null ? opts.eps : Math.max(1, Math.round(ppq / 8));
    function cp(n) { return { start: n.start, end: n.end, pitch: n.pitch, velocity: n.velocity, channel: n.channel, track: n.track }; }
    var src = notes.slice().filter(function (n) { return n.end > n.start; })
      .sort(function (a, b) { return a.start - b.start || b.pitch - a.pitch; });
    var lead = [], rhythm = [], i = 0;
    while (i < src.length) {
      var gStart = src[i].start, j = i, top = i;
      while (j < src.length && src[j].start <= gStart + eps) { if (src[j].pitch > src[top].pitch) top = j; j++; }
      for (var k = i; k < j; k++) (k === top ? lead : rhythm).push(cp(src[k]));
      i = j;
    }
    // trim the lead to a strictly monophonic top line
    lead.sort(function (a, b) { return a.start - b.start; });
    for (var m = 0; m < lead.length - 1; m++) if (lead[m].end > lead[m + 1].start) lead[m].end = lead[m + 1].start;
    return { lead: lead.filter(function (n) { return n.end > n.start; }), rhythm: rhythm };
  }

  // How "two-part" a guitar transcription is: fraction of sounding time where a
  // low (chordal) register and a high (lead) register are active simultaneously.
  function concurrency(notes, opts) {
    opts = opts || {};
    var loMax = opts.loMax != null ? opts.loMax : 52;   // <= E3 ~ rhythm/chord register
    var hiMin = opts.hiMin != null ? opts.hiMin : 64;   // >= E4 ~ lead register
    if (!notes || !notes.length) return 0;
    var end = notes.reduce(function (m, n) { return Math.max(m, n.end); }, 0);
    if (!end) return 0;
    var step = Math.max(1, Math.round(end / 400)), both = 0, tot = 0;
    for (var t = 0; t < end; t += step) {
      var lo = false, hi = false, any = false;
      for (var i = 0; i < notes.length; i++) {
        var n = notes[i]; if (n.start <= t && n.end > t) { any = true; if (n.pitch <= loMax) lo = true; if (n.pitch >= hiMin) hi = true; }
      }
      if (any) { tot++; if (lo && hi) both++; }
    }
    return tot ? both / tot : 0;
  }

  // ---- chord-diagram shapes -------------------------------------------------
  // Open-position shapes for the common chords (frets per string low->high; -1 = mute).
  var OPEN = {
    'C':    { frets: [-1, 3, 2, 0, 1, 0], fingers: [0, 3, 2, 0, 1, 0] },
    'A':    { frets: [-1, 0, 2, 2, 2, 0], fingers: [0, 0, 1, 2, 3, 0] },
    'G':    { frets: [3, 2, 0, 0, 0, 3],  fingers: [2, 1, 0, 0, 0, 3] },
    'E':    { frets: [0, 2, 2, 1, 0, 0],  fingers: [0, 2, 3, 1, 0, 0] },
    'D':    { frets: [-1, -1, 0, 2, 3, 2],fingers: [0, 0, 0, 1, 3, 2] },
    'Am':   { frets: [-1, 0, 2, 2, 1, 0], fingers: [0, 0, 2, 3, 1, 0] },
    'Em':   { frets: [0, 2, 2, 0, 0, 0],  fingers: [0, 2, 3, 0, 0, 0] },
    'Dm':   { frets: [-1, -1, 0, 2, 3, 1],fingers: [0, 0, 0, 2, 3, 1] },
    'A7':   { frets: [-1, 0, 2, 0, 2, 0], fingers: [0, 0, 2, 0, 3, 0] },
    'E7':   { frets: [0, 2, 0, 1, 0, 0],  fingers: [0, 2, 0, 1, 0, 0] },
    'D7':   { frets: [-1, -1, 0, 2, 1, 2],fingers: [0, 0, 0, 2, 1, 3] },
    'G7':   { frets: [3, 2, 0, 0, 0, 1],  fingers: [3, 2, 0, 0, 0, 1] },
    'C7':   { frets: [-1, 3, 2, 3, 1, 0], fingers: [0, 3, 2, 4, 1, 0] },
    'Cmaj7':{ frets: [-1, 3, 2, 0, 0, 0], fingers: [0, 3, 2, 0, 0, 0] },
    'Am7':  { frets: [-1, 0, 2, 0, 1, 0], fingers: [0, 0, 2, 0, 1, 0] },
    'Em7':  { frets: [0, 2, 0, 0, 0, 0],  fingers: [0, 2, 0, 0, 0, 0] },
    'Dm7':  { frets: [-1, -1, 0, 2, 1, 1],fingers: [0, 0, 0, 2, 1, 1] }
  };

  // Movable barre templates (intervals from the barre fret), and which string
  // carries the root: 'E' shape (root on string 6) and 'A' shape (root on string 5).
  // value -1 = muted string.  Each entry: {rootStr, shape:[6], barre:string-count}
  var BARRE = {
    'maj':  { E: [0, 2, 2, 1, 0, 0],  A: [-1, 0, 2, 2, 2, 0] },
    'min':  { E: [0, 2, 2, 0, 0, 0],  A: [-1, 0, 2, 2, 1, 0] },
    '7':    { E: [0, 2, 0, 1, 0, 0],  A: [-1, 0, 2, 0, 2, 0] },
    'm7':   { E: [0, 2, 0, 0, 0, 0],  A: [-1, 0, 2, 0, 1, 0] },
    'maj7': { E: [0, 2, 1, 1, 0, 0],  A: [-1, 0, 2, 1, 2, 0] },
    'sus4': { E: [0, 2, 2, 2, 0, 0],  A: [-1, 0, 2, 2, 3, 0] },
    'sus2': { E: [0, 2, 2, -1, 0, 0], A: [-1, 0, 2, 2, 0, 0] },
    'dim':  { A: [-1, 0, 1, 2, 1, -1] },
    'aug':  { E: [0, 3, 2, 1, 1, 0] },
    'm7b5': { A: [-1, 0, 1, 0, 1, -1] },
    '6':    { E: [0, 2, 2, 1, 2, 0],  A: [-1, 0, 2, 2, 2, 2] },
    'm6':   { E: [0, 2, 2, 0, 2, 0],  A: [-1, 0, 2, 2, 1, 2] }
  };
  var E_ROOT_PC = 4, A_ROOT_PC = 9;   // pitch classes of open low-E and A strings

  // Return a chord-diagram shape {frets:[6], baseFret, label, root, quality}.
  // Prefers an open-position shape; else the lower-fret movable barre.
  function shapeFor(root, quality) {
    root = ((root % 12) + 12) % 12;
    var lbl = label(root, quality);
    if (OPEN[lbl]) return { frets: OPEN[lbl].frets.slice(), fingers: OPEN[lbl].fingers.slice(), baseFret: 1, label: lbl, root: root, quality: quality };
    var tmpl = BARRE[quality] || BARRE.maj;
    var cands = [];
    if (tmpl.E) { var fe = ((root - E_ROOT_PC) % 12 + 12) % 12; if (fe === 0) fe = 12; cands.push({ barre: fe, shape: tmpl.E, rootStr: 0 }); }
    if (tmpl.A) { var fa = ((root - A_ROOT_PC) % 12 + 12) % 12; if (fa === 0) fa = 12; cands.push({ barre: fa, shape: tmpl.A, rootStr: 1 }); }
    if (!cands.length) return null;
    cands.sort(function (a, b) { return a.barre - b.barre; });
    var c = cands[0];
    var frets = c.shape.map(function (v) { return v < 0 ? -1 : v + c.barre; });
    var baseFret = Math.max(1, Math.min.apply(null, frets.filter(function (v) { return v > 0; }).concat([c.barre])));
    return { frets: frets, baseFret: baseFret, label: lbl, root: root, quality: quality, barreFret: c.barre, barreFrom: c.rootStr };
  }

  function shapeForLabel(lbl) {
    // parse "C#m7" -> root + quality
    var m = /^([A-G][#b]?)(.*)$/.exec(lbl || ''); if (!m) return null;
    var pc = NAMES.indexOf(m[1].replace('b', '').toUpperCase());
    if (m[1].indexOf('b') >= 0) pc = (pc - 1 + 12) % 12;   // flats (NAMES is sharp-spelled)
    if (pc < 0) return null;
    var suf = m[2], qd = QUAL.filter(function (x) { return x.suffix === suf; })[0];
    return shapeFor(pc, qd ? qd.q : 'maj');
  }

  var api = { NAMES: NAMES, QUAL: QUAL, label: label, detect: detect, matchChroma: matchChroma,
              splitLeadRhythm: splitLeadRhythm, concurrency: concurrency,
              shapeFor: shapeFor, shapeForLabel: shapeForLabel, OPEN: OPEN };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ChordCore = api;
  return api;
})();
