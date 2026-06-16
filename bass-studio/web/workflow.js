/* ============================================================================
 * workflow.js  —  backend client: YouTube ingest, file/MIDI input, and the
 * Demucs / basic-pitch / ADTLib pipelines. Owns the source-input + job UI and
 * reports finished artifacts (with blobs + the instrument they belong to) back
 * to the app, which owns the project model + audio elements + transport.
 *
 *   Workflow.init({ getTarget, onSong, onStem, onMelodicMidi, onDrumData,
 *                   onMidiFile, flash })
 *     onSong(blob, name, youtubeUrl)      onStem(blob, name, instrument)
 *     onMelodicMidi(bytes, instrument)    onDrumData(data, instrument)
 *     onMidiFile(file)
 * ========================================================================== */
var Workflow = (function () {
  'use strict';
  var API = '/api';
  var API_CANDIDATES = ['/api', 'http://localhost:8000/api', 'http://127.0.0.1:8000/api'];
  var ctx = null, poller = null;
  var lastSong = null, lastSongName = 'audio', lastStemBlob = null, lastStemName = null, lastStemInstrument = '';
  var pendingYtUrl = '', backendOk = false, jobRunning = false;

  function $(id) { return document.getElementById(id); }
  function show(el, on) { if (el) el.style.display = on ? '' : 'none'; }
  function setText(id, t) { var e = $(id); if (e) e.textContent = t; }
  function wire(id, fn) { var e = $(id); if (e) e.addEventListener('click', fn); }

  function init(c) {
    ctx = c;
    wire('btnYt', fetchYouTube);
    var yt = $('ytUrl');
    if (yt) yt.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); fetchYouTube(); } });
    var drop = $('songDrop'), input = $('songInput');
    if (input) input.addEventListener('change', function (e) { if (e.target.files[0]) routeFile(e.target.files[0]); });
    if (drop) {
      drop.addEventListener('click', function () { input && input.click(); });
      ['dragover', 'dragenter'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
      ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
      drop.addEventListener('drop', function (e) { var f = e.dataTransfer.files[0]; if (f) routeFile(f); });
    }
    var midiIn = $('midiInput');
    if (midiIn) midiIn.addEventListener('change', function (e) { if (e.target.files[0]) { ctx.onMidiFile(e.target.files[0]); e.target.value = ''; } });

    wire('btnSongToBass', function () { runPipeline('song'); });
    wire('btnSeparate', function () { runPipeline('separate'); });
    wire('btnTranscribe', function () { runPipeline('transcribe'); });
    wire('btnCancelJob', cancelJob);

    health();
    setInterval(health, 15000);
  }

  // ---- backend status ------------------------------------------------------
  function probe(base) {
    return fetch(base + '/health', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }
  function health() {
    var pill = $('backendPill');
    var bases = [API].concat(API_CANDIDATES.filter(function (b) { return b !== API; }));
    (function tryNext(i) {
      if (i >= bases.length) {
        backendOk = false;
        if (pill) { pill.className = 'pill bad'; pill.textContent = 'Backend offline'; }
        setPipelineButtons();
        setText('backendHint', 'Editor, MIDI and tabs work offline. For stems / transcription / YouTube / saving projects start the backend: cd bass-studio/server && .venv\\Scripts\\python -m uvicorn app:app --port 8000');
        return;
      }
      probe(bases[i]).then(function (j) {
        if (!j) { tryNext(i + 1); return; }
        API = bases[i]; backendOk = true;
        var via = API.charAt(0) !== '/' ? ' · ' + API.replace(/\/api$/, '') : '';
        if (pill) { pill.className = 'pill ok'; pill.textContent = 'Backend ✓ ' + (j.device || ''); }
        setText('backendHint', 'Demucs ' + (j.demucs ? '✓' : '✗') + ' · basic-pitch ' + (j.basic_pitch ? '✓' : '✗') +
          ' · drums ' + (j.adtof ? '✓' : '~') + ' · YouTube ' + (j.yt_dlp ? '✓' : '✗') + via);
        setPipelineButtons();
      });
    })(0);
  }
  function setPipelineButtons() {
    var canRun = backendOk && !!lastSong && !jobRunning;
    ['btnSongToBass', 'btnSeparate', 'btnTranscribe'].forEach(function (id) { var e = $(id); if (e) e.disabled = !canRun; });
    var yb = $('btnYt'); if (yb) yb.disabled = !backendOk || jobRunning;
  }
  function isOnline() { return backendOk; }

  // Adopt an externally-supplied song (e.g. when a saved project is opened) so the
  // pipeline buttons enable and operate on THIS project's audio. reset() clears it.
  function adoptSong(blob, name) { lastSong = blob || null; lastSongName = name || 'audio'; lastStemBlob = null; lastStemInstrument = ''; setPipelineButtons(); }
  function reset() { lastSong = null; lastSongName = 'audio'; lastStemBlob = null; lastStemInstrument = ''; setPipelineButtons(); }

  // ---- source: YouTube -----------------------------------------------------
  function fetchYouTube() {
    var url = ($('ytUrl') && $('ytUrl').value || '').trim();
    if (!url) { flash('Paste a YouTube link first.'); return; }
    if (!backendOk) { flash('Backend offline — needed to download.'); return; }
    pendingYtUrl = url;
    var fd = new FormData(); fd.append('url', url);
    jobRunning = true; setPipelineButtons();
    jobUI('queued', 'Downloading audio…', 0);
    fetch(API + '/youtube', { method: 'POST', body: fd })
      .then(function (r) { return r.ok ? r.json() : r.json().then(function (j) { throw new Error(j.detail || 'request failed'); }); })
      .then(function (j) { startPolling(j.job_id, 'youtube', ''); })
      .catch(function (err) { jobError(err.message || 'Could not reach backend.'); });
  }

  // ---- source: files -------------------------------------------------------
  function routeFile(f) {
    if (/\.mid(i)?$/i.test(f.name)) ctx.onMidiFile(f);
    else pickSong(f, f.name, '');
  }
  function pickSong(blobOrFile, name, youtubeUrl) {
    lastSong = blobOrFile; lastSongName = name || 'audio';
    setPipelineButtons();
    ctx.onSong(blobOrFile, lastSongName, youtubeUrl || '');
  }

  // ---- pipeline jobs -------------------------------------------------------
  function target() { return (ctx.getTarget && ctx.getTarget()) || { id: 'bass', label: 'Bass', stem: 'bass', model: 'htdemucs', minFreq: '30', maxFreq: '400', minNote: '80', onset: '0.5', frame: '0.3', shifts: '2', kind: 'melodic' }; }

  function runPipeline(kind) {  // kind: 'song' | 'separate' | 'transcribe'
    if (!backendOk) { flash('Backend offline.'); return; }
    var T = target(), fd = new FormData(), pipeline;
    var inst = T.id || (T.kind === 'drum' ? 'drums' : 'bass');
    if (T.kind === 'drum') pipeline = kind === 'song' ? 'song-to-drums' : kind === 'separate' ? 'separate' : 'drum-transcribe';
    else pipeline = kind === 'song' ? 'song-to-bass' : kind === 'separate' ? 'separate' : 'transcribe';

    // Transcribe the already-separated stem only when it belongs to THIS target,
    // otherwise transcribe the song (avoids transcribing e.g. the bass stem into a piano track).
    if (kind === 'transcribe' && lastStemBlob && lastStemInstrument === inst) fd.append('file', lastStemBlob, lastStemName || 'stem.wav');
    else { if (!lastSong) { flash('Add a song first.'); return; } fd.append('file', lastSong, lastSongName); }

    fd.append('pipeline', pipeline);
    fd.append('stem', T.stem);
    fd.append('model', T.model);
    fd.append('min_freq', T.minFreq || ''); fd.append('max_freq', T.maxFreq || ''); fd.append('min_note_len', T.minNote || '');
    fd.append('onset_threshold', T.onset || ''); fd.append('frame_threshold', T.frame || ''); fd.append('shifts', T.shifts || '2');

    var verb = kind === 'separate' ? 'Separating ' + T.label : kind === 'transcribe' ? 'Transcribing' : 'Isolating ' + T.label + ' + transcribing';
    jobRunning = true; setPipelineButtons();
    jobUI('queued', verb + '…', 0);
    fetch(API + '/jobs', { method: 'POST', body: fd })
      .then(function (r) { return r.ok ? r.json() : r.json().then(function (j) { throw new Error(j.detail || 'request failed'); }); })
      .then(function (j) { startPolling(j.job_id, 'job', inst); })
      .catch(function (err) { jobError(err.message || 'Could not reach backend.'); });
  }

  function startPolling(id, mode, inst) {
    stopPolling();
    poller = setInterval(function () {
      fetch(API + '/jobs/' + id).then(function (r) { return r.json(); }).then(function (j) {
        jobUI(j.status, j.stage || j.status, j.progress || 0, j.elapsed);
        if (j.status === 'done') { stopPolling(); jobRunning = false; setPipelineButtons(); mode === 'youtube' ? onYouTubeDone(id, j) : onJobDone(id, j, inst); }
        else if (j.status === 'error') { stopPolling(); jobRunning = false; setPipelineButtons(); jobError(j.error || 'Processing failed.'); }
      }).catch(function () { });
    }, 1200);
  }
  function stopPolling() { if (poller) { clearInterval(poller); poller = null; } }
  function cancelJob() { stopPolling(); jobRunning = false; setPipelineButtons(); jobUI('idle', 'Cancelled', 0); }

  function onYouTubeDone(id, j) {
    var url = API + '/jobs/' + id + '/artifacts/song.mp3';
    fetch(url).then(function (r) { return r.blob(); }).then(function (b) {
      var name = (j.title ? j.title.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) : 'youtube') + '.mp3';
      pickSong(b, name, pendingYtUrl);
      jobUI('done', '✓ ' + (j.title || 'audio downloaded'), 1);
    }).catch(function (e) { jobError('Downloaded but could not load audio: ' + e.message); });
  }

  function onJobDone(id, j, inst) {
    inst = inst || 'bass';
    var arts = j.artifacts || [], base = API + '/jobs/' + id + '/artifacts/', msg = [];
    var stem = arts.find(function (a) { return a.name === 'stem.wav'; });
    var mid = arts.find(function (a) { return a.name === 'notes.mid'; });
    var dj = arts.find(function (a) { return a.name === 'drums.json'; });
    var tail = Promise.resolve();
    if (stem) tail = tail.then(function () {
      return fetch(base + 'stem.wav').then(function (r) { return r.blob(); }).then(function (b) {
        lastStemBlob = b; lastStemName = inst + '.wav'; lastStemInstrument = inst;
        ctx.onStem(b, lastStemName, inst); msg.push('stem ready');
      });
    });
    if (mid) tail = tail.then(function () {
      return fetch(base + 'notes.mid').then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
        ctx.onMelodicMidi(new Uint8Array(buf), inst); msg.push('transcription loaded');
      });
    });
    if (dj) tail = tail.then(function () {
      return fetch(base + 'drums.json').then(function (r) { return r.json(); }).then(function (data) {
        ctx.onDrumData(data, 'drums'); msg.push('drum hits loaded');
      });
    });
    tail.then(function () { jobUI('done', '✓ ' + (msg.join(' · ') || 'done'), 1); })
      .catch(function (e) { jobError('Fetched job but could not load artifacts: ' + e.message); });
  }

  function jobUI(status, stage, progress, elapsed) {
    show($('jobPanel'), status !== 'idle');
    setText('jobStage', stage + (elapsed ? '  ·  ' + Math.round(elapsed) + 's' : ''));
    var bar = $('jobBar'); if (bar) { bar.classList.toggle('indeterminate', status !== 'done' && (!progress || progress <= 0)); bar.style.setProperty('--p', Math.round((progress || 0) * 100) + '%'); }
    show($('btnCancelJob'), status === 'queued' || status === 'running');
  }
  function jobError(msg) { jobUI('error', '⚠ ' + msg, 0); flash(msg); }
  function flash(m) { if (ctx && ctx.flash) ctx.flash(m); }

  return {
    init: init, isOnline: isOnline, adoptSong: adoptSong, reset: reset,
    hasStem: function () { return !!lastStemBlob; },
    hasSong: function () { return !!lastSong; }
  };
})();
