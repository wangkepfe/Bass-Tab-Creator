/* ============================================================================
 * drum-synth.js  —  Web Audio drum synthesizer (extracted from the drum page).
 *
 * A rolling lookahead scheduler keeps only ~1s of hits queued at a time:
 * scheduling a whole song upfront floods Chrome's realtime audio thread and the
 * output collapses to silence, so voices are created just-in-time from a timer
 * tick, all noise hits share one pre-rendered buffer, and finished nodes are
 * reaped via onended.
 *
 *   DrumSynth.setEvents([{time_sec,type,velocity}])
 *   DrumSynth.play() / pause() / stop() / seekSeconds(t)
 *   DrumSynth.currentTime() -> seconds   ·   DrumSynth.isPlaying() -> bool
 * ========================================================================== */
var DrumSynth = (function () {
  'use strict';
  var ac = null, master = null, noiseBuf = null;
  var NOISE_LEN = 2;       // seconds; longest voice (crash) needs ~1.62
  var sched = [];          // [{ t, type, vel }] sorted by time
  var schedIdx = 0;
  var timer = null;
  var HORIZON = 1.2;       // seconds scheduled ahead — must exceed the timer period
  var TICK_MS = 250;
  var nodes = [];
  var playing = false;
  var posSec = 0, clockBase = 0, startCtx = 0;

  function ctx() {
    if (!ac) {
      ac = new (window.AudioContext || window.webkitAudioContext)();
      master = ac.createGain(); master.gain.value = 0.9;
      master.connect(ac.destination);
      noiseBuf = ac.createBuffer(1, Math.ceil(ac.sampleRate * NOISE_LEN), ac.sampleRate);
      var d = noiseBuf.getChannelData(0);
      for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return ac;
  }
  function reap(n) { n.onended = function () { var i = nodes.indexOf(n); if (i >= 0) nodes.splice(i, 1); }; nodes.push(n); }
  function env(gain, t, vol, decay) { gain.setValueAtTime(vol, t); gain.exponentialRampToValueAtTime(0.0001, t + decay); }
  function osc(type, freq, t, vol, decay, freqEnd) {
    var g = ac.createGain(); g.connect(master); env(g.gain, t, vol, decay);
    var o = ac.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + decay * 0.3);
    o.connect(g); o.start(t); o.stop(t + decay + 0.01); reap(o);
  }
  function nz(hpFreq, t, vol, decay, bpQ) {
    var g = ac.createGain(); g.connect(master); env(g.gain, t, vol, decay);
    var f = ac.createBiquadFilter(); f.type = bpQ ? 'bandpass' : 'highpass';
    f.frequency.value = hpFreq; if (bpQ) f.Q.value = bpQ;
    var n = ac.createBufferSource(); n.buffer = noiseBuf;
    var len = decay + 0.02; n.connect(f); f.connect(g);
    n.start(t, Math.random() * (NOISE_LEN - len - 0.01), len); reap(n);
  }
  var HIT = {
    kick:       function (t, v) { osc('sine', 160, t, v, 0.45, 50); nz(80, t, v * 0.15, 0.05); },
    snare:      function (t, v) { nz(2200, t, v * 0.55, 0.18, 0.8); osc('triangle', 185, t, v * 0.35, 0.1); },
    hihat:      function (t, v) { nz(8000, t, v * 0.3, 0.04); },
    hihat_open: function (t, v) { nz(7000, t, v * 0.3, 0.32); },
    crash:      function (t, v) { nz(4500, t, v * 0.45, 1.6); nz(8000, t, v * 0.2, 0.8); },
    ride:       function (t, v) { nz(6000, t, v * 0.22, 0.55, 3); },
    tom1:       function (t, v) { osc('sine', 220, t, v * 0.9, 0.3, 130); },
    tom2:       function (t, v) { osc('sine', 170, t, v * 0.9, 0.35, 95); },
    floor_tom:  function (t, v) { osc('sine', 110, t, v * 0.9, 0.45, 60); },
  };
  function clearNodes() {
    nodes.forEach(function (n) { n.onended = null; try { n.stop(0); } catch (e) {} try { n.disconnect(); } catch (e) {} });
    nodes = [];
  }
  function schedTick() {
    if (!ac || !playing) return;
    var horizon = ac.currentTime + HORIZON;
    while (schedIdx < sched.length) {
      var ev = sched[schedIdx];
      var at = startCtx + (ev.t - clockBase);
      if (at > horizon) break;
      schedIdx++;
      if (at < ac.currentTime - 0.005) continue;
      var fn = HIT[ev.type];
      if (fn) fn(Math.max(at, ac.currentTime + 0.005), Math.max(0.01, (ev.vel || 100) / 127));
    }
  }
  function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }
  function startFrom(p) {
    ctx();
    if (ac.state === 'suspended') ac.resume();
    clearNodes();
    posSec = Math.max(0, p);
    clockBase = posSec;
    startCtx = ac.currentTime + 0.06;
    schedIdx = 0;
    while (schedIdx < sched.length && sched[schedIdx].t < posSec - 0.001) schedIdx++;
    playing = true;
    schedTick(); stopTimer(); timer = setInterval(schedTick, TICK_MS);
  }

  return {
    setEvents: function (events) {
      sched = (events || []).map(function (e) { return { t: e.time_sec, type: e.type, vel: e.velocity }; })
        .sort(function (a, b) { return a.t - b.t; });
    },
    play: function (events) { if (events) this.setEvents(events); startFrom(posSec); },
    pause: function () { if (!playing) return; posSec = this.currentTime(); stopTimer(); clearNodes(); playing = false; },
    stop: function () { stopTimer(); clearNodes(); playing = false; posSec = 0; schedIdx = 0; },
    seekSeconds: function (t) { var was = playing; if (was) { stopTimer(); clearNodes(); } posSec = Math.max(0, t); if (was) startFrom(posSec); },
    currentTime: function () { if (!ac) return posSec; return playing ? Math.max(0, clockBase + (ac.currentTime - startCtx)) : posSec; },
    isPlaying: function () { return playing; },
  };
})();
