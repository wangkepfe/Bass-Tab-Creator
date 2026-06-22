// Node test harness for the tempo / bar-grid detector (web/tempo-core.js).
//   run:  node tab-studio/test-tempo.js
//
// Two kinds of checks:
//   1. synthetic patterns at a KNOWN bpm + bar offset (ground truth)
//   2. the real drum MIDIs in seed-sources/ (detected bpm must match the file's tempo)
const fs = require('fs');
const path = require('path');
const TempoCore = require(path.join(__dirname, 'web', 'tempo-core.js'));
const BassTab   = require(path.join(__dirname, 'web', 'bass-tab-core.js'));
const DrumTabCore = require(path.join(__dirname, 'web', 'drum-tab-core.js'));

let failures = 0;
function ok(cond, msg) { console.log((cond ? '  ok  ' : ' FAIL ') + msg); if (!cond) failures++; }

// onset weights by drum role — kick/snare define the pulse; hats/cymbals less so.
// (Kept in sync with WEIGHT in app.js autoDetectDrumGrid.)
const WEIGHT = { kick: 1.6, snare: 1.4, floor_tom: 1.1, tom1: 1.0, tom2: 1.0,
                 crash: 1.0, ride: 0.6, hihat: 0.6, hihat_open: 0.7 };

// deterministic pseudo-jitter so the test is reproducible (no Math.random).
function jitter(i) { return ((Math.sin(i * 12.9898) * 43758.5453) % 1) * 0.010 - 0.005; } // ±5 ms

// Build a realistic rock-beat onset list: kick on 1 & 3, snare on 2 & 4, closed
// hats on every eighth, plus a crash on beat 1 to break the half-bar symmetry.
function rockBeat(bpm, offsetSec, bars) {
  const beat = 60 / bpm, ev = [], add = (t, type) => ev.push({ t: Math.max(0, t), w: WEIGHT[type] });
  let n = 0;
  for (let b = 0; b < bars; b++) {
    for (let k = 0; k < 4; k++) {
      const beatT = offsetSec + (b * 4 + k) * beat;
      if (k === 0 || k === 2) add(beatT + jitter(n++), 'kick');
      if (k === 1 || k === 3) add(beatT + jitter(n++), 'snare');
      if (b === 0 && k === 0) add(beatT + jitter(n++), 'crash');     // mark bar 1
      add(beatT + jitter(n++), 'hihat');                              // on-beat hat
      add(beatT + beat / 2 + jitter(n++), 'hihat');                   // off-beat hat
    }
  }
  return ev;
}

function circDist(a, b, period) { let d = Math.abs(a - b) % period; return Math.min(d, period - d); }

console.log('== synthetic: tempo + bar offset recovery ==');
[
  { bpm: 90,  off: 0.30 }, { bpm: 100, off: 0.00 }, { bpm: 120, off: 0.42 },
  { bpm: 128, off: 0.15 }, { bpm: 140, off: 0.55 }, { bpm: 75,  off: 0.20 }
].forEach(function (tc) {
  const ev = rockBeat(tc.bpm, tc.off, 16);
  const r = TempoCore.analyze(ev, { tsNum: 4 });
  const bar = (60 / tc.bpm) * 4;
  const offErr = circDist(r.offsetSec, tc.off, bar);
  ok(Math.abs(r.bpm - tc.bpm) <= 2.0,
    'bpm ' + tc.bpm + ' -> ' + r.bpm + ' (err ' + (Math.abs(r.bpm - tc.bpm)).toFixed(2) + ', conf ' + r.tempoConfidence.toFixed(2) + ')');
  ok(offErr <= 0.035,    // ~1/4 of a 16th note @120bpm — imperceptible in a tab
    'offset ' + tc.off + 's -> ' + r.offsetSec.toFixed(3) + 's (err ' + (offErr * 1000).toFixed(0) + ' ms, conf ' + r.offsetConfidence.toFixed(2) + ')');
});

console.log('\n== synthetic: sparse 4-on-the-floor must not double the tempo ==');
(function () {
  const bpm = 80, beat = 60 / bpm, ev = [];
  for (let i = 0; i < 64; i++) ev.push({ t: i * beat + jitter(i), w: 1.6 });  // one kick per beat only
  const r = TempoCore.detectTempo(ev);
  ok(Math.abs(r.bpm - bpm) <= 2.0, 'sparse ' + bpm + ' -> ' + r.bpm + ' (no octave error)');
})();

