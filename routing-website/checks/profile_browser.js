// Drives the page in headless Chrome for the link profile and saving: profile margins against Simulate for every pair, map clicks, point profiles, swapping ends, the link and browser round trips, import, export through linktable.py and lmesh_sim, phone width, screenshots.
"use strict";
const http = require("http"), fs = require("fs"), path = require("path"), { spawn, execFileSync } = require("child_process");

const TOOL = path.join(__dirname, "..");
const SCR = process.env.SCRATCH_DIR;
if (!SCR) { console.error("set SCRATCH_DIR"); process.exit(2); }
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
// The shared agent profile only: a new profile makes Chrome try a blank-password Windows sign-in, which counts toward account lockout.
const PROFILE = path.join(process.env.LOCALAPPDATA, "agent-chrome-profile");
const SIM = path.join(TOOL, "..", "..", "mesh-network", "build", process.platform === "win32" ? "lmesh_sim.exe" : "lmesh_sim");
const SHOT = path.join(SCR, "shots_profile");
const PORT = 8933, DBG = 9335, ORIGIN = "http://127.0.0.1:" + PORT;
fs.mkdirSync(SHOT, { recursive: true });
const types = { ".txt": "text/plain", ".webp": "image/webp", ".html": "text/html", ".json": "application/json" };
const srv = http.createServer((q, r) => {
  const u = decodeURIComponent(q.url.split("?")[0].split("#")[0]);
  const p = path.join(TOOL, u === "/" ? "index.html" : u);
  if (!p.startsWith(TOOL) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { "content-type": types[path.extname(p)] || "application/octet-stream" });
  fs.createReadStream(p).pipe(r);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ch = null;

async function main() {
  await new Promise((res) => srv.listen(PORT, "127.0.0.1", res));
  ch = spawn(CHROME, ["--headless=new", "--remote-debugging-port=" + DBG, "--user-data-dir=" + PROFILE, "--no-first-run", "--disable-gpu", "--window-size=1440,900", "about:blank"], { stdio: "ignore" });
  let tabs;
  for (let i = 0; i < 60; i++) { try { tabs = await (await fetch("http://127.0.0.1:" + DBG + "/json")).json(); if (tabs.length) break; } catch (e) { await sleep(250); } }
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
    const r = await Promise.race([send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }),
      sleep(60000).then(() => { throw new Error("no answer in 60 s from: " + x.slice(0, 120)); })]);
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
    return r.result.result.value;
  };
  const shot = async (n) => { const r = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(SHOT, n + ".png"), Buffer.from(r.result.data, "base64")); };
  const until = async (x, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 90000)) { if (await ev(x).catch(() => false)) return true; await sleep(150); } return false; };
  const click = async (x, y) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  };
  const ready = "!!(window.malapert && window.malapert.S.sim && !window.malapert.S.busy && !window.malapert.S.stale)";
  const go = async (url) => { await send("Page.navigate", { url }); await sleep(500); return until(ready); };
  const out = [], say = (s) => { console.log(s); out.push(s); };
  const check = (name, ok, detail) => say((ok ? "PASS " : "FAIL ") + name + (detail ? " " + detail : ""));
  const center = (x, y) => ev(`(() => { const v = window.malapert.view; v.cx = ${x}; v.cy = ${y}; return 1; })()`);
  const mapPt = (x, y) => ev(`(() => { const r = document.getElementById("map").getBoundingClientRect(), p = window.malapert.toScreen(${x}, ${y}); return { x: r.left + p.x, y: r.top + p.y }; })()`);

  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await send("Page.navigate", { url: ORIGIN + "/" }); await sleep(300);
  await ev("(() => { try { localStorage.clear(); } catch (e) {} return 1; })()");
  check("default plan loads and simulates", await go(ORIGIN + "/"));

  // 1. profile margins equal Simulate's for every ordered pair, and the path loss is the larger of P.526 and the hybrid
  const cmp = await ev(`(() => { const M = window.malapert, s = M.S.sim, L = s.list; let dm = 0, dl = 0, n = 0, los = 0, dif = 0;
    for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
      M.openProfile(L[i].id, L[j].id); const D = M.profile(); n++;
      dm = Math.max(dm, Math.abs(D.fwd - s.M[i][j]), Math.abs(D.back - s.M[j][i]));
      if (D.fw.los) los++; else { dif++; dl = Math.max(dl, Math.abs(D.fw.L - Math.max(D.fw.L526, D.hybrid))); }
    }
    return { n, dm, dl, los, dif, shown: !document.getElementById("prof").hidden, rows: document.querySelectorAll("#prof-k tr").length }; })()`);
  check("profile margins equal Simulate's both ways", cmp.dm < 1e-9, JSON.stringify(cmp));
  check("diffracted loss is the larger of P.526 and the hybrid", cmp.dl < 1e-9, "");
  check("panel shows with a budget table", cmp.shown && cmp.rows >= 8, "");

  // 2. a click on a chain link opens its profile
  await ev("(window.malapert.closeProfile(), 1)");
  const lk = await ev(`(() => { const s = window.malapert.S.sim, L = s.list; for (let i = 1; i < L.length; i++) if (s.par[i] >= 0) { const a = L[i], b = L[s.par[i]]; return { a: a.id, b: b.id, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; } return null; })()`);
  await center(lk.x, lk.y);
  const mp = await mapPt(lk.x, lk.y);
  await click(mp.x, mp.y); await sleep(150);
  const got = await ev("(() => { const P = window.malapert.S.prof; return P && [P.a, P.b].sort().join('-'); })()");
  check("map click on a chain link opens its profile", got === [lk.a, lk.b].sort().join("-"), got + " at " + Math.round(mp.x) + "," + Math.round(mp.y));
  await shot("01_link_profile");

  // 3. hover readout
  const cvb = await ev(`(() => { const r = document.getElementById("prof-cv").getBoundingClientRect(); return { x: r.left + r.width * 0.5, y: r.top + r.height * 0.5 }; })()`);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cvb.x, y: cvb.y }); await sleep(100);
  const rd = await ev(`document.getElementById("prof-read").hidden ? "" : document.getElementById("prof-read").textContent`);
  check("hover readout on the profile", /km: ground .* ray /.test(rd), rd.slice(0, 90));
  await shot("02_hover");

  // 4. swap ends: margins trade places
  const sw = await ev(`(() => { const M = window.malapert, a = M.profile(); document.getElementById("prof-swap").click(); const b = M.profile(); return { ok: a.A.id === b.B.id && Math.abs(a.fwd - b.back) < 1e-9 && Math.abs(a.back - b.fwd) < 1e-9, t: document.getElementById("prof-t").textContent }; })()`);
  check("swap ends trades the two margins", sw.ok, sw.t);
  const hm = await ev(`document.getElementById("prof-m").textContent`);
  check("the header shows state and both margins", /(reliable|marginal|down), margin .+ \/ .+ dB/.test(hm), hm);

  // 5. profile to a point, from the selected relay, at crew height
  await ev(`(() => { const M = window.malapert; M.closeProfile(); M.S.sel = M.S.nodes[0]; document.getElementById("probe").click(); return 1; })()`);
  const tgt = await ev(`(() => { const q = window.malapert.S.nodes[0]; return { x: q.x + 700, y: q.y - 400, id: q.id }; })()`);
  await center(tgt.x, tgt.y);
  const tp = await mapPt(tgt.x, tgt.y);
  await click(tp.x, tp.y); await sleep(150);
  const pr = await ev(`(() => { const D = window.malapert.profile(); return D && { a: D.A.id, crew: !!D.B.crew, h: D.fw.hrs - D.z[D.N - 1], probing: window.malapert.S.probing, t: document.getElementById("prof-t").textContent, s: document.getElementById("prof-s").textContent }; })()`);
  check("profile to a point starts at the selected site and ends at crew height", pr && pr.a === tgt.id && pr.crew && Math.abs(pr.h - 1.5) < 1e-9 && !pr.probing, JSON.stringify(pr));
  await shot("03_point_profile");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  check("Escape closes the profile", await ev(`document.getElementById("prof").hidden && window.malapert.S.prof === null`), "");

  // 6. live update: dragging a relay moves the open profile with it
  await ev(`(() => { const M = window.malapert, s = M.S.sim; M.openProfile("B", M.S.nodes[0].id); return 1; })()`);
  const n0 = await ev(`(() => { const q = window.malapert.S.nodes[0]; return { x: q.x, y: q.y, D: window.malapert.profile().D }; })()`);
  await center(n0.x, n0.y - 300);
  const p0 = await mapPt(n0.x, n0.y), p1 = await mapPt(n0.x + 250, n0.y + 150);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p0.x, y: p0.y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: p0.x, y: p0.y, button: "left", clickCount: 1 });
  for (let k = 1; k <= 6; k++) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p0.x + (p1.x - p0.x) * k / 6, y: p0.y + (p1.y - p0.y) * k / 6, button: "left", buttons: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p1.x, y: p1.y, button: "left", clickCount: 1 });
  await sleep(100);
  const n1 = await ev(`(() => { const q = window.malapert.S.nodes[0]; return { x: q.x, y: q.y, D: window.malapert.profile().D, stale: window.malapert.S.stale }; })()`);
  check("dragging a relay updates the open profile", Math.hypot(n1.x - n0.x, n1.y - n0.y) > 100 && Math.abs(n1.D - n0.D) > 1 && n1.stale, Math.round(n0.D) + " m to " + Math.round(n1.D) + " m");

  // 7. save: the link carries the plan, and this browser restores it
  await ev(`(() => { const e = document.getElementById("ant-relay"); e.value = "dipole"; e.dispatchEvent(new Event("change")); const b = document.getElementById("budget"); b.value = "22.5"; b.dispatchEvent(new Event("change")); return 1; })()`);
  await sleep(700);
  const st0 = await ev("JSON.stringify(window.malapert.planState())"), href = await ev("location.href");
  check("the page link carries the plan", /#p=[A-Za-z0-9_-]+$/.test(href) && JSON.stringify(await ev(`window.malapert.dec(location.hash.slice(3))`)) === st0, href.length + " characters");
  await ev("(() => { localStorage.clear(); return 1; })()");
  await send("Page.navigate", { url: "about:blank" }); await sleep(200);
  await go(href); await sleep(100);
  const st1 = await ev("JSON.stringify(window.malapert.planState())");
  check("opening the link restores the plan", st1 === st0, st1.length + " characters of state");
  await sleep(700);
  await send("Page.navigate", { url: "about:blank" }); await sleep(200);
  await go(ORIGIN + "/"); await sleep(100);
  const st2 = await ev("JSON.stringify(window.malapert.planState())");
  check("this browser restores the plan without the link", st2 === st0, "");
  const ui = await ev(`({ ant: document.getElementById("ant-relay").value, budget: document.getElementById("budget").value, relayAnt: window.malapert.S.nodes.every((q) => q.ant === "dipole") })`);
  check("controls show the restored settings", ui.ant === "dipole" && ui.budget === "22.5" && ui.relayAnt, JSON.stringify(ui));

  // 8. export: the scenario builds a link table and runs in the mesh simulator
  const sc = await ev("window.malapert.scenario()");
  const ej = path.join(SCR, "planner_export.json"), et = path.join(SCR, "planner_export.txt");
  fs.writeFileSync(ej, JSON.stringify(sc));
  let lt = "", simOut = "";
  try { lt = execFileSync("python", ["-B", "-m", "models.linktable", ej, "-o", et], { cwd: path.join(TOOL, ".."), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch (e) { lt = "ERROR " + e.message; }
  check("export builds a link table", fs.existsSync(et) && /nodes/.test(lt), lt.split("\n")[0]);
  if (fs.existsSync(SIM) && fs.existsSync(et)) {
    try { simOut = execFileSync(SIM, ["--terrain", et, "terrain", "1"], { encoding: "utf8" }); } catch (e) { simOut = String(e.stdout || e.message); }
    const pass = simOut.split("\n").find((l) => /^(PASS|FAIL) terrain/.test(l)) || "";
    check("the table runs in lmesh_sim", pass.startsWith("PASS"), pass.replace(/ (latency|rx_latency|receipts|data_retries|resend|evictions|refused|store_unexplained|duplicates|store_depth)[^ ]*/g, "").slice(0, 200));
  } else say("SKIP lmesh_sim not built at " + SIM);
  const relCount = sc.nodes.length - 2, starts = sc.nodes.filter((n) => n.start_s > 0).length;
  check("export carries base, relays, crew track and the planner state", sc.nodes[0].name === "base" && sc.nodes[sc.nodes.length - 1].track && sc.planner && sc.planner.v === 1, relCount + " relays, " + starts + " switch on along the route, track " + sc.nodes[sc.nodes.length - 1].track.t.length + " points");

  // 9. import: the export restores the plan; a scenario without planner state loads its sites and route
  await ev(`(async () => { await window.malapert.applyState(Object.assign({}, window.malapert.planState(), { relays: [] }), true); return 1; })()`);
  await ev(`(async () => { await window.malapert.importText(${JSON.stringify(JSON.stringify(sc))}); return 1; })()`); await until(ready);
  const st3 = await ev("JSON.stringify(window.malapert.planState())");
  check("import of an export restores the plan", st3 === st0, "");
  const bare = Object.assign({}, sc); delete bare.planner;
  await ev(`(async () => { await window.malapert.importText(${JSON.stringify(JSON.stringify(bare))}); return 1; })()`); await until(ready);
  const imp = await ev(`(() => { const S = window.malapert.S; return { relays: S.nodes.length, drawn: !!(S.plan && S.plan.drawn), ants: S.nodes.map((q) => q.ant).join(",") }; })()`);
  check("import of a bare scenario loads sites and route", imp.relays === relCount && imp.drawn, JSON.stringify(imp));
  const bad = await ev(`(async () => { try { await window.malapert.importText("{}"); return "accepted"; } catch (e) { return e.message; } })()`);
  check("import refuses a file with no plan", /no planner state/.test(bad), bad);

  // 10. a broken link falls back to the default plan with a note
  await ev("(() => { localStorage.clear(); return 1; })()");
  await send("Page.navigate", { url: "about:blank" }); await sleep(200);
  await send("Page.navigate", { url: ORIGIN + "/#p=not_a_plan" }); await sleep(900);
  const hint = await ev(`document.getElementById("hint").hidden ? "" : document.getElementById("hint").textContent`);
  await until(ready);
  check("a broken link shows the default plan with a note", /could not be read/.test(hint) && await ev("window.malapert.S.plan !== null"), hint);

  // 11. screenshots: a diffracted link and a line-of-sight link, light theme, phone width
  const two = await ev(`(() => { const M = window.malapert, s = M.S.sim, L = s.list; let d = null, l = null;
    for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) { M.openProfile(L[i].id, L[j].id); const D = M.profile(); if (!D.fw.los && D.runs.length >= 2 && !d) d = [L[i].id, L[j].id]; if (D.fw.los && !l) l = [L[i].id, L[j].id]; }
    return { d, l }; })()`);
  if (two.d) { await ev(`(window.malapert.openProfile("${two.d[0]}", "${two.d[1]}"), 1)`); await sleep(100); await shot("04_diffracted"); }
  if (two.l) { await ev(`(window.malapert.openProfile("${two.l[0]}", "${two.l[1]}"), 1)`); await sleep(100); await shot("05_line_of_sight"); }
  say("profiles shot: diffracted " + JSON.stringify(two.d) + ", line of sight " + JSON.stringify(two.l));
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] }); await sleep(200);
  await ev(`(() => { const r = document.querySelector(".scroll"), e = document.querySelector("section[aria-label='Save and share']"); r.scrollTop = e.offsetTop - r.offsetTop; return 1; })()`); await sleep(100);
  await shot("06_light_save");
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }); await sleep(600);
  await ev("(window.scrollTo(0, 0), document.querySelector('.scroll').scrollTop = 0, 1)");
  await ev(`(window.malapert.openProfile("${(two.d || two.l)[0]}", "${(two.d || two.l)[1]}"), 1)`); await sleep(200);
  await shot("07_phone_profile");
  const over = await ev("document.documentElement.scrollWidth > window.innerWidth");
  check("no horizontal scroll at 390 px", !over, "");
  check("no console errors", logs.length === 0, logs.join(" | "));
  fs.writeFileSync(path.join(SCR, "profile_browser.txt"), out.join("\n") + "\n");
  ch.kill(); srv.close(); process.exit(out.some((l) => l.startsWith("FAIL")) ? 1 : 0);
}
main().catch((e) => { console.error(e); if (ch) ch.kill(); srv.close(); process.exit(1); });
