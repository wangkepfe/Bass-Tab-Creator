/* ============================================================================
 * transport.js  —  one transport shared by every view.
 *
 * Sources:  synth | original | stem.  The "synth" source is the melodic
 * EditorPlayer for the Piano-Roll / Bass-Tab views and the DrumSynth for the
 * Drum-Tab view; original/stem are the two <audio> elements. A single rAF loop
 * reads the active engine's position (in seconds) and pushes the playhead into
 * the active view — melodic views in ticks, the drum view in seconds — so the
 * transcription can be A/B'd against the source audio under one playhead.
 *
 *   Transport.init({ getProject, melodicSynth, drumSynth, audios, views,
 *                    getDrumDuration, onUpdate })
 *   Transport.setView('pianoroll'|'basstab'|'drumtab')
 *   Transport.setSource('synth'|'original'|'stem')
 *   Transport.play()/pause()/stop()/toggle()/seekSeconds(t)/seekTick(t)
 *   Transport.setMetro(bool) · setDrumEvents(events) · rebuildMelodic()
 *   Transport.sourceAvailable(name) · getSource() · getView()
 * ========================================================================== */
var Transport = (function () {
  'use strict';
  var cfg = null;
  var source = 'synth';          // 'synth' | 'original' | 'stem'
  var view = 'pianoroll';        // 'pianoroll' | 'basstab' | 'drumtab'
  var running = false;
  var raf = 0;
  var metroOn = false;
  var drumDuration = 0;

  function init(o) {
    cfg = o || {};
    drumDuration = 0;
    // keep the play button / clock in sync when audio elements end on their own
    ['original', 'stem'].forEach(function (k) {
      var el = cfg.audios && cfg.audios[k];
      if (el) el.addEventListener('ended', function () { if (source === k) finalize(); });
    });
  }

  function isMelodic() { return view !== 'drumtab'; }
  function project() { return (cfg.getProject && cfg.getProject()) || { ppq: 480, tempo: 120 }; }
  function tps() { var p = project(); return (p.tempo / 60) * (p.ppq || 480); }   // ticks per second
  function audioEl() { return source === 'original' ? cfg.audios.original : source === 'stem' ? cfg.audios.stem : null; }
  function activeMelodicView() { return view === 'basstab' ? cfg.views.basstab : cfg.views.pianoroll; }

  // The "original" (song) source plays a downloaded <audio> file when one is
  // loaded; otherwise a YouTube video (the web app has no audio to download).
  function yt() { return cfg.youtube; }
  function origHasAudio() { var el = cfg.audios && cfg.audios.original; return !!(el && el.getAttribute && el.getAttribute('src')); }
  function isYt() { return source === 'original' && !origHasAudio() && yt() && yt().hasVideo(); }

  // ---- engine abstraction --------------------------------------------------
  function enginePlay(fromExisting) {
    if (source === 'synth') {
      if (isMelodic()) { cfg.melodicSynth.rebuild(); cfg.melodicSynth.setMetro(metroOn); cfg.melodicSynth.play(); }
      else cfg.drumSynth.play();
    } else if (isYt()) { yt().play(); }
    else { var el = audioEl(); if (el) { var p = el.play(); if (p && p.catch) p.catch(function () {}); } }
  }
  function enginePause() {
    if (source === 'synth') { isMelodic() ? cfg.melodicSynth.pause() : cfg.drumSynth.pause(); }
    else if (isYt()) { yt().pause(); }
    else { var el = audioEl(); if (el) el.pause(); }
  }
  function engineStop() {
    if (source === 'synth') { isMelodic() ? cfg.melodicSynth.stop() : cfg.drumSynth.stop(); }
    else if (isYt()) { yt().stop(); }
    else { var el = audioEl(); if (el) { el.pause(); try { el.currentTime = 0; } catch (e) {} } }
  }
  function engineSeek(sec) {
    sec = Math.max(0, sec);
    if (source === 'synth') { isMelodic() ? cfg.melodicSynth.seekTick(Math.round(sec * tps())) : cfg.drumSynth.seekSeconds(sec); }
    else if (isYt()) { yt().seek(sec); }
    else { var el = audioEl(); if (el) { try { el.currentTime = sec; } catch (e) {} } }
  }
  function enginePlaying() {
    if (source === 'synth') return isMelodic() ? cfg.melodicSynth.isPlaying() : cfg.drumSynth.isPlaying();
    if (isYt()) return yt().isPlaying();
    var el = audioEl(); return !!(el && !el.paused && !el.ended);
  }
  function posSeconds() {
    if (source === 'synth') return isMelodic() ? cfg.melodicSynth.positionTick() / tps() : cfg.drumSynth.currentTime();
    if (isYt()) return yt().currentTime();
    var el = audioEl(); return el ? el.currentTime : 0;
  }
  function durSeconds() {
    if (source === 'synth') return isMelodic() ? cfg.melodicSynth.durationTick() / tps() : drumDuration;
    if (isYt()) return yt().duration();
    var el = audioEl(); return (el && isFinite(el.duration)) ? el.duration : 0;
  }

  // ---- playhead + UI fan-out ----------------------------------------------
  function pushPlayhead(sec) {
    if (isMelodic()) { var t = Math.round(sec * tps()); var v = activeMelodicView(); if (v && v.setPlayheadTick) v.setPlayheadTick(t); }
    else { if (cfg.views.drumtab && cfg.views.drumtab.setPlayheadSeconds) cfg.views.drumtab.setPlayheadSeconds(sec); }
  }
  function hidePlayhead() {
    if (cfg.views.pianoroll && cfg.views.pianoroll.setPlayheadTick) cfg.views.pianoroll.setPlayheadTick(0);
    if (cfg.views.basstab && cfg.views.basstab.setPlayheadTick) cfg.views.basstab.setPlayheadTick(-1);
    if (cfg.views.drumtab && cfg.views.drumtab.setPlayheadSeconds) cfg.views.drumtab.setPlayheadSeconds(-1);
  }
  function emit() {
    if (cfg.onUpdate) cfg.onUpdate({ playing: running, posSec: posSeconds(), durationSec: durSeconds(), source: source, view: view });
  }
  function frame() {
    var sec = posSeconds();
    pushPlayhead(sec);
    emit();
    var dur = durSeconds();
    var done = !enginePlaying() || (dur > 0 && sec >= dur - 0.02);
    if (done) { finalize(); return; }
    raf = requestAnimationFrame(frame);
  }
  function stopRaf() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }
  function finalize() { running = false; stopRaf(); enginePause(); emit(); }

  // ---- public transport ----------------------------------------------------
  function play() {
    if (running) return;
    if (!sourceAvailable(source)) { setSource('synth'); }
    enginePlay();
    running = true; stopRaf(); frame();
  }
  function pause() { if (!running) return; running = false; stopRaf(); enginePause(); emit(); }
  function stop() { running = false; stopRaf(); engineStop(); pushPlayhead(0); emit(); }
  function toggle() { running ? pause() : play(); }

  function seekSeconds(t) {
    engineSeek(t);
    pushPlayhead(Math.max(0, t));
    if (!running) emit();
  }
  function seekTick(t) { seekSeconds(Math.max(0, t) / tps()); }

  function setView(name) {
    if (name === view) return;
    if (running) stop();
    view = name;
    emit();
  }
  function setSource(name) {
    if (name === source) return;
    if (running) stop();
    source = name;
    emit();
  }
  function setMetro(on) { metroOn = !!on; if (source === 'synth' && isMelodic()) cfg.melodicSynth.setMetro(metroOn); }
  function rebuildMelodic() { cfg.melodicSynth.rebuild(); if (!running) emit(); }
  function setDrumEvents(events) { cfg.drumSynth.setEvents(events); }
  function setDrumDuration(d) { drumDuration = d || 0; }

  function sourceAvailable(name) {
    if (name === 'synth') {
      if (isMelodic()) { var p = project(); return !!(p.notes && p.notes.length) || true; }   // synth always selectable for melodic
      return drumDuration > 0;
    }
    if (name === 'original') {
      var oel = cfg.audios.original;
      return !!(oel && oel.getAttribute && oel.getAttribute('src')) || !!(cfg.youtube && cfg.youtube.hasVideo());
    }
    var el = cfg.audios.stem;
    return !!(el && el.getAttribute && el.getAttribute('src'));
  }

  return {
    init: init, setView: setView, setSource: setSource, getSource: function () { return source; },
    getView: function () { return view; }, play: play, pause: pause, stop: stop, toggle: toggle,
    seekSeconds: seekSeconds, seekTick: seekTick, setMetro: setMetro, rebuildMelodic: rebuildMelodic,
    setDrumEvents: setDrumEvents, setDrumDuration: setDrumDuration, sourceAvailable: sourceAvailable,
    isRunning: function () { return running; }, hidePlayhead: hidePlayhead
  };
})();
