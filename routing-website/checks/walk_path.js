// The walking path search (LL.walkPath) on small made-up terrain: a straight walk on open ground, a detour through the gap in a steep wall, no path when the wall is closed, a ramp too steep to step onto, and the mask.
"use strict";
const path = require("path");
const LL = require(path.join(__dirname, "..", "src", "engine.js"));

let fail = 0;
const check = (name, ok, detail) => { if (!ok) fail++; console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " " + detail : "")); };
const N = 60, CELL = 20;
const make = (zf, sf, mf) => {
  const z = new Float32Array(N * N), slope = new Uint8Array(N * N), mask = new Uint8Array(N * N).fill(1);
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) { z[r * N + c] = zf ? zf(r, c) : 0; slope[r * N + c] = Math.round(4 * (sf ? sf(r, c) : 0)); if (mf && !mf(r, c)) mask[r * N + c] = 0; }
  return { ter: new LL.Terrain(z, N, N, 0, (N - 1) * CELL, CELL, 0, 0, 1e9), slope, mask };
};
const xy = (r, c) => [c * CELL, (N - 1 - r) * CELL];
const run = (w, a, b, deg) => LL.walkPath(w.ter, w.slope, w.mask, ...xy(...a), ...xy(...b), deg);
const flatLen = (p) => { let s = 0; for (let i = 2; i < p.length; i += 2) s += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]); return s; };

// open ground: one straight segment
{
  const q = run(make(), [10, 5], [40, 50], 20), d = Math.hypot(30, 45) * CELL;
  check("open ground gives the straight line", q && q.pts.length === 4 && Math.abs(q.len - d) < 1e-6, q && q.len.toFixed(1) + " m against " + d.toFixed(1));
}
// a steep wall across the grid with one gap: the path goes through the gap
{
  const wall = (r, c) => (c === 30 && !(r >= 50 && r <= 52) ? 35 : 0), w = make(null, wall), q = run(w, [10, 5], [10, 55], 20);
  let through = false, onWall = false;
  if (q) for (let i = 2; i < q.pts.length; i += 2) {
    const m = 200; for (let k = 0; k <= m; k++) { const x = q.pts[i - 2] + (q.pts[i] - q.pts[i - 2]) * k / m, y = q.pts[i - 1] + (q.pts[i + 1] - q.pts[i - 1]) * k / m, c = Math.round(x / CELL), r = N - 1 - Math.round(y / CELL); if (c === 30) { if (r >= 50 && r <= 52) through = true; else onWall = true; } }
  }
  const direct = 50 * CELL, viaGap = (Math.hypot(25, 40) + Math.hypot(25, 40)) * CELL;
  check("a wall with a gap is passed through the gap", q && through && !onWall && flatLen(q.pts) > direct * 1.2 && flatLen(q.pts) < viaGap * 1.08, q && flatLen(q.pts).toFixed(0) + " m; straight " + direct + ", through the gap about " + viaGap.toFixed(0));
  const shut = make(null, (r, c) => (c === 30 ? 35 : 0));
  check("a closed wall gives no path at 20 degrees", run(shut, [10, 5], [10, 55], 20) === null);
  check("and a path once the limit is above the wall's slope", !!run(shut, [10, 5], [10, 55], 36));
}
// a height step too steep to climb in one move, with gentle cell slopes: the grade rule closes it
{
  const w = make((r, c) => (c >= 30 ? 15 : 0)), q = run(w, [10, 5], [10, 55], 20);
  check("a 15 m step between cells is closed by the grade rule", q === null);
  const ramp = make((r, c) => Math.max(0, Math.min(15, (c - 25) * 3)));
  check("the same rise as a 3 m per cell ramp is open", !!run(ramp, [10, 5], [10, 55], 20));
}
// cells outside the mask are closed, and the end cells stay open
{
  const w = make(null, null, (r, c) => c !== 30 || r > 55), q = run(w, [10, 5], [10, 55], 20);
  check("the mask closes cells", q && flatLen(q.pts) > 50 * CELL * 1.3);
  const ends = make(null, (r, c) => ((r === 10 && c === 5) || (r === 10 && c === 55) ? 40 : 0));
  check("steep end cells stay open", !!run(ends, [10, 5], [10, 55], 20));
  check("points off the grid give no path", LL.walkPath(w.ter, w.slope, w.mask, -500, 0, 100, 100, 20) === null);
}
process.exit(fail ? 1 : 0);
