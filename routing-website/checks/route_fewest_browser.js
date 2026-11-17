// Drives the page in headless Chrome for the route relay search: on drawn copies of stored routes, the search with relays anywhere and within 100 m of the route, the result note, Simulate's contact on the route, the saved state, console errors and screenshots.
"use strict";
const http = require("http"), fs = require("fs"), path = require("path"), { spawn } = require("child_process");

const TOOL = path.join(__dirname, "..");
const SCR = process.env.SCRATCH_DIR;
if (!SCR) { console.error("set SCRATCH_DIR"); process.exit(2); }
const ROUTES = (process.env.PLANS || "0,8").split(",").map(Number);
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
// The shared agent profile only: a new profile makes Chrome try a blank-password Windows sign-in, which counts toward account lockout.
const PROFILE = path.join(process.env.LOCALAPPDATA, "agent-chrome-profile");
const SHOT = path.join(SCR, "shots_route");
const PORT = 8937, DBG = 9337, ORIGIN = "http://127.0.0.1:" + PORT;
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
  const ev = async (x, ms) => {
    const r = await Promise.race([send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }),
      sleep(ms || 60000).then(() => { throw new Error("no answer from: " + x.slice(0, 120)); })]);
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
    return r.result.result.value;
  };
  const shot = async (n) => { const r = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(SHOT, n + ".png"), Buffer.from(r.result.data, "base64")); };
  const until = async (x, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 90000)) { if (await ev(x).catch(() => false)) return true; await sleep(150); } return false; };
  const ready = "!!(window.malapert && window.malapert.S.sim && !window.malapert.S.busy && !window.malapert.S.stale)";
  const out = [], T0 = Date.now(), say = (s) => { console.log(s); out.push(s); if (process.env.TIMES) console.error(((Date.now() - T0) / 1000).toFixed(0) + " s: " + s.slice(0, 70)); };
  const check = (name, ok, detail) => say((ok ? "PASS " : "FAIL ") + name + (detail ? " " + detail : ""));

  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await send("Page.navigate", { url: ORIGIN + "/" }); await sleep(300);
  await ev("(() => { try { localStorage.clear(); } catch (e) {} return 1; })()");
  await send("Page.navigate", { url: ORIGIN + "/?route=1" }); await sleep(500);
  check("page loads and simulates", await until(ready));
  const pick = await ev(`(async () => { const M = window.malapert, S = M.S, sel = document.getElementById("route-sel"), opts = Array.from(sel.options).filter((o) => !o.hidden).map((o) => o.textContent), first = sel.value;
    sel.value = sel.options[1].value; sel.dispatchEvent(new Event("change"));
    for (let i = 0; i < 2400 && (S.busy || S.stale); i++) await new Promise((res) => setTimeout(res, 50));
    const got = S.plan && S.plan.name, relays = S.nodes.length;
    M.buildRoute([{ x: S.base.x, y: S.base.y }, { x: S.base.x - 800, y: S.base.y - 500 }]); const drawnValue = sel.value;
    M.loadPlan(first, false);
    return { opts, first: sel.options[sel.selectedIndex].textContent, got, relays, drawnValue, back: sel.value === first }; })()`, 120000);
  check("the reference route box lists five routes, opens on the default and loads the one picked", pick.opts.length === 5 && /10 km drive, southeast/.test(pick.first) && /Design-reference EVA/.test(pick.got) && pick.relays === 2 && pick.drawnValue === "" && pick.back, JSON.stringify(pick));
  check("the antenna caption and its help text are gone", await ev(`!document.getElementById("ant-note") && !document.querySelector(".antcav")`));
  check("a stored plan shows the route button and the near-route option", await ev(`!document.getElementById("auto-near-row").hidden && !document.getElementById("auto-route").hidden && document.getElementById("auto-note").hidden`));
  for (const near of [false, true]) {
    const r = await ev(`(async () => { const M = window.malapert, S = M.S; M.loadPlan("0", false);
      const box = document.getElementById("auto-near"); box.checked = ${near}; box.dispatchEvent(new Event("change"));
      document.getElementById("auto-route").click();
      for (let i = 0; i < 600 && !(S.busy); i++) await new Promise((res) => setTimeout(res, 5));
      for (let i = 0; i < 2400 && (S.busy || S.stale); i++) await new Promise((res) => setTimeout(res, 50));
      const s = S.sim, off = S.nodes.map((q) => { let d = Infinity; for (let i = 0; i < S.plan.tx.length; i++) d = Math.min(d, Math.hypot(S.plan.tx[i] - q.x, S.plan.ty[i] - q.y)); return Math.round(d); });
      return { n: S.nodes.length, stored: !S.plan.drawn && S.plan.name, note: document.getElementById("auto-note").textContent, noteShown: !document.getElementById("auto-note").hidden, off, out: s.route ? s.route.out : null, conn: s.conn.filter(Boolean).length - 1, proven: S.autoInfo && S.autoInfo.proven }; })()`, 240000);
    say(`  stored plan 0 (${r.stored}), ${near ? "within 100 m" : "anywhere"}: ${r.n} relays, off route ${JSON.stringify(r.off)} m, out of contact ${r.out === null ? "n/a" : r.out.toFixed(1)} min`);
    say(`    note: ${r.note}`);
    check(`stored plan ${near ? "near" : "anywhere"}: the button searches along the stored route and keeps the plan`, !!r.stored && r.conn === r.n && r.noteShown && r.note.indexOf(r.n + " relay") === 0);
    if (near) check("stored plan near: relays lie within 100 m of the route (one block of slack)", r.off.every((d) => d <= 130), JSON.stringify(r.off));
    await sleep(600); await shot(`stored0_${near ? "near" : "anywhere"}`);
  }

  for (const pi of ROUTES) {
    const name = await ev(`window.MALAPERT_META.plans[${pi}].name + ", " + window.MALAPERT_META.plans[${pi}].km + " km"`);
    const res = {};
    for (const near of [false, true]) {
      const r = await ev(`(async () => { const M = window.malapert, S = M.S, P = window.MALAPERT_META.plans[${pi}], way = [], st = Math.max(1, Math.ceil(P.tx.length / 40));
        for (let i = 0; i < P.tx.length; i += st) way.push({ x: P.tx[i], y: P.ty[i] });
        way.push({ x: P.tx[P.tx.length - 1], y: P.ty[P.ty.length - 1] });
        S.nodes = []; S.base.ant = "iso"; S.relayAnt = "iso"; M.buildRoute(way);
        const box = document.getElementById("auto-near"); box.checked = ${near}; box.dispatchEvent(new Event("change"));
        const rowShown = !document.getElementById("auto-near-row").hidden, t0 = performance.now();
        await M.autoPlan();
        const t = (performance.now() - t0) / 1000, s = S.sim, off = S.nodes.map((q) => { let d = Infinity; for (let i = 0; i < S.plan.tx.length; i++) d = Math.min(d, Math.hypot(S.plan.tx[i] - q.x, S.plan.ty[i] - q.y)); return Math.round(d); });
        return { t, n: S.nodes.length, note: document.getElementById("auto-note").textContent, noteShown: !document.getElementById("auto-note").hidden, info: S.autoInfo, rowShown, off,
          out: s.route ? s.route.out : null, conn: s.conn.filter(Boolean).length - 1, stale: S.stale, near: M.planState().near }; })()`, 240000);
      res[near] = r;
      const f = r.info || {};
      say(`  ${name}, ${near ? "within 100 m" : "anywhere"}: ${r.n} relays in ${r.t.toFixed(1)} s (quick search ${f.greedy}, ${f.proven ? "proven" : "not proven"}, ${f.checked} sites, ${f.nodes || 0} states, ${Math.round(f.ms || 0)} ms); off route ${JSON.stringify(r.off)} m; out of contact ${r.out === null ? "n/a" : r.out.toFixed(1)} min`);
      say(`    note: ${r.note}`);
      check(`route ${pi} ${near ? "near" : "anywhere"}: every relay is connected and the plan is simulated`, r.conn === r.n && !r.stale);
      check(`route ${pi} ${near ? "near" : "anywhere"}: never more relays than the quick search`, r.n <= f.greedy);
      check(`route ${pi} ${near ? "near" : "anywhere"}: the note is shown and names the count`, r.noteShown && r.rowShown && (r.n === 0 ? /no relays/.test(r.note) : r.note.indexOf(r.n + " relay") === 0));
      check(`route ${pi} ${near ? "near" : "anywhere"}: the option is in the saved state`, r.near === near);
      if (near) check(`route ${pi} near: relays lie within 100 m of the route (one block of slack)`, r.off.every((d) => d <= 130), JSON.stringify(r.off));
      await sleep(600); await shot(`route${pi}_${near ? "near" : "anywhere"}`);
    }
    check(`route ${pi}: relays anywhere never need more than relays near the route`, res[false].n <= res[true].n, res[false].n + " against " + res[true].n);
  }

  // high bandwidth: hops between sites also close at the FLRC burst rung, 22 dB tighter than SF9
  const hb = await ev(`(async () => { const M = window.malapert, S = M.S, out = {};
    for (const on of [false, true]) {
      M.loadPlan("0", false);
      const near = document.getElementById("auto-near"); near.checked = false; near.dispatchEvent(new Event("change"));
      const box = document.getElementById("auto-hb"); box.checked = on; box.dispatchEvent(new Event("change"));
      await M.autoPlan(false, true);
      const s = S.sim, hops = []; for (let i = 1; i < s.list.length; i++) if (s.conn[i] && s.par[i] >= 0) hops.push(s.hop[i][s.par[i]]);
      out[on] = { n: S.nodes.length, weakest: Math.min.apply(null, hops), conn: s.conn.filter(Boolean).length - 1, out: s.route.out, note: document.getElementById("auto-note").textContent, saved: M.planState().hb };
    }
    const box = document.getElementById("auto-hb"); box.checked = false; box.dispatchEvent(new Event("change"));
    return out; })()`, 240000);
  say(`  high bandwidth on the 2 km walk: ${hb[false].n} relays, weakest hop ${hb[false].weakest.toFixed(1)} dB; with the box, ${hb[true].n} relays, weakest hop ${hb[true].weakest.toFixed(1)} dB, out of contact ${hb[true].out.toFixed(1)} min`);
  say(`    note: ${hb[true].note}`);
  check("high bandwidth: every hop holds 32 dB (10 dB over the 487 kb/s FLRC rung) and all relays connect", hb[true].weakest >= 32 - 0.01 && hb[true].conn === hb[true].n && hb[true].n >= hb[false].n && hb[true].saved === true && /FLRC burst range/.test(hb[true].note));
  await sleep(600); await shot("stored0_high_bandwidth");

  // point search: the walking path from the base
  const wk = await ev(`(async () => { const M = window.malapert, S = M.S; M.loadPlan("0", false);
    S.target = { x: S.base.x - 1500, y: S.base.y - 900 }; await M.autoPlan(true);
    const w = S.walk, p = w && w.pts; if (!p) return { none: true };
    let step = 0, steep = 0, len = 0;
    for (let i = 1; i < p.length; i++) {
      const d = Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y), m = Math.max(1, Math.ceil(d / 10)); step = Math.max(step, d); len += d;
      for (let k = 1; k < m; k++) steep = Math.max(steep, M.tiltAt(p[i - 1].x + (p[i].x - p[i - 1].x) * k / m, p[i - 1].y + (p[i].y - p[i - 1].y) * k / m).t);
    }
    return { n: p.length, step, steep, len, len3: w.len, deg: w.deg, straight: Math.hypot(S.target.x - S.base.x, S.target.y - S.base.y), d0: Math.hypot(p[0].x - S.base.x, p[0].y - S.base.y), d1: Math.hypot(p[p.length - 1].x - S.target.x, p[p.length - 1].y - S.target.y),
      note: document.getElementById("auto-note").textContent, legend: /Walking path/.test(document.querySelector(".legend").textContent), relays: S.nodes.length }; })()`, 240000);
  say(`  walking path to a point 1.75 km out: ${wk.none ? "none" : (wk.len3 / 1000).toFixed(2) + " km in " + wk.n + " points, steepest cell " + wk.steep.toFixed(1) + " deg, limit " + wk.deg + " deg"}`);
  say(`    note: ${wk.note}`);
  check("point search draws a walking path from the base to the point within the slope limit", !wk.none && wk.d0 <= 15 && wk.d1 <= 15 && wk.len >= wk.straight - 30 && wk.len <= 1.5 * wk.straight && wk.len3 >= wk.len - 0.01 && wk.steep <= wk.deg + 3 && wk.legend && /Walking path from the base/.test(wk.note), JSON.stringify({ n: wk.n, step: wk.step, steep: wk.steep, straight: wk.straight, len: wk.len }));
  await sleep(600); await shot("point_walk");
  const bend = await ev(`(async () => { const M = window.malapert, S = M.S; let best = null;
    const t0 = performance.now(); let worst = 0;
    for (let k = 0; k < 24; k++) { const t = k * Math.PI / 12, tg = { x: S.base.x + 4000 * Math.sin(t), y: S.base.y + 4000 * Math.cos(t) };
      const t1 = performance.now(), w = await M.walkTo(tg), p = w && w.pts; worst = Math.max(worst, performance.now() - t1); if (!p) continue;
      let steep = 0, len = 0;
      for (let i = 1; i < p.length; i++) { const d = Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y), m = Math.max(1, Math.ceil(d / 10)); len += d;
        for (let j = 1; j < m; j++) steep = Math.max(steep, M.tiltAt(p[i - 1].x + (p[i].x - p[i - 1].x) * j / m, p[i - 1].y + (p[i].y - p[i - 1].y) * j / m).t); }
      const r = { k, n: p.length, ratio: len / 4000, steep, deg: w.deg, tg };
      if (!best || r.ratio > best.ratio) best = r; }
    if (best) { best.worstMs = worst; S.target = best.tg; await M.autoPlan(true); }
    return best; })()`, 600000);
  say(`  most bent walking path of 24 points 4 km out (slowest search ${bend ? Math.round(bend.worstMs) : 0} ms): ${bend ? bend.n + " points, " + bend.ratio.toFixed(2) + " times the straight line, steepest cell " + bend.steep.toFixed(1) + " deg, limit " + bend.deg + " deg" : "none"}`);
  check("the walking path bends around steep ground and stays within the slope limit", !!bend && bend.n > 2 && bend.ratio > 1.03 && bend.steep <= bend.deg + 3, JSON.stringify(bend && { n: bend.n, ratio: bend.ratio, steep: bend.steep }));
  await sleep(600); await shot("point_walk_bent");
  check("the save-and-share help text is gone", await ev(`!/kept in this browser/.test(document.body.textContent)`));

  // moving a relay hides the note; the page link restores the option
  await ev(`(async () => { const M = window.malapert; M.loadPlan("0", false); const near = document.getElementById("auto-near"); near.checked = true; near.dispatchEvent(new Event("change")); await M.autoPlan(false, true); return 1; })()`, 240000);
  const edit = await ev(`(() => { const M = window.malapert, S = M.S; if (!S.nodes.length) return { skip: true }; S.nodes[0].x += 40; M.renderAll(); const b = document.getElementById("auto-note").hidden; return { hiddenAfterEdit: b }; })()`);
  await ev(`(() => { const M = window.malapert; M.S.nodes.length && (M.S.nodes[0].x -= 40); return 1; })()`);
  const st = await ev(`(() => { const M = window.malapert; return M.enc(M.planState()); })()`);
  await send("Page.navigate", { url: ORIGIN + "/?route=2#p=" + st }); await sleep(500);
  await until(ready);
  const back = await ev(`(() => ({ near: window.malapert.S.near, box: document.getElementById("auto-near").checked, shown: !document.getElementById("auto-near-row").hidden }))()`);
  check("the option survives the page link", back.near === true && back.box === true && back.shown, JSON.stringify(back) + " " + JSON.stringify(edit));
  check("no console errors", logs.length === 0, logs.slice(0, 3).join(" | "));
  fs.writeFileSync(path.join(SCR, "route_fewest_browser.txt"), out.join("\n") + "\n");
  ws.close();
  return out.some((s) => s.startsWith("FAIL")) ? 1 : 0;
}
main().then((c) => { process.exitCode = c; }).catch((e) => { console.error("ERROR", e.message); process.exitCode = 1; }).finally(() => { try { ch && ch.kill(); } catch (e) { } srv.close(); setTimeout(() => process.exit(process.exitCode || 0), 300); });
