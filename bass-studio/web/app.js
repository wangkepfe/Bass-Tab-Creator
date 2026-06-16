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

  /* ---- instrument targets ---- */
  var TARGETS = {
    bass:   { id: 'bass',   label: 'Bass',   kind: 'melodic', stem: 'bass',  model: 'htdemucs',    minFreq: '30',  maxFreq: '400',  minNote: '80', onset: '0.5', frame: '0.3',  shifts: '2', center: 40, markers: { 28: 1, 33: 1, 38: 1, 43: 1 }, instrument: 'bass',  defaultView: 'basstab' },
    piano:  { id: 'piano',  label: 'Piano',  kind: 'melodic', stem: 'piano', model: 'htdemucs_6s', minFreq: '',    maxFreq: '',     minNote: '50', onset: '0.4', frame: '0.25', shifts: '2', center: 60, markers: {}, instrument: 'piano', defaultView: 'pianoroll' },
    guitar: { id: 'guitar', label: 'Guitar', kind: 'melodic', stem: 'guitar', model: 'htdemucs_6s', minFreq: '70', maxFreq: '1400', minNote: '60', onset: '0.4', frame: '0.3',  shifts: '2', center: 52, markers: {}, instrument: 'piano', defaultView: 'pianoroll' },
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
    onChange: function () { updateStats(); Transport.rebuildMelodic(); if (currentView === 'basstab') bassTab.render(); scheduleSave(); },
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
  var drumRoll = DrumRoll.create($('drumCanvas'), {
    onEdit: function (events) {
      if (drumData) { drumData.events = events; drumData.duration = Math.max(drumData.duration || 0, drumEnd(events)); Transport.setDrumDuration(drumData.duration); }
      Transport.setDrumEvents(events); scheduleSave();
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
  Transport.init({
    getProject: function () { return roll.getProject(); },
    melodicSynth: EditorPlayer, drumSynth: DrumSynth,
    audios: { original: $('songAudio'), stem: $('stemAudio') },
    views: {
      pianoroll: { setPlayheadTick: function (t) { roll.setPlayhead(t); } },
      basstab: { setPlayheadTick: function (t) { bassTab.setPlayheadTick(t); } },
      drumtab: { setPlayheadSeconds: function (s) { drumRoll.setPlayhead(s); } }
    },
    onUpdate: onTransport
  });
  function onTransport(st) {
    $('btnPlay').textContent = st.playing ? '⏸' : '▶';
    $('timeNow').textContent = fmt(st.posSec); $('timeTotal').textContent = fmt(st.durationSec);
  }

  /* ---- backend client ---- */
  Workflow.init({
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
    setTabEnabled('drumtab', isDrum);
  }
  function setView(name) {
    var b = $('viewTabs').querySelector('[data-view=' + name + ']');
    if (b && b.classList.contains('disabled')) return;
    currentView = name;
    Array.prototype.forEach.call($('viewTabs').children, function (x) { x.classList.toggle('on', x.dataset.view === name); });
    show($('panePianoRoll'), name === 'pianoroll'); show($('paneBassTab'), name === 'basstab'); show($('paneDrumTab'), name === 'drumtab');
    show($('toolsPianoRoll'), name === 'pianoroll'); show($('toolsBassTab'), name === 'basstab'); show($('toolsDrumTab'), name === 'drumtab');
    Transport.setView(name);
    if (name === 'pianoroll') roll.redraw();
    else if (name === 'basstab') bassTab.render();
    else if (name === 'drumtab') drumRoll.render();
    refreshSrcButtons();
  }
  $('viewTabs').addEventListener('click', function (e) { var b = e.target.closest('.vtab'); if (b && !b.classList.contains('disabled')) setView(b.dataset.view); });

  /* ====================== tracks ====================== */
  function trackList() { return Object.keys(project.tracks).map(function (k) { return project.tracks[k]; }); }

  function serializeActive() {
    var id = project.activeTrackId; if (!id) return;
    var t = project.tracks[id]; if (!t) return;
    if (t.kind === 'drum') { t.events = drumRoll.getEvents(); t.duration = Math.max(t.duration || 0, drumEnd(t.events)); }
    else {
      var pj = roll.getProject();
      t.notes = pj.notes; t.ppq = pj.ppq; t.tempo = pj.tempo; t.timeSig = pj.timeSig;
      t.view = bassTab.getOptions(); t.overrides = bassTab.getOverrides();
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
      drumData = { events: t.events || [], tempo: t.tempo || 120, duration: Math.max(t.duration || 0, drumEnd(t.events)), adtlib: false };
      drumRoll.setData(drumData); drumRoll.zoomFit();
      Transport.setDrumEvents(drumData.events); Transport.setDrumDuration(drumData.duration);
      show($('drumEmpty'), !(t.events && t.events.length));
      setStemAudio(t.stem);
      setView('drumtab');
    } else {
      roll.load({ ppq: t.ppq || 480, tempo: t.tempo || 120, timeSig: t.timeSig || { num: 4, den: 4 }, notes: t.notes || [] });
      $('bpmInput').value = Math.round(t.tempo || 120);
      $('tsNum').value = (t.timeSig && t.timeSig.num) || 4; $('tsDen').value = (t.timeSig && t.timeSig.den) || 4;
      bassTab.setOverrides(t.overrides || {});
      bassTab.setOptions(t.view || {});            // re-renders the tab
      syncBassToolbar(bassTab.getOptions());
      Transport.rebuildMelodic();
      setStemAudio(t.stem);
      setView(t.instrument === 'bass' ? 'basstab' : 'pianoroll');
    }
    loading = wasLoading;
    updateStats(); renderTracks(); refreshSrcButtons();
  }

  function upsertMelodic(instrument, m) {
    var T = TARGETS[instrument] || TARGETS.bass;
    var t = project.tracks[instrument] || { id: instrument, instrument: instrument, kind: 'melodic', name: T.label, view: {}, overrides: {} };
    t.notes = m.notes; t.ppq = m.ppq; t.tempo = m.tempo; t.timeSig = m.timeSig;
    project.tracks[instrument] = t;
    activateTrack(instrument);
    scheduleSave();
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
    if (project.activeTrackId === instrument) setStemAudio(t.stem);
    renderTracks(); refreshSrcButtons();
    if (project.id) uploadStem(instrument).then(scheduleSaveNow);
  }
  function onMelodicResult(bytes, instrument) {
    var m = MidiIO.read(bytes);
    upsertMelodic(instrument, { notes: m.notes, ppq: m.ppq, tempo: m.tempo, timeSig: m.timeSig });
    flash(m.notes.length + ' notes → ' + instLabel(instrument) + ' track.');
  }
  function onDrumResult(data) { upsertDrums(data); flash((data.events || []).length + ' drum hits → Drums track.'); }

  function openMidiFile(file) {
    var r = new FileReader();
    r.onload = function () {
      try {
        var m = MidiIO.read(new Uint8Array(r.result));
        var drumCh = m.notes.filter(function (n) { return n.channel === 9; }).length;
        if (m.notes.length && drumCh / m.notes.length >= 0.5) {
          var tps = (m.tempo / 60) * (m.ppq || 480);
          var events = m.notes.map(function (n) { return { time_sec: n.start / tps, type: DrumTabCore.GM_TO_TYPE[n.pitch], velocity: n.velocity || 100 }; }).filter(function (e) { return e.type; });
          var dur = m.notes.reduce(function (a, n) { return Math.max(a, n.end); }, 0) / tps;
          upsertDrums({ events: events, tempo: m.tempo, duration: dur });
          flash(events.length + ' drum hits imported.');
        } else {
          var inst = instKind(curTarget().id) === 'melodic' ? curTarget().id : 'bass';
          upsertMelodic(inst, { notes: m.notes, ppq: m.ppq, tempo: m.tempo, timeSig: m.timeSig });
          flash(m.notes.length + ' notes imported → ' + instLabel(inst) + '.');
        }
      } catch (e) { flash('Could not read MIDI: ' + e.message); }
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
    bassTab.setOverrides({}); bassTab.render();
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
      if (t.kind === 'drum') { o.events = (t.events || []).map(function (e) { return { time_sec: e.time_sec, type: e.type, velocity: e.velocity }; }); o.tempo = t.tempo || 120; o.duration = t.duration || 0; }
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
  function uploadStem(instrument) {
    var t = project.tracks[instrument];
    if (!project.id || !t || !t.stem || !t.stem.blob) return Promise.resolve();
    pendingUploads++;
    var fd = new FormData(); fd.append('file', t.stem.blob, t.stem.name || (instrument + '.wav')); fd.append('role', 'stem'); fd.append('instrument', instrument);
    return fetch('/api/projects/' + project.id + '/audio', { method: 'POST', body: fd })
      .then(function (r) { if (!r.ok) throw new Error('upload failed'); return r.json(); })
      .then(function (j) { t.stem.file = j.file; })
      .catch(function () { flash('Stem upload failed — audio not saved.'); })
      .then(function () { pendingUploads--; });
  }

  function projectHasContent() { return !!(project.song || Object.keys(project.tracks).length); }
  function confirmDiscard() { return !(dirty && projectHasContent()) || confirm('Discard unsaved changes to the current project?'); }
  function newProject() {
    if (!confirmDiscard()) return;
    clearTimeout(saveTimer);
    if (project.song) revoke(project.song.url);
    trackList().forEach(function (t) { if (t.stem) revoke(t.stem.url); });
    project = emptyProject(); dirty = false; Workflow.reset();
    $('projName').value = ''; $('ytUrl').value = ''; markSave('');
    show($('songMeta'), false); $('songAudio').removeAttribute('src'); show($('songAudioRow'), false);
    Transport.stop(); clearEditors(); renderTracks();
    flash('New project.');
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
        var aud = '/api/projects/' + id + '/audio/';
        if (meta.song && meta.song.file) {
          project.song = { name: meta.song.name, file: meta.song.file, url: aud + meta.song.file, blob: null };
          $('songName').textContent = (meta.song.name || 'song') + (project.youtubeUrl ? '  ·  YouTube' : ''); show($('songMeta'), true);
          $('songAudio').src = project.song.url; show($('songAudioRow'), true);
          // materialize the song into a Blob so the pipeline can extract more tracks from it
          fetch(project.song.url).then(function (r) { return r.ok ? r.blob() : null; }).then(function (b) { if (b) { project.song.blob = b; Workflow.adoptSong(b, project.song.name); } }).catch(function () { });
        } else { show($('songMeta'), false); $('songAudio').removeAttribute('src'); Workflow.reset(); }
        (meta.tracks || []).forEach(function (t) {
          var tr = { id: t.id || t.instrument, instrument: t.instrument, kind: t.kind, name: t.name || instLabel(t.instrument) };
          if (t.kind === 'drum') { tr.events = t.events || []; tr.tempo = t.tempo || 120; tr.duration = t.duration || 0; }
          else { tr.notes = t.notes || []; tr.ppq = t.ppq || 480; tr.tempo = t.tempo || 120; tr.timeSig = t.timeSig || { num: 4, den: 4 }; tr.view = t.view || {}; tr.overrides = t.overrides || {}; }
          if (t.stem && t.stem.file) tr.stem = { name: t.stem.name, file: t.stem.file, url: aud + t.stem.file, blob: null };
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
  var libProjects = [], libLoaded = false;
  function openLibrary() { $('libOverlay').style.display = ''; $('libSearch').value = ''; libLoaded = false; renderLibrary(); fetchProjects(); setTimeout(function () { $('libSearch').focus(); }, 30); }
  function closeLibrary() { $('libOverlay').style.display = 'none'; }
  function fetchProjects() {
    fetch('/api/projects', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : { projects: [] }; })
      .then(function (j) { libProjects = (j && j.projects) || []; libLoaded = true; renderLibrary(); })
      .catch(function () { libProjects = []; libLoaded = true; renderLibrary(); });
  }
  function renderLibrary() {
    var q = ($('libSearch').value || '').toLowerCase().trim();
    var list = $('libList'); list.innerHTML = '';
    var items = libProjects.filter(function (p) { return !q || (p.name || '').toLowerCase().indexOf(q) >= 0; });
    if (!items.length) { show($('libEmpty'), true); $('libEmpty').textContent = libLoaded ? (libProjects.length ? 'No projects match.' : 'No saved projects yet — load a song, extract a track, then Save.') : 'Loading…'; }
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
    // pinned: built-in demo (works offline)
    var demo = document.createElement('div'); demo.className = 'lib-item demo';
    var db = document.createElement('button'); db.className = 'lib-open';
    var dn = document.createElement('span'); dn.className = 'nm'; dn.textContent = 'Demo bass line';
    var dm = document.createElement('span'); dm.className = 'meta'; dm.textContent = 'built-in · offline quick-start';
    db.appendChild(dn); db.appendChild(dm); db.onclick = loadDemo;
    demo.appendChild(db); list.appendChild(demo);
  }
  function fmtDate(t) { if (!t) return '—'; try { return new Date(t * 1000).toLocaleString(); } catch (e) { return '—'; } }
  function loadDemo() {
    newProject();
    project.tracks.bass = { id: 'bass', instrument: 'bass', kind: 'melodic', name: 'Bass', view: {}, overrides: {},
      ppq: 480, tempo: 110, timeSig: { num: 4, den: 4 }, notes: exampleNotes() };
    renderTracks(); activateTrack('bass'); closeLibrary(); flash('Demo bass line loaded — Save to keep it.');
  }

  /* ====================== transport UI ====================== */
  $('btnPlay').onclick = function () { Transport.toggle(); };
  $('btnStop').onclick = function () { Transport.stop(); };
  var metro = false;
  $('btnMetro').onclick = function () { metro = !metro; this.classList.toggle('on', metro); this.setAttribute('aria-pressed', metro); Transport.setMetro(metro); };
  $('srcSeg').addEventListener('click', function (e) { var b = e.target.closest('button[data-src]'); if (b && !b.disabled) { Transport.setSource(b.dataset.src); refreshSrcButtons(); } });
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

  $('bpmInput').addEventListener('change', function () { roll.setTempo(+this.value || 120); });
  function setTS() { roll.setTimeSig(+$('tsNum').value || 4, +$('tsDen').value || 4); }
  $('tsNum').addEventListener('change', setTS); $('tsDen').addEventListener('change', setTS);

  // any blocking dialog is open → editor/global hotkeys should stand down so e.g.
  // Esc-to-close-Help doesn't also clear the selection in the editor behind it.
  function isModalOpen() { return $('helpOverlay').style.display !== 'none' || $('libOverlay').style.display !== 'none'; }
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
    roll.load(p); if (currentView === 'basstab') bassTab.render();
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

  /* ====================== drum-tab toolbar ====================== */
  function dToolUI(t) { $('dToolSelect').classList.toggle('on', t === 'select'); $('dToolDraw').classList.toggle('on', t === 'draw'); }
  $('dToolSelect').onclick = function () { drumRoll.setTool('select'); };   // setTool fires onTool → dToolUI
  $('dToolDraw').onclick = function () { drumRoll.setTool('draw'); };
  $('dSnap').addEventListener('change', function () { drumRoll.setSnap(this.checked); });
  $('dGridSub').addEventListener('change', function () { drumRoll.setGridSub(+this.value); });
  $('dUndo').onclick = function () { drumRoll.undo(); }; $('dRedo').onclick = function () { drumRoll.redo(); };
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
  $('btnExportMidi').onclick = function () {
    var t = project.tracks[project.activeTrackId];
    if (t && t.kind === 'drum') { exportDrumMidi(); return; }
    download(MidiIO.write(roll.getProject()), (project.name || 'studio') + '.mid', 'audio/midi');
  };
  $('btnHelp').onclick = function () { showHelp(true); };
  $('helpClose').onclick = function () { showHelp(false); };
  $('helpOverlay').addEventListener('click', function (e) { if (e.target === this) showHelp(false); });
  function showHelp(on) { $('helpOverlay').style.display = on ? '' : 'none'; }
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if ($('libOverlay').style.display !== 'none') closeLibrary();
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
  roll.setGridTicks(gridTicks());
  setToolUI('select'); dToolUI('select');
  applyTarget(); updateViewAvailability('bass');
  updateStats(); refreshSrcButtons(); renderTracks();
  setView('pianoroll');

  // debug/automation handle
  window.Studio = {
    roll: roll, bassTab: bassTab, drumRoll: drumRoll, transport: Transport,
    getProject: function () { return project; }, activateTrack: activateTrack,
    newProject: newProject, saveProject: saveProject, openProject: openProject,
    onSong: onSong, onStem: onStem, onMelodicResult: onMelodicResult, onDrumResult: onDrumResult,
    setView: setView, curTarget: curTarget
  };
})();
