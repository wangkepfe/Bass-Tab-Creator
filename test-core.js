// Dev harness: validate the engine against the real MIDI file under Node.
const fs = require('fs');
const BassTab = require('./bass-tab-core.js');

const buf = fs.readFileSync('assets/Too Many Kicks Bass.mid');
const song = BassTab.parseMidi(new Uint8Array(buf));

console.log('== parse ==');
console.log('ppq', song.ppq, 'format', song.format, 'tracks', song.ntracks);
console.log('names', song.trackNames);
console.log('tempos', song.tempos.map(t => `${t.bpm.toFixed(0)}bpm@${t.tick}`).join(', '));
console.log('timeSig', song.timeSigs.map(s => `${s.num}/${s.den}@${s.tick}`).join(', '));
console.log('notes', song.notes.length);

const grid = BassTab.detectGrid(song.notes, song.ppq);
console.log('\n== detectGrid ==', grid, '(expect 120 ticks = 1/16 note)');

const ps = BassTab.pitchStats(song.notes);
console.log('pitch range', ps.min, BassTab.pitchName(ps.min), '..', ps.max, BassTab.pitchName(ps.max));
const loc = BassTab.firstNoteLocation(song.notes, song.ppq, song.timeSigs[0]);
console.log('first note at bar', loc.bar, 'beat', loc.beat.toFixed(2), 'ticksPerBar', loc.ticksPerBar);

function run(label, settings) {
  console.log('\n========================================================');
  console.log(label);
  console.log('========================================================');
  const r = BassTab.convert(song, settings);
  console.log('ergo:', JSON.stringify({
    notes: r.ergo.noteCount, minFret: r.ergo.minFret, maxFret: r.ergo.maxFret,
    shifts: r.ergo.positionShifts, biggestJump: r.ergo.biggestJump,
    fastShifts: r.ergo.fastShifts.length, rating: r.ergo.rating, score: r.ergo.score
  }));
  if (r.fingering.unplayable.length)
    console.log('UNPLAYABLE notes:', r.fingering.unplayable.length);
  // show first ~8 bars of ascii
  console.log(r.ascii.split('\n').slice(0, 16).join('\n'));
}

const ticksPerBar = song.ppq * 4; // 4/4
const firstStart = song.notes[0].start;
const trimToBar = -(Math.floor(firstStart / ticksPerBar) * ticksPerBar); // remove empty lead bars, keep phase
const trimToBeat1 = -firstStart;                                          // force first note to bar1 beat1

run('A) octave 0, grid 1/16, trim empty lead bars (keep off-beat phase)',
    { octaveShift: 0, gridTicks: 120, tickShift: trimToBar });

run('B) octave -1, grid 1/16, trim empty lead bars (RECOMMENDED by analysis)',
    { octaveShift: -1, gridTicks: 120, tickShift: trimToBar });

run('C) octave -1, grid 1/16, first note forced to bar1 beat1',
    { octaveShift: -1, gridTicks: 120, tickShift: trimToBeat1 });
