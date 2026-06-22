/* ============================================================================
 * quantize-core.js  —  shared quantization math for every instrument type.
 *
 * One snap() used by the piano-roll (ticks) and the drum grid (seconds). Beyond
 * plain grid snapping it supports:
 *   • swing / shuffle  — delay the off-beat of each subdivision pair (50% =
 *                        straight, 66.7% = triplet shuffle, up to ~75%).
 *   • bias             — nudge the rounding threshold toward the previous (−) or
 *                        next (+) grid line (−0.5 … +0.5 of a grid step).
 *   • strength         — how far each onset moves toward its target (0 … 1);
 *                        <1 keeps some of the original human feel.
 *
 *   QuantizeCore.GRIDS                       — selectable grid resolutions
 *   QuantizeCore.find(value)                 — grid descriptor for a select value
 *   QuantizeCore.gridTicks(value, ppq)       — grid step in MIDI ticks
 *   QuantizeCore.gridSeconds(value, tempo)   — grid step in seconds
 *   QuantizeCore.snap(t, g, {swing,bias,strength})  — quantize one value
 * ========================================================================== */
var QuantizeCore = (function () {
  'use strict';

  // Grid resolutions, coarse → fine. `div` is the note denominator (8 = 1/8),
  // `triplet` squeezes three into the space of two.
  var GRIDS = [
    { value: '4',   label: '1/4',   div: 4,  triplet: false },
    { value: '4t',  label: '1/4T',  div: 4,  triplet: true  },
    { value: '8',   label: '1/8',   div: 8,  triplet: false },
    { value: '8t',  label: '1/8T',  div: 8,  triplet: true  },
    { value: '16',  label: '1/16',  div: 16, triplet: false },
    { value: '16t', label: '1/16T', div: 16, triplet: true  },
    { value: '32',  label: '1/32',  div: 32, triplet: false },
    { value: '32t', label: '1/32T', div: 32, triplet: true  },
    { value: '64',  label: '1/64',  div: 64, triplet: false }
  ];

  function find(value) {
    for (var i = 0; i < GRIDS.length; i++) if (GRIDS[i].value === String(value)) return GRIDS[i];
    return GRIDS[4];   // default 1/16
  }

  // grid step in ticks: a 1/div note is ppq*4/div ticks; triplets are ×2/3.
  function gridTicks(value, ppq) {
    var g = find(value), step = (ppq || 480) * 4 / g.div;
    if (g.triplet) step = step * 2 / 3;
    return step;
  }
  // grid step in seconds: a 1/div note is (60/tempo)*4/div seconds.
  function gridSeconds(value, tempo) {
    var g = find(value), beat = 60 / (tempo || 120), step = beat * 4 / g.div;
    if (g.triplet) step = step * 2 / 3;
    return step;
  }

  // Time of grid slot `i` under a swing feel. Slots pair up; the even slot sits
  // on the pair's start, the odd slot is pushed to `swing` of the pair (0.5 =
  // straight, 0.667 = triplet shuffle). g is the straight grid step.
  function slotTime(i, g, swing) {
    var pair = Math.floor(i / 2), inPair = i - pair * 2;
    return (pair * 2 + (inPair ? 2 * swing : 0)) * g;
  }

  // Quantize one value t (same unit as g) toward the swung grid.
  function snap(t, g, opts) {
    opts = opts || {};
    if (!(g > 0)) return t;
    var swing    = (opts.swing == null ? 0.5 : opts.swing);
    var bias     = opts.bias || 0;                        // −0.5 … +0.5 of a step
    var strength = (opts.strength == null ? 1 : opts.strength);
    var biased = t + bias * g;                            // +bias → lean toward the next slot
    var approx = Math.round(t / g);
    var best = null, bd = Infinity;
    for (var i = approx - 3; i <= approx + 3; i++) {
      var st = slotTime(i, g, swing), d = Math.abs(biased - st);
      if (d < bd) { bd = d; best = st; }
    }
    if (best == null) return t;
    return t + (best - t) * strength;
  }

  return { GRIDS: GRIDS, find: find, gridTicks: gridTicks, gridSeconds: gridSeconds, snap: snap };
})();
