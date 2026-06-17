/* ============================================================================
 * app.js  —  the unified Studio shell.
 *
 * Owns the PROJECT model (the app's document): a project bundles a YouTube link,
 * the song audio, isolated stems, and multiple editable instrument TRACKS (bass,
 * drums, piano, …) each with its own MIDI/drum data, stem and view options.
 * There's no multi-track timeline — you pick a track and see it in its
 * instrument-appropriate view (bass→bass tab, drums→drum tab, others→piano-roll),
 * all under one shared transport. Projects persist server-side (/api/projects)
 * with save + auto-update.
 * ========================================================================== */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  function show(el, on) { if (el) el.style.display = on ? '' : 'none'; }
  function fmt(sec) { sec = Math.max(0, sec || 0); var m = Math.floor(sec / 60), s = Math.floor(sec % 60); return m + ':' + (s < 10 ? '0' : '') + s; }
  function flash(msg) { var t = $('toast'); if (!t) return; t.textContent = msg; t.classList.add('show'); clearTimeout(flash._t); flash._t = setTimeout(function () { t.classList.remove('show'); }, 3000); }
  function revoke(u) { if (u && u.indexOf('blob:') === 0) { try { URL.revokeObjectURL(u); } catch (e) {} } }

  var currentView = 'pianoroll';
  var drumData = null;   // mirror of the active drum track for the drum tab
  // 'web' = the static build: offline editor + asset library, no backend (no AI,
  // no save / project library). 'desktop' = full app served by the local backend.
  var WEB = !!(window.STUDIO_CONFIG && window.STUDIO_CONFIG.mode === 'web');

  /* ---- instrument targets ---- */
  var TARGETS = {
    bass:   { id: 'bass',   label: 'Bass',   kind: 'melodic', stem: 'bass',  model: 'htdemucs',    minFreq: '30',  maxFreq: '400',  minNote: '80', onset: '0.5', frame: '0.3',  shifts: '2', center: 40, markers: { 28: 1, 33: 1, 38: 1, 43: 1 }, instrument: 'bass',  defaultView: 'basstab' },
    piano:  { id: 'piano',  label: 'Piano',  kind: 'melodic', stem: 'piano', model: 'htdemucs_6s', minFreq: '',    maxFreq: '',     minNote: '50', onset: '0.4', frame: '0.25', shifts: '2', center: 60, markers: {}, instrument: 'piano', defaultView: 'pianoroll' },
    guitar: { id: 'guitar', label: 'Guitar', kind: 'melodic', stem: 'guitar', model: 'htdemucs_6s', minFreq: '70', maxFreq: '1400', minNote: '60', onset: '0.4', frame: '0.3',  shifts: '2', center: 52, markers: { 40: 1, 45: 1, 50: 1, 55: 1, 59: 1, 64: 1 }, instrument: 'guitar', defaultView: 'guitartab' },
    vocals: { id: 'vocals', label: 'Vocals', kind: 'melodic', stem: 'vocals', model: 'htdemucs',    minFreq: '80', maxFreq: '1200', minNote: '80', onset: '0.5', frame: '0.3',  shifts: '2', center: 60, markers: {}, instrument: 'piano', defaultView: 'pianoroll' },
    keys:   { id: 'keys',   label: 'Keys',   kind: 'melodic', stem: 'other',  model: 'htdemucs',    minFreq: '',    maxFreq: '',    minNote: '60', onset: '0.4', frame: '0.3',  shifts: '2', center: 60, markers: {}, instrument: 'piano', defaultView: 'pianoroll' },
    drums:  { id: 'drums',  label: 'Drums',  kind: 'drum',    stem: 'drums', model: 'htdemucs',     shifts: '2', center: 48, markers: {}, instrument: 'bass', defaultView: 'drumtab' }
  };
  function curTarget() {
    var key = $('targetSel').value, T = TARGETS[key] || TARGETS.bass, m = T.model;
    if ($('ftChk').checked && m === 'htdemucs') m = 'htdemucs_ft';
    return Object.assign({}, T, { model: m });
  }
  function instLabel(id) { return (TARGETS[id] || {}).label || id; }
  function instKind(id) { return (TARGETS[id] || {}).kind || 'melodic'; }

  /* ====================== project model ====================== */
  function emptyProject() { return { id: null, name: '', youtubeUrl: '', song: null, tracks: {}, activeTrackId: null }; }
  var project = emptyProject();

  /* ---- views ---- */
  var roll = PianoRoll.create($('rollCanvas'), {
    onChange: function () { updateStats(); Transport.rebuildMelodic(); if (TAB_VIEWS[currentView]) TAB_VIEWS[currentView].render(); scheduleSave(); },
    onSeek: function (t) { Transport.seekTick(t); },
    onSelection: function (n) { $('selCount').textContent = n ? '  ·  ' + n + ' selected' : ''; },
    onTool: setToolUI,
    modalOpen: isModalOpen,
    follow: function () { return $('followChk').checked; }
  });
  var bassTab = BassTabView.create($('tabHost'), {
    getProject: function () { return roll.getProject(); },
    onSeekSeconds: function (s) { Transport.seekSeconds(s); },
    onStatus: function (ergo) { updateErgo(ergo); },
    onChange: function () { scheduleSave(); }   // fingering override edits
  });
  // Guitar Tab reuses the same fretted-instrument engine/renderer with a 6-string
  // standard tuning. Both tab views read the shared piano-roll notes (getProject).
  var guitarTab = BassTabView.create($('guitarTabHost'), {
    getProject: function () { return roll.getProject(); },
    onSeekSeconds: function (s) { Transport.seekSeconds(s); },
    onStatus: function (ergo) { updateGuitarErgo(ergo); },
    onChange: function () { scheduleSave(); },
    tuning: BassTab.GUITAR_TUNING
  });
  // Guitar Chords (Tab Type 1): chord progression + diagram charts, detected from
  // the same shared piano-roll notes via ChordCore.
  var guitarChords = GuitarChordView.create($('guitarChordHost'), {
    getProject: function () { return roll.getProject(); },
    onSeekSeconds: function (s) { Transport.seekSeconds(s); },
    onStatus: function (st) { updateChordInfo(st); }
  });
  // view-name -> view controller that re-renders from the shared notes when active.
  var TAB_VIEWS = { basstab: bassTab, guitartab: guitarTab, guitarchords: guitarChords };
  function melodicViewFor(instrument) {
    return instrument === 'bass' ? 'basstab' : instrument === 'guitar' ? 'guitartab' : 'pianoroll';
  }
  function tabViewForInstrument(instrument) { return TAB_VIEWS[melodicViewFor(instrument)] || null; }
  guitarTab.setOptions({ maxFret: 19 });   // guitar default (vs the view's 24-fret bass default)

  // Playing-style router: chordal/strummed guitar -> chord charts (Type 1); single-note
  // lead/riff -> 6-string tab (Type 2). Uses the polyphony signal validated in research
  // (fraction of time >=3 notes sound at once — the dominant comp-vs-solo discriminator).
  function guitarPolyphony(notes, ppq) {
    if (!notes || !notes.length) return 0;
    var end = notes.reduce(function (m, n) { return Math.max(m, n.end); }, 0);
    var step = Math.max(1, Math.round((ppq || 480) / 4));   // 16th-note grid
    var hi = 0, tot = 0;
    for (var t = 0; t < end; t += step) {
      var c = 0;
      for (var i = 0; i < notes.length; i++) if (notes[i].start <= t && notes[i].end > t) c++;
      if (c >= 3) hi++; tot++;
    }
    return tot ? hi / tot : 0;
  }
  function defaultGuitarView(notes, ppq) { return guitarPolyphony(notes, ppq) >= 0.30 ? 'guitarchords' : 'guitartab'; }
  var drumRoll = DrumRoll.create($('drumCanvas'), {
    onEdit: function (events) {
      if (drumData) { drumData.events = events; drumData.duration = Math.max(drumData.duration || 0, drumEnd(events)); Transport.setDrumDuration(drumData.duration); }
      Transport.setDrumEvents(events); renderDrumSheet(); scheduleSave();
    },
    onHistory: function (u, r) { $('dUndo').disabled = !u; $('dRedo').disabled = !r; },
    onTool: function (t) { dToolUI(t); },   // keep the toolbar in sync with keyboard tool changes (B/V)
    onSeekSeconds: function (s) { Transport.seekSeconds(s); },   // click the drum timeline to move the playhead
    isPlaying: function () { return Transport.isRunning(); },     // drives play-time auto-follow (~30% from left)
    modalOpen: isModalOpen
  });
  function drumEnd(events) { return (events || []).reduce(function (a, e) { return Math.max(a, e.time_sec || 0); }, 0) + 0.5; }

  /* ---- synth + transport ---- */
  EditorPlayer.configure({ getProject: function () { return roll.getProject(); }, setPlayhead: function () { }, onState: function () { } });
  YouTubePlayer.mount('ytPlayer');
  Transport.init({
    getProject: function () { return roll.getProject(); },
    melodicSynth: EditorPlayer, drumSynth: DrumSynth,
    audios: { original: $('songAudio'), stem: $('stemAudio') },
    youtube: YouTubePlayer,
    views: {
      pianoroll: { setPlayheadTick: function (t) { roll.setPlayhead(t); } },
      basstab: { setPlayheadTick: function (t) { bassTab.setPlayheadTick(t); } },
      guitartab: { setPlayheadTick: function (t) { guitarTab.setPlayheadTick(t); } },
      guitarchords: { setPlayheadTick: function (t) { guitarChords.setPlayheadTick(t); } },
      drumtab: { setPlayheadSeconds: function (s) { drumRoll.setPlayhead(s); updateDrumSheetPlayhead(s); } }
    },
    onUpdate: onTransport
  });
  function onTransport(st) {
    $('btnPlay').textContent = st.playing ? '⏸' : '▶';
    $('timeNow').textContent = fmt(st.posSec); $('timeTotal').textContent = fmt(st.durationSec);
  }

  /* ---- backend client (desktop only — the web build has no backend) ---- */
  if (!WEB) Workflow.init({
    getTarget: curTarget,
    onSong: onSong, onStem: onStem,
    onMelodicMidi: onMelodicResult, onDrumData: onDrumResult,
    onMidiFile: openMidiFile, flash: flash
  });

  /* ====================== view switching ====================== */
  function setTabEnabled(view, on) {
    var b = $('viewTabs').querySelector('[data-view=' + view + ']');
    if (b) { b.classList.toggle('disabled', !on); if (!on) b.classList.remove('on'); }
  }
  function updateViewAvailability(instrument) {
    var isDrum = instKind(instrument) === 'drum';
    setTabEnabled('pianoroll', !isDrum);
    setTabEnabled('basstab', instrument === 'bass');
    setTabEnabled('guitartab', instrument === 'guitar');
    setTabEnabled('guitarchords', instrument === 'guitar');
    setTabEnabled('drumtab', isDrum);
  }
  function setView(name) {
    var b = $('viewTabs').querySelector('[data-view=' + name + ']');
    if (b && b.classList.contains('disabled')) return;
    currentView = name;
    Array.prototype.forEach.call($('viewTabs').children, function (x) { x.classList.toggle('on', x.dataset.view === name); });
    show($('panePianoRoll'), name === 'pianoroll'); show($('paneBassTab'), name === 'basstab'); show($('paneGuitarTab'), name === 'guitartab'); show($('paneGuitarChords'), name === 'guitarchords'); show($('paneDrumTab'), name === 'drumtab');
    show($('toolsPianoRoll'), name === 'pianoroll'); show($('toolsBassTab'), name === 'basstab'); show($('toolsGuitarTab'), name === 'guitartab'); show($('toolsGuitarChords'), name === 'guitarchords'); show($('toolsDrumTab'), name === 'drumtab');
    Transport.setView(name);
    if (name === 'pianoroll') roll.redraw();
    else if (TAB_VIEWS[name]) TAB_VIEWS[name].render();
    else if (name === 'drumtab') drumRoll.render();
    refreshSrcButtons();
  }
  $('viewTabs').addEventListener('click', function (e) { var b = e.target.closest('.vtab'); if (b && !b.classList.contains('disabled')) setView(b.dataset.view); });

  /* ====================== tracks ====================== */
  function trackList() { return Object.keys(project.tracks).map(function (k) { return project.tracks[k]; }); }

  function serializeActive() {
    var id = project.activeTrackId; if (!id) return;
    var t = project.tracks[id]; if (!t) return;
    if (t.kind === 'drum') { t.events = drumRoll.getEvents(); t.duration = Math.max(t.duration || 0, drumEnd(t.events)); t.gridOffset = drumRoll.getGridOffset(); if (drumData) t.tempo = drumData.tempo; }
    else {
      var pj = roll.getProject();
      t.notes = pj.notes; t.ppq = pj.ppq; t.tempo = pj.tempo; t.timeSig = pj.timeSig;
      var tv = tabViewForInstrument(t.instrument);
      if (tv) { t.view = tv.getOptions(); t.overrides = tv.getOverrides(); }
    }
  }

  function activateTrack(id, opts) {
    opts = opts || {};
    var t = project.tracks[id]; if (!t) return;
    if (project.activeTrackId && project.activeTrackId !== id) serializeActive();
    project.activeTrackId = id;
    var wasLoading = loading; loading = true;
    $('targetSel').value = t.instrument; applyTarget();
    updateViewAvailability(t.instrument);
    if (t.kind === 'drum') {
      drumData = { events: t.events || [], tempo: t.tempo || 120, duration: Math.max(t.duration || 0, drumEnd(t.events)), gridOffset: t.gridOffset || 0, adtlib: false };
      drumRoll.setData(drumData); drumRoll.zoomFit();
      Transport.setDrumEvents(drumData.events); Transport.setDrumDuration(drumData.duration);
      Transport.setDrumTempo(drumData.tempo); Transport.setDrumGridOffset(drumData.gridOffset);
      $('dGridShift').value = drumData.gridOffset;
      $('bpmInput').value = Math.round(drumData.tempo);   // the transport BPM box reflects the drum tempo
      show($('drumEmpty'), !(t.events && t.events.length));
      setStemAudio(t.stem);
      setView('drumtab');
      renderDrumSheet();
    } else {
      roll.load({ ppq: t.ppq || 480, tempo: t.tempo || 120, timeSig: t.timeSig || { num: 4, den: 4 }, notes: t.notes || [] });
      $('bpmInput').value = Math.round(t.tempo || 120);
      $('tsNum').value = (t.timeSig && t.timeSig.num) || 4; $('tsDen').value = (t.timeSig && t.timeSig.den) || 4;
      var tv = tabViewForInstrument(t.instrument);
      if (tv) {
        tv.setOverrides(t.overrides || {});
        tv.setOptions(t.view || {});               // re-renders the tab
        syncTabToolbar(t.instrument, tv.getOptions());
      }
      Transport.rebuildMelodic();
      setStemAudio(t.stem);
      // Auto-route guitar to chords vs 6-string tab by detected style (user can still switch tabs).
      var mview = melodicViewFor(t.instrument);
      if (t.instrument === 'guitar' && !opts.keepView) mview = defaultGuitarView(t.notes || [], t.ppq || 480);
      setView(mview);
    }
    loading = wasLoading;
    updateStats(); renderTracks(); refreshSrcButtons();
  }

  // Mint a unique track id for an instrument (bass -> bass, then bass-2, bass-3 …),
  // so multiple tracks of the same instrument (e.g. two guitars) can coexist.
  function uniqueTrackId(base) {
    if (!project.tracks[base]) return base;
    var i = 2; while (project.tracks[base + '-' + i]) i++;
    return base + '-' + i;
  }
  // opts.id pins the track id (default = instrument, the single-track case);
  // opts.name overrides the label; opts.activate=false adds without switching to it.
  function upsertMelodic(instrument, m, opts) {
    opts = opts || {};
    var T = TARGETS[instrument] || TARGETS.bass;
    var id = opts.id || instrument;
    var t = project.tracks[id] || { id: id, instrument: instrument, kind: 'melodic', name: opts.name || T.label, view: {}, overrides: {} };
    if (opts.name) t.name = opts.name;
    t.notes = m.notes; t.ppq = m.ppq; t.tempo = m.tempo; t.timeSig = m.timeSig;
    project.tracks[id] = t;
    if (opts.activate !== false) activateTrack(id);
    scheduleSave();
    return t;
  }

  // Split a guitar track into a monophonic LEAD track (-> 6-string tab) and a
  // RHYTHM track (the chordal remainder -> chord charts). The original track keeps
  // its id and becomes the rhythm part; a new track holds the lead. Both share the
  // guitar stem. This is how one guitar stem (rhythm + lead at once) becomes two.
  function splitGuitarTrack(srcId) {
    var t = project.tracks[srcId];
    if (!t || t.instrument !== 'guitar' || t.kind !== 'melodic') { flash('Select a guitar track to split.'); return; }
    if (project.activeTrackId === srcId) serializeActive();   // capture live edits first
    var parts = ChordCore.splitLeadRhythm(t.notes || [], t.ppq || 480);
    if (!parts.lead.length || !parts.rhythm.length) { flash('This part doesn’t split into distinct lead + rhythm.'); return; }
    var leadId = uniqueTrackId('guitar');
    var lead = upsertMelodic('guitar', { notes: parts.lead, ppq: t.ppq, tempo: t.tempo, timeSig: t.timeSig },
                             { id: leadId, name: 'Guitar (lead)', activate: false });
    if (t.stem) lead.stem = t.stem;                            // share the same guitar stem
    t.name = 'Guitar (rhythm)'; t.notes = parts.rhythm; t.view = {}; t.overrides = {};
    renderTracks();
    activateTrack(srcId);                                      // land on the rhythm/chords part
    flash('Split guitar → Lead (' + parts.lead.length + ') + Rhythm (' + parts.rhythm.length + ' notes).');
    scheduleSave();
  }
  // Detect a guitar part that carries a rhythm AND a lead at once, and hint to split.
  function maybeSuggestSplit(notes, ppq) {
    if (ChordCore.concurrency(notes) >= 0.5)
      flash('This guitar part plays rhythm + lead together — use “Split parts” to get two guitar tracks.');
  }
  function upsertDrums(data) {
    var t = project.tracks.drums || { id: 'drums', instrument: 'drums', kind: 'drum', name: 'Drums' };
    t.events = data.events || []; t.tempo = data.tempo || 120; t.duration = data.duration || 0;
    project.tracks.drums = t;
    activateTrack('drums');
    scheduleSave();
  }

  function removeTrack(id) {
    if (!project.tracks[id]) return;
    if (!confirm('Remove the ' + (project.tracks[id].name || id) + ' track from this project?')) return;
    var st = project.tracks[id].stem; if (st) revoke(st.url);
    delete project.tracks[id];
    if (project.activeTrackId === id) {
      project.activeTrackId = null;
      var next = Object.keys(project.tracks)[0];
      if (next) activateTrack(next); else clearEditors();
    }
    renderTracks(); scheduleSave();
  }

  function renderTracks() {
    var strip = $('trackStrip'); if (!strip) return;
    strip.innerHTML = '';
    var tracks = trackList();
    show($('trackbar'), true);
    if (!tracks.length) { var e = document.createElement('span'); e.className = 'dim'; e.textContent = 'No tracks yet — extract one above, or open a project.'; strip.appendChild(e); return; }
    tracks.forEach(function (t) {
      var chip = document.createElement('span');
      chip.className = 'trk' + (t.id === project.activeTrackId ? ' on' : '');
      var lab = document.createElement('button'); lab.className = 'trk-lab'; lab.textContent = t.name + (t.stem ? ' ♪' : '');
      lab.title = t.instrument + (t.kind === 'drum' ? ' · ' + (t.events ? t.events.length : 0) + ' hits' : ' · ' + (t.notes ? t.notes.length : 0) + ' notes') + (t.stem ? ' · stem' : '');
      lab.onclick = function () { if (t.id !== project.activeTrackId) activateTrack(t.id); };
      var x = document.createElement('button'); x.className = 'trk-x'; x.textContent = '✕'; x.title = 'Remove track';
      x.onclick = function (e) { e.stopPropagation(); removeTrack(t.id); };
      chip.appendChild(lab); chip.appendChild(x); strip.appendChild(chip);
    });
  }

  /* ====================== source / pipeline results ====================== */
  function onSong(blob, name, youtubeUrl) {
    if (project.song) revoke(project.song.url);
    project.song = { name: name, blob: blob, url: URL.createObjectURL(blob), file: null };
    if (youtubeUrl) { project.youtubeUrl = youtubeUrl; $('ytUrl').value = youtubeUrl; }
    if (!project.name) { project.name = name.replace(/\.[^.]+$/, ''); $('projName').value = project.name; }
    $('songName').textContent = name + (youtubeUrl ? '  ·  YouTube' : ''); show($('songMeta'), true);
    $('songAudio').src = project.song.url; show($('songAudioRow'), true);
    refreshSrcButtons();
    if (project.id) uploadSong().then(scheduleSaveNow);
  }
  function onStem(blob, name, instrument) {
    var t = project.tracks[instrument];
    if (!t) { t = { id: instrument, instrument: instrument, kind: instKind(instrument), name: instLabel(instrument), view: {}, overrides: {} }; project.tracks[instrument] = t; }
    if (t.stem) revoke(t.stem.url);
    t.stem = { name: name, blob: blob, url: URL.createObjectURL(blob), file: null };
    if (project.activeTrackId === t.id) setStemAudio(t.stem);
    renderTracks(); refreshSrcButtons();
    if (project.id) uploadStem(t.id).then(scheduleSaveNow);
  }
  function onMelodicResult(bytes, instrument) {
    var m = MidiIO.read(bytes);
    upsertMelodic(instrument, { notes: m.notes, ppq: m.ppq, tempo: m.tempo, timeSig: m.timeSig });
    flash(m.notes.length + ' notes → ' + instLabel(instrument) + ' track.');
    if (instrument === 'guitar') maybeSuggestSplit(m.notes, m.ppq);
  }
  function onDrumResult(data) { upsertDrums(data); flash((data.events || []).length + ' drum hits → Drums track.'); }

  // Parse MIDI bytes into a track (drum channel → drum tab, else a melodic track).
  // Shared by file import and the static example loader.
  function importMidiBytes(bytes, opts) {
    opts = opts || {};
    var m = MidiIO.read(bytes);
    var drumCh = m.notes.filter(function (n) { return n.channel === 9; }).length;
    if (m.notes.length && drumCh / m.notes.length >= 0.5) {
      var tps = (m.tempo / 60) * (m.ppq || 480);
      var events = m.notes.map(function (n) { return { time_sec: n.start / tps, type: DrumTabCore.GM_TO_TYPE[n.pitch], velocity: n.velocity || 100 }; }).filter(function (e) { return e.type; });
      var dur = m.notes.reduce(function (a, n) { return Math.max(a, n.end); }, 0) / tps;
      upsertDrums({ events: events, tempo: m.tempo, duration: dur });
      flash(events.length + ' drum hits imported.');
    } else {
      var inst = opts.instrument || (instKind(curTarget().id) === 'melodic' ? curTarget().id : 'bass');
      upsertMelodic(inst, { notes: m.notes, ppq: m.ppq, tempo: m.tempo, timeSig: m.timeSig }, { id: opts.id, name: opts.name });
      flash(m.notes.length + ' notes imported → ' + (opts.name || instLabel(inst)) + '.');
    }
  }
  function openMidiFile(file) {
    var r = new FileReader();
    r.onload = function () {
      try { importMidiBytes(new Uint8Array(r.result)); }
      catch (e) { flash('Could not read MIDI: ' + e.message); }
    };
    r.readAsArrayBuffer(file);
  }

  function setStemAudio(stem) {
    var a = $('stemAudio');
    if (stem && stem.url) { a.src = stem.url; show($('stemRow'), true); }
    else { a.removeAttribute('src'); show($('stemRow'), false); }
    refreshSrcButtons();
  }
  function clearEditors() {
    var wasLoading = loading; loading = true;
    roll.load({ ppq: 480, tempo: 120, timeSig: { num: 4, den: 4 }, notes: [] });
    drumData = null; if (drumRoll.clearData) drumRoll.clearData(); show($('drumEmpty'), true);
    bassTab.setOverrides({}); bassTab.render(); guitarTab.setOverrides({}); guitarTab.render(); guitarChords.clear();
    setStemAudio(null); updateStats(); updateViewAvailability('bass'); setView('pianoroll');
    loading = wasLoading;
  }

  /* ====================== persistence ====================== */
  var saveTimer = null, loading = false, dirty = false, pendingUploads = 0;
  function markSave(s) { var e = $('saveStatus'); if (e) e.textContent = s; }
  // `loading` suppresses saves during programmatic track/project loads (so merely
  // browsing tracks or opening a project doesn't dirty/re-PUT it).
  function scheduleSave() {
    if (loading) return;
    dirty = true;
    if (!project.id) { markSave('unsaved'); return; }
    markSave('•'); clearTimeout(saveTimer); saveTimer = setTimeout(doSave, 800);
  }
  function scheduleSaveNow() { if (!project.id) return; clearTimeout(saveTimer); doSave(); }
  function serializeMeta() {
    var tracks = trackList().map(function (t) {
      var o = { id: t.id, instrument: t.instrument, kind: t.kind, name: t.name };
      if (t.kind === 'drum') { o.events = (t.events || []).map(function (e) { return { time_sec: e.time_sec, type: e.type, velocity: e.velocity }; }); o.tempo = t.tempo || 120; o.duration = t.duration || 0; o.gridOffset = t.gridOffset || 0; }
      else { o.notes = t.notes || []; o.ppq = t.ppq || 480; o.tempo = t.tempo || 120; o.timeSig = t.timeSig || { num: 4, den: 4 }; o.view = t.view || {}; o.overrides = t.overrides || {}; }
      if (t.stem && t.stem.file) o.stem = { file: t.stem.file, name: t.stem.name };
      return o;
    });
    return { id: project.id, name: project.name || 'Untitled', youtubeUrl: project.youtubeUrl || '',
      song: project.song && project.song.file ? { file: project.song.file, name: project.song.name } : null,
      tracks: tracks, activeTrackId: project.activeTrackId };
  }
  function doSave() {
    if (!project.id) return;
    // never PUT project.json while an audio upload is in flight — serializeMeta
    // omits a song/stem whose .file isn't set yet, which would drop the reference.
    if (pendingUploads > 0) { clearTimeout(saveTimer); saveTimer = setTimeout(doSave, 300); return; }
    serializeActive();
    markSave('saving…');
    fetch('/api/projects/' + project.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(serializeMeta()) })
      .then(function (r) { if (!r.ok) throw new Error('save failed'); return r.json(); })
      .then(function () { dirty = false; markSave('saved ✓'); })
      .catch(function () { markSave('save failed'); flash('Auto-save failed (backend offline?) — your edits are not saved.'); });
  }
  function uploadSong() {
    if (!project.id || !project.song || !project.song.blob) return Promise.resolve();
    pendingUploads++;
    var fd = new FormData(); fd.append('file', project.song.blob, project.song.name || 'song.mp3'); fd.append('role', 'song');
    return fetch('/api/projects/' + project.id + '/audio', { method: 'POST', body: fd })
      .then(function (r) { if (!r.ok) throw new Error('upload failed'); return r.json(); })
      .then(function (j) { project.song.file = j.file; })
      .catch(function () { flash('Song upload failed — audio not saved.'); })
      .then(function () { pendingUploads--; });
  }
  function uploadStem(trackId) {
    var t = project.tracks[trackId];
    if (!project.id || !t || !t.stem || !t.stem.blob || t.stem.file) return Promise.resolve();
    // Key the backend stem file by INSTRUMENT (not track id) so split tracks that
    // share one guitar stem map to the same stems/guitar.wav instead of duplicating.
    var inst = t.instrument || 'stem';
    pendingUploads++;
    var fd = new FormData(); fd.append('file', t.stem.blob, t.stem.name || (inst + '.wav')); fd.append('role', 'stem'); fd.append('instrument', inst);
    return fetch('/api/projects/' + project.id + '/audio', { method: 'POST', body: fd })
      .then(function (r) { if (!r.ok) throw new Error('upload failed'); return r.json(); })
      .then(function (j) { t.stem.file = j.file; })
      .catch(function () { flash('Stem upload failed — audio not saved.'); })
      .then(function () { pendingUploads--; });
  }

  function projectHasContent() { return !!(project.song || Object.keys(project.tracks).length); }
  function confirmDiscard() { return !(dirty && projectHasContent()) || confirm('Discard unsaved changes to the current project?'); }
  // Returns true if it actually reset; false if the user cancelled the discard
  // prompt — callers (loadExample/loadDemo) must bail on false or they'd clobber
  // (and auto-save over) the project the user chose to keep.
  function newProject(silent) {
    if (!confirmDiscard()) return false;
    clearTimeout(saveTimer);
    if (project.song) revoke(project.song.url);
    trackList().forEach(function (t) { if (t.stem) revoke(t.stem.url); });
    project = emptyProject(); dirty = false; Workflow.reset();
    $('projName').value = ''; $('ytUrl').value = ''; markSave('');
    show($('songMeta'), false); $('songAudio').removeAttribute('src'); show($('songAudioRow'), false);
    YouTubePlayer.clear(); $('ytPanel').style.display = 'none';
    Transport.stop(); clearEditors(); renderTracks();
    if (!silent) flash('New project.');
    return true;
  }
  function saveProject() {
    if (project.id) { scheduleSaveNow(); return; }
    project.name = ($('projName').value || '').trim() || defaultName();
    $('projName').value = project.name;
    var fd = new FormData(); fd.append('name', project.name);
    markSave('creating…');
    fetch('/api/projects', { method: 'POST', body: fd })
      .then(function (r) { if (!r.ok) throw new Error('create failed'); return r.json(); })
      .then(function (j) {
        project.id = j.id;
        var ups = [];
        if (project.song && project.song.blob) ups.push(uploadSong());
        trackList().forEach(function (t) { if (t.stem && t.stem.blob) ups.push(uploadStem(t.id)); });
        return Promise.all(ups);
      })
      .then(function () { doSave(); flash('Project saved: ' + project.name); })
      .catch(function () { markSave('save failed'); flash('Could not save project (backend offline?).'); });
  }
  function defaultName() {
    if (project.song && project.song.name) return project.song.name.replace(/\.[^.]+$/, '');
    return 'Untitled ' + new Date().toLocaleDateString();
  }
  function openProject(id) {
    if (!confirmDiscard()) return;
    clearTimeout(saveTimer);
    fetch('/api/projects/' + id).then(function (r) { if (!r.ok) throw new Error('not found'); return r.json(); })
      .then(function (meta) {
        if (project.song) revoke(project.song.url);
        trackList().forEach(function (t) { if (t.stem) revoke(t.stem.url); });
        project = emptyProject();
        project.id = meta.id; project.name = meta.name || 'Untitled'; project.youtubeUrl = meta.youtubeUrl || '';
        $('projName').value = project.name; $('ytUrl').value = project.youtubeUrl;
        // Saved-project audio is served same-origin by the local backend.
        var audUrl = function (file) {
          var enc = String(file).split('/').map(encodeURIComponent).join('/');  // keep '/' separators, escape segments
          return '/api/projects/' + id + '/audio/' + enc;
        };
        if (meta.song && meta.song.file) {
          project.song = { name: meta.song.name, file: meta.song.file, url: audUrl(meta.song.file), blob: null };
          $('songName').textContent = (meta.song.name || 'song') + (project.youtubeUrl ? '  ·  YouTube' : ''); show($('songMeta'), true);
          $('songAudio').src = project.song.url; show($('songAudioRow'), true);
          // materialize the song into a Blob so the pipeline can extract more tracks from it
          fetch(project.song.url).then(function (r) { return r.ok ? r.blob() : null; }).then(function (b) { if (b) { project.song.blob = b; Workflow.adoptSong(b, project.song.name); } }).catch(function () { });
        } else { show($('songMeta'), false); $('songAudio').removeAttribute('src'); Workflow.reset(); }
        (meta.tracks || []).forEach(function (t) {
          var tr = { id: t.id || t.instrument, instrument: t.instrument, kind: t.kind, name: t.name || instLabel(t.instrument) };
          if (t.kind === 'drum') { tr.events = t.events || []; tr.tempo = t.tempo || 120; tr.duration = t.duration || 0; tr.gridOffset = t.gridOffset || 0; }
          else { tr.notes = t.notes || []; tr.ppq = t.ppq || 480; tr.tempo = t.tempo || 120; tr.timeSig = t.timeSig || { num: 4, den: 4 }; tr.view = t.view || {}; tr.overrides = t.overrides || {}; }
          if (t.stem && t.stem.file) tr.stem = { name: t.stem.name, file: t.stem.file, url: audUrl(t.stem.file), blob: null };
          project.tracks[tr.id] = tr;
        });
        renderTracks();
        var first = (meta.activeTrackId && project.tracks[meta.activeTrackId]) ? meta.activeTrackId : Object.keys(project.tracks)[0];
        if (first) activateTrack(first); else clearEditors();
        dirty = false; markSave('saved ✓'); closeLibrary(); flash('Opened: ' + project.name);
      })
      .catch(function (e) { flash('Could not open project: ' + e.message); });
  }
  function deleteProject(id) {
    fetch('/api/projects/' + id, { method: 'DELETE' }).then(function () {
      if (project.id === id) newProject();
      fetchProjects();
    }).catch(function () { flash('Could not delete project.'); });
  }

  /* ====================== project library ====================== */
  var libProjects = [], libLoaded = false, libExamples = null;
  function openLibrary() { $('libOverlay').style.display = ''; $('libSearch').value = ''; libLoaded = false; renderLibrary(); if (!WEB) fetchProjects(); loadExamples(); setTimeout(function () { $('libSearch').focus(); }, 30); }
  function closeLibrary() { $('libOverlay').style.display = 'none'; }
  function fetchProjects() {
    fetch('/api/projects', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : { projects: [] }; })
      .then(function (j) { libProjects = (j && j.projects) || []; libLoaded = true; renderLibrary(); })
      .catch(function () { libProjects = []; libLoaded = true; renderLibrary(); });
  }
  // Static asset library — bundled example tabs served alongside the frontend
  // (same-origin /assets, no backend or token needed; works even when offline).
  // isHtml: the SPA fallback (_redirects '/* /index.html 200') serves index.html
  // with HTTP 200 for a MISSING asset — so a 200 alone doesn't mean the file
  // exists. Reject HTML so a not-deployed asset fails clearly, not as MIDI garbage.
  function isHtml(r) { return /text\/html/i.test(r.headers.get('content-type') || ''); }
  function loadExamples() {
    if (libExamples) { renderLibrary(); return; }
    // no-cache (revalidate): the manifest changes when examples are added, so it
    // must NOT be force-cached/immutable. The MIDIs it points to are stable.
    fetch('assets/manifest.json', { cache: 'no-cache' })
      .then(function (r) { return (r.ok && !isHtml(r)) ? r.json() : null; })
      .then(function (j) { libExamples = (j && j.examples) || []; renderLibrary(); })
      .catch(function () { libExamples = []; });
  }
  // An example is a project with one or more tracks (bass + drums). Old single-file
  // form ({file,instrument}) is still supported.
  function exampleTracks(ex) { return ex.tracks || (ex.file ? [{ file: ex.file, instrument: ex.instrument }] : []); }
  function loadExample(ex) {
    var tracks = exampleTracks(ex);
    if (!tracks.length) { flash('Empty example.'); return; }
    Promise.all(tracks.map(function (t) {
      return fetch('assets/' + encodeURIComponent(t.file), { cache: 'force-cache' })
        .then(function (r) { if (!r.ok || isHtml(r)) throw new Error(t.file + ' not deployed (HTTP ' + r.status + ')'); return r.arrayBuffer(); })
        .then(function (buf) { return { bytes: new Uint8Array(buf), instrument: t.instrument, name: t.name }; });
    })).then(function (loaded) {
      if (!newProject(true)) return;          // user cancelled the discard prompt
      project.name = ex.name; $('projName').value = ex.name;
      // assign a unique id per repeated instrument so e.g. two guitar tracks coexist
      var seen = {};
      loaded.forEach(function (l) {
        var n = seen[l.instrument] || 0; seen[l.instrument] = n + 1;
        var id = n === 0 ? l.instrument : l.instrument + '-' + (n + 1);
        importMidiBytes(l.bytes, { instrument: l.instrument, id: id, name: l.name });
      });
      var first = Object.keys(project.tracks)[0];   // land on the first track (bass)
      if (first) activateTrack(first);
      if (ex.youtube) setSongYouTube(ex.youtube);   // wire the song's YouTube as the "Song" source
      closeLibrary(); flash('Loaded example: ' + ex.name + ' — Save to keep it.');
    }).catch(function (e) { flash('Could not load "' + ex.name + '": ' + e.message); });
  }
  function renderLibrary() {
    var q = ($('libSearch').value || '').toLowerCase().trim();
    var list = $('libList'); list.innerHTML = '';
    var items = libProjects.filter(function (p) { return !q || (p.name || '').toLowerCase().indexOf(q) >= 0; });
    if (!items.length) {
      // In web mode there's no server project list — the pinned examples below are
      // the whole library, so only show an empty hint when filtering hides them.
      var emptyMsg = WEB ? (q ? 'No examples match.' : '') : (libLoaded ? (libProjects.length ? 'No projects match.' : 'No saved projects yet — load a song, extract a track, then Save.') : 'Loading…');
      show($('libEmpty'), !!emptyMsg); $('libEmpty').textContent = emptyMsg;
    }
    else {
      show($('libEmpty'), false);
      items.forEach(function (p) {
        var row = document.createElement('div'); row.className = 'lib-item';
        var open = document.createElement('button'); open.className = 'lib-open';
        var nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = p.name || 'Untitled';
        var meta = document.createElement('span'); meta.className = 'meta';
        var insts = (p.instruments || []).filter(Boolean);
        meta.textContent = (insts.length ? insts.join(' · ') : 'empty') + (p.hasSong ? '  ·  ♪' : '') + (p.youtubeUrl ? '  ·  YT' : '') + '  ·  ' + fmtDate(p.updated);
        open.appendChild(nm); open.appendChild(meta);
        open.onclick = function () { openProject(p.id); };
        var del = document.createElement('button'); del.className = 'lib-del'; del.textContent = '🗑'; del.title = 'Delete project';
        del.onclick = function (e) { e.stopPropagation(); if (confirm('Delete project "' + (p.name || 'Untitled') + '"? This removes its saved audio + tracks.')) deleteProject(p.id); };
        row.appendChild(open); row.appendChild(del); list.appendChild(row);
      });
    }
    // pinned offline content: static asset-library examples + the built-in demo.
    function pinned(name, meta, onClick) {
      var row = document.createElement('div'); row.className = 'lib-item demo';
      var b = document.createElement('button'); b.className = 'lib-open';
      var nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = name;
      var mt = document.createElement('span'); mt.className = 'meta'; mt.textContent = meta;
      b.appendChild(nm); b.appendChild(mt); b.onclick = onClick;
      row.appendChild(b); list.appendChild(row);
    }
    (libExamples || []).filter(function (e) { return !q || (e.name || '').toLowerCase().indexOf(q) >= 0; })
      .forEach(function (e) {
        var insts = exampleTracks(e).map(function (t) { return t.instrument; }).join(' · ') || 'bass';
        pinned(e.name, insts + ' · example', function () { loadExample(e); });
      });
    pinned('Demo bass line', 'built-in · offline quick-start', loadDemo);
  }
  function fmtDate(t) { if (!t) return '—'; try { return new Date(t * 1000).toLocaleString(); } catch (e) { return '—'; } }
  function loadDemo() {
    if (!newProject(true)) return;
    project.tracks.bass = { id: 'bass', instrument: 'bass', kind: 'melodic', name: 'Bass', view: {}, overrides: {},
      ppq: 480, tempo: 110, timeSig: { num: 4, den: 4 }, notes: exampleNotes() };
    renderTracks(); activateTrack('bass'); closeLibrary(); flash('Demo bass line loaded — Save to keep it.');
  }

  /* ====================== transport UI ====================== */
  $('btnPlay').onclick = function () { Transport.toggle(); };
  $('btnStop').onclick = function () { Transport.stop(); };
  var metro = false;
  $('btnMetro').onclick = function () { metro = !metro; this.classList.toggle('on', metro); this.setAttribute('aria-pressed', metro); Transport.setMetro(metro); };
  $('srcSeg').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-src]');
    if (b && !b.disabled) {
      Transport.setSource(b.dataset.src); refreshSrcButtons();
      // selecting the Song source re-shows the (hideable) video panel
      if (b.dataset.src === 'original' && YouTubePlayer.hasVideo()) $('ytPanel').style.display = '';
    }
  });
  // Wire a song's YouTube video as the "Song" source (web app has no audio file).
  function setSongYouTube(url) {
    if (url && YouTubePlayer.load(url)) {
      project.youtubeUrl = url;
      $('ytTitle').textContent = 'YouTube';
      $('ytPanel').style.display = '';
    } else {
      YouTubePlayer.clear();
      $('ytPanel').style.display = 'none';
    }
    refreshSrcButtons();
  }
  $('ytHide').onclick = function () { $('ytPanel').style.display = 'none'; };
  function refreshSrcButtons() {
    var seg = $('srcSeg');
    seg.querySelector('[data-src=original]').disabled = !Transport.sourceAvailable('original');
    seg.querySelector('[data-src=stem]').disabled = !Transport.sourceAvailable('stem');
    var synthBtn = seg.querySelector('[data-src=synth]');
    synthBtn.disabled = !Transport.sourceAvailable('synth');
    if (!Transport.sourceAvailable(Transport.getSource())) Transport.setSource('synth');
    Array.prototype.forEach.call(seg.children, function (b) { b.classList.toggle('on', b.dataset.src === Transport.getSource()); });
  }
  ['songAudio', 'stemAudio'].forEach(function (id) { var el = $(id); if (el) ['loadeddata', 'canplay', 'emptied'].forEach(function (ev) { el.addEventListener(ev, refreshSrcButtons); }); });

  $('bpmInput').addEventListener('change', function () {
    var v = +this.value || 120, t = project.tracks[project.activeTrackId];
    if (t && t.kind === 'drum') {   // drums own their own tempo (the grid + sheet + metronome all key off it)
      t.tempo = v; if (drumData) drumData.tempo = v;
      Transport.setDrumTempo(v); drumRoll.render(); renderDrumSheet(); scheduleSave();
    } else { roll.setTempo(v); }
  });
  function setTS() { roll.setTimeSig(+$('tsNum').value || 4, +$('tsDen').value || 4); }
  $('tsNum').addEventListener('change', setTS); $('tsDen').addEventListener('change', setTS);

  // any blocking dialog is open → editor/global hotkeys should stand down so e.g.
  // Esc-to-close-Help doesn't also clear the selection in the editor behind it.
  function isModalOpen() { return $('helpOverlay').style.display !== 'none' || $('libOverlay').style.display !== 'none' || $('qzOverlay').style.display !== 'none'; }
  document.addEventListener('keydown', function (e) {
    if (e.code !== 'Space' && e.key !== ' ') return;
    var tag = (document.activeElement && document.activeElement.tagName) || '';
    if (/INPUT|SELECT|TEXTAREA/.test(tag) || isModalOpen()) return;
    e.preventDefault(); Transport.toggle();
  });
  // global "?" opens the user guide from any view
  document.addEventListener('keydown', function (e) {
    if (e.key !== '?') return;
    var tag = (document.activeElement && document.activeElement.tagName) || '';
    if (/INPUT|SELECT|TEXTAREA/.test(tag) || isModalOpen()) return;
    e.preventDefault(); showHelp(true);
  });

  /* ====================== piano-roll toolbar ====================== */
  function gridTicks() {
    var ppq = roll.stats().ppq, v = $('gridSel').value;
    var map = { q: ppq, '8': ppq / 2, '8t': ppq / 3, '16': ppq / 4, '16t': ppq / 6, '32': ppq / 8 };
    return Math.round(map[v] || ppq / 4);
  }
  $('gridSel').addEventListener('change', function () { roll.setGridTicks(gridTicks()); });
  $('snapChk').addEventListener('change', function () { roll.setSnap(this.checked); });
  function setToolUI(t) { $('toolSelect').classList.toggle('on', t === 'select'); $('toolDraw').classList.toggle('on', t === 'draw'); }
  $('toolSelect').onclick = function () { roll.setTool('select'); setToolUI('select'); };
  $('toolDraw').onclick = function () { roll.setTool('draw'); setToolUI('draw'); };
  $('btnUndo').onclick = roll.undo; $('btnRedo').onclick = roll.redo;
  $('btnCopy').onclick = roll.copy; $('btnPaste').onclick = roll.paste;
  $('btnDup').onclick = roll.duplicate; $('btnDel').onclick = roll.deleteSel;
  $('btnQuant').onclick = function () { roll.quantize(1, false); };
  $('btnMono').onclick = function () {
    var p = roll.getProject(); var before = p.notes.length;
    p.notes = BassTab.monophonicReduce(p.notes, p.ppq, { pick: 'low' });
    roll.load(p); if (TAB_VIEWS[currentView]) TAB_VIEWS[currentView].render();
    flash('Reduced ' + before + ' → ' + p.notes.length + ' notes (monophonic).');
  };
  $('btnOctUp').onclick = function () { roll.transpose(12); };
  $('btnOctDown').onclick = function () { roll.transpose(-12); };
  $('btnZoomHIn').onclick = function () { roll.zoomTime(1.25); };
  $('btnZoomHOut').onclick = function () { roll.zoomTime(0.8); };
  $('btnZoomVIn').onclick = function () { roll.zoomPitch(1.2); };
  $('btnZoomVOut').onclick = function () { roll.zoomPitch(1 / 1.2); };
  $('btnZoomFit').onclick = function () { roll.fitTime(); };

  /* ====================== bass-tab toolbar ====================== */
  function btOpts(p) { bassTab.setOptions(p); scheduleSave(); }
  $('btMono').addEventListener('change', function () { btOpts({ monophonic: this.checked }); });
  $('btAvoidOpen').addEventListener('change', function () { btOpts({ avoidOpen: this.checked }); });
  $('btFingers').addEventListener('change', function () { btOpts({ showFingers: this.checked }); });
  $('btMaxFret').addEventListener('change', function () { btOpts({ maxFret: +this.value || 24 }); });
  $('btGrid').addEventListener('change', function () { btOpts({ gridDiv: this.value }); });
  $('btBars').addEventListener('change', function () { btOpts({ barsPerLine: +this.value || 4 }); });
  $('btOffset').addEventListener('change', function () { btOpts({ offsetTicks: Math.round(+this.value || 0) }); });
  $('btOctUp').onclick = function () { btOpts({ octaveShift: (bassTab.getOptions().octaveShift || 0) + 1 }); };
  $('btOctDown').onclick = function () { btOpts({ octaveShift: (bassTab.getOptions().octaveShift || 0) - 1 }); };
  $('btCopy').onclick = function () { var a = bassTab.getAscii && bassTab.getAscii(); if (!a) { flash('No tab yet.'); return; } navigator.clipboard && navigator.clipboard.writeText(a); flash('ASCII tab copied.'); };
  $('btExport').onclick = function () { var a = bassTab.getAscii && bassTab.getAscii(); if (!a) { flash('No tab yet.'); return; } download(new TextEncoder().encode(a), (project.name || 'bass') + '-tab.txt', 'text/plain'); };
  function updateErgo(ergo) { var e = $('btErgo'); if (!e) return; e.textContent = ergo ? (ergo.rating + ' · ' + ergo.noteCount + ' notes · frets ' + ergo.minFret + '–' + ergo.maxFret) : '—'; }
  function syncBassToolbar(v) {
    if ($('btMono')) $('btMono').checked = v.monophonic !== false;
    if ($('btAvoidOpen')) $('btAvoidOpen').checked = !!v.avoidOpen;
    if ($('btFingers')) $('btFingers').checked = v.showFingers !== false;
    if ($('btMaxFret')) $('btMaxFret').value = v.maxFret || 24;
    if ($('btGrid')) $('btGrid').value = v.gridDiv || '16';
    if ($('btBars')) $('btBars').value = v.barsPerLine || 4;
    if ($('btOffset')) $('btOffset').value = v.offsetTicks || 0;
  }

  /* ====================== guitar-tab toolbar (mirrors bass; drives guitarTab) ====================== */
  function gtOpts(p) { guitarTab.setOptions(p); scheduleSave(); }
  $('gtMono').addEventListener('change', function () { gtOpts({ monophonic: this.checked }); });
  $('gtAvoidOpen').addEventListener('change', function () { gtOpts({ avoidOpen: this.checked }); });
  $('gtFingers').addEventListener('change', function () { gtOpts({ showFingers: this.checked }); });
  $('gtMaxFret').addEventListener('change', function () { gtOpts({ maxFret: +this.value || 19 }); });
  $('gtGrid').addEventListener('change', function () { gtOpts({ gridDiv: this.value }); });
  $('gtBars').addEventListener('change', function () { gtOpts({ barsPerLine: +this.value || 4 }); });
  $('gtOffset').addEventListener('change', function () { gtOpts({ offsetTicks: Math.round(+this.value || 0) }); });
  $('gtOctUp').onclick = function () { gtOpts({ octaveShift: (guitarTab.getOptions().octaveShift || 0) + 1 }); };
  $('gtOctDown').onclick = function () { gtOpts({ octaveShift: (guitarTab.getOptions().octaveShift || 0) - 1 }); };
  $('gtCopy').onclick = function () { var a = guitarTab.getAscii && guitarTab.getAscii(); if (!a) { flash('No tab yet.'); return; } navigator.clipboard && navigator.clipboard.writeText(a); flash('ASCII tab copied.'); };
  $('gtExport').onclick = function () { var a = guitarTab.getAscii && guitarTab.getAscii(); if (!a) { flash('No tab yet.'); return; } download(new TextEncoder().encode(a), (project.name || 'guitar') + '-tab.txt', 'text/plain'); };
  function updateGuitarErgo(ergo) { var e = $('gtErgo'); if (!e) return; e.textContent = ergo ? (ergo.rating + ' · ' + ergo.noteCount + ' notes · frets ' + ergo.minFret + '–' + ergo.maxFret) : '—'; }
  function syncGuitarToolbar(v) {
    if ($('gtMono')) $('gtMono').checked = v.monophonic !== false;
    if ($('gtAvoidOpen')) $('gtAvoidOpen').checked = !!v.avoidOpen;
    if ($('gtFingers')) $('gtFingers').checked = v.showFingers !== false;
    if ($('gtMaxFret')) $('gtMaxFret').value = v.maxFret || 19;
    if ($('gtGrid')) $('gtGrid').value = v.gridDiv || '16';
    if ($('gtBars')) $('gtBars').value = v.barsPerLine || 4;
    if ($('gtOffset')) $('gtOffset').value = v.offsetTicks || 0;
  }
  // Sync whichever fretted-instrument toolbar matches the active melodic instrument.
  function syncTabToolbar(instrument, v) {
    if (instrument === 'guitar') syncGuitarToolbar(v);
    else if (instrument === 'bass') syncBassToolbar(v);
  }
  // "Split parts" (both guitar toolbars): split the active guitar track into lead + rhythm.
  if ($('gtSplit')) $('gtSplit').onclick = function () { splitGuitarTrack(project.activeTrackId); };

  /* ====================== guitar-chords toolbar (Tab Type 1) ====================== */
  $('gcBars').addEventListener('change', function () { guitarChords.setOptions({ barsPerLine: +this.value || 4 }); });
  $('gcOffset').addEventListener('change', function () { guitarChords.setOptions({ offsetTicks: Math.round(+this.value || 0) }); });
  $('gcCopy').onclick = function () { var a = guitarChords.getAscii && guitarChords.getAscii(); if (!a) { flash('No chords detected yet.'); return; } navigator.clipboard && navigator.clipboard.writeText(a); flash('Chord progression copied.'); };
  if ($('gcSplit')) $('gcSplit').onclick = function () { splitGuitarTrack(project.activeTrackId); };
  function updateChordInfo(st) { var e = $('gcInfo'); if (!e) return; e.textContent = st ? (st.count + ' changes · ' + st.unique + ' chords') : '—'; }

  /* ====================== drum-tab toolbar ====================== */
  function dToolUI(t) { $('dToolSelect').classList.toggle('on', t === 'select'); $('dToolDraw').classList.toggle('on', t === 'draw'); }
  $('dToolSelect').onclick = function () { drumRoll.setTool('select'); };   // setTool fires onTool → dToolUI
  $('dToolDraw').onclick = function () { drumRoll.setTool('draw'); };
  $('dSnap').addEventListener('change', function () { drumRoll.setSnap(this.checked); });
  $('dGridSub').addEventListener('change', function () { drumRoll.setGridSub(+this.value); renderDrumSheet(); });
  $('dUndo').onclick = function () { drumRoll.undo(); }; $('dRedo').onclick = function () { drumRoll.redo(); };

  /* ---- drum bar-grid shift (move the grid, not the notes — re-align to audio) ---- */
  function applyDrumGridOffset(sec) {
    sec = Math.round((+sec || 0) * 1000) / 1000;
    drumRoll.setGridOffset(sec);
    if (drumData) drumData.gridOffset = sec;
    Transport.setDrumGridOffset(sec);
    $('dGridShift').value = sec;
    renderDrumSheet(); scheduleSave();
  }
  $('dGridShift').addEventListener('change', function () { applyDrumGridOffset(this.value); });
  $('dShiftL').onclick = function () { applyDrumGridOffset(drumRoll.getGridOffset() - 0.01); };
  $('dShiftR').onclick = function () { applyDrumGridOffset(drumRoll.getGridOffset() + 0.01); };

  /* ---- traditional drum sheet (auto-aligned staff below the grid) ---- */
  // On by default: the staff reads straight off the grid (it quantizes its own
  // display copy) so no manual Quantize pass is needed first.
  var sheetOn = true;
  function renderDrumSheet() {
    if (!sheetOn) return;
    var host = $('drumSheet'); if (!host) return;
    DrumSheet.render(host, {
      events: drumRoll.getEvents(),
      tempo: (drumData && drumData.tempo) || 120,
      gridOffset: drumRoll.getGridOffset(),
      gridSub: drumRoll.getGridSub(),
      tsNum: 4, barsPerLine: 4
    });
  }
  // Drive the staff's playhead from the transport so it scrolls with playback
  // (it follows vertically while playing, and just marks the spot when paused).
  function updateDrumSheetPlayhead(s) {
    if (!sheetOn) return;
    DrumSheet.setPlayhead(s, Transport.isRunning());
  }
  function applySheetVisibility() {
    show($('drumSheetWrap'), sheetOn);
    document.body.classList.toggle('sheet-on', sheetOn);
  }
  $('dSheetChk').addEventListener('change', function () {
    sheetOn = this.checked;
    applySheetVisibility();
    renderDrumSheet();
  });
  $('dSheetChk').checked = sheetOn;   // reflect the default-on state in the toolbar
  applySheetVisibility();
  $('dZoomIn').onclick = function () { drumRoll.zoomIn(); }; $('dZoomOut').onclick = function () { drumRoll.zoomOut(); }; $('dZoomFit').onclick = function () { drumRoll.zoomFit(); };
  $('dDlJson').onclick = function () {
    if (!drumData) return;
    var blob = new Blob([JSON.stringify(Object.assign({}, drumData, { events: drumRoll.getEvents() }), null, 2)], { type: 'application/json' });
    dl(URL.createObjectURL(blob), (project.name || 'drums') + '.json');
  };
  $('dDlMidi').onclick = exportDrumMidi;
  function dl(href, name) { var a = document.createElement('a'); a.href = href; a.download = name; document.body.appendChild(a); a.click(); document.body.removeChild(a); }
  // Build a GM channel-10 drum MIDI from the live drum grid (DrumTabCore lane → GM note).
  function exportDrumMidi() {
    var events = drumRoll.getEvents();
    if (!events.length) { flash('No drum hits to export.'); return; }
    var ppq = 480, tempo = (drumData && drumData.tempo) || 120, tps = (tempo / 60) * ppq;
    var notes = events.map(function (e) {
      var lane = DrumTabCore.LANES[DrumTabCore.TYPE_TO_IDX[e.type]];
      var pitch = (lane && lane.midi && lane.midi[0]) || 38;
      var st = Math.round((e.time_sec || 0) * tps);
      return { start: st, end: st + Math.round(ppq / 8), pitch: pitch, velocity: e.velocity || 100, channel: 9 };
    });
    download(MidiIO.write({ ppq: ppq, tempo: tempo, timeSig: { num: 4, den: 4 }, notes: notes }), (project.name || 'drums') + '-drums.mid', 'audio/midi');
  }

  /* ====================== header / global toolbar ====================== */
  $('btnNewProj').onclick = newProject;
  $('btnSaveProj').onclick = saveProject;
  $('btnLibrary').onclick = openLibrary;
  $('libClose').onclick = closeLibrary;
  $('libOverlay').addEventListener('click', function (e) { if (e.target === this) closeLibrary(); });
  $('libSearch').addEventListener('input', renderLibrary);
  $('projName').addEventListener('change', function () { project.name = (this.value || '').trim() || defaultName(); this.value = project.name; scheduleSave(); });
  $('btnOpenMidi').onclick = function () { $('midiInput').click(); };
  // MIDI import is client-side, so it's wired here (works in both web + desktop;
  // the workflow source-bar drop zone is desktop-only).
  $('midiInput').addEventListener('change', function (e) { if (e.target.files[0]) { openMidiFile(e.target.files[0]); e.target.value = ''; } });
  $('btnExportMidi').onclick = function () {
    var t = project.tracks[project.activeTrackId];
    if (t && t.kind === 'drum') { exportDrumMidi(); return; }
    download(MidiIO.write(roll.getProject()), (project.name || 'studio') + '.mid', 'audio/midi');
  };
  /* ====================== quantize modal (all instrument types) ====================== */
  (function () {
    var sel = $('qzGrid'); if (!sel) return;
    QuantizeCore.GRIDS.forEach(function (g) {
      var o = document.createElement('option'); o.value = g.value; o.textContent = g.label; sel.appendChild(o);
    });
    sel.value = '16';
  })();
  function qzTriplet() { return QuantizeCore.find($('qzGrid').value).triplet; }
  function qzSyncLabels() {
    $('qzSwingVal').textContent = (+$('qzSwing').value) + '%';
    var trip = qzTriplet();
    $('qzSwing').disabled = trip;
    $('qzSwingRow').style.opacity = trip ? 0.4 : 1;
    $('qzSwingNote').textContent = trip ? 'swing doesn’t apply to a triplet grid'
      : '50% = straight · 66% = triplet shuffle · 75% = hard shuffle';
    var bias = +$('qzBias').value;
    $('qzBiasVal').textContent = bias === 0 ? 'centre' : (bias < 0 ? '◄ ' + (-bias) + '%' : bias + '% ►');
    $('qzStrengthVal').textContent = (+$('qzStrength').value) + '%';
  }
  ['qzSwing', 'qzBias', 'qzStrength'].forEach(function (id) { $(id).addEventListener('input', qzSyncLabels); });
  $('qzGrid').addEventListener('change', qzSyncLabels);

  function openQuantize() {
    var t = project.tracks[project.activeTrackId];
    if (!t) { flash('No track to quantize — add notes first.'); return; }
    if (t.kind === 'drum') { $('qzGrid').value = String(drumRoll.getGridSub()); }
    else { var m = { q: '4', '8': '8', '8t': '8t', '16': '16', '16t': '16t', '32': '32' }; $('qzGrid').value = m[$('gridSel').value] || '16'; }
    $('qzTrackName').textContent = '· ' + (t.name || t.instrument);
    show($('qzLengthsRow'), t.kind !== 'drum');
    qzSyncLabels();
    $('qzOverlay').style.display = '';
  }
  function closeQuantize() { $('qzOverlay').style.display = 'none'; }
  function applyQuantize() {
    var t = project.tracks[project.activeTrackId]; if (!t) { closeQuantize(); return; }
    var gridV = $('qzGrid').value, trip = qzTriplet();
    var o = {
      swing: trip ? 0.5 : (+$('qzSwing').value) / 100,
      bias: (+$('qzBias').value) / 100 * 0.5,           // −100..100% → −0.5..0.5 of a grid step
      strength: (+$('qzStrength').value) / 100
    };
    if (t.kind === 'drum') {
      o.gridSec = QuantizeCore.gridSeconds(gridV, (drumData && drumData.tempo) || 120);
      var n = drumRoll.quantizeAdvanced(o);
      // keep the drum grid-sub (and the read-only sheet, which renders against it) showing
      // the grid we just snapped to — for the straight grids the sub can represent.
      var straightSub = { '4': 4, '8': 8, '16': 16, '32': 32 }[gridV];
      if (straightSub && drumRoll.getGridSub() !== straightSub) {
        drumRoll.setGridSub(straightSub);
        if ($('dGridSub')) $('dGridSub').value = String(straightSub);
      }
      renderDrumSheet();
      flash('Quantized ' + n + ' drum hits.');
    } else {
      o.gridTicks = QuantizeCore.gridTicks(gridV, roll.stats().ppq);
      o.lengths = $('qzLengths').checked;
      var n2 = roll.quantizeAdvanced(o);
      if (TAB_VIEWS[currentView]) TAB_VIEWS[currentView].render();
      flash('Quantized ' + n2 + ' notes.');
    }
    closeQuantize(); scheduleSave();
  }
  $('btnQuantize').onclick = openQuantize;
  $('qzApply').onclick = applyQuantize;
  $('qzCancel').onclick = closeQuantize;
  $('qzClose').onclick = closeQuantize;
  $('qzOverlay').addEventListener('click', function (e) { if (e.target === this) closeQuantize(); });

  $('btnHelp').onclick = function () { showHelp(true); };
  $('helpClose').onclick = function () { showHelp(false); };
  $('helpOverlay').addEventListener('click', function (e) { if (e.target === this) showHelp(false); });
  function showHelp(on) { $('helpOverlay').style.display = on ? '' : 'none'; }
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if ($('qzOverlay').style.display !== 'none') $('qzOverlay').style.display = 'none';
    else if ($('libOverlay').style.display !== 'none') closeLibrary();
    else if ($('helpOverlay').style.display !== 'none') showHelp(false);
  });

  $('targetSel').addEventListener('change', applyTarget);
  $('ftChk').addEventListener('change', function () { });
  $('ytUrl').addEventListener('change', function () { project.youtubeUrl = (this.value || '').trim(); scheduleSave(); });
  function applyTarget() {
    var T = TARGETS[$('targetSel').value] || TARGETS.bass;
    roll.setGuides({ markers: T.markers || {}, centerPitch: T.center || 48 });
    EditorPlayer.setInstrument(T.instrument || 'bass');
    $('btnSongToBass').textContent = T.kind === 'drum' ? '▶ Song → Drums' : '▶ Song → ' + T.label + ' MIDI';
    $('btnSeparate').textContent = 'Separate ' + T.label.toLowerCase();
    var tag = $('stemTag'); if (tag) tag.textContent = 'isolated ' + T.label.toLowerCase();
    $('ftChk').disabled = (T.model === 'htdemucs_6s'); $('ftWrap').style.opacity = $('ftChk').disabled ? 0.45 : 1;
  }

  /* ---- helpers ---- */
  function updateStats() { var s = roll.stats(); $('noteCount').textContent = s.notes + (s.notes === 1 ? ' note' : ' notes'); }
  function download(bytes, name, mime) {
    var blob = new Blob([bytes], { type: mime || 'application/octet-stream' }), url = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click();
    document.body.removeChild(a); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function exampleNotes() {
    var ppq = 480, eN = ppq / 2, notes = [], t = 0;
    var seq = [28, 28, 31, 33, 35, 33, 31, 28, 33, 33, 36, 38, 40, 38, 36, 33];
    seq.forEach(function (p) { notes.push({ start: t, end: t + eN - 20, pitch: p, velocity: 92 + (t / eN % 2 ? 0 : 14) }); t += eN; });
    return notes;
  }

  window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  /* ---- init ---- */
  if (WEB) document.body.classList.add('mode-web');   // CSS hides .desktop-only
  roll.setGridTicks(gridTicks());
  setToolUI('select'); dToolUI('select');
  applyTarget(); updateViewAvailability('bass');
  updateStats(); refreshSrcButtons(); renderTracks();
  setView('pianoroll');

  // debug/automation handle
  window.Studio = {
    roll: roll, bassTab: bassTab, guitarTab: guitarTab, drumRoll: drumRoll, transport: Transport,
    getProject: function () { return project; }, activateTrack: activateTrack,
    newProject: newProject, saveProject: saveProject, openProject: openProject,
    onSong: onSong, onStem: onStem, onMelodicResult: onMelodicResult, onDrumResult: onDrumResult,
    setView: setView, curTarget: curTarget
  };
})();
