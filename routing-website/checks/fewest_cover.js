// The exact relay search (LL.fewestCover) against brute force on random small cases: the size found, that every returned set covers and is linked, and the proven flag.
"use strict";
const path = require("path");
const LL = require(path.join(__dirname, "..", "src", "engine.js"));

let seed = 12345, fail = 0;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const bits = (rows, n) => { const W = Math.max(1, Math.ceil(n / 32)), a = new Uint32Array(rows.length * W); rows.forEach((r, i) => r.forEach((j) => { a[i * W + (j >>> 5)] |= 1 << (j & 31); })); return a; };
const valid = (S, cov, adj, nt) => {
  const all = [0].concat(S), c = new Set(), seen = new Set([0]), st = [0];
  all.forEach((u) => cov[u].forEach((t) => c.add(t)));
  if (c.size < nt) return false;
  while (st.length) { const x = st.pop(); all.forEach((y) => { if (!seen.has(y) && adj[x].includes(y)) { seen.add(y); st.push(y); } }); }
  return seen.size === all.length;
};
const brute = (m, cov, adj, nt) => {
  let best = null;
  for (let mask = 0; mask < 1 << (m - 1); mask++) {
    const S = [];
    for (let i = 0; i < m - 1; i++) if (mask >> i & 1) S.push(i + 1);
    if ((best === null || S.length < best) && valid(S, cov, adj, nt)) best = S.length;
  }
  return best;
};

let cases = 0, withBridge = 0, none = 0, proven = 0, sizes = {};
for (let trial = 0; trial < 900; trial++) {
  const sparse = trial >= 600, m = 5 + Math.floor(rnd() * 9), nt = sparse ? 3 + Math.floor(rnd() * 5) : 6 + Math.floor(rnd() * 60), pc = sparse ? 0.12 : 0.08 + rnd() * 0.3, pa = sparse ? 0.2 + rnd() * 0.15 : 0.1 + rnd() * 0.4;
  const cov = [], adj = [];
  for (let u = 0; u < m; u++) { cov.push([]); adj.push([]); }
  for (let u = 0; u < m; u++) for (let t = 0; t < nt; t++) if (rnd() < pc && !(sparse && u > m / 2)) cov[u].push(t);
  for (let t = 0; t < nt; t++) if (!cov.some((r) => r.includes(t))) cov[1 + Math.floor(rnd() * (sparse ? Math.floor(m / 2) : m - 1))].push(t);
  for (let u = 0; u < m; u++) for (let v = u + 1; v < m; v++) if (rnd() < pa) { adj[u].push(v); adj[v].push(u); }
  const want = brute(m, cov, adj, nt), kmax = m - 1;
  const r = LL.fewestCover(m, nt, bits(cov, nt), bits(adj, m), kmax, 20, 5000);
  cases++;
  let ok = true, why = "";
  if (want === null) { none++; if (r.k !== null && r.sets.length) { ok = false; why = "found a set where none exists"; } }
  else {
    sizes[want] = (sizes[want] || 0) + 1;
    if (r.proven) proven++;
    if (r.k !== want && r.proven) { ok = false; why = "size " + r.k + " against " + want; }
    if (r.k !== null && r.k < want) { ok = false; why = "size below the minimum"; }
    for (const S of r.sets) { if (S.length !== r.k || !valid(S, cov, adj, nt)) { ok = false; why = "a returned set is not valid"; } }
    if (r.sets.length && !valid(r.sets[0].filter((u) => cov[u].length), cov, adj, nt)) withBridge++;
  }
  if (!r.proven && want !== null && want <= 3) { ok = false; why = "not proven on a small case"; }
  if (!ok) { fail++; console.log("FAIL trial " + trial + ": " + why + " (m " + m + ", targets " + nt + ", brute " + want + ", got " + JSON.stringify({ k: r.k, proven: r.proven, sets: r.sets.slice(0, 2) }) + ")"); }
}
console.log((fail ? "FAIL " : "PASS ") + "fewest cover against brute force: " + cases + " cases, " + none + " with no linked cover, " + proven + " of the rest proven, " + withBridge + " needing a bridge site, sizes " + JSON.stringify(sizes));

// kmax below the minimum: nothing found, and proven means no set of kmax or fewer exists
{
  const cov = [[0], [1], [2], [3]], adj = [[1, 2, 3], [0], [0], [0]];
  const r = LL.fewestCover(4, 4, bits(cov, 4), bits(adj, 4), 2, 10, 1000);
  const ok = r.k === null && r.proven && !r.sets.length;
  if (!ok) fail++;
  console.log((ok ? "PASS " : "FAIL ") + "kmax below the minimum returns no set, proven");
}
// time limit: a zero budget on a large case returns unproven without throwing
{
  const m = 400, nt = 300, cov = [], adj = [];
  for (let u = 0; u < m; u++) { cov.push([]); adj.push([]); }
  for (let u = 1; u < m; u++) for (let t = 0; t < nt; t++) if (rnd() < 0.02) cov[u].push(t);
  for (let u = 0; u < m; u++) for (let v = u + 1; v < m; v++) if (rnd() < 0.05) { adj[u].push(v); adj[v].push(u); }
  let t = 0;
  const r = LL.fewestCover(m, nt, bits(cov, nt), bits(adj, m), 12, 10, -1, () => (t += 10));
  const ok = r.proven === false && r.k === null;
  if (!ok) fail++;
  console.log((ok ? "PASS " : "FAIL ") + "time limit stops the search unproven (" + r.nodes + " states)");
}
process.exit(fail ? 1 : 0);