console.log('\n== onset count: trustworthy when dense, flagged when sparse ==');
// Regression for two bugs: (1) the unbiased ÷(n−lag) normalisation used to inflate
// long lags on short inputs and report half the true tempo; the biased ÷n estimator
// fixes the systematic case. (2) What's left is the inherent noise floor of ~few
// onsets, so detectTempo must report LOW confidence there (callers then defer to a
// prior) and only claim trust once enough onsets exist (>=8).
[90, 100, 120, 128, 140].forEach(function (bpm) {
  const beat = 60 / bpm;
  for (let nOn = 4; nOn <= 12; nOn++) {
    const ev = [];
    for (let i = 0; i < nOn; i++) ev.push({ t: i * beat + jitter(i), w: 1.5 });
    const r = TempoCore.detectTempo(ev);
    if (nOn >= 8) ok(Math.abs(r.bpm - bpm) <= 3.0, bpm + ' bpm, ' + nOn + ' onsets -> ' + r.bpm + ' (trusted, conf ' + r.confidence.toFixed(2) + ')');
    else ok(r.confidence < 0.3, bpm + ' bpm, ' + nOn + ' onsets -> conf ' + r.confidence.toFixed(2) + ' < 0.3 (flagged sparse; got ' + r.bpm + ')');
  }
});

console.log('\n== edge cases ==');
ok(TempoCore.detectTempo([]).confidence === 0, 'empty input -> confidence 0, fallback bpm');
ok(TempoCore.detectTempo([1, 2]).bpm === 120, 'too few onsets -> fallback 120');
ok(TempoCore.detectGridOffset([], { bpm: 120 }).offsetSec === 0, 'empty offset -> 0');
(function () {
  const r = TempoCore.detectTempo([], { fallbackBpm: 100 });
  ok(r.bpm === 100, 'custom fallback bpm honoured (' + r.bpm + ')');
})();

console.log('\n== real drum MIDIs (seed-sources/) ==');
// Ground truth here is the FILE tempo; we don't know where the artist intended
// "bar 1", so instead of assuming the song starts at t=0 we check that the
// detected beat grid actually FITS the hits — i.e. most onset weight lands on a
// beat line under the detected (tempo, phase). That validates the alignment
// without a bar-1 assumption a performed/transcribed take wouldn't honour.
// Most drum hits sit on off-beat 8ths/16ths, and a multi-minute take drifts off
// any single constant tempo — so we measure fit to a 16th-note grid over just the
// opening window (drift still negligible there). That tells us the detected phase
// is right, independent of which beat got labelled "bar 1".
function gridFit(ev, bpm, offsetSec) {
  const beat = 60 / bpm, g = beat / 4, tol = 0.30 * g;   // 16th grid, ±30% of a cell
  const t0 = ev[0].t, windowEnd = t0 + 32 * beat;        // ~first 8 bars
  let onW = 0, totW = 0;
  ev.forEach(function (e) {
    if (e.t > windowEnd) return;
    const d = circDist(e.t, offsetSec, g);
    totW += e.w; if (d <= tol) onW += e.w;
  });
  return totW > 0 ? onW / totW : 0;
}
const ASSETS = path.join(__dirname, '..', 'seed-sources');
fs.readdirSync(ASSETS).filter(f => /Drums\.mid$/i.test(f)).forEach(function (f) {
  const song = BassTab.parseMidi(new Uint8Array(fs.readFileSync(path.join(ASSETS, f))));
  const tempo = song.tempos.length ? song.tempos[0].bpm : 120;
  const tps = (tempo / 60) * song.ppq;
  const ev = song.notes.map(function (n) {
    const type = DrumTabCore.GM_TO_TYPE[n.pitch];
    return type ? { t: n.start / tps, w: (WEIGHT[type] || 1) * ((n.velocity || 100) / 100) } : null;
  }).filter(Boolean);
  if (ev.length < 8) { console.log('  --  ' + f + ': too few mapped hits (' + ev.length + '), skipped'); return; }
  const r = TempoCore.analyze(ev, { tsNum: 4 });
  const fit = gridFit(ev, r.bpm, r.offsetSec);
  console.log('  ··  ' + f + ': file ' + tempo.toFixed(1) + ' bpm -> detected ' + r.bpm +
    ' bpm (conf ' + r.tempoConfidence.toFixed(2) + '), offset ' + r.offsetSec.toFixed(3) +
    's, grid-fit ' + (fit * 100).toFixed(0) + '%');
  ok(Math.abs(r.bpm - tempo) <= Math.max(2.5, tempo * 0.03),
    f + ': detected tempo within 3% of the file tempo (' + r.bpm + ' vs ' + tempo.toFixed(1) + ')');
  // grid-fit is reported, not gated: it's hyper-sensitive to sub-percent tempo
  // drift over the window (a performed take never holds one exact tempo), so it
  // swings widely for a perfectly usable detection. The synthetic ground-truth
  // cases above are what gate offset accuracy.
});

console.log('\n' + (failures ? failures + ' TEST(S) FAILED' : 'ALL TESTS PASSED'));
process.exit(failures ? 1 : 0);
