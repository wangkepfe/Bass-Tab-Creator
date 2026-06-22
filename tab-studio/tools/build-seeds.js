/* ============================================================================
 * build-seeds.js — regenerate the starter projects (seed-projects/) from their
 * source MIDIs (seed-sources/).
 *
 * These starter projects replace the old "examples": instead of bundling MIDIs
 * that the app loads read-only, we pre-bake each one into a real project.json
 * (the exact format a user gets by importing the MIDI and saving). On desktop the
 * backend copies them into projects/ on first run; the web build ships them as a
 * static read-only library. There is now only ONE kind of thing — a project.
 *
 * Fidelity: this reuses the REAL frontend modules (midi-io / tempo-core /
 * drum-tab-core) and mirrors app.js's importMidiBytes() exactly, so the output is
 * byte-identical to a browser import+save (verified against a hand-made save:
 * same notes, drum events, tempo and gridOffset).
 *
 *   run:  node tab-studio/tools/build-seeds.js
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');               // repo root
const WEB = path.join(__dirname, '..', 'web');
const SRC = path.join(ROOT, 'seed-sources');
const OUT = path.join(ROOT, 'seed-projects');

const MidiIO = require(path.join(WEB, 'midi-io.js'));
const TempoCore = require(path.join(WEB, 'tempo-core.js'));
const DrumTabCore = require(path.join(WEB, 'drum-tab-core.js'));

// Fixed timestamp for committed seeds (deterministic — no Date.now in output).
// 2025-01-01T00:00:00Z. Desktop overwrites this with the real time on first edit.
const SEED_UPDATED = 1735689600;

// instrument → default track label (mirrors app.js TARGETS[*].label)
const LABELS = { bass: 'Bass', piano: 'Piano', guitar: 'Guitar', vocals: 'Vocals', keys: 'Keys', drums: 'Drums' };

// --- verbatim from app.js: DRUM_ONSET_WEIGHT + autoDetectDrumGrid (trustPrior) ---
const DRUM_ONSET_WEIGHT = { kick: 1.6, snare: 1.4, floor_tom: 1.1, tom1: 1.0, tom2: 1.0, crash: 1.0, ride: 0.6, hihat: 0.6, hihat_open: 0.7 };
function autoDetectDrumGrid(events, priorBpm, trustPrior) {
  const onsets = (events || []).map(e => ({ t: e.time_sec, w: (DRUM_ONSET_WEIGHT[e.type] || 1) * ((e.velocity || 100) / 100) }));
  const t = TempoCore.detectTempo(onsets, { fallbackBpm: priorBpm || 120 });
  const tempo = trustPrior ? (priorBpm || t.bpm) : (t.confidence >= 0.3 ? t.bpm : (priorBpm || t.bpm));
  const g = TempoCore.detectGridOffset(onsets, { tsNum: 4, bpm: tempo });
  return { tempo, gridOffset: Math.round(g.offsetSec * 1000) / 1000 };
}

// Mirror of app.js importMidiBytes() + the serializeMeta() shape for one track.
// Drums always become track id 'drums' (channel-9 routing); melodic uses the
// assigned id/name. Returns the serialized track object.
function trackFromMidi(file, instrument, name, assignedId) {
  const m = MidiIO.read(new Uint8Array(fs.readFileSync(path.join(SRC, file))));
  const drumCh = m.notes.filter(n => n.channel === 9).length;
  if (m.notes.length && drumCh / m.notes.length >= 0.5) {
    const tps = (m.tempo / 60) * (m.ppq || 480);
    const events = m.notes
      .map(n => ({ time_sec: n.start / tps, type: DrumTabCore.GM_TO_TYPE[n.pitch], velocity: n.velocity || 100 }))
      .filter(e => e.type);
    const duration = m.notes.reduce((a, n) => Math.max(a, n.end), 0) / tps;
    const d = autoDetectDrumGrid(events, m.tempo, true);
    return { id: 'drums', instrument: 'drums', kind: 'drum', name: 'Drums',
      events, tempo: d.tempo, duration, gridOffset: d.gridOffset };
  }
  const inst = instrument || 'bass';
  const o = { id: assignedId, instrument: inst, kind: 'melodic', name: name || LABELS[inst] || inst,
    notes: m.notes.map(n => ({ start: n.start, end: n.end, pitch: n.pitch, velocity: n.velocity })),
    ppq: m.ppq, tempo: m.tempo, timeSig: m.timeSig, view: {}, overrides: {} };
  if (inst === 'guitar') o.chordView = {};
  return o;
}

function buildSeed(seed) {
  // assign track ids the way loadExample() does: first of an instrument keeps the
  // bare id, repeats get '<instrument>-2', '-3', … (drums override to 'drums').
  const seen = {};
  const tracks = seed.tracks.map(t => {
    const n = seen[t.instrument] || 0; seen[t.instrument] = n + 1;
    const assignedId = n === 0 ? t.instrument : t.instrument + '-' + (n + 1);
    return trackFromMidi(t.file, t.instrument, t.name, assignedId);
  });
  return {
    id: seed.id, name: seed.name, youtubeUrl: seed.youtube || '', song: null,
    tracks, activeTrackId: tracks.length ? tracks[0].id : null, updated: SEED_UPDATED,
  };
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
  const seeds = manifest.seeds || [];
  // fresh OUT dir so removed seeds don't linger
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  seeds.forEach(seed => {
    const proj = buildSeed(seed);
    const dir = path.join(OUT, seed.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(proj), 'utf8');
    const summary = proj.tracks.map(t => t.instrument + (t.kind === 'drum' ? '(' + t.events.length + ')' : '(' + t.notes.length + ')')).join(' ');
    console.log('  ' + seed.id + '  ' + proj.name + '  [' + summary + ']');
  });
  console.log('Wrote ' + seeds.length + ' seed project(s) to ' + path.relative(ROOT, OUT));
}

main();
