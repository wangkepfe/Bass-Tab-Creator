/* ============================================================================
 * drum-tab-core.js  —  Drum event list → quantized grid + ASCII tab.
 *
 * Input:  { events: [{time_sec, type, velocity}], tempo, duration }
 * Output: ASCII tab string, quantized grid data for the canvas renderer.
 *
 * Exported:  DrumTabCore.{ LANES, TYPE_TO_IDX, GM_TO_TYPE, quantize, toAscii }
 * ========================================================================== */
var DrumTabCore = (function () {
  'use strict';

  /* Lane definitions — display order top-to-bottom.
     id      : event type key from the backend
     label   : 2-char ASCII column label
     name    : human-readable name shown in the grid sidebar
     color   : lane / hit colour (dark-theme palette)
     symbol  : default ASCII tab character for a hit
     midi    : GM drum MIDI note numbers that map to this lane              */
  var LANES = [
    { id: 'crash',      label: 'CC', name: 'Crash',     color: '#4f9cf0', symbol: 'X', midi: [49, 57] },
    { id: 'ride',       label: 'RD', name: 'Ride',      color: '#5bc4f5', symbol: 'x', midi: [51, 59] },
    { id: 'hihat',      label: 'HH', name: 'Hi-Hat',    color: '#4caf50', symbol: 'x', midi: [42, 44] },
    { id: 'hihat_open', label: 'OH', name: 'Open HH',   color: '#81c784', symbol: 'O', midi: [46]     },
    { id: 'snare',      label: 'SN', name: 'Snare',     color: '#ffc107', symbol: 'X', midi: [38, 40] },
    { id: 'tom1',       label: 'T1', name: 'Hi Tom',    color: '#ba68c8', symbol: 'O', midi: [48, 50] },
    { id: 'tom2',       label: 'T2', name: 'Mid Tom',   color: '#9c27b0', symbol: 'O', midi: [45, 47] },
    { id: 'floor_tom',  label: 'FT', name: 'Floor Tom', color: '#7b1fa2', symbol: 'O', midi: [43, 41] },
    { id: 'kick',       label: 'KD', name: 'Kick',      color: '#ef5350', symbol: 'X', midi: [36, 35] },
  ];

  // Fast lookup tables built from LANES.
  var TYPE_TO_IDX = {};   // event type → lane index
  var GM_TO_TYPE  = {};   // GM MIDI note number → event type
  LANES.forEach(function (l, i) {
    TYPE_TO_IDX[l.id] = i;
    l.midi.forEach(function (n) { GM_TO_TYPE[n] = l.id; });
  });

  // ---- quantization ---------------------------------------------------------

  /**
   * Map raw onset events to integer grid positions.
   * @param {Array}  events      [{time_sec, type, velocity}]
   * @param {number} tempo       BPM
   * @param {number} subdivision Grid resolution (16 = sixteenth notes)
   * @returns {Array} [{type, laneIdx, gridPos, velocity}]
   */
  function quantize(events, tempo, subdivision) {
    var secsPerGrid = (60 / tempo) / (subdivision / 4);
    var out = [];
    events.forEach(function (ev) {
      var idx = TYPE_TO_IDX[ev.type];
      if (idx === undefined) return;
      out.push({
        type:     ev.type,
        laneIdx:  idx,
        gridPos:  Math.round(ev.time_sec / secsPerGrid),
        velocity: ev.velocity || 100,
      });
    });
    return out;
  }

  // ---- ASCII tab ------------------------------------------------------------

  /**
   * Render drum events as an ASCII tab string.
   *
   * Format (compact, 2 bars per line by default):
   *   Tempo: 120 BPM  |  4/4
   *
   *        |1e+a2e+a3e+a4e+a|1e+a2e+a3e+a4e+a|
   *   HH   |x.x.x.x.x.x.x.x.|x.x.x.x.x.x.x.x.|
   *   SN   |....X.......X...|....X.......X...|
   *   KD   |X.......X.X.....|X.......X.X.....|
   *
   * @param {Object} data       { events, tempo, duration }
   * @param {Object} [opts]     { tsNum, tsDen, subdivision, barsPerLine }
   * @returns {string}
   */
  function toAscii(data, opts) {
    if (!data || !data.events || !data.events.length) return '(no drum hits detected)';
    opts = opts || {};
    var tempo       = data.tempo || 120;
    var tsNum       = opts.tsNum || 4;
    var tsDen       = opts.tsDen || 4;
    var subdivision = opts.subdivision || 16;
    var barsPerLine = opts.barsPerLine || 2;

    // grid slots per beat: for 4/4 + 1/16 → 4 slots/beat
    var gridPerBeat = subdivision * (4 / tsDen) / 4;
    var gridPerBar  = gridPerBeat * tsNum;

    var qEvents = quantize(data.events, tempo, subdivision);

    // Build hit map: gridPos → { type: velocity }
    var hitMap = {};
    qEvents.forEach(function (ev) {
      if (!hitMap[ev.gridPos]) hitMap[ev.gridPos] = {};
      // keep highest velocity when two events quantize to the same slot
      if (!hitMap[ev.gridPos][ev.type] || hitMap[ev.gridPos][ev.type] < ev.velocity) {
        hitMap[ev.gridPos][ev.type] = ev.velocity;
      }
    });

    var maxPos    = qEvents.reduce(function (m, e) { return Math.max(m, e.gridPos); }, 0);
    var totalBars = Math.max(1, Math.ceil((maxPos + 1) / gridPerBar));

    // Only include lanes that have at least one hit.
    var activeLanes = LANES.filter(function (l) {
      return qEvents.some(function (e) { return e.type === l.id; });
    });
    if (!activeLanes.length) return '(no drum hits detected)';

    // Sub-division character labels within a beat (1/16: 1 e + a, 1/8: 1 +).
    var subLabels4 = ['1', 'e', '+', 'a'];
    var subLabels2 = ['1', '+'];
    var subLabels  = gridPerBeat === 4 ? subLabels4 : gridPerBeat === 2 ? subLabels2 : null;

    var LPAD = 5;  // label column width (e.g. "HH   ")

    var lines = [];
    lines.push('Tempo: ' + Math.round(tempo) + ' BPM  |  ' + tsNum + '/' + tsDen);
    lines.push('');

    for (var lineBar = 0; lineBar < totalBars; lineBar += barsPerLine) {
      var count = Math.min(barsPerLine, totalBars - lineBar);

      // ---- header line ----
      var hdr = ' '.repeat(LPAD);
      for (var b = 0; b < count; b++) {
        var barNum = lineBar + b + 1;
        hdr += '|';
        for (var beat = 0; beat < tsNum; beat++) {
          for (var sub = 0; sub < gridPerBeat; sub++) {
            if (subLabels && sub < subLabels.length) {
              // First sub of each beat: use beat number (cycle 1-4).
              hdr += sub === 0 ? String((beat % tsNum) + 1) : subLabels[sub];
            } else {
              hdr += sub === 0 ? String((beat % tsNum) + 1) : '.';
            }
          }
        }
      }
      hdr += '|';
      lines.push(hdr);

      // ---- lane rows ----
      activeLanes.forEach(function (lane) {
        var row = (lane.label + '   ').slice(0, LPAD);
        for (var b = 0; b < count; b++) {
          row += '|';
          var barOffset = (lineBar + b) * gridPerBar;
          for (var pos = 0; pos < gridPerBar; pos++) {
            var gp  = barOffset + pos;
            var vel = hitMap[gp] && hitMap[gp][lane.id];
            if (vel) {
              // Accent (vel > 110) → upper-case symbol; ghost (vel < 50) → lower-case
              var sym = lane.symbol;
              row += vel > 110 ? sym.toUpperCase() : vel < 50 ? sym.toLowerCase() : sym;
            } else {
              row += '.';
            }
          }
        }
        row += '|';
        lines.push(row);
      });

      lines.push('');
    }

    return lines.join('\n');
  }

  // ---- MIDI note import helper ----------------------------------------------

  /**
   * Convert an array of GM MIDI note objects to drum events.
   * Accepts the pretty_midi / MidiIO format: {pitch, velocity, start, end} or {pitch, velocity, tick}.
   */
  function fromMidiNotes(notes) {
    var out = [];
    notes.forEach(function (n) {
      var type = GM_TO_TYPE[n.pitch];
      if (!type) return;
      out.push({ time_sec: n.start || 0, type: type, velocity: n.velocity || 100 });
    });
    return out;
  }

  var api = {
    LANES:       LANES,
    TYPE_TO_IDX: TYPE_TO_IDX,
    GM_TO_TYPE:  GM_TO_TYPE,
    quantize:    quantize,
    toAscii:     toAscii,
    fromMidiNotes: fromMidiNotes,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
