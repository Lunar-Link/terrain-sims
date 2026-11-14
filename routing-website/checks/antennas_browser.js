// Drives the page in headless Chrome for the antenna features: isotropic default against a reference page, each antenna type on the loaded plan with aiming, the relay search, console errors and screenshots.
"use strict";
const http = require("http"), fs = require("fs"), path = require("path"), { spawn } = require("child_process");

const TOOL = path.join(__dirname, "..");
const SCR = process.env.SCRATCH_DIR;
const REF = process.env.REF_INDEX;
const CHROME = process.env.CHROME_PATH || (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "C:/Program Files/Google/Chrome/Application/chrome.exe");
// The shared agent profile only: a new profile makes Chrome try a blank-password Windows sign-in, which counts toward account lockout.
const PROFILE = path.join(process.platform === "win32" ? process.env.LOCALAPPDATA : SCR, "agent-chrome-profile");
let ch = null;
const SHOT = path.join(SCR, "shots_ant");
fs.mkdirSync(SHOT, { recursive: true });
const types = { ".txt": "text/plain", ".webp": "image/webp", ".html": "text/html" };
const wrap = (b) => '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0}[hidden]{display:none!important}</style></head><body>' + b + "</body></html>";
const srv = http.createServer((q, r) => {
  const u = decodeURIComponent(q.url.split("?")[0]);
  if (u === "/" || u === "/index.html" || u === "/ref.html") {
    r.writeHead(200, { "content-type": "text/html" });
    r.end(wrap(fs.readFileSync(u === "/ref.html" ? REF : path.join(TOOL, "index.html"), "utf8")));
    return;
  }
  const p = path.join(TOOL, u);
  if (!fs.existsSync(p)) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { "content-type": types[path.extname(p)] || "application/octet-stream" });
  fs.createReadStream(p).pipe(r);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await new Promise((res) => srv.listen(8932, "127.0.0.1", res));
  ch = spawn(CHROME, ["--headless=new", "--remote-debugging-port=9334", "--user-data-dir=" + PROFILE, "--no-first-run", "--disable-gpu", "--window-size=1440,900", "about:blank"], { stdio: "ignore" });
  let tabs;
  for (let i = 0; i < 60; i++) { try { tabs = await (await fetch("http://127.0.0.1:9334/json")).json(); if (tabs.length) break; } catch (e) { await sleep(250); } }
  const tab = tabs.find((t) => t.type === "page"), ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res) => (ws.onopen = res));
  let id = 0; const wait = new Map(), logs = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); }
    if (m.method === "Runtime.exceptionThrown") logs.push("EXC " + m.params.exceptionDetails.text + " " + (m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description));
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") logs.push("CONSOLE " + m.params.args.map((a) => a.value || a.description).join(" "));
  };
  const send = (method, params) => new Promise((res) => { const i = ++id; wait.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const ev = async (x) => {
    const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
    return r.result.result.value;
  };
  const shot = async (n) => { const r = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(SHOT, n + ".png"), Buffer.from(r.result.data, "base64")); };
  const until = async (x, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 90000)) { if (await ev(x).catch(() => false)) return true; await sleep(150); } return false; };
  await send("Page.enable"); await send("Runtime.enable");
  await send("Page.navigate", { url: "http://127.0.0.1:8932/" }); await sleep(300);
  await ev("(() => { try { localStorage.clear(); } catch (e) {} return 1; })()");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  let failures = 0;
  const out = [], say = (s) => { console.log(s); out.push(s); if (s.startsWith("FAIL")) failures++; };
  const summary = `(() => { const s = window.malapert.S.sim; const n = s.list.length; let w = Infinity; for (let i = 1; i < n; i++) if (s.conn[i]) w = Math.min(w, s.hop[i][s.par[i]]);
    return { conn: s.conn.filter(Boolean).length - 1, n: n - 1, weak: +w.toFixed(3), area: +s.area.toFixed(3), out: s.route ? +s.route.out.toFixed(3) : null, ms: Math.round(s.ms) }; })()`;
  const ready = "!!(window.malapert && window.malapert.S.sim && !window.malapert.S.busy)";

  if (REF) {
    await send("Page.navigate", { url: "http://127.0.0.1:8932/ref.html" }); await sleep(400); await until(ready);
    const a = await ev(summary);
    await send("Page.navigate", { url: "http://127.0.0.1:8932/" }); await sleep(400); await until(ready);
    const b = await ev(summary);
    say("reference " + JSON.stringify(a)); say("isotropic " + JSON.stringify(b));
    say((a.weak === b.weak && a.area === b.area && a.out === b.out && a.conn === b.conn ? "PASS" : "FAIL") + " isotropic default matches the page before antennas");
  } else { await send("Page.navigate", { url: "http://127.0.0.1:8932/" }); await sleep(400); await until(ready); }
  await shot("00_iso");
  const tgt = await ev(`(async () => { const M = window.malapert, S = M.S, start = S.target;
    const ps = document.getElementById("preset"); ps.value = "free"; ps.dispatchEvent(new Event("change"));
    S.target = { x: S.base.x + 1500, y: S.base.y - 1500 }; await M.autoPlan(true);
    const ok = start === null && S.rateTarget === 1758 && S.target && S.target.x === S.base.x + 1500 && isFinite(S.sim.r.ceil);
    ps.value = "sf9"; ps.dispatchEvent(new Event("change")); M.loadPlan(String(window.MALAPERT_META.plans.findIndex((p) => p.case === "c2" && p.budget === "141")), false); await M.simulate();
    return { ok, start, rate: S.rateTarget, ceil: S.sim && S.sim.r.ceil }; })()`);
  say((tgt.ok ? "PASS" : "FAIL") + " map target and rate target are separate " + JSON.stringify(tgt));
  // Record actual map drawing, including markers drawn after the path overlay.
  await ev(`(() => {
    const P = CanvasRenderingContext2D.prototype, fill = P.fillRect, stroke = P.stroke, arc = P.arc;
    window.mapDrawing = { strokes: [], arcs: [] };
    P.fillRect = function (...a) { if (this.canvas.id === "map") window.mapDrawing = { strokes: [], arcs: [] }; return fill.apply(this, a); };
    P.stroke = function (...a) { if (this.canvas.id === "map") window.mapDrawing.strokes.push({ width: this.lineWidth, color: this.strokeStyle }); return stroke.apply(this, a); };
    P.arc = function (...a) { if (this.canvas.id === "map") window.mapDrawing.arcs.push(a[2]); return arc.apply(this, a); };
    return true;
  })()`);
  const robust = await ev(`(async () => {
    const M = window.malapert, S = M.S, input = document.getElementById("auto-failures");
    S.plan = null; S.base.ant = "iso"; S.relayAnt = "iso";
    const anchor = { id: "R1", x: S.base.x + 900, y: S.base.y - 700, h: 1.5, ant: "iso", bore: 0 }; S.nodes = [anchor];
    S.target = { x: S.base.x + 5000, y: S.base.y - 4000 };
    const one = async (failures) => {
      input.value = String(failures); await M.autoPlan(true);
      const paths = S.auto && S.auto.paths || [], mids = paths.flatMap((p) => p.slice(1, -1).map((q) => q.id));
      let margins = true;
      for (const p of paths) for (let i = 0; i + 1 < p.length; i++) {
        const a = p[i], b = p[i + 1]; M.openProfile(a.id, b.id || null, b.id ? null : { x: b.x, y: b.y });
        const d = M.profile(); if (!d || d.fwd < S.sim.r.fade || d.back < S.sim.r.fade) margins = false;
      }
      M.closeProfile();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const direct = paths.length === 1 && paths[0].length === 2;
      const disjoint = direct || (paths.length >= failures + 1 && new Set(mids).size === mids.length);
      const preserved = S.nodes.includes(anchor);
      const drawing = window.mapDrawing, drawnNodes = drawing.arcs.filter((r) => r === 11).length, drawnTargets = drawing.arcs.filter((r) => r === 8).length;
      const highlights = drawing.strokes.filter((s) => s.color === "#7fe0c2" && s.width >= 2.5).length;
      const extraBold = drawing.strokes.filter((s) => s.width >= 2.5 && (s.color === "#f2f4f5" || s.color === "#ffd640")).length;
      const gray = drawing.strokes.filter((s) => s.width === 1 && s.color === "rgba(170, 178, 186, 0.6)").length;
      const visible = drawnNodes === S.nodes.length && drawnTargets === 1;
      const styled = highlights === 1 && extraBold === 0 && (direct || gray > 0);
      return { failures, nodes: S.nodes.length, paths: paths.length, robust: disjoint && margins && preserved && visible && styled && S.nodes.length <= 12, disjoint, margins, preserved, direct, visible, styled, drawnNodes, drawnTargets, highlights, extraBold, gray };
    };
    window.checkRobust = one;
    return { one: await one(1), two: await one(2) };
  })()`);
  say((robust.one.robust ? "PASS" : "FAIL") + " one relay failure leaves a checked base-to-target path set " + JSON.stringify(robust.one));
  say((robust.two.robust ? "PASS" : "FAIL") + " two relay failures leave a checked base-to-target path set " + JSON.stringify(robust.two));
  await shot("robust_paths");
  const impossible = await ev(`(async () => { const result = await window.checkRobust(12); return { result, status: document.getElementById("stat").textContent }; })()`);
  say((!impossible.result.robust && /No layout survives up to 12 relay failures/.test(impossible.status) ? "PASS" : "FAIL") + " impossible failure request reports the relay limit " + JSON.stringify(impossible.result));
  if (process.env.POINT_ONLY) {
    say(logs.length ? "FAIL console: " + logs.join(" | ") : "PASS no console errors");
    ch.kill(); srv.close(); process.exit(failures ? 1 : 0);
  }
  const note = await ev(`(() => { const e = document.getElementById("ant-base"); e.value = "dipole"; e.dispatchEvent(new Event("change")); return document.getElementById("ant-note").textContent; })()`);
  say((note.startsWith("Base.") && /dipole/i.test(note) ? "PASS" : "FAIL") + " preview follows the base antenna: " + note.slice(0, 60));
  await ev(`(() => { const e = document.getElementById("ant-base"); e.value = "iso"; e.dispatchEvent(new Event("change")); return 1; })()`);
  const ids = await ev("Object.keys(window.malapert.ANTS)");
  for (const a of ids) {
    if (a === "iso") continue;
    await ev(`(async () => { const M = window.malapert, S = M.S; S.base.ant = "${a}"; S.relayAnt = "${a}"; S.nodes.forEach((q) => q.ant = "${a}"); document.getElementById("ant-relay").value = "${a}"; document.getElementById("ant-base").value = "${a}"; M.renderAnt(); await M.aimAll(true); return 1; })()`);
    await until(ready);
    const r = await ev(summary);
    say(a.padEnd(8) + " " + JSON.stringify(r));
    await shot("ant_" + a);
  }
  // relay search along a drawn route with a directional relay antenna
  await ev(`(async () => { const M = window.malapert, S = M.S, b = S.base; S.relayAnt = "${ids.includes("bidir") ? "bidir" : ids[1]}"; S.base.ant = "dipole"; M.buildRoute([{ x: b.x, y: b.y }, { x: b.x + 2500, y: b.y - 1500 }, { x: b.x + 4200, y: b.y - 3600 }]); await M.autoPlan(); return 1; })()`);
  await until(ready);
  say("drawn route, auto plan " + JSON.stringify(await ev(summary)) + " relays " + (await ev("window.malapert.S.nodes.map((q) => q.ant + '@' + q.bore).join(' ')")));
  await shot("auto_route");
  // aim handle drag on the map
  const before = await ev("window.malapert.S.nodes.length ? window.malapert.S.nodes[0].bore : null");
  say("aim before drag " + before);
  // phone width
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }); await sleep(600); await shot("phone");
  const over = await ev("document.documentElement.scrollWidth > window.innerWidth");
  say((over ? "FAIL" : "PASS") + " no horizontal scroll at 390 px");
  say(logs.length ? "FAIL console: " + logs.join(" | ") : "PASS no console errors");
  ch.kill(); srv.close(); process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); if (ch) ch.kill(); process.exit(1); });
