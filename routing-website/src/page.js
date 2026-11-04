// Page logic: data loading, worker pool, Simulate, canvas map, node dragging, readouts.
"use strict";
(function () {
  var META = window.MALAPERT_META, VALID = window.MALAPERT_VALID, T = META.terrain, N = T.n, PLANS = META.plans;
  var $ = function (id) { return document.getElementById(id); };
  var PRESETS = [
    { id: "sf12_62", group: "433 MHz LoRa", label: "SF12 / 62.5 kHz", f: 433, tx: 22, sens: -144, bps: 146.484 },
    { id: "sf12_125", group: "433 MHz LoRa", label: "SF12 / 125 kHz", f: 433, tx: 22, sens: -141, bps: 292.969 },
    { id: "sf9", group: "433 MHz LoRa", label: "SF9 / 125 kHz (study)", f: 433, tx: 22, sens: -129, bps: 1757.812 },
    { id: "sf7_125", group: "433 MHz LoRa", label: "SF7 / 125 kHz", f: 433, tx: 22, sens: -127, bps: 5468.75 },
    { id: "sf7_500", group: "433 MHz LoRa", label: "SF7 / 500 kHz", f: 433, tx: 22, sens: -121, bps: 21875 },
    { id: "l24_7", group: "2.4 GHz LoRa", label: "SF7 / 406 kHz, +11.5 dBm", f: 2442, tx: 11.5, sens: -114, bps: 17773.438 },
    { id: "l24_5", group: "2.4 GHz LoRa", label: "SF5 / 812 kHz, +11.5 dBm", f: 2442, tx: 11.5, sens: -108, bps: 101562.5 },
    { id: "fl195", group: "433 MHz FLRC (LR2021, sensitivity from 915 MHz)", label: "195 kb/s, 300 kHz", f: 433, tx: 22, sens: -111, bps: 195000 },
    { id: "fl487", group: "433 MHz FLRC (LR2021, sensitivity from 915 MHz)", label: "487 kb/s, 600 kHz", f: 433, tx: 22, sens: -107, bps: 487500 },
    { id: "fl975", group: "433 MHz FLRC (LR2021, sensitivity from 915 MHz)", label: "975 kb/s, 1.2 MHz", f: 433, tx: 22, sens: -104.5, bps: 975000 },
    { id: "fl975_915", group: "915 MHz FLRC (LR2021)", label: "975 kb/s, 1.2 MHz", f: 915, tx: 22, sens: -104.5, bps: 975000 },
    { id: "n41", group: "5G (fiveg_relays likely budget)", label: "n41, 2593 MHz, 1 Mb/s tier", f: 2593, nr: true, ceil: 128 },
    { id: "n78", group: "5G (fiveg_relays likely budget)", label: "n78, 3550 MHz, 1 Mb/s tier", f: 3550, nr: true, ceil: 128 },
    { id: "free", group: "Any frequency", label: "Free slider, practical Shannon", free: true }
  ];
  var FADE_STUDY = 10, MAX_RELAYS = 12, HR_DEFAULT = 1.5, WALK_KMH = 1.8;
  var S = {
    base: { id: "B", x: T.bx, y: T.by, h: 1.5 }, nodes: [], crew: { h: HR_DEFAULT }, target: null, picking: false,
    preset: "sf9", fMHz: 433, fade: FADE_STUDY, target: 1758, nAz: 2880, overlay: "coverage", solo: null, plan: null,
    sim: null, stale: true, busy: false, placing: false, sel: null, seq: 1, gen: 0, auto: null, drawing: false, draw: []
  };
  var view = { cx: T.bx, cy: T.by, s: 0.03 };
  var ter, lay = {}, overview = null, tiles = {}, covCan = null, layerCan = {}, pool = null, CACHE = new Map();
  var grid, cv = $("map"), ctx = cv.getContext("2d"), dpr = 1, W = 0, H = 0, raf = 0;

  // ---- worker pool
  function Pool(n, init) {
    var src = $("engine-src").textContent + "\nvar state={};self.onmessage=function(e){try{var r=LL.handle(state,e.data),t=r.transfer||[];delete r.transfer;self.postMessage(r,t);}catch(err){self.postMessage({type:'error',message:String(err)});}};";
    var url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    this.w = []; this.idle = []; this.q = []; this.n = n;
    for (var i = 0; i < n; i++) { var w = new Worker(url); w.postMessage(init); this.w.push(w); }
  }
  Pool.prototype.start = function () {
    var self = this;
    return Promise.all(this.w.map(function (w) {
      return new Promise(function (res, rej) {
        w.onmessage = function (e) { if (e.data.type === "error") rej(new Error(e.data.message)); else { self.idle.push(w); res(); } };
        w.onerror = function (e) { rej(new Error(e.message || "worker failed")); };
      });
    }));
  };
  Pool.prototype.run = function (job, tr) {
    var self = this;
    return new Promise(function (res, rej) { self.q.push({ job: job, tr: tr || [], res: res, rej: rej }); self.pump(); });
  };
  Pool.prototype.pump = function () {
    var self = this;
    while (this.idle.length && this.q.length) {
      (function () {
        var w = self.idle.pop(), it = self.q.shift();
        w.onmessage = function (e) { self.idle.push(w); if (e.data.type === "error") it.rej(new Error(e.data.message)); else it.res(e.data); self.pump(); };
        w.postMessage(it.job, it.tr);
      })();
    }
  };

  // ---- data loading
  function gunzip(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url + " returned " + r.status);
      if (typeof DecompressionStream === "undefined") throw new Error("this browser has no DecompressionStream");
      return r.text();
    }).then(function (t) {
      var s = atob(t.trim()), b = new Uint8Array(s.length);
      for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
      return new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
    });
  }
  function loadData() {
    return Promise.all([gunzip("data/dem20.b64.txt"), gunzip("data/layers20.b64.txt"), gunzip("data/winter40.b64.txt")]).then(function (a) {
      var raw = new Uint8Array(a[0]), q = raw.length / 4, b = new Uint8Array(raw.length);
      for (var k = 0; k < 4; k++) for (var i = 0; i < q; i++) b[i * 4 + k] = raw[k * q + i];
      var dem = new Float32Array(b.buffer);
      var L = new Uint8Array(a[1]), nn = N * N;
      lay = { slope: L.subarray(0, nn), pe15: L.subarray(nn, 2 * nn), pe30: L.subarray(2 * nn, 3 * nn), lit: L.subarray(3 * nn, 4 * nn), dark: L.subarray(4 * nn, 5 * nn), never: L.subarray(5 * nn, 6 * nn) };
      var w = new Uint8Array(a[2]), wn = T.wn * T.wn;
      lay.winter = w.subarray(0, wn); lay.worst = w.subarray(wn, 2 * wn);
      ter = new LL.Terrain(dem, N, N, T.x0, T.ytop, T.cell, T.bx, T.by, T.rdisk);
      var mask = new Uint8Array(nn);
      for (var r = 0; r < N; r++) for (var c = 0; c < N; c++) {
        var x = T.x0 + c * T.cell - T.bx, y = T.ytop - r * T.cell - T.by;
        if (x * x + y * y <= T.rdisk * T.rdisk) mask[r * N + c] = 1;
      }
      grid = { w: N, h: N, x0: T.x0, ytop: T.ytop, cell: T.cell, mask: mask };
      var nw = Math.max(1, (navigator.hardwareConcurrency || 2) - 1);
      pool = new Pool(nw, { type: "init", dem: dem, terrain: { nr: N, nc: N, x0: T.x0, ytop: T.ytop, cell: T.cell, bx: T.bx, by: T.by, rdisk: T.rdisk } });
      return pool.start();
    });
  }
  function cellAt(x, y) { var c = Math.round((x - T.x0) / T.cell), r = Math.round((T.ytop - y) / T.cell); return r < 0 || c < 0 || r >= N || c >= N ? -1 : r * N + c; }
  function slopeAt(x, y) { var i = cellAt(x, y); return i < 0 || !lay.slope ? NaN : lay.slope[i] / 4; }
  // ---- radio
  function fmtRate(b) {
    if (!(b > 0)) return "0";
    if (b >= 1e6) return (b / 1e6).toFixed(b >= 1e7 ? 0 : 1) + " Mb/s";
    if (b >= 1e3) return (b / 1e3).toFixed(b >= 1e4 ? 0 : 1) + " kb/s";
    return b.toFixed(0) + " b/s";
  }
  function radio() {
    var p = PRESETS.filter(function (q) { return q.id === S.preset; })[0], fade = S.fade;
    if (p.free) {
      var f = S.fMHz * 1e6, o = { p_dbm: 22, a_m: 0.75, nf_db: 7, margin_db: fade, gap_db: 2 }, ceil = LL.lossForRate(f, S.target, o);
      return { f: f, fMHz: S.fMHz, ceil: ceil, fade: fade, label: fmtF(S.fMHz) + ", " + fmtRate(S.target) + " target", rate: function (L) { return LL.shannonRate(f, L, o).rate; } };
    }
    if (p.nr) return { f: p.f * 1e6, fMHz: p.f, ceil: p.ceil, fade: fade, label: p.label, rate: function (L) { return LL.nrRate(L, 23, 5.7, 8.4, fade); } };
    return { f: p.f * 1e6, fMHz: p.f, ceil: p.tx - p.sens, fade: fade, label: p.group + " " + p.label, rate: function (L) { return p.tx - p.sens - L >= fade ? p.bps : 0; } };
  }
  function fmtF(m) { return m >= 1000 ? (m / 1000).toFixed(2) + " GHz" : Math.round(m) + " MHz"; }
  function sliderToF(v) { return 50 * Math.pow(70, v / 1000); }
  function fToSlider(f) { return 1000 * Math.log(f / 50) / Math.log(70); }
  function db(v) { return v.toFixed(Math.abs(v) >= 100 ? 0 : 1).replace("-", "−"); }
  function sign(v) { return (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(1); }
  // ---- simulate
  function sites() { return [S.base].concat(S.nodes); }
  function key(s, r) { return [s.x, s.y, s.h, S.crew.h, r.f, r.ceil.toFixed(2), S.nAz].join("|"); }
  var reused = 0;
  function coverage(s, r, onDone) {
    var k = key(s, r);
    if (CACHE.has(k)) { var v = CACHE.get(k); CACHE.delete(k); CACHE.set(k, v); reused++; onDone(); return Promise.resolve(v); }
    var ds = T.cell, nAz = S.nAz, maxN = Math.ceil((T.rdisk + Math.hypot(s.x - T.bx, s.y - T.by)) / ds) + 2, blocks = Math.max(pool.n * 4, 16), jobs = [];
    for (var b = 0; b < blocks; b++) jobs.push(pool.run({ type: "cov", id: b, x: s.x, y: s.y, ht: s.h, hr: S.crew.h, f: r.f, nAz: nAz, ds: ds, maxN: maxN, a0: Math.floor(nAz * b / blocks), a1: Math.floor(nAz * (b + 1) / blocks), lossCut: r.ceil + 6 }));
    return Promise.all(jobs).then(function (res) {
      var polar = new Float32Array(nAz * (maxN + 1)), counts = new Int32Array(nAz);
      res.forEach(function (q) { polar.set(q.out, q.a0 * (maxN + 1)); counts.set(q.counts, q.a0); });
      return pool.run({ type: "raster", id: 0, polar: polar, counts: counts, nAz: nAz, maxN: maxN, ds: ds, x: s.x, y: s.y, grid: grid, f: r.f }, [polar.buffer]);
    }).then(function (m) {
      CACHE.set(k, m.into);
      while (CACHE.size > 14) CACHE.delete(CACHE.keys().next().value);
      onDone();
      return m.into;
    });
  }
  function simulate() {
    if (S.busy || !pool) return Promise.resolve();
    S.busy = true; $("simulate").disabled = true; setChip("Running", "stale");
    var gen = S.gen;
    var t0 = performance.now(), r = radio(), list = sites().map(function (q) { return { id: q.id, x: q.x, y: q.y, h: q.h }; }), n = list.length, pairs = [], ch = S.crew.h, done = 0;
    var total = n + 2;
    var tick = function () { done++; $("prog").style.width = Math.min(100, 100 * done / total) + "%"; };
    for (var i = 0; i < n; i++) for (var j = 0; j < n; j++) if (i !== j) pairs.push(list[i].x, list[i].y, list[j].x, list[j].y, list[i].h, list[j].h);
    var sim = { r: r, list: list, plan: S.plan };
    return pool.run({ type: "links", id: 0, links: Float64Array.from(pairs), f: r.f }).then(function (m) {
      tick();
      var M = [], hop = [], p = 0;
      for (i = 0; i < n; i++) { M.push(new Array(n).fill(Infinity)); hop.push(new Array(n).fill(-Infinity)); }
      for (i = 0; i < n; i++) for (j = 0; j < n; j++) if (i !== j) { M[i][j] = r.ceil - m.L[p * 2]; p++; }
      for (i = 0; i < n; i++) for (j = 0; j < n; j++) if (i !== j) hop[i][j] = Math.min(M[i][j], M[j][i]);
      var ch2 = LL.widestChain(hop.map(function (a, u) { return a.map(function (v, w) { return u === w ? -Infinity : v; }); }));
      sim.M = M; sim.hop = hop; sim.par = ch2.par; sim.best = ch2.best;
      sim.conn = ch2.best.map(function (b, u) { return u === 0 || b >= r.fade; });
      sim.depth = []; sim.chainRate = [];
      for (i = 0; i < n; i++) {
        var d = 0, c = i, rate = Infinity;
        while (sim.par[c] >= 0 && c !== 0) { rate = Math.min(rate, r.rate(r.ceil - hop[c][sim.par[c]])); d++; c = sim.par[c]; }
        sim.depth.push(d); sim.chainRate.push(rate);
      }
      reused = 0;
      return Promise.all(list.map(function (s) { return coverage(s, r, tick); }));
    }).then(function (rasters) {
      sim.rasters = rasters; sim.reused = reused;
      var best = new Float32Array(N * N).fill(Infinity), who = new Uint8Array(N * N), nn = N * N;
      rasters.forEach(function (R, u) {
        if (!sim.conn[u]) return;
        for (var q = 0; q < nn; q++) if (R[q] < best[q]) { best[q] = R[q]; who[q] = u; }
      });
      sim.best2 = best; sim.who = who;
      var a = 0, cellA = T.cell * T.cell / 1e6, lim = r.ceil - r.fade;
      for (var q = 0; q < nn; q++) if (best[q] <= lim) a++;
      sim.area = a * cellA;
      sim.nodeArea = rasters.map(function (R) { var c = 0; for (var w = 0; w < nn; w++) if (R[w] <= lim) c++; return c * cellA; });
      if (!S.plan) return null;
      return routeRun(sim, r);
    }).then(function () {
      tick();
      S.sim = sim; S.stale = gen !== S.gen; S.busy = false;
      sim.ms = performance.now() - t0;
      $("simulate").disabled = false; $("prog").style.width = "0";
      paintCoverage(); renderAll(); draw();
      return sim;
    }).catch(function (e) {
      S.busy = false; $("simulate").disabled = false; banner("Simulate failed: " + e.message + ". Reload the page to try again.");
    });
  }
  function routeRun(sim, r) {
    var P = S.plan, tx = P.tx, conn = [], ns = tx.length;
    sim.list.forEach(function (s, i) { if (sim.conn[i]) conn.push({ s: s, i: i }); });
    var links = new Float64Array(ns * conn.length * 6), o = 0;
    for (var k = 0; k < ns; k++) for (var c = 0; c < conn.length; c++) { links[o++] = conn[c].s.x; links[o++] = conn[c].s.y; links[o++] = tx[k]; links[o++] = P.ty[k]; links[o++] = conn[c].s.h; links[o++] = S.crew.h; }
    var chunks = [], nc = Math.max(1, Math.min(pool.n, ns));
    for (var q = 0; q < nc; q++) {
      var a = Math.floor(q * ns / nc) * conn.length * 6, b = Math.floor((q + 1) * ns / nc) * conn.length * 6;
      chunks.push(pool.run({ type: "links", id: q, links: links.slice(a, b), f: r.f }));
    }
    return Promise.all(chunks).then(function (res) {
      var L = [], i = 0;
      res.forEach(function (m) { for (var z = 0; z < m.L.length; z += 2) L.push(m.L[z]); });
      var best = new Float32Array(ns), out = 0, segs = [], cur = null;
      for (var k2 = 0; k2 < ns; k2++) {
        var bm = -Infinity;
        for (var c2 = 0; c2 < conn.length; c2++) { var mg = r.ceil - L[i++]; if (mg > bm) bm = mg; }
        best[k2] = bm;
        if (bm < r.fade) {
          out += P.dt[k2];
          if (!cur) { cur = { a: P.s[k2], b: P.s[k2], t: 0, ka: k2, kb: k2 }; segs.push(cur); }
          cur.b = P.s[k2]; cur.kb = k2; cur.t += P.dt[k2];
        } else cur = null;
      }
      sim.route = { best: best, out: out, segs: segs };
    });
  }

  // ---- fewest relays
  function linkBatch(r, a) {
    var n = a.length / 6;
    if (!n) return Promise.resolve(new Float64Array(0));
    var nc = Math.min(pool.n * 3, Math.ceil(n / 64)), jobs = [];
    for (var q = 0; q < nc; q++) jobs.push(pool.run({ type: "links", id: q, links: a.slice(Math.floor(q * n / nc) * 6, Math.floor((q + 1) * n / nc) * 6), f: r.f }));
    return Promise.all(jobs).then(function (res) {
      var L = new Float64Array(n), p = 0;
      res.forEach(function (m) { for (var z = 0; z < m.L.length; z += 2) L[p++] = m.L[z]; });
      return L;
    });
  }
  function nearPath(x, y, path, W) {
    for (var i = 0; i + 1 < path.length; i++) {
      var a = path[i], b = path[i + 1];
      if (x < Math.min(a.x, b.x) - W || x > Math.max(a.x, b.x) + W || y < Math.min(a.y, b.y) - W || y > Math.max(a.y, b.y) + W) continue;
      var dx = b.x - a.x, dy = b.y - a.y, u = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / Math.max(dx * dx + dy * dy, 1)));
      if (Math.hypot(x - a.x - u * dx, y - a.y - u * dy) <= W) return true;
    }
    return false;
  }
  // Highest cell at or under the slope rule in each block of the grid, near a path or across the disk.
  function candidates(path, W, want) {
    var area = Math.PI * T.rdisk * T.rdisk;
    if (path) { area = Math.PI * W * W; for (var k = 0; k + 1 < path.length; k++) area += 2 * W * Math.hypot(path[k + 1].x - path[k].x, path[k + 1].y - path[k].y); }
    var blk = Math.max(1, Math.round(Math.max(100, Math.sqrt(Math.min(area, Math.PI * T.rdisk * T.rdisk) / want)) / T.cell)), out = [];
    for (var r0 = 0; r0 < N; r0 += blk) for (var c0 = 0; c0 < N; c0 += blk) {
      var bz = -Infinity, bi = -1;
      for (var r = r0; r < Math.min(r0 + blk, N); r++) for (var c = c0; c < Math.min(c0 + blk, N); c++) {
        var i = r * N + c;
        if (!grid.mask[i] || lay.slope[i] / 4 > 20 || ter.z[i] <= bz) continue;
        if (path && !nearPath(T.x0 + c * T.cell, T.ytop - r * T.cell, path, W)) continue;
        bz = ter.z[i]; bi = i;
      }
      if (bi >= 0) out.push({ x: T.x0 + (bi % N) * T.cell, y: T.ytop - Math.floor(bi / N) * T.cell });
    }
    return { sites: out, spacing: blk * T.cell };
  }
  // Layered search from the sources: the first layer holding a target gives the fewest hops, and the layers keep the widest chain of that length.
  async function chainSearch(r, need, list, onStep, srcs, tgts) {
    var n = list.length, seen = new Uint8Array(n), w = new Float64Array(n).fill(-Infinity), em = new Float64Array(n), par = new Int32Array(n).fill(-1), frontier = srcs.slice();
    srcs.forEach(function (u) { seen[u] = 1; w[u] = Infinity; });
    for (var hop = 1; hop <= MAX_RELAYS + 1 && frontier.length; hop++) {
      onStep(hop);
      var rest = [], v, o = 0;
      for (v = 0; v < n; v++) if (!seen[v]) rest.push(v);
      var a = new Float64Array(frontier.length * rest.length * 6);
      frontier.forEach(function (u) {
        var U = list[u];
        rest.forEach(function (q) { var V = list[q]; a[o++] = U.x; a[o++] = U.y; a[o++] = V.x; a[o++] = V.y; a[o++] = U.h; a[o++] = V.h; });
      });
      var L = await linkBatch(r, a), keep = [], b = [];
      for (var i = 0; i < frontier.length; i++) for (var j = 0; j < rest.length; j++) {
        var mf = r.ceil - L[i * rest.length + j];
        if (mf >= need) { var U = list[frontier[i]], V = list[rest[j]]; keep.push([frontier[i], rest[j], mf]); b.push(V.x, V.y, U.x, U.y, V.h, U.h); }
      }
      var Lb = await linkBatch(r, Float64Array.from(b)), fresh = [], end = -1;
      keep.forEach(function (e, k) {
        var m = Math.min(e[2], r.ceil - Lb[k]), val = Math.min(w[e[0]], m);
        if (m < need || val <= w[e[1]]) return;
        if (w[e[1]] === -Infinity) fresh.push(e[1]);
        w[e[1]] = val; em[e[1]] = m; par[e[1]] = e[0];
      });
      fresh.forEach(function (q) { if (tgts[q] && (end < 0 || w[q] > w[end])) end = q; });
      if (end >= 0) {
        var ids = [], c = end;
        while (c >= 0) { ids.unshift(c); c = par[c]; }
        return { ids: ids, weak: w[end], last: em[end] };
      }
      fresh.forEach(function (q) { seen[q] = 1; });
      frontier = fresh;
    }
    return null;
  }
  async function pointSearch(r, need, h, setStat) {
    var tg = { x: S.target.x, y: S.target.y, h: S.crew.h }, D = Math.hypot(tg.x - S.base.x, tg.y - S.base.y);
    for (var pass = 0; pass < 2; pass++) {
      var whole = pass === 1, c = candidates(whole ? null : [S.base, tg], Math.max(1500, 0.35 * D), whole ? 700 : 500);
      var list = [S.base].concat(c.sites.map(function (q) { return { x: q.x, y: q.y, h: h }; }), [tg]), mask = new Uint8Array(list.length);
      mask[list.length - 1] = 1;
      var q = await chainSearch(r, need, list, function (hop) { setStat("Searching " + c.sites.length + " sites" + (whole ? " across the whole map" : "") + ", hop " + hop, hop / (MAX_RELAYS + 1)); }, [0], mask);
      if (q) return { mid: q.ids.slice(1, -1).map(function (i) { return list[i]; }), weak: q.weak, last: q.last, count: c.sites.length, spacing: c.spacing, whole: whole, cx: tg.x, cy: tg.y };
    }
    return null;
  }
  // Greedy along the route: from the first station out of contact, add the linked site that holds contact farthest, bridging with a fewest-hop chain when none can, then drop any relay the plan does not need.
  async function routeSearch(r, need, h, P, setStat) {
    var c = candidates(P.way, 2000, 700), list = [S.base].concat(c.sites.map(function (q) { return { x: q.x, y: q.y, h: h }; })), m = list.length, ns = P.tx.length, u, k, o = 0;
    setStat("Checking " + c.sites.length + " sites against " + ns + " route points", 0.1);
    var a = new Float64Array(m * ns * 6);
    for (u = 0; u < m; u++) for (k = 0; k < ns; k++) { a[o++] = list[u].x; a[o++] = list[u].y; a[o++] = P.tx[k]; a[o++] = P.ty[k]; a[o++] = list[u].h; a[o++] = S.crew.h; }
    var L = await linkBatch(r, a), cov = new Uint8Array(m * ns), any = new Uint8Array(ns), covered = new Uint8Array(ns);
    for (u = 0; u < m; u++) for (k = 0; k < ns; k++) if (r.ceil - L[u * ns + k] >= need) { cov[u * ns + k] = 1; any[k] = 1; }
    var chosen = [], hopM = new Float64Array(m).fill(-Infinity), edge = new Set();
    var addSite = async function (s) {
      chosen.push(s);
      for (var q = 0; q < ns; q++) if (cov[s * ns + q]) covered[q] = 1;
      var A = list[s], f = new Float64Array(m * 6), p = 0, v;
      for (v = 0; v < m; v++) { f[p++] = A.x; f[p++] = A.y; f[p++] = list[v].x; f[p++] = list[v].y; f[p++] = A.h; f[p++] = list[v].h; }
      var L1 = await linkBatch(r, f), pass = [], b = [];
      for (v = 0; v < m; v++) if (v !== s && r.ceil - L1[v] >= need) { pass.push(v); b.push(list[v].x, list[v].y, A.x, A.y, list[v].h, A.h); }
      var L2 = await linkBatch(r, Float64Array.from(b));
      pass.forEach(function (w, i) {
        var mg = Math.min(r.ceil - L1[w], r.ceil - L2[i]);
        if (mg < need) return;
        edge.add(s * m + w); edge.add(w * m + s);
        if (mg > hopM[w]) hopM[w] = mg;
      });
    };
    var reach = function (u2, s) { var e = s; while (e < ns && (cov[u2 * ns + e] || covered[e] || !any[e])) e++; return e; };
    await addSite(0);
    while (chosen.length - 1 < MAX_RELAYS) {
      var s = 0;
      while (s < ns && (covered[s] || !any[s])) s++;
      if (s >= ns) break;
      setStat("Placing relay " + chosen.length + ", " + P.s[s].toFixed(1) + " km along the route", 0.2 + 0.7 * s / ns);
      var best = -1, be = -1, far = -1;
      for (u = 1; u < m; u++) {
        if (!cov[u * ns + s] || chosen.indexOf(u) >= 0) continue;
        var e = reach(u, s);
        if (e > far) far = e;
        if (hopM[u] >= need && (e > be || (e === be && hopM[u] > hopM[best]))) { best = u; be = e; }
      }
      if (best >= 0 && be >= s + 0.6 * (far - s)) { await addSite(best); continue; }
      var mask = new Uint8Array(m);
      for (u = 1; u < m; u++) if (cov[u * ns + s] && reach(u, s) >= s + 0.6 * (far - s)) mask[u] = 1;
      var q = far >= 0 ? await chainSearch(r, need, list, function () {}, chosen, mask) : null;
      if (q && q.ids.length - 1 + chosen.length - 1 <= MAX_RELAYS) { for (var z = 1; z < q.ids.length; z++) await addSite(q.ids[z]); continue; }
      if (best >= 0) { await addSite(best); continue; }
      any[s] = 0;
    }
    for (var d = chosen.length - 1; d >= 1; d--) {
      var trial = chosen.filter(function (x, i) { return i !== d; }), seen = new Set([0]), st = [0];
      while (st.length) { var x = st.pop(); trial.forEach(function (y) { if (!seen.has(y) && edge.has(x * m + y)) { seen.add(y); st.push(y); } }); }
      if (seen.size !== trial.length) continue;
      var lost = false;
      for (k = 0; k < ns && !lost; k++) if (covered[k] && !trial.some(function (y) { return cov[y * ns + k]; })) lost = true;
      if (!lost) chosen = trial;
    }
    var held = 0;
    for (k = 0; k < ns; k++) if (chosen.some(function (y) { return cov[y * ns + k]; })) held++;
    return { mid: chosen.slice(1).map(function (i) { return list[i]; }), count: c.sites.length, spacing: c.spacing, held: 100 * held / ns };
  }
  function setPicking(on) {
    S.picking = on; $("auto").setAttribute("aria-pressed", String(on)); $("app").classList.toggle("placing", on);
    if (on) hintShow("Click the map to set the point."); else $("hint").hidden = true;
  }
  function autoPlan(useTarget) {
    if (!S.busy && !(S.plan && S.plan.drawn) && useTarget !== true) { setPlacing(false); setPicking(!S.picking); return Promise.resolve(); }
    if (S.busy) hintShow("A run is still going. Try again when it finishes.", 2500);
    if (S.busy || !pool) return Promise.resolve();
    var r = radio(), h = parseFloat($("auto-h").value), extra = parseFloat($("auto-x").value), t0 = performance.now(), drawn = S.plan && S.plan.drawn;
    h = h >= 0.5 && h <= 30 ? h : 1.5; extra = extra >= 0 && extra <= 20 ? extra : 0;
    $("auto-h").value = h; $("auto-x").value = extra;
    var need = r.fade + extra, setStat = function (t, f) { $("stat").textContent = t; $("prog").style.width = Math.min(100, 100 * f) + "%"; };
    S.busy = true; $("simulate").disabled = true; $("auto").disabled = true; setChip("Planning", "stale");
    var done = function () { S.busy = false; $("simulate").disabled = false; $("auto").disabled = false; $("prog").style.width = "0"; };
    return (drawn ? routeSearch(r, need, h, S.plan, setStat) : pointSearch(r, need, h, setStat)).then(function (q) {
      done();
      var sec = ((performance.now() - t0) / 1000).toFixed(1);
      if (!q) {
        S.auto = null;
        if (S.sim) { renderResult(); setChip(S.stale ? "Out of date" : "Up to date", S.stale ? "stale" : "fresh"); }
        $("stat").textContent = "No chain of up to " + MAX_RELAYS + " relays reaches the point."; renderPlan(); return null;
      }
      var n = q.mid.length;
      if (!drawn) S.plan = null;
      S.solo = null; S.sel = null;
      S.nodes = q.mid.map(function (w, k) { return { id: "R" + (k + 1), x: w.x, y: w.y, h: h }; });
      S.seq = n + 1;
      S.auto = drawn ? null : { cx: q.cx, cy: q.cy, from: n ? "R" + n : "B", last: q.last };
      fitPlan(); markStale(); renderPlan(); renderNodes(); renderLegend();
      return simulate();
    }).catch(function (e) {
      done(); banner("The relay search failed: " + e.message + ". Reload the page to try again.");
    });
  }

  // ---- drawn route
  function setDrawing(on) {
    S.drawing = on; $("draw").textContent = on ? "Finish route" : "Draw route"; $("draw").setAttribute("aria-pressed", String(on)); $("undo").hidden = !on;
    $("app").classList.toggle("placing", on);
    if (on) hintShow("Click points along the route from the base. Double-click or press Finish route to end."); else $("hint").hidden = true;
    draw();
  }
  function retime() {
    var P = S.plan; if (!P || !P.drawn) return;
    var v = WALK_KMH;
    P.dt = P.tx.map(function () { return P.ds / 1000 / v * 60; }); P.t_min = P.km / v * 60; P.speed = v;
  }
  function buildRoute(way) {
    var seg = [], L = 0, i;
    for (i = 0; i + 1 < way.length; i++) { var d = Math.hypot(way[i + 1].x - way[i].x, way[i + 1].y - way[i].y); seg.push(d); L += d; }
    var ds = Math.max(40, L / 300), n = Math.max(2, Math.ceil(L / ds) + 1), tx = [], ty = [], s = [], at = 0, g = 0, base = 0;
    for (i = 0; i < n; i++) {
      at = L * i / (n - 1);
      while (g < seg.length - 1 && at > base + seg[g]) { base += seg[g]; g++; }
      var f = seg[g] > 0 ? (at - base) / seg[g] : 0;
      tx.push(way[g].x + (way[g + 1].x - way[g].x) * f); ty.push(way[g].y + (way[g + 1].y - way[g].y) * f); s.push(at / 1000);
    }
    S.plan = { drawn: true, way: way, name: "Drawn route", km: L / 1000, tx: tx, ty: ty, s: s, ds: L / (n - 1), relays: 0 };
    retime(); S.auto = null; S.solo = null;
    markStale(); renderPlan(); renderLegend();
  }
  function finishDraw() {
    var w = S.draw.filter(function (q, i, a) { return i === 0 || Math.hypot(q.x - a[i - 1].x, q.y - a[i - 1].y) > 10; });
    setDrawing(false);
    if (w.length >= 2) buildRoute(w);
  }
  function drawPreview() {
    if (!S.drawing || !S.draw.length) return;
    ctx.beginPath(); ctx.moveTo(sx(S.draw[0].x), sy(S.draw[0].y));
    S.draw.forEach(function (q) { ctx.lineTo(sx(q.x), sy(q.y)); });
    ctx.setLineDash([7, 5]); ctx.lineWidth = 2.5; ctx.strokeStyle = "#7fe0c2"; ctx.stroke(); ctx.setLineDash([]);
    S.draw.forEach(function (q) { ctx.beginPath(); ctx.arc(sx(q.x), sy(q.y), 4, 0, 7); ctx.fillStyle = "#7fe0c2"; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = "#0b0e11"; ctx.stroke(); });
  }

  // ---- overlays
  var BANDS = [[10, [16, 62, 150]], [20, [18, 104, 214]], [30, [30, 158, 248]], [Infinity, [120, 212, 255]]];
  var ALPHA = 132, MARGINAL = [255, 214, 64], MARGINAL_CSS = "#ffd640";
  function paintCoverage() {
    var sim = S.sim; if (!sim) return;
    if (!covCan) { covCan = document.createElement("canvas"); covCan.width = N; covCan.height = N; }
    var c = covCan.getContext("2d"), im = c.createImageData(N, N), d = im.data, ceil = sim.r.ceil, fade = sim.r.fade;
    var src = S.solo !== null && sim.rasters[S.solo] ? sim.rasters[S.solo] : sim.best2;
    for (var r = 0; r < N; r++) for (var q = 0; q < N; q++) {
      var i = r * N + q, L = src[i];
      if (L === Infinity || !grid.mask[i]) continue;
      var m = ceil - L, o = i * 4;
      if (m < 0) continue;
      if (m < fade) { d[o] = MARGINAL[0]; d[o + 1] = MARGINAL[1]; d[o + 2] = MARGINAL[2]; d[o + 3] = 175; continue; }
      var e = m - fade, b = e < 10 ? 0 : e < 20 ? 1 : e < 30 ? 2 : 3, col = BANDS[b][1];
      d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2]; d[o + 3] = ALPHA;
    }
    c.putImageData(im, 0, 0);
  }
  function layerCanvas(name) {
    if (layerCan[name]) return layerCan[name];
    var n = name === "winter" ? T.wn : N, can = document.createElement("canvas"); can.width = n; can.height = n;
    var c = can.getContext("2d"), im = c.createImageData(n, n), d = im.data, i, o, v;
    for (i = 0; i < n * n; i++) {
      o = i * 4;
      if (name === "slope") {
        v = lay.slope[i] / 4; if (!grid.mask[i] || v < 10) continue;
        if (v > 20) { var hatch = ((i % N + Math.floor(i / N)) & 7) < 5; d[o] = 214; d[o + 1] = 52; d[o + 2] = 44; d[o + 3] = hatch ? 215 : 120; }
        else if (v > 15) { d[o] = 232; d[o + 1] = 150; d[o + 2] = 58; d[o + 3] = 165; }
        else { d[o] = 240; d[o + 1] = 208; d[o + 2] = 120; d[o + 3] = 105; }
      } else if (name === "winter") {
        v = lay.winter[i]; if (v === 255) continue; v /= 250;
        var a = Math.pow(v, 0.8); d[o] = 255; d[o + 1] = 176 + 60 * v; d[o + 2] = 40 + 130 * v * v; d[o + 3] = v < 0.02 ? 0 : 40 + 170 * a;
      } else if (name === "psr") {
        if (lay.never[i] && grid.mask[i]) { d[o] = 124; d[o + 1] = 92; d[o + 2] = 214; d[o + 3] = 190; }
      }
    }
    c.putImageData(im, 0, 0);
    return (layerCan[name] = can);
  }

  // ---- map drawing
  function sx(x) { return W / 2 + (x - view.cx) * view.s; }
  function sy(y) { return H / 2 - (y - view.cy) * view.s; }
  function wx(p) { return view.cx + (p - W / 2) / view.s; }
  function wy(p) { return view.cy - (p - H / 2) / view.s; }
  function resize() {
    var r = $("wrap").getBoundingClientRect(); dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = r.width; H = r.height; cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); draw();
  }
  function draw() { if (!raf) raf = requestAnimationFrame(function () { raf = 0; paint(); }); }
  function drawLayer(img, x0, ytop, size) { ctx.drawImage(img, sx(x0), sy(ytop), size * view.s, size * view.s); }
  function diskPath() { ctx.beginPath(); ctx.arc(sx(T.bx), sy(T.by), T.rdisk * view.s, 0, 2 * Math.PI); }
  function tilesVisible() {
    var M = META.tiles, x0 = wx(0), x1 = wx(W), y1 = wy(0), y0 = wy(H);
    M.tiles.forEach(function (t) {
      var ax = M.x0 + t[4] * M.pix, bx = M.x0 + t[5] * M.pix, ay = M.ytop - t[3] * M.pix, by = M.ytop - t[2] * M.pix, k = t[0] + "_" + t[1];
      if (bx < x0 || ax > x1 || by < y0 || ay > y1) return;
      var im = tiles[k];
      if (!im) { im = tiles[k] = new Image(); im.onload = draw; im.src = "data/tiles/h" + k + ".webp"; }
      if (im.complete && im.naturalWidth) ctx.drawImage(im, sx(ax), sy(by), (bx - ax) * view.s, (by - ay) * view.s);
    });
  }
  function niceStep(px) { var km = px / view.s / 1000, p = Math.pow(10, Math.floor(Math.log10(km))), f = km / p; return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p; }
  function axes() {
    var st = niceStep(110) * 1000, X0 = wx(0), X1 = wx(W), Y1 = wy(0), Y0 = wy(H), i;
    ctx.lineWidth = 1; ctx.strokeStyle = "rgba(233,236,238,0.16)"; ctx.font = "11px 'B612', 'Segoe UI', sans-serif"; ctx.textBaseline = "top"; ctx.textAlign = "center";
    var fmt = function (m) { var v = m / 1000; return (st < 1000 ? v.toFixed(1) : v.toFixed(0)).replace("-", "−"); };
    ctx.beginPath();
    for (i = Math.ceil((X0 - T.bx) / st); T.bx + i * st <= X1; i++) { var a = sx(T.bx + i * st); ctx.moveTo(a, 0); ctx.lineTo(a, H); }
    for (i = Math.ceil((Y0 - T.by) / st); T.by + i * st <= Y1; i++) { var b = sy(T.by + i * st); ctx.moveTo(0, b); ctx.lineTo(W, b); }
    ctx.stroke();
    label2(fmt, st, X0, X1, Y0, Y1);
  }
  function label2(fmt, st, X0, X1, Y0, Y1) {
    var i, t;
    for (i = Math.ceil((X0 - T.bx) / st); T.bx + i * st <= X1; i++) { var a = sx(T.bx + i * st); if (a < 30 || a > W - 120) continue; t = fmt(i * st); halo(t, a, H - 18, "center"); }
    for (i = Math.ceil((Y0 - T.by) / st); T.by + i * st <= Y1; i++) { var b = sy(T.by + i * st); if (b < 18 || b > H - 34) continue; t = fmt(i * st); halo(t, 6, b - 6, "left"); }
    halo("km from base", W - 8, H - 18, "right");
  }
  function halo(t, x, y, align, color) {
    ctx.textAlign = align; ctx.lineWidth = 3; ctx.strokeStyle = "rgba(8,11,14,0.9)"; ctx.strokeText(t, x, y); ctx.fillStyle = color || "#e9ecee"; ctx.fillText(t, x, y);
  }
  function linkLines() {
    var sim = S.sim; if (!sim) return;
    var L = sim.list, n = L.length, i, j, r = sim.r;
    ctx.save(); if (S.stale) { ctx.setLineDash([6, 5]); ctx.globalAlpha = 0.55; }
    for (i = 0; i < n; i++) for (j = i + 1; j < n; j++) {
      var m = sim.hop[i][j]; if (!(m >= 0)) continue;
      var chain = sim.par[i] === j || sim.par[j] === i;
      if (chain) continue;
      ctx.beginPath(); ctx.moveTo(sx(L[i].x), sy(L[i].y)); ctx.lineTo(sx(L[j].x), sy(L[j].y));
      ctx.lineWidth = 1; ctx.strokeStyle = m >= r.fade ? "rgba(233,236,238,0.45)" : "rgba(255,214,64,0.5)"; ctx.stroke();
    }
    for (i = 1; i < n; i++) {
      var p = sim.par[i]; if (p < 0) continue;
      var mm = sim.hop[i][p], ok = mm >= r.fade;
      ctx.beginPath(); ctx.moveTo(sx(L[i].x), sy(L[i].y)); ctx.lineTo(sx(L[p].x), sy(L[p].y));
      ctx.lineWidth = 5; ctx.strokeStyle = "rgba(8,11,14,0.7)"; ctx.stroke();
      ctx.lineWidth = 2.5; ctx.strokeStyle = ok ? "#f2f4f5" : MARGINAL_CSS; ctx.stroke();
    }
    ctx.restore();
    ctx.font = "12px 'B612', 'Segoe UI', sans-serif"; ctx.textBaseline = "middle";
    for (i = 1; i < n; i++) {
      var q = sim.par[i]; if (q < 0) continue;
      var v = sim.hop[i][q], mx = (sx(L[i].x) + sx(L[q].x)) / 2, my = (sy(L[i].y) + sy(L[q].y)) / 2;
      if (Math.hypot(sx(L[i].x) - sx(L[q].x), sy(L[i].y) - sy(L[q].y)) < 60) continue;
      halo(v.toFixed(0).replace("-", "−") + " dB", mx, my - 9, "center", v >= r.fade ? "#f2f4f5" : MARGINAL_CSS);
    }
  }
  function routeLine() {
    var P = S.plan; if (!P || !$("t-route").checked) return;
    var sim = S.sim, rt = sim && sim.plan === P && sim.route, n = P.tx.length, i;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(sx(P.tx[0]), sy(P.ty[0]));
    for (i = 1; i < n; i++) ctx.lineTo(sx(P.tx[i]), sy(P.ty[i]));
    ctx.lineWidth = 5; ctx.strokeStyle = "rgba(8,11,14,0.75)"; ctx.stroke();
    ctx.lineWidth = 2.5; ctx.strokeStyle = "#7fe0c2"; ctx.stroke();
    if (rt) rt.segs.forEach(function (g) {
      ctx.beginPath(); ctx.moveTo(sx(P.tx[g.ka]), sy(P.ty[g.ka]));
      for (var k = g.ka; k <= g.kb; k++) ctx.lineTo(sx(P.tx[k]), sy(P.ty[k]));
      ctx.lineWidth = 4; ctx.strokeStyle = S.stale ? "rgba(240,88,74,0.55)" : "#f0584a"; ctx.stroke();
      ctx.beginPath(); ctx.arc(sx(P.tx[g.ka]), sy(P.ty[g.ka]), 5, 0, 7); ctx.fillStyle = "#f0584a"; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = "#0b0e11"; ctx.stroke();
    });
    ctx.lineCap = "butt";
  }
  function targetLink() {
    var A = S.auto, sim = S.sim;
    if (!A || !sim || S.stale || A.from === undefined || !S.target || S.target.x !== A.cx || S.target.y !== A.cy) return;
    var q = sim.list.filter(function (u) { return u.id === A.from; })[0]; if (!q) return;
    ctx.beginPath(); ctx.moveTo(sx(q.x), sy(q.y)); ctx.lineTo(sx(S.target.x), sy(S.target.y));
    ctx.lineWidth = 5; ctx.strokeStyle = "rgba(8,11,14,0.7)"; ctx.stroke();
    ctx.lineWidth = 2.5; ctx.strokeStyle = "#7fe0c2"; ctx.stroke();
    ctx.font = "12px 'B612', 'Segoe UI', sans-serif"; ctx.textBaseline = "middle";
    halo(A.last.toFixed(0) + " dB", (sx(q.x) + sx(S.target.x)) / 2, (sy(q.y) + sy(S.target.y)) / 2 - 9, "center", "#bff3e2");
  }
  function nodesDraw() {
    var sim = S.sim, all = sites(), i;
    ctx.font = "600 13px 'Saira Semi Condensed', 'Arial Narrow', sans-serif"; ctx.textBaseline = "middle";
    for (i = 0; i < all.length; i++) {
      var q = all[i], x = sx(q.x), y = sy(q.y), snap = sim && !S.stale ? sim.list.findIndex(function (u) { return u.id === q.id; }) : -1;
      var conn = snap >= 0 ? sim.conn[snap] : true, steep = slopeAt(q.x, q.y) > 20;
      if (i === 0) {
        ctx.beginPath(); ctx.moveTo(x, y - 12); ctx.lineTo(x + 12, y); ctx.lineTo(x, y + 12); ctx.lineTo(x - 12, y); ctx.closePath();
        ctx.fillStyle = "#c68a1e"; ctx.strokeStyle = "#0b0e11"; ctx.lineWidth = 2; ctx.fill(); ctx.stroke();
        ctx.textAlign = "center"; ctx.fillStyle = "#15110a"; ctx.fillText("B", x, y + 0.5);
      } else {
        ctx.beginPath(); ctx.arc(x, y, 11, 0, 7); ctx.fillStyle = conn ? "#f2f4f5" : "#20262c"; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = conn ? "#0b0e11" : "#f0584a"; ctx.stroke();
        ctx.textAlign = "center"; ctx.fillStyle = conn ? "#14181c" : "#f7a79e"; ctx.fillText(q.id, x, y + 0.5);
        if (!conn) { ctx.font = "11px 'B612', 'Segoe UI', sans-serif"; halo("no path to base", x + 15, y + 1, "left", "#f7a79e"); ctx.font = "600 13px 'Saira Semi Condensed', 'Arial Narrow', sans-serif"; }
      }
      if (steep) { ctx.font = "11px 'B612', 'Segoe UI', sans-serif"; halo("slope " + slopeAt(q.x, q.y).toFixed(0) + "°, over 20°", x + 15, y - 13, "left", "#ffb3a8"); ctx.font = "600 13px 'Saira Semi Condensed', 'Arial Narrow', sans-serif"; }
      if (q === S.sel) { ctx.beginPath(); ctx.arc(x, y, 16, 0, 7); ctx.lineWidth = 2; ctx.strokeStyle = "#e6b04a"; ctx.stroke(); }
    }
    if (S.target) {
      var cx = sx(S.target.x), cy = sy(S.target.y);
      ctx.beginPath(); ctx.arc(cx, cy, 8, 0, 7); ctx.lineWidth = 4; ctx.strokeStyle = "#0b0e11"; ctx.stroke(); ctx.lineWidth = 2; ctx.strokeStyle = "#7fe0c2"; ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy, 2.5, 0, 7); ctx.fillStyle = "#7fe0c2"; ctx.fill();
      ctx.font = "11px 'B612', 'Segoe UI', sans-serif"; ctx.textBaseline = "middle"; halo("target", cx, cy + 18, "center", "#bff3e2");
    }
  }
  function poleMark() {
    var dx = -T.bx, dy = -T.by, l = Math.hypot(dx, dy), ux = dx / l, uy = dy / l, ax = W - 62, ay = 104;
    ctx.save(); ctx.translate(ax, ay); ctx.rotate(Math.atan2(ux, uy) + Math.PI);
    ctx.beginPath(); ctx.moveTo(0, -14); ctx.lineTo(6, 2); ctx.lineTo(0, -2); ctx.lineTo(-6, 2); ctx.closePath(); ctx.fillStyle = "#e9ecee"; ctx.fill(); ctx.restore();
    ctx.font = "10.5px 'B612', 'Segoe UI', sans-serif"; ctx.textBaseline = "top"; halo("to south pole", ax + 44, ay + 16, "right"); halo((l / 1000).toFixed(0) + " km", ax + 44, ay + 29, "right");
  }
  function paint() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#0b0e11"; ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    var M = META.tiles, full = M.N * M.pix;
    if (overview) drawLayer(overview, M.x0, M.ytop, full);
    if (view.s * dpr > 0.09) { ctx.save(); diskPath(); ctx.clip(); tilesVisible(); ctx.restore(); }
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.arc(sx(T.bx), sy(T.by), T.rdisk * view.s, 0, 2 * Math.PI, true); ctx.fillStyle = "rgba(7,9,12,0.66)"; ctx.fill("evenodd"); ctx.restore();
    ctx.imageSmoothingEnabled = view.s * T.cell * dpr < 1.2;
    var ext = N * T.cell, xe = T.x0 - T.cell / 2, ye = T.ytop + T.cell / 2, ov = S.overlay;
    if (ov === "coverage" && covCan) { ctx.globalAlpha = S.stale ? 0.45 : 1; drawLayer(covCan, xe, ye, ext); ctx.globalAlpha = 1; }
    else if (ov === "slope") { if (lay.slope) drawLayer(layerCanvas(ov), xe, ye, ext); }
    else if (ov === "winter" && lay.winter) drawLayer(layerCanvas("winter"), T.wx0 - T.wcell / 2, T.wytop + T.wcell / 2, T.wn * T.wcell);
    if ($("t-psr").checked && lay.never) drawLayer(layerCanvas("psr"), xe, ye, ext);
    ctx.imageSmoothingEnabled = true;
    diskPath(); ctx.lineWidth = 1.5; ctx.strokeStyle = "rgba(233,236,238,0.55)"; ctx.stroke();
    axes();
    routeLine(); drawPreview(); linkLines(); targetLink(); nodesDraw(); poleMark();
  }

  // ---- interaction
  var ptrs = new Map(), drag = null, pinch = null;
  function pos(e) { var r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function hit(p) {
    var tol = 20;
    for (var i = S.nodes.length - 1; i >= 0; i--) if (Math.hypot(sx(S.nodes[i].x) - p.x, sy(S.nodes[i].y) - p.y) < tol) return { kind: "node", node: S.nodes[i] };
    if (Math.hypot(sx(S.base.x) - p.x, sy(S.base.y) - p.y) < tol) return { kind: "base" };
    return null;
  }
  function clampDisk(q) {
    var dx = q.x - T.bx, dy = q.y - T.by, r = Math.hypot(dx, dy), lim = T.rdisk - 30;
    if (r > lim) { q.x = T.bx + dx * lim / r; q.y = T.by + dy * lim / r; }
  }
  function markStale() { S.stale = true; S.gen++; $("rd").classList.add("dim"); setChip("Out of date", "stale"); $("stat").textContent = "Press Simulate to update the results."; draw(); }
  function zoomAt(px, py, f) {
    var x = wx(px), y = wy(py);
    view.s = Math.max(0.01, Math.min(1.6, view.s * f));
    view.cx = x - (px - W / 2) / view.s; view.cy = y + (py - H / 2) / view.s; clampView(); draw();
  }
  function clampView() {
    var lim = T.rdisk + 1000;
    view.cx = Math.max(T.bx - lim, Math.min(T.bx + lim, view.cx)); view.cy = Math.max(T.by - lim, Math.min(T.by + lim, view.cy));
  }
  cv.addEventListener("pointerdown", function (e) {
    cv.setPointerCapture(e.pointerId); var p = pos(e); ptrs.set(e.pointerId, p);
    if (ptrs.size === 2) { var a = Array.from(ptrs.values()); pinch = { d: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) }; drag = null; return; }
    if (S.picking) { var tp = { x: wx(p.x), y: wy(p.y) }; clampDisk(tp); S.target = tp; setPicking(false); drag = null; draw(); autoPlan(true); return; }
    if (S.drawing) { var wp = { x: wx(p.x), y: wy(p.y) }; clampDisk(wp); S.draw.push(wp); drag = null; draw(); return; }
    if (S.placing) { addNode(wx(p.x), wy(p.y)); setPlacing(false); drag = null; return; }
    var h = hit(p);
    if (h && h.kind === "node") { S.sel = h.node; drag = h; renderNodes(); draw(); }
    else if (h && h.kind === "base") { hintShow("The base stays at the summit. Its mast is set under Sites.", 2500); drag = { kind: "pan", x: p.x, y: p.y, cx: view.cx, cy: view.cy }; }
    else drag = { kind: "pan", x: p.x, y: p.y, cx: view.cx, cy: view.cy };
  });
  function readAt(px, py, name) {
    var x = wx(px), y = wy(py), e = $("read"), r = Math.hypot(x - T.bx, y - T.by);
    if (r > T.rdisk) { e.hidden = true; return; }
    var t = (name ? name + " at " : "") + ((x - T.bx) / 1000).toFixed(2).replace("-", "−") + ", " + ((y - T.by) / 1000).toFixed(2).replace("-", "−") + " km, " + Math.round(ter ? ter.sample(x, y) : 0) + " m, slope " + slopeAt(x, y).toFixed(1) + "°";
    var i = cellAt(x, y), sim = S.sim;
    if (sim && !S.stale && S.overlay === "coverage" && i >= 0) {
      var src = S.solo !== null && sim.rasters[S.solo] ? sim.rasters[S.solo] : sim.best2, m = sim.r.ceil - src[i];
      t += isFinite(m) && m >= 0 ? ", margin " + db(m) + " dB" : ", no link";
    }
    e.textContent = t; e.hidden = false;
  }
  cv.addEventListener("pointerleave", function () { $("read").hidden = true; });
  cv.addEventListener("pointermove", function (e) {
    if (!ptrs.has(e.pointerId)) { if (e.pointerType === "mouse" && ter) { var hp = pos(e); readAt(hp.x, hp.y); } return; }
    var p = pos(e); ptrs.set(e.pointerId, p);
    if (ptrs.size === 2 && pinch) {
      var a = Array.from(ptrs.values()), d = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
      zoomAt((a[0].x + a[1].x) / 2, (a[0].y + a[1].y) / 2, d / pinch.d); pinch.d = d; return;
    }
    if (!drag) return;
    if (drag.kind !== "pan") readAt(p.x, p.y, drag.node.id);
    if (drag.kind === "pan") { view.cx = drag.cx - (p.x - drag.x) / view.s; view.cy = drag.cy + (p.y - drag.y) / view.s; clampView(); draw(); }
    else if (drag.kind === "node") { var q = drag.node; q.x = wx(p.x); q.y = wy(p.y); clampDisk(q); markStale(); renderNodes(); }
  });
  var up = function (e) { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null; if (ptrs.size === 0) drag = null; };
  cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);
  cv.addEventListener("wheel", function (e) { e.preventDefault(); var p = pos(e); zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0014)); }, { passive: false });
  cv.addEventListener("dblclick", function (e) { if (S.drawing) { finishDraw(); return; } var p = pos(e); if (!hit(p)) addNode(wx(p.x), wy(p.y)); });
  function setPlacing(on) { S.placing = on; $("add").setAttribute("aria-pressed", String(on)); $("app").classList.toggle("placing", on); if (on) hintShow("Tap the map to place the relay."); else $("hint").hidden = true; }
  var hintT = 0;
  function hintShow(t, ms) { var h = $("hint"); h.textContent = t; h.hidden = false; clearTimeout(hintT); if (ms) hintT = setTimeout(function () { h.hidden = true; }, ms); }
  function addNode(x, y) {
    if (S.nodes.length >= MAX_RELAYS) { hintShow("Twelve relays is the limit here.", 2500); return; }
    var q = { id: "R" + S.seq++, x: x, y: y, h: 1.5 }; clampDisk(q); S.nodes.push(q); S.sel = q; markStale(); renderNodes();
  }
  function renumber() { S.nodes.forEach(function (q, i) { q.id = "R" + (i + 1); }); S.seq = S.nodes.length + 1; }

  // ---- panels
  function setChip(t, c) { var e = $("chip"); e.textContent = t; e.className = "chip " + c; }
  function banner(t) { var b = document.createElement("div"); b.className = "banner"; b.setAttribute("role", "alert"); b.textContent = t; $("wrap").appendChild(b); }
  function renderValid() {
    var r = radio();
    $("budget-note").textContent = "Allowed loss " + (r.ceil - r.fade).toFixed(1) + " dB";
    $("freq-v").textContent = fmtF(r.fMHz);
    $("target-wrap").hidden = S.preset !== "free";
  }
  function renderResult() {
    var sim = S.sim; if (!sim) return;
    var n = sim.list.length, c = sim.conn.filter(Boolean).length - 1, w = Infinity, i;
    for (i = 1; i < n; i++) if (sim.conn[i]) w = Math.min(w, sim.hop[i][sim.par[i]]);
    $("r-conn").textContent = c + " of " + (n - 1);
    $("r-weak").textContent = isFinite(w) ? db(w) + " dB" : "–";
    $("r-area").textContent = sim.area.toFixed(1) + " km²";
    $("r-out").textContent = sim.route ? sim.route.out.toFixed(1) + " min" : "No route";
    $("rd").classList.toggle("dim", S.stale);
    if (!S.stale) { setChip("Up to date", "fresh"); $("stat").textContent = "Updated in " + (sim.ms / 1000).toFixed(1) + " s"; }
    else { setChip("Out of date", "stale"); $("stat").textContent = "Press Simulate to update the results."; }
  }
  function renderPlan() {
    var P = S.plan;
    $("auto").textContent = P && P.drawn ? "Find fewest relays along route" : "Find fewest relays to a point";
  }
  function nodeCard(q, i) {
    var sim = S.sim, idx = sim ? sim.list.findIndex(function (u) { return u.id === q.id; }) : -1, fresh = sim && !S.stale && idx >= 0;
    var d = document.createElement("div"); d.className = "node" + (q === S.sel ? " sel" : "");
    var sl = slopeAt(q.x, q.y), rx = (q.x - T.bx) / 1000, ry = (q.y - T.by) / 1000;
    var t = document.createElement("div"); t.className = "t";
    var id = document.createElement("span"); id.className = "id"; id.textContent = i === 0 ? "Base" : q.id; t.appendChild(id);
    var po = document.createElement("span"); po.className = "pos"; po.textContent = rx.toFixed(2).replace("-", "−") + ", " + ry.toFixed(2).replace("-", "−") + " km"; t.appendChild(po);
    d.appendChild(t);
    var st = document.createElement("div"); st.className = "st";
    var tg = function (txt, c) { var s = document.createElement("span"); s.className = "tag " + c; s.textContent = txt + "  "; st.appendChild(s); };
    tg((sl > 20 ? "▲ slope " : "slope ") + sl.toFixed(0) + "°", sl > 20 ? "bad" : "");
    if (fresh) {
      if (i > 0) {
        if (sim.conn[idx]) tg("● " + sim.depth[idx] + (sim.depth[idx] === 1 ? " hop, " : " hops, ") + db(sim.best[idx]) + " dB", "good");
        else tg("✕ no path to base", "bad");
      }
      tg(sim.nodeArea[idx].toFixed(1) + " km²", "");
      if (i > 0 && sim.conn[idx]) tg("≈ " + fmtRate(sim.chainRate[idx] * LL.hopShare(sim.depth[idx])) + " to base", "");
    }
    d.appendChild(st);
    var c = document.createElement("div"); c.className = "ctl";
    var inp = document.createElement("input"); inp.type = "number"; inp.min = 0.5; inp.max = 30; inp.step = 0.5; inp.value = q.h; inp.id = "mast-" + q.id; inp.setAttribute("aria-label", "Mast height of " + q.id + " in meters");
    inp.addEventListener("change", function () { var v = parseFloat(inp.value); if (v >= 0.5 && v <= 30) { q.h = v; markStale(); } else inp.value = q.h; });
    c.appendChild(inp);
    var x = document.createElement("div"); x.className = "x"; var ml = document.createElement("span"); ml.textContent = "m mast"; ml.style.marginRight = "auto"; ml.style.fontSize = "12px"; ml.style.alignSelf = "center"; x.appendChild(ml);
    var so = document.createElement("button"); so.className = "btn"; so.type = "button"; so.textContent = "Coverage"; so.setAttribute("aria-pressed", String(S.solo === idx && idx >= 0)); so.disabled = !fresh;
    so.addEventListener("click", function () { if (!sim || idx < 0) return; S.solo = S.solo === idx ? null : idx; paintCoverage(); renderNodes(); renderLegend(); draw(); });
    x.appendChild(so);
    if (i > 0) {
      var rm = document.createElement("button"); rm.className = "btn"; rm.type = "button"; rm.textContent = "Remove";
      rm.addEventListener("click", function () { S.nodes = S.nodes.filter(function (u) { return u !== q; }); renumber(); S.solo = null; markStale(); renderNodes(); });
      x.appendChild(rm);
    }
    c.appendChild(x); d.appendChild(c);
    return d;
  }
  function renderNodes() { var e = $("nodes"); e.innerHTML = ""; sites().forEach(function (q, i) { e.appendChild(nodeCard(q, i)); }); }
  function renderLinks() {
    var sim = S.sim, e = $("links"); if (!sim) return;
    var n = sim.list.length, rows = [], i, j, r = sim.r;
    for (i = 0; i < n; i++) for (j = i + 1; j < n; j++) {
      var a = sim.M[i][j], b = sim.M[j][i], m = Math.min(a, b);
      if (m < 0 && !(sim.par[i] === j || sim.par[j] === i)) continue;
      rows.push({ i: i, j: j, a: a, b: b, m: m, chain: sim.par[i] === j || sim.par[j] === i });
    }
    rows.sort(function (u, v) { return (v.chain - u.chain) || (v.m - u.m); });
    var h = "<table><thead><tr><th scope=\"col\">Link</th><th scope=\"col\">Forward dB</th><th scope=\"col\">Back dB</th><th scope=\"col\">Rate</th><th scope=\"col\">State</th></tr></thead><tbody>";
    rows.forEach(function (q) {
      var A = sim.list[q.i].id, B = sim.list[q.j].id, ok = q.m >= r.fade;
      h += "<tr><td>" + A + "–" + B + (q.chain ? " chain" : "") + "</td><td>" + db(q.a) + "</td><td>" + db(q.b) + "</td><td>" + fmtRate(r.rate(r.ceil - q.m)) + "</td><td>" + (ok ? "● reliable" : q.m >= 0 ? "▲ marginal" : "✕ down") + "</td></tr>";
    });
    e.innerHTML = rows.length ? h + "</tbody></table>" : "<p class=\"st\">No two sites can reach each other at this budget.</p>";
  }
  function renderLegend() {
    var e = $("legend"), ov = S.overlay, sim = S.sim, h = "";
    var sw = function (c, t) { return "<div><i style=\"background:" + c + "\"></i>" + t + "</div>"; };
    var rgb = function (b) { var c = BANDS[b][1]; return "rgb(" + c.join(",") + ")"; };
    if (ov === "coverage") {
      var fade = ov === "coverage" ? (sim ? sim.r.fade : S.fade) : 10;
      h += "<b>" + (ov === "coverage" ? (S.solo !== null && sim && sim.list[S.solo] ? "Coverage from " + sim.list[S.solo].id : "Best margin from connected sites") : "Stored PE map, summit base, " + (ov === "pe15" ? "1.5" : "3") + " m both ends, 433 MHz SF9") + "</b>";
      if (ov === "coverage") h += "<div class=\"opt\">Crew at " + S.crew.h.toFixed(1) + " m</div>";
      h += sw(rgb(3), "over " + (fade + 30) + " dB") + sw(rgb(2), (fade + 20) + " to " + (fade + 30) + " dB") + sw(rgb(1), (fade + 10) + " to " + (fade + 20) + " dB") + sw(rgb(0), fade + " to " + (fade + 10) + " dB, reliable") + sw(MARGINAL_CSS, "0 to " + fade + " dB, marginal");
    } else if (ov === "slope") {
      h += "<b>Slope, 20 m grid</b>" + sw("#f0d078", "10 to 15°") + sw("#e8963a", "15 to 20°") + sw("repeating-linear-gradient(45deg,#d6342c 0 4px,#7a2a26 4px 6px)", "over 20°, node rule");
    } else if (ov === "winter") {
      h += "<b>Sunlight, lunar days 6 and 7, 1.5 m</b>" + sw("linear-gradient(90deg,#3a2a10,#ffb028,#ffecaa)", "0 to 100 % of the time");
    } else h += "<b>Terrain</b><div>5 m hillshade, 16 km disk</div>";
    if ($("t-psr").checked) h += sw("#7c5cd6", "PSRs");
    if (S.plan && $("t-route").checked) h += "<div class=\"opt\"><i style=\"background:#7fe0c2\"></i>Route, in contact</div><div class=\"opt\"><i style=\"background:#f0584a\"></i>Route, contact lost</div>";
    e.innerHTML = h;
  }
  function renderAll() { renderValid(); renderResult(); renderPlan(); renderNodes(); renderLinks(); renderLegend(); }
  // ---- controls
  function presetList() {
    var add = function (g, v, t) { var o = document.createElement("option"); o.value = v; o.textContent = t; g.appendChild(o); };
    var ps = $("preset"), gs = {};
    PRESETS.forEach(function (p) {
      var g = gs[p.group]; if (!g) { g = gs[p.group] = document.createElement("optgroup"); g.label = p.group; ps.appendChild(g); }
      add(g, p.id, p.label);
    });
    ps.value = S.preset;
  }
  function loadPlan(i, run) {
    if (S.drawing) setDrawing(false);
    var P = i === "" ? null : PLANS[+i]; S.plan = P; S.auto = null; S.target = null; S.solo = null; S.sel = null;
    S.nodes = P ? P.nodes.map(function (q, k) { return { id: "R" + (k + 1), x: q[0], y: q[1], h: 1.5 }; }) : [];
    S.seq = S.nodes.length + 1;
    if (P) { S.fade = P.budget === "128.5" ? 22.5 : 10; $("budget").value = String(S.fade); }
    fitPlan(); markStale(); renderValid(); renderPlan(); renderNodes(); renderLegend();
    if (run) simulate();
  }
  function fitPlan() {
    var xs = [S.base.x], ys = [S.base.y];
    if (S.target) { xs.push(S.target.x); ys.push(S.target.y); }
    S.nodes.forEach(function (q) { xs.push(q.x); ys.push(q.y); });
    if (S.plan) { xs = xs.concat(S.plan.tx); ys = ys.concat(S.plan.ty); }
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    var w = Math.max(x1 - x0, 2500), h = Math.max(y1 - y0, 2500), pad = 70;
    view.cx = (x0 + x1) / 2; view.cy = (y0 + y1) / 2; view.s = Math.min((W - 2 * pad) / w, (H - 2 * pad) / h);
    draw();
  }
  $("simulate").addEventListener("click", simulate);
  document.querySelectorAll("input[name=ov]").forEach(function (e) { e.addEventListener("change", function () { S.overlay = e.value; renderLegend(); draw(); }); });
  $("t-psr").addEventListener("change", function () { renderLegend(); draw(); });
  $("t-route").addEventListener("change", function () { renderLegend(); draw(); });
  $("preset").addEventListener("change", function () {
    S.preset = $("preset").value;
    var p = PRESETS.filter(function (q) { return q.id === S.preset; })[0];
    if (p.f) { S.fMHz = p.f; $("freq").value = fToSlider(p.f); }
    renderValid(); markStale();
  });
  $("freq").addEventListener("input", function () { S.fMHz = sliderToF(+$("freq").value); S.preset = "free"; $("preset").value = "free"; renderValid(); markStale(); });
  $("target").addEventListener("change", function () { S.target = +$("target").value; renderValid(); markStale(); });
  $("budget").addEventListener("change", function () { S.fade = +$("budget").value; renderValid(); markStale(); });
  $("crewh").addEventListener("change", function () { var v = parseFloat($("crewh").value); if (v >= 0.5 && v <= 5) { S.crew.h = v; markStale(); } else $("crewh").value = S.crew.h; });
  $("add").addEventListener("click", function () { setPlacing(!S.placing); });
  $("clear").addEventListener("click", function () { if (S.drawing) setDrawing(false); S.nodes = []; S.seq = 1; S.plan = null; S.auto = null; S.target = null; S.solo = null; markStale(); renderPlan(); renderNodes(); renderLegend(); });
  $("auto").addEventListener("click", function () { autoPlan(); });
  $("draw").addEventListener("click", function () {
    if (S.drawing) { finishDraw(); return; }
    setPlacing(false); setPicking(false); S.draw = [{ x: S.base.x, y: S.base.y }]; setDrawing(true);
  });
  $("undo").addEventListener("click", function () { if (S.draw.length > 1) { S.draw.pop(); draw(); } });
  $("zin").addEventListener("click", function () { zoomAt(W / 2, H / 2, 1.5); });
  $("zout").addEventListener("click", function () { zoomAt(W / 2, H / 2, 1 / 1.5); });
  window.addEventListener("resize", resize);
  window.addEventListener("keydown", function (e) { if (e.key === "Escape" && S.placing) setPlacing(false); if (e.key === "Escape" && S.drawing) setDrawing(false); if (e.key === "Escape" && S.picking) setPicking(false); if (e.key === "Enter" && S.drawing) finishDraw(); });

  // ---- start
  presetList(); renderValid(); renderLegend();
  $("freq").value = fToSlider(433);
  resize();
  var firstPlan = PLANS.findIndex(function (p) { return p.case === "c2" && p.budget === "141"; });
  var pv = new Image(); pv.onload = function () { if (!overview) { overview = pv; draw(); } }; pv.src = META.preview;
  loadPlan(String(firstPlan), false);
  var ovw = new Image(); ovw.onload = function () { overview = ovw; draw(); }; ovw.src = "data/hill_overview.webp";
  loadData().then(function () {
    renderNodes(); draw();
    window.malapert = { S: S, simulate: simulate, autoPlan: autoPlan, buildRoute: buildRoute, loadPlan: loadPlan, view: view };
    return simulate();
  }).catch(function (e) {
    setChip("Not loaded", "stale"); $("stat").textContent = "";
    banner("The planner could not start: " + e.message + ". Reload the page to try again.");
  });
})();
