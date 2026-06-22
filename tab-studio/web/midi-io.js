/* ============================================================================
 * midi-io.js  —  self-contained Standard MIDI File reader + writer (no deps).
 *
 * Bass Studio is a standalone app: it does NOT import the Bass Tab Creator's
 * bass-tab-core.js. This module owns both directions of MIDI I/O. The reader is
 * adapted from that engine's parser as a reference; the writer is new (the
 * repo had no MIDI writer before).
 *
 *   MidiIO.read(bytes)   -> { ppq, tempo, timeSig:{num,den}, notes:[{start,end,pitch,velocity}] }
 *   MidiIO.write(project)-> Uint8Array   (format-0 SMF: tempo + time sig + notes)
 *
 * Times are in ticks at the file's PPQ. notes carry start/end ticks, MIDI pitch
 * (0..127) and velocity (1..127).
 * ========================================================================== */
(function (global) {
  'use strict';

  // ---- READ ----------------------------------------------------------------
  function read(bytes) {
    var d = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var pos = 0;
    function u8() { return d[pos++]; }
    function u16() { return (d[pos++] << 8) | d[pos++]; }
    function u32() { return ((d[pos++] << 24) | (d[pos++] << 16) | (d[pos++] << 8) | d[pos++]) >>> 0; }
    function str(n) { var s = ''; for (var i = 0; i < n; i++) s += String.fromCharCode(d[pos++]); return s; }
    function vlen() { var v = 0, c; do { c = d[pos++]; v = (v << 7) | (c & 0x7f); } while (c & 0x80); return v; }

    if (str(4) !== 'MThd') throw new Error('Not a MIDI file (missing MThd header).');
    var hlen = u32();
    /* format */ u16();
    var ntracks = u16(), division = u16();
    pos += hlen - 6;
    if (division & 0x8000) throw new Error('SMPTE-timed MIDI is not supported (need PPQ).');
    var ppq = division || 480;

    var tempo = 120, timeSig = { num: 4, den: 4 }, gotTempo = false, gotTs = false;
    var notes = [];

    for (var t = 0; t < ntracks; t++) {
      if (str(4) !== 'MTrk') break;                 // tolerate trailing junk
      var tlen = u32(), end = pos + tlen, abs = 0, running = null;
      var open = {};                                 // pitch -> [{start, vel}]
      while (pos < end) {
        abs += vlen();
        var status = d[pos];
        if (status & 0x80) { pos++; running = status; } else { status = running; }
        var ev = status & 0xf0;
        if (status === 0xff) {                       // meta
          var mtype = u8(), mlen = vlen(), mstart = pos;
          if (mtype === 0x51 && mlen === 3 && !gotTempo) {
            var us = (d[mstart] << 16) | (d[mstart + 1] << 8) | d[mstart + 2];
            tempo = 60000000 / us; gotTempo = true;
          } else if (mtype === 0x58 && mlen >= 2 && !gotTs) {
            timeSig = { num: d[mstart], den: Math.pow(2, d[mstart + 1]) }; gotTs = true;
          }
          pos = mstart + mlen;
        } else if (status === 0xf0 || status === 0xf7) {   // sysex
          var sl = vlen(); pos += sl;
        } else if (ev === 0xc0 || ev === 0xd0) {           // program / chan pressure (1 byte)
          pos += 1;
        } else {                                            // 2-byte channel voice
          var d1 = d[pos++], d2 = d[pos++];
          if (ev === 0x90 && d2 > 0) {
            (open[d1] = open[d1] || []).push({ start: abs, vel: d2, ch: status & 0x0f });
          } else if (ev === 0x80 || (ev === 0x90 && d2 === 0)) {
            var st = open[d1] && open[d1].shift();
            if (st) notes.push({ start: st.start, end: abs, pitch: d1, velocity: st.vel, channel: st.ch });
          }
        }
      }
      for (var p in open) open[p].forEach(function (st) {   // close hanging notes
        notes.push({ start: st.start, end: abs, pitch: +p, velocity: st.vel, channel: st.ch });
      });
      pos = end;
    }

    notes.sort(function (a, b) { return a.start - b.start || a.pitch - b.pitch; });
    return { ppq: ppq, tempo: tempo, timeSig: timeSig, notes: notes };
  }

  // ---- WRITE ---------------------------------------------------------------
  function vlenBytes(v) {                          // variable-length quantity
    v = Math.max(0, Math.round(v));
    var buf = [v & 0x7f];
    v >>= 7;
    while (v) { buf.unshift((v & 0x7f) | 0x80); v >>= 7; }
    return buf;
  }
  function pushStr(out, s) { for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff); }
  function pushU16(out, v) { out.push((v >> 8) & 0xff, v & 0xff); }
  function pushU32(out, v) { out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff); }

  function write(project) {
    var ppq = Math.max(1, Math.round(project.ppq || 480));
    var tempo = project.tempo || 120;
    var ts = project.timeSig || { num: 4, den: 4 };
    var notes = (project.notes || []).slice().filter(function (n) { return n.end > n.start; });

    // flatten notes to a time-sorted event stream; note-offs before note-ons at
    // the same tick so a re-struck pitch isn't immediately killed.
    var events = [];
    notes.forEach(function (n) {
      var pitch = clampInt(n.pitch, 0, 127), vel = clampInt(n.velocity || 100, 1, 127);
      var ch = clampInt(n.channel || 0, 0, 15);   // 9 = GM percussion (channel 10)
      events.push({ tick: Math.round(n.start), kind: 1, pitch: pitch, vel: vel, ch: ch });   // on
      events.push({ tick: Math.round(n.end),   kind: 0, pitch: pitch, vel: 64, ch: ch });    // off
    });
    events.sort(function (a, b) { return a.tick - b.tick || a.kind - b.kind; });

    var trk = [];
    // tempo meta: FF 51 03 tttttt
    var us = Math.round(60000000 / tempo);
    Array.prototype.push.apply(trk, vlenBytes(0));
    trk.push(0xff, 0x51, 0x03, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff);
    // time-sig meta: FF 58 04 nn dd cc bb
    Array.prototype.push.apply(trk, vlenBytes(0));
    trk.push(0xff, 0x58, 0x04, clampInt(ts.num, 1, 255), Math.round(Math.log2(ts.den || 4)), 24, 8);

    var last = 0;
    events.forEach(function (e) {
      Array.prototype.push.apply(trk, vlenBytes(e.tick - last));
      last = e.tick;
      if (e.kind === 1) trk.push(0x90 | e.ch, e.pitch, e.vel);
      else trk.push(0x80 | e.ch, e.pitch, e.vel);
    });
    // end of track
    Array.prototype.push.apply(trk, vlenBytes(0));
    trk.push(0xff, 0x2f, 0x00);

    var out = [];
    pushStr(out, 'MThd'); pushU32(out, 6);
    pushU16(out, 0); pushU16(out, 1); pushU16(out, ppq);   // format 0, 1 track
    pushStr(out, 'MTrk'); pushU32(out, trk.length);
    Array.prototype.push.apply(out, trk);
    return new Uint8Array(out);
  }

  function clampInt(v, lo, hi) { v = Math.round(v || 0); return v < lo ? lo : v > hi ? hi : v; }

  var api = { read: read, write: write };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MidiIO = api;
})(typeof window !== 'undefined' ? window : globalThis);
