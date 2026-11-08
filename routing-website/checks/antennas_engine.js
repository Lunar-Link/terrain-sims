// Antenna patterns in the engine: isotropic leaves every loss unchanged, the radial sweep applies the same gain as the per-link path, and the dipole adds what study 6.4.2 found.
"use strict";
const fs = require("fs"), path = require("path"), zlib = require("zlib");
const LL = require("../src/engine.js");
const OLD = process.env.OLD_ENGINE ? require(process.env.OLD_ENGINE) : null;

const TOOL = path.join(__dirname, "..");
const PAT = process.env.ANT_PATTERNS || path.join(TOOL, "data", "antennas.json");
const meta = JSON.parse(fs.readFileSync(path.join(TOOL, "data", "meta.json")));
const T = meta.terrain, n = T.n;
const raw = zlib.gunzipSync(Buffer.from(fs.readFileSync(path.join(TOOL, "data", "dem20.b64.txt"), "utf8").trim(), "base64"));
const q = raw.length / 4, bytes = new Uint8Array(raw.length);
for (let i = 0; i < q; i++) for (let k = 0; k < 4; k++) bytes[i * 4 + k] = raw[k * q + i];
const dem = new Float32Array(bytes.buffer);
const ter = new LL.Terrain(dem, n, n, T.x0, T.ytop, T.cell, T.bx, T.by, T.rdisk);
const P = JSON.parse(fs.readFileSync(PAT));
const ants = {};
for (const a of P.antennas) {
  const g = new Float32Array(a.g.length * a.g[0].length);
  a.g.forEach((r, i) => g.set(r, i * r.length));
  ants[a.id] = new LL.Antenna({ id: a.id, g, naz: a.g[0].length, nel: a.g.length, azStep: P.az_step, elStep: P.el_step, elMin: P.el_min, beams: a.family === "switched" ? 6 : 1, iso: a.id === "iso" });
}
const p = new LL.Params(433e6), f = 433e6, out = [];
const say = (s) => { console.log(s); out.push(s); };
let fail = 0;
const check = (name, ok, detail) => { say((ok ? "PASS " : "FAIL ") + name + " " + detail); if (!ok) fail++; };

function cov(x, y, ant, bore, crew, nAz) {
  const ds = 20, maxN = Math.ceil((T.rdisk + Math.hypot(x - T.bx, y - T.by)) / ds) + 2;
  const r = LL.coverageBlock(ter, new LL.Sweep(2048), { nAz, ds, a0: 0, a1: nAz, maxN, x, y, ht: 1.5, hr: 1.5, lossCut: 1e9, ant, bore, crew }, p, ants);
  return { r, maxN };
}
// 1. isotropic at both ends is bit-identical to no antennas
const nAz = 72, A = cov(T.bx, T.by, null, 0, null, nAz), B = cov(T.bx, T.by, "iso", 37, "iso", nAz);
let same = A.r.out.length === B.r.out.length;
for (let i = 0; same && i < A.r.out.length; i++) if (!(A.r.out[i] === B.r.out[i] || (isNaN(A.r.out[i]) && isNaN(B.r.out[i])))) same = false;
check("isotropic sweep identical", same, A.r.out.length + " samples");
if (OLD) {
  const C = OLD.coverageBlock(ter, new OLD.Sweep(2048), { nAz, ds: 20, a0: 0, a1: nAz, maxN: A.maxN, x: T.bx, y: T.by, ht: 1.5, hr: 1.5, lossCut: 1e9 }, new OLD.Params(f));
  let s2 = true; for (let i = 0; s2 && i < C.out.length; i++) if (C.out[i] !== A.r.out[i]) s2 = false;
  check("sweep identical to the engine before antennas", s2, "");
  let d = 0; for (let k = 0; k < 200; k++) { const x2 = T.bx + Math.cos(k) * 40 * k, y2 = T.by + Math.sin(k) * 40 * k; d = Math.max(d, Math.abs(OLD.linkLoss(ter, T.bx, T.by, x2, y2, 1.5, 1.5, new OLD.Params(f), false).L - LL.linkLoss(ter, T.bx, T.by, x2, y2, 1.5, 1.5, p, false).L)); }
  check("links identical to the engine before antennas", d === 0, "max diff " + d);
}
// 2. sweep gain against per-link gain on the same targets, directional antenna at an odd bearing
const ids = P.antennas.map((a) => a.id).filter((i) => i !== "iso"), dir = ids.find((i) => /yagi/.test(i)) || ids[0], bore = 23;
const D2 = cov(T.bx, T.by, dir, bore, "dipole", nAz), D0 = A;
const diffs = [], gaps = [];
for (let a = 0; a < nAz; a += 3) for (let k = 10; k < D2.r.counts[a]; k += 37) {
  const i = a * (D2.maxN + 1) + k, L0 = D0.r.out[i], L1 = D2.r.out[i];
  if (!isFinite(L0) || !isFinite(L1)) continue;
  const az = 360 * a / nAz, x = T.bx + k * 20 * Math.sin(az * Math.PI / 180), y = T.by + k * 20 * Math.cos(az * Math.PI / 180);
  const lk = LL.linkLoss(ter, T.bx, T.by, x, y, 1.5, 1.5, p, false);
  const g = ants[dir].gain(az - bore, lk.elT) + ants.dipole.gain(0, lk.elR);
  diffs.push((L0 - L1) - g); gaps.push(L0 - L1);
}
diffs.sort((u, v) => Math.abs(u) - Math.abs(v));
const med = diffs[Math.floor(diffs.length / 2)], p95 = diffs[Math.floor(diffs.length * 0.95)];
check("sweep gain matches link gain", Math.abs(med) < 0.3 && Math.abs(p95) < 1.5, "n " + diffs.length + ", median |diff| " + Math.abs(med).toFixed(2) + " dB, 95th " + Math.abs(p95).toFixed(2) + " dB");
// 3. dipole at both ends on summit coverage: 6.4.2 reports +3.2 to +3.9 dB per link on Malapert
const DD = cov(T.bx, T.by, "dipole", 0, "dipole", 360), add = [];
const I0 = cov(T.bx, T.by, null, 0, null, 360);
for (let a = 0; a < 360; a++) for (let k = 5; k <= DD.r.counts[a]; k++) {
  const i = a * (DD.maxN + 1) + k, u = I0.r.out[i], v = DD.r.out[i];
  if (isFinite(u) && isFinite(v) && k * 20 <= 8000) add.push(u - v);
}
add.sort((u, v) => u - v);
const mid = add[Math.floor(add.length / 2)], lo = add[Math.floor(add.length * 0.1)], hi = add[Math.floor(add.length * 0.9)];
check("dipole both ends, summit", mid > 3.0 && mid < 4.4, "median +" + mid.toFixed(2) + " dB (10-90 % " + lo.toFixed(2) + " to " + hi.toFixed(2) + "); 6.4.2: +3.2 to +3.9 dB");
// 4. switched beams take the best state, never less than one state
if (ants.espar) {
  let worst = Infinity; for (let az = 0; az < 360; az += 1) worst = Math.min(worst, ants.espar.gain(az, 0) - ants.espar.raw(az, 0));
  let ring = Infinity; for (let az = 0; az < 360; az += 1) ring = Math.min(ring, ants.espar.gain(az, 0));
  check("switched beam is the best state", worst >= 0, "lowest horizon gain over all bearings " + ring.toFixed(2) + " dBi");
}
process.exit(fail ? 1 : 0);
