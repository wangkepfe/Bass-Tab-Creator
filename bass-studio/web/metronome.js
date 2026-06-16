/* ============================================================================
 * metronome.js  —  a transport-driven click track that works for EVERY view
 * and EVERY source (synth · song · stem).
 *
 * The old metronome was baked into the melodic synth (player.js) so it only
 * clicked for the Piano-Roll / Bass-Tab views when the "Synth" source was
 * active — the Drum-Tab view (DrumSynth, no metro) and audio sources were
 * silent. This module instead polls the live transport position once per frame
 * and schedules clicks a short lookahead ahead on its own AudioContext, so the
 * click follows whatever is actually playing.
 *
 *   Metronome.setEnabled(bool)
 *   Metronome.sync(posSec, tempo, tsNum, originSec)   // call each frame while playing
 *   Metronome.reset()    // re-seed the beat cursor (seek / tempo change)
 *   Metronome.stop()     // reset + silence any queued clicks (stop / pause)
 *   Metronome.prime()    // unlock the AudioContext on a user gesture
 * ========================================================================== */
var Metronome = (function () {
  'use strict';
  var ac = null, master = null;
  var enabled = false;
  var live = [];                 // currently-scheduled click oscillators
  var nextBeat = -1;             // index of the next beat to schedule (-1 = unseeded)
  var lastTempo = 0, lastTs = 0, lastOrigin = 0;
  var LOOK = 0.12;               // schedule clicks up to 120 ms ahead

  function ctx() {
    if (!ac) {
      var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
      ac = new AC();
      master = ac.createGain(); master.gain.value = 0.6; master.connect(ac.destination);
    }
    return ac;
  }

  function click(at, accent) {
    if (!ac) return;
    var o = ac.createOscillator(), g = ac.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime(accent ? 2000 : 1320, at);
    var peak = accent ? 0.34 : 0.18, dur = 0.035;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g); g.connect(master);
    o.onended = function () { var i = live.indexOf(o); if (i >= 0) live.splice(i, 1); };
    o.start(at); o.stop(at + dur + 0.02);
    live.push(o);
  }

  function kill() {
    live.forEach(function (o) { o.onended = null; try { o.stop(0); } catch (e) {} try { o.disconnect(); } catch (e) {} });
    live = [];
  }
  function reset() { nextBeat = -1; }

  // Schedule the clicks that fall in the next lookahead window. posSec is the
  // live transport position (seconds); tempo + tsNum define the click grid;
  // originSec shifts the grid (the drum bar-grid offset) so clicks land on the
  // same downbeats the editor draws. Safe to call every frame — it only queues
  // each beat once via the nextBeat cursor.
  function sync(posSec, tempo, tsNum, originSec) {
    if (!enabled) return;
    var c = ctx(); if (!c) return;
    if (c.state === 'suspended') c.resume();
    tempo = tempo || 120; tsNum = tsNum || 4; originSec = originSec || 0;
    var spb = 60 / tempo;                                  // seconds per (quarter) beat
    var rel = posSec - originSec;
    var curBeat = Math.floor(rel / spb);
    // (re)seed the cursor on the first call, a seek (cursor far from the clock),
    // or a tempo / time-sig / origin change.
    if (nextBeat < 0 || nextBeat > curBeat + 2 || nextBeat < curBeat - 1 ||
        tempo !== lastTempo || tsNum !== lastTs || originSec !== lastOrigin) {
      // start at the beat we're on if we're right at it, else the next one
      nextBeat = (rel - curBeat * spb < 0.03) ? curBeat : curBeat + 1;
      lastTempo = tempo; lastTs = tsNum; lastOrigin = originSec;
    }
    for (var guard = 0; guard < 64; guard++) {
      var beatT = originSec + nextBeat * spb;
      var ahead = beatT - posSec;
      if (ahead > LOOK) break;
      if (ahead > -0.05) {
        var accent = ((((nextBeat % tsNum) + tsNum) % tsNum) === 0);
        click(c.currentTime + Math.max(0, ahead), accent);
      }
      nextBeat++;
    }
  }

  return {
    setEnabled: function (v) { enabled = !!v; reset(); if (!enabled) kill(); },
    isEnabled: function () { return enabled; },
    reset: reset,
    stop: function () { reset(); kill(); },
    sync: sync,
    prime: function () { var c = ctx(); if (c && c.state === 'suspended') c.resume(); }
  };
})();
