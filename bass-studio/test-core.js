// Node test harness for the bass-tab engine (web/bass-tab-core.js).
//   run:  node bass-studio/test-core.js
const fs = require('fs');
const path = require('path');
const BassTab = require(path.join(__dirname, 'web', 'bass-tab-core.js'));

const MIDI = path.join(__dirname, '..', 'assets', 'Too Many Kicks Bass.mid');
const buf = fs.readFileSync(MIDI);
const song = BassTab.parseMidi(new Uint8Array(buf));

let failures = 0;
function ok(cond, msg) { console.log((cond ? '  ok  ' : ' FAIL ') + msg); if (!cond) failures++; }

console.log('== parse ==');
console.log('ppq', song.ppq, 'tracks', song.ntracks, 'notes', song.notes.length,
  'tempos', song.tempos.map(t => Math.round(t.bpm)).join(','));

const grid = BassTab.detectGrid(song.notes, song.ppq);
const ps = BassTab.pitchStats(song.notes);
console.log('grid', grid.label, '| pitch', BassTab.pitchName(ps.min), '..', BassTab.pitchName(ps.max));

console.log('\n== monophonic example: full fingering ==');
const r = BassTab.convert(song, { octaveShift: -1, gridTicks: 120 });
ok(r.fingering.positions.filter(Boolean).length === song.notes.length,
  'every note gets a position (' + r.fingering.positions.filter(Boolean).length + '/' + song.notes.length + ')');
ok(r.ascii.indexOf('\n') > 0 && /\d/.test(r.ascii), 'ascii tab has fret digits');
console.log(r.ascii.split('\n').slice(0, 10).join('\n'));

console.log('\n== regression: DP must not blank on unplayable notes ==');
// Inject 3 out-of-range (unplayable) pitches among playable ones; the Viterbi
// must still assign positions to all the PLAYABLE notes (the old bug left them null).
const mixed = [];
for (let i = 0; i < 30; i++) mixed.push({ start: i * 120, end: i * 120 + 100, pitch: 40 + (i % 5), velocity: 100 });
mixed.splice(5, 0, { start: 5 * 120, end: 5 * 120 + 100, pitch: 10, velocity: 100 });   // far below E1 → unplayable
mixed.splice(15, 0, { start: 15 * 120, end: 15 * 120 + 100, pitch: 12, velocity: 100 });
mixed.splice(25, 0, { start: 25 * 120, end: 25 * 120 + 100, pitch: 11, velocity: 100 });
const fb = BassTab.assignFingering(mixed, { tuning: BassTab.STD_TUNING, maxFret: 24 });
const playable = mixed.length - fb.unplayable.length;
ok(fb.positions.filter(Boolean).length === playable,
  'all playable notes assigned despite unplayable ones (' + fb.positions.filter(Boolean).length + '/' + playable + ', unplayable ' + fb.unplayable.length + ')');

console.log('\n== regression: monophonicReduce collapses polyphony ==');
const poly = [
  { start: 0, end: 480, pitch: 40, velocity: 100 },   // onset 1: chord (keep lowest)
  { start: 5, end: 200, pitch: 52, velocity: 120 },
  { start: 10, end: 240, pitch: 47, velocity: 90 },
  { start: 240, end: 720, pitch: 43, velocity: 100 },  // onset 2 overlaps onset 1's tail
  { start: 244, end: 300, pitch: 55, velocity: 80 },
];
const mono = BassTab.monophonicReduce(poly, 480, { pick: 'low' });
ok(mono.length === 2, 'two onsets -> two notes (' + mono.length + ')');
ok(mono[0].pitch === 40 && mono[1].pitch === 43, 'kept the lowest pitch at each onset');
ok(mono[0].end <= mono[1].start, 'first note trimmed to be monophonic');

console.log('\n' + (failures ? failures + ' TEST(S) FAILED' : 'ALL TESTS PASSED'));
process.exit(failures ? 1 : 0);
