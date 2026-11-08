// Antenna trade on Malapert routes: for each antenna set, the page's fewest-relay search to each route's farthest point and its greedy search along the route, then aim and Simulate (MODE=fixed instead keeps the study's relays and swaps only the antennas); relays, minutes out of contact, weakest and mean chain hop, and the chance every chain hop clears the fade margin under ±10 dB independent model error to ../antennas/data/planner_trade.csv.
"use strict";
const http = require("http"), fs = require("fs"), path = require("path"), { spawn } = require("child_process");

const TOOL = path.join(__dirname, ".."), SCR = process.env.SCRATCH_DIR;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = process.env.TRADE_OUT || path.join(SCR, "planner_trade.csv");
const PLANS = (process.env.PLANS || "1,5,9,13,17,8,12").split(",").map(Number);
const SETS = [
  ["iso", "iso", "Isotropic everywhere (study)"],
  ["dipole", "dipole", "Dipoles everywhere (hardware)"],
  ["col2", "col2", "2-stack collinears"],
  ["col4", "col4", "4-stack collinears"],
  ["skew3", "skew3", "Skewed omni, 3 dB F/B"],
  ["skew6", "skew6", "Skewed omni, 6 dB F/B"],
  ["refl2", "refl2", "Reflector dipoles"],
  ["yagi3", "yagi3", "3-element Yagis everywhere"],
  ["yagi5", "yagi5", "5-element Yagis everywhere"],
  ["card", "card", "Cardioid pairs"],
  ["yagi3", "bidir", "Yagi base, bidirectional relays"],
  ["espar", "espar", "Switched parasitic arrays"],
  ["pa4", "pa4", "4-element phased arrays"],
  ["dipole_inst", "dipole_inst", "Dipoles on the node (HFSS)"],
  ["col2_inst", "col2_inst", "2-stack collinears on the node (HFSS)"],
  ["espar_inst", "espar_inst", "ESPAR on the node (HFSS)"]
].filter((s) => !process.env.ONLY || process.env.ONLY.split(",").includes(s[1]));
const types = { ".txt": "text/plain", ".webp": "image/webp", ".html": "text/html" };
const srv = http.createServer((q, r) => {
  const u = decodeURIComponent(q.url.split("?")[0]);
  if (u === "/") { r.writeHead(200, { "content-type": "text/html" }); r.end('<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">' + fs.readFileSync(path.join(TOOL, "index.html"), "utf8") + "</body></html>"); return; }
  const p = path.join(TOOL, u);
  if (!fs.existsSync(p)) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { "content-type": types[path.extname(p)] || "application/octet-stream" }); fs.createReadStream(p).pipe(r);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await new Promise((res) => srv.listen(8933, "127.0.0.1", res));
  const ch = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9335", "--user-data-dir=" + path.join(SCR, "chrome_prof_trade"), "--no-first-run", "--disable-gpu", "--window-size=1440,900", "about:blank"], { stdio: "ignore" });
  let tabs;
  for (let i = 0; i < 60; i++) { try { tabs = await (await fetch("http://127.0.0.1:9335/json")).json(); if (tabs.length) break; } catch (e) { await sleep(250); } }
  const ws = new WebSocket(tabs.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((res) => (ws.onopen = res));
  let id = 0; const wait = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } };
  const send = (method, params) => new Promise((res) => { const i = ++id; wait.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const ev = async (x) => { const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600)); return r.result.result.value; };
  const until = async (x, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 600000)) { if (await ev(x).catch(() => false)) return true; await sleep(200); } return false; };
  await send("Page.enable"); await send("Runtime.enable");
  await send("Page.navigate", { url: "http://127.0.0.1:8933/" }); await sleep(500);
  await until("!!(window.malapert && window.malapert.S.sim && !window.malapert.S.busy)");
  const have = await ev("Object.keys(window.malapert.ANTS)");
  const rows = [["plan", "budget_db", "route_km", "study_relays", "set", "base", "relay", "far_km", "fewest_relays_to_far_point", "relays", "out_min", "route_min", "in_contact_pct", "weakest_hop_db", "mean_hop_db", "p_chain_holds", "connected", "area_km2"]];
  if (process.env.MODE === "robust") {
    const RS = [["dipole", "dipole", "Dipole"], ["col2", "col2", "2-stack collinear"], ["col4", "col4", "4-stack collinear"], ["skew6", "skew6", "Skewed omni, 6 dB"], ["yagi3", "bidir", "Yagi base, bidirectional relays"], ["espar", "espar", "ESPAR"], ["pa4", "pa4", "Phased array"], ["espar_inst", "espar_inst", "ESPAR on the node (HFSS)"]].filter((s) => !process.env.ONLY || process.env.ONLY.split(",").includes(s[1]));
    const out = [["plan", "budget_db", "set", "variant", "draw", "relays", "connected", "out_min", "route_min", "weakest_hop_db", "mean_hop_db", "p_chain_indep", "p_chain_shared", "area_km2"]];
    for (const pi of PLANS) for (const set of RS) {
      const steer = ["espar", "pa4", "espar_inst"].includes(set[1]), aim = ["skew6", "bidir"].includes(set[1]);
      const variants = [["baseline", 0]];
      if (steer) variants.push(["listen omni", 0]);
      variants.push(["unleveled", 0], ["suit -2 dB", 0], ["suit -6 dB", 0]);
      for (let k = 1; k <= 5; k++) variants.push(["tilt 3 deg rms", k]);
      if (aim) for (let k = 1; k <= 5; k++) variants.push(["aim error 15 deg rms", k]);
      for (const [v, k] of variants) {
        const r = await ev(`(async () => {
          const M = window.malapert, S = M.S, P = window.MALAPERT_META.plans[${pi}];
          let seed = ${pi * 1000 + k * 7 + 1}; const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
          const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
          S.rxMode = "best"; S.crewLoss = 0; S.base.tilt = 0; S.base.tiltAz = 0;
          S.relayAnt = "${set[1]}"; M.loadPlan("${pi}", false); S.base.ant = "${set[0]}";
          await M.aimAll(false);
          const all = [S.base].concat(S.nodes);
          if ("${v}" === "listen omni") S.rxMode = "omni";
          if ("${v}" === "suit -2 dB") S.crewLoss = 2;
          if ("${v}" === "suit -6 dB") S.crewLoss = 6;
          if ("${v}" === "unleveled") all.forEach((q) => { const g = M.tiltAt(q.x, q.y); q.tilt = g.t; q.tiltAz = g.ta; });
          if ("${v}" === "tilt 3 deg rms") all.forEach((q) => { q.tilt = 3 * Math.sqrt(-2 * Math.log(1 - rnd())); q.tiltAz = 360 * rnd(); });
          if ("${v}" === "aim error 15 deg rms") all.forEach((q) => { q.bore = ((q.bore + 15 * gauss()) % 360 + 360) % 360; });
          await M.simulate();
          const s = S.sim, n = s.list.length; let w = Infinity, sum = 0, cnt = 0, pind = 1; const ms = [];
          const phi = (z) => { const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2), e = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2); return z >= 0 ? (1 + e) / 2 : (1 - e) / 2; };
          for (let i = 1; i < n; i++) { const m = s.par[i] >= 0 ? s.hop[i][s.par[i]] : -Infinity; ms.push(m); if (s.conn[i]) { w = Math.min(w, m); sum += m; cnt++; } pind *= isFinite(m) ? phi((m - S.fade) / 10) : 0; }
          let psh = 0, wsum = 0;
          for (let j = -40; j <= 40; j++) { const b = 6 * j / 10, wt = Math.exp(-0.5 * (j / 10) * (j / 10)); let p = 1; ms.forEach((m) => { p *= isFinite(m) ? phi((m - S.fade + b) / 8) : 0; }); psh += wt * p; wsum += wt; }
          const res = { relays: n - 1, conn: s.conn.filter(Boolean).length - 1, out: s.route ? s.route.out : null, tmin: P.t_min, weak: w, mean: cnt ? sum / cnt : NaN, pind, psh: psh / wsum, area: s.area, name: P.name, budget: P.budget };
          S.rxMode = "best"; S.crewLoss = 0; S.base.tilt = 0; S.base.tiltAz = 0;
          return res;
        })()`);
        const f1 = (x) => typeof x === "number" && isFinite(x) ? x.toFixed(1) : "";
        out.push([r.name, r.budget, set[2], v, k, r.relays, r.conn, f1(r.out), f1(r.tmin), f1(r.weak), f1(r.mean), r.pind.toFixed(3), r.psh.toFixed(3), f1(r.area)]);
        console.log(out[out.length - 1].join(" | "));
      }
    }
    fs.writeFileSync(OUT, out.map((r) => r.map((v) => /[,"]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v).join(",")).join("\n") + "\n");
    ch.kill(); srv.close(); process.exit(0);
  }
  if (process.env.MODE === "fixed") {
    const fx = [["plan", "budget_db", "relays", "set", "base", "relay", "connected", "out_min", "route_min", "weakest_hop_db", "mean_hop_db", "p_chain_holds", "area_km2"]];
    for (const pi of PLANS) for (const set of SETS) {
      if (![set[0], set[1]].every((a) => have.includes(a))) continue;
      const r = await ev(`(async () => {
        const M = window.malapert, S = M.S, P = window.MALAPERT_META.plans[${pi}];
        S.relayAnt = "${set[1]}"; M.loadPlan("${pi}", false); S.base.ant = "${set[0]}";
        await M.aimAll(true);
        const s = S.sim, n = s.list.length; let w = Infinity, sum = 0, cnt = 0, pall = 1;
        const phi = (z) => { const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2), e = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2); return z >= 0 ? (1 + e) / 2 : (1 - e) / 2; };
        for (let i = 1; i < n; i++) { const m = s.par[i] >= 0 ? s.hop[i][s.par[i]] : -Infinity; if (s.conn[i]) { w = Math.min(w, m); sum += m; cnt++; } pall *= isFinite(m) ? phi((m - S.fade) / 10) : 0; }
        return { name: P.name, budget: P.budget, relays: n - 1, conn: s.conn.filter(Boolean).length - 1, out: s.route ? s.route.out : null, tmin: P.t_min, weak: w, mean: cnt ? sum / cnt : NaN, pall, area: s.area };
      })()`);
      fx.push([r.name, r.budget, r.relays, set[2], set[0], set[1], r.conn, r.out === null ? "" : r.out.toFixed(1), r.tmin.toFixed(1), typeof r.weak === "number" && isFinite(r.weak) ? r.weak.toFixed(1) : "", typeof r.mean === "number" && isFinite(r.mean) ? r.mean.toFixed(1) : "", r.pall.toFixed(3), r.area.toFixed(1)]);
      console.log(fx[fx.length - 1].join(" | "));
    }
    fs.writeFileSync(OUT, fx.map((r) => r.map((v) => /[,"]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v).join(",")).join("\n") + "\n");
    ch.kill(); srv.close(); process.exit(0);
  }
  for (const pi of PLANS) {
    for (const set of SETS) {
      if (![set[0], set[1]].every((a) => have.includes(a))) continue;
      const r = await ev(`(async () => {
        const M = window.malapert, S = M.S, P = window.MALAPERT_META.plans[${pi}];
        S.fade = P.budget === "128.5" ? 22.5 : 10; document.getElementById("budget").value = String(S.fade);
        S.nodes = []; S.base.ant = "${set[0]}"; S.relayAnt = "${set[1]}";
        let far = 0, fd = -1;
        P.tx.forEach((x, i) => { const d = Math.hypot(x - S.base.x, P.ty[i] - S.base.y); if (d > fd) { fd = d; far = i; } });
        S.plan = null; S.target = { x: P.tx[far], y: P.ty[far] };
        document.getElementById("auto-h").value = 1.5; document.getElementById("auto-x").value = 0;
        await M.autoPlan(true);
        const ptRelays = S.auto ? S.nodes.length : null;
        S.nodes = [];
        const k = Math.max(1, Math.floor(P.tx.length / 40)), way = [];
        for (let i = 0; i < P.tx.length; i += k) way.push({ x: P.tx[i], y: P.ty[i] });
        way.push({ x: P.tx[P.tx.length - 1], y: P.ty[P.ty.length - 1] });
        M.buildRoute(way); document.getElementById("auto-h").value = 1.5; document.getElementById("auto-x").value = 0;
        await M.autoPlan();
        const s = S.sim, n = s.list.length; let w = Infinity;
        for (let i = 1; i < n; i++) if (s.conn[i]) w = Math.min(w, s.hop[i][s.par[i]]);
        const phi = (z) => { const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2), e = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2); return z >= 0 ? (1 + e) / 2 : (1 - e) / 2; };
        let sum = 0, cnt = 0, pall = 1;
        for (let i = 1; i < n; i++) {
          const m = s.par[i] >= 0 ? s.hop[i][s.par[i]] : -Infinity;
          if (s.conn[i]) { sum += m; cnt++; }
          pall *= isFinite(m) ? phi((m - S.fade) / 10) : 0;
        }
        return { mean: cnt ? sum / cnt : NaN, pall, far_km: fd / 1000, ptRelays, name: P.name, budget: P.budget, km: S.plan.km, study: P.relays, relays: S.nodes.length, out: s.route ? s.route.out : null, tmin: S.plan.t_min, weak: w, conn: s.conn.filter(Boolean).length - 1, area: s.area };
      })()`);
      const pct = r.out === null ? "" : (100 * (1 - r.out / r.tmin)).toFixed(1);
      rows.push([r.name, r.budget, r.km.toFixed(2), r.study, set[2], set[0], set[1], r.far_km.toFixed(2), r.ptRelays === null ? "none within 12" : r.ptRelays, r.relays, r.out === null ? "" : r.out.toFixed(1), r.tmin.toFixed(1), pct, typeof r.weak === "number" && isFinite(r.weak) ? r.weak.toFixed(1) : "", typeof r.mean === "number" && isFinite(r.mean) ? r.mean.toFixed(1) : "", r.pall.toFixed(3), r.conn, r.area.toFixed(1)]);
      console.log(rows[rows.length - 1].join(" | "));
    }
  }
  fs.writeFileSync(OUT, rows.map((r) => r.map((v) => /[,"]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v).join(",")).join("\n") + "\n");
  ch.kill(); srv.close(); process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
