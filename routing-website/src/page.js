// Page logic: data loading, worker pool, Simulate, canvas map, node dragging and antenna aiming, link profiles, saving and sharing, readouts.
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
  var ALIB = window.MALAPERT_ANT, ANTS = {}, ASPEC = {}, GREF = 0;
  ALIB.antennas.forEach(function (a) {
    var s = atob(a.b64), g = new Float32Array(s.length), mx = -Infinity, i;
    for (i = 0; i < s.length; i++) { var v = s.charCodeAt(i); g[i] = (v > 127 ? v - 256 : v) / 4; if (g[i] > mx) mx = g[i]; }
    ASPEC[a.id] = { id: a.id, g: g, naz: a.naz, nel: a.nel, azStep: ALIB.az_step, elStep: ALIB.el_step, elMin: ALIB.el_min, beams: a.beams, iso: a.id === "iso" };
    var A = ANTS[a.id] = new LL.Antenna(ASPEC[a.id]); A.meta = a; A.max = mx; if (mx > GREF) GREF = mx;
  });
  var FADE_STUDY = 10, MAX_RELAYS = 12, HR_DEFAULT = 1.5, WALK_KMH = 1.8;
  var S = {
    base: { id: "B", x: T.bx, y: T.by, h: 1.5, ant: "iso", bore: 0 }, nodes: [], crew: { h: HR_DEFAULT }, relayAnt: "iso", rxMode: "best", crewLoss: 0, showPat: true, prev: { who: "Relays", id: "iso" }, target: null, picking: false,
    preset: "sf9", fMHz: 433, fade: FADE_STUDY, rateTarget: 1758, nAz: 2880, overlay: "coverage", solo: null, plan: null,
    sim: null, stale: true, busy: false, placing: false, sel: null, seq: 1, gen: 0, auto: null, drawing: false, draw: [], prof: null, profData: null, profHover: null, probing: false
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
      pool = new Pool(nw, { type: "init", dem: dem, ants: ASPEC, terrain: { nr: N, nc: N, x0: T.x0, ytop: T.ytop, cell: T.cell, bx: T.bx, by: T.by, rdisk: T.rdisk } });
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
      var f = S.fMHz * 1e6, o = { p_dbm: 22, a_m: 0.75, nf_db: 7, margin_db: fade, gap_db: 2 }, ceil = LL.lossForRate(f, S.rateTarget, o);
      return { f: f, fMHz: S.fMHz, ceil: ceil, fade: fade, label: fmtF(S.fMHz) + ", " + fmtRate(S.rateTarget) + " target", rate: function (L) { return LL.shannonRate(f, L, o).rate; } };
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
  // ---- antennas: gain toward a map bearing (clockwise from up) at a take-off elevation; planning gain for relays is the weaker of front and back, what a straight chain gets when aimed along it
  function antGain(A, s, brg, el) { return A.iso ? 0 : s.tilt ? A.gainTilted(brg - (s.bore || 0), el, { t: s.tilt, ta: s.tiltAz || 0, bore: s.bore || 0 }) : A.gain(brg - (s.bore || 0), el); }
  function gainAt(s, brg, el) { return antGain(ANTS[s.ant], s, brg, el); }
  // Switched and phased arrays transmit on a beam; when they listen on their omni setting, receiving takes the dipole.
  function omniRx(id) { return S.rxMode === "omni" && ANTS[id].beams > 1; }
  function omniId(id) { return ANTS[id].meta.omni_id || "dipole"; }
  function gainRx(s, brg, el) { return antGain(ANTS[omniRx(s.ant) ? omniId(s.ant) : s.ant], s, brg, el); }
  function covAnt(s) { return omniRx(s.ant) ? omniId(s.ant) : s.ant; }
  // Planning rows by elevation, so a search never promises more than Simulate gives: hops get the weaker of front and back (the worst bearing for steerable arrays), route points get the worst bearing.
  var PLAN = {};
  function planRows(id) {
    var pk = id + (omniRx(id) ? "|omni" : "");
    if (PLAN[pk]) return PLAN[pk];
    var A = ANTS[id], n = A.nel, hop = new Float64Array(n), cov = new Float64Array(n), front = new Float64Array(n);
    if (!A.iso) for (var e = 0; e < n; e++) {
      var el = A.elMin + e * A.elStep, mn = Infinity;
      for (var az = 0; az < 360; az += 2) mn = Math.min(mn, A.gain(az, el));
      cov[e] = mn; front[e] = A.beams > 1 ? mn : A.gain(0, el); hop[e] = A.beams > 1 ? mn : Math.min(A.gain(0, el), A.gain(180, el));
      if (omniRx(id)) { var dg = ANTS[omniId(id)].gain(0, el); cov[e] = Math.min(mn, dg); front[e] = hop[e] = (mn + dg) / 2; }
    }
    return (PLAN[pk] = { hop: hop, cov: cov, front: front });
  }
  function planG(id) { var r = planRows(id).hop; return function (el) { return LL.elGain(r, el); }; }
  function covG(id) { var r = planRows(id).cov; return function (el) { return LL.elGain(r, el); }; }
  function aimable(id) { var f = ANTS[id].meta.family; return f === "unidirectional" || f === "bidirectional" || f === "skewed"; }
  function relay(id, x, y, h) { return { id: id, x: x, y: y, h: h, ant: S.relayAnt, bore: 0 }; }
  function brg(a, b) { return LL.bearing(a.x, a.y, b.x, b.y); }
  function sites() { return [S.base].concat(S.nodes); }
  function key(s, r) { return [s.x, s.y, s.h, S.crew.h, r.f, r.ceil.toFixed(2), S.nAz, covAnt(s), ANTS[covAnt(s)].meta.family === "omni" && !s.tilt ? 0 : s.bore, s.tilt || 0, s.tiltAz || 0].join("|"); }
  var reused = 0;
  function coverage(s, r, onDone) {
    var k = key(s, r);
    if (CACHE.has(k)) { var v = CACHE.get(k); CACHE.delete(k); CACHE.set(k, v); reused++; onDone(); return Promise.resolve(v); }
    var ds = T.cell, nAz = S.nAz, maxN = Math.ceil((T.rdisk + Math.hypot(s.x - T.bx, s.y - T.by)) / ds) + 2, blocks = Math.max(pool.n * 4, 16), jobs = [];
    for (var b = 0; b < blocks; b++) jobs.push(pool.run({ type: "cov", id: b, x: s.x, y: s.y, ht: s.h, hr: S.crew.h, f: r.f, nAz: nAz, ds: ds, maxN: maxN, a0: Math.floor(nAz * b / blocks), a1: Math.floor(nAz * (b + 1) / blocks), lossCut: r.ceil + 6 + Math.max(0, ANTS[covAnt(s)].max), ant: covAnt(s), bore: s.bore || 0, tilt: s.tilt || 0, tiltAz: s.tiltAz || 0 }));
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
    var t0 = performance.now(), r = radio(), list = sites().map(function (q) { return { id: q.id, x: q.x, y: q.y, h: q.h, ant: q.ant, bore: q.bore, tilt: q.tilt || 0, tiltAz: q.tiltAz || 0 }; }), n = list.length, pairs = [], ch = S.crew.h, done = 0;
    var total = n + 2;
    var tick = function () { done++; $("prog").style.width = Math.min(100, 100 * done / total) + "%"; };
    for (var i = 0; i < n; i++) for (var j = 0; j < n; j++) if (i !== j) pairs.push(list[i].x, list[i].y, list[j].x, list[j].y, list[i].h, list[j].h);
    var sim = { r: r, list: list, plan: S.plan };
    return pool.run({ type: "links", id: 0, links: Float64Array.from(pairs), f: r.f }).then(function (m) {
      tick();
      var M = [], hop = [], p = 0;
      for (i = 0; i < n; i++) { M.push(new Array(n).fill(Infinity)); hop.push(new Array(n).fill(-Infinity)); }
      for (i = 0; i < n; i++) for (j = 0; j < n; j++) if (i !== j) { M[i][j] = r.ceil - m.L[p * 2] + gainAt(list[i], brg(list[i], list[j]), m.E[p * 2]) + gainRx(list[j], brg(list[j], list[i]), m.E[p * 2 + 1]); p++; }
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
      var a = 0, cellA = T.cell * T.cell / 1e6, lim = r.ceil - r.fade - S.crewLoss;
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
      var L = [], E = [], i = 0;
      res.forEach(function (m) { for (var z = 0; z < m.L.length; z += 2) { L.push(m.L[z]); E.push(m.E[z], m.E[z + 1]); } });
      var best = new Float32Array(ns), out = 0, segs = [], cur = null;
      for (var k2 = 0; k2 < ns; k2++) {
        var bm = -Infinity, pt = { x: tx[k2], y: P.ty[k2] };
        for (var c2 = 0; c2 < conn.length; c2++) { var s2 = conn[c2].s, bp = brg(s2, pt), mg = r.ceil - L[i] - S.crewLoss + Math.min(gainAt(s2, bp, E[2 * i]), gainRx(s2, bp, E[2 * i])); i++; if (mg > bm) bm = mg; }
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
  // Losses for a flat list of links, less the antenna gain gf(link, take-off elevation at the start, at the end) when given.
  function linkBatch(r, a, gf) {
    var n = a.length / 6;
    if (!n) return Promise.resolve(new Float64Array(0));
    var nc = Math.min(pool.n * 3, Math.ceil(n / 64)), jobs = [];
    for (var q = 0; q < nc; q++) jobs.push(pool.run({ type: "links", id: q, links: a.slice(Math.floor(q * n / nc) * 6, Math.floor((q + 1) * n / nc) * 6), f: r.f }));
    return Promise.all(jobs).then(function (res) {
      var L = new Float64Array(n), p = 0;
      res.forEach(function (m) { for (var z = 0; z < m.L.length; z += 2) { L[p] = m.L[z] - (gf ? gf(p, m.E[z], m.E[z + 1]) : 0); p++; } });
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
      var rest = [], v, o = 0, nr;
      for (v = 0; v < n; v++) if (!seen[v]) rest.push(v);
      nr = rest.length;
      var a = new Float64Array(frontier.length * nr * 6);
      frontier.forEach(function (u) {
        var U = list[u];
        rest.forEach(function (q) { var V = list[q]; a[o++] = U.x; a[o++] = U.y; a[o++] = V.x; a[o++] = V.y; a[o++] = U.h; a[o++] = V.h; });
      });
      var L = await linkBatch(r, a, function (p, e1, e2) { return list[frontier[Math.floor(p / nr)]].g(e1) + list[rest[p % nr]].g(e2); }), keep = [], b = [];
      for (var i = 0; i < frontier.length; i++) for (var j = 0; j < nr; j++) {
        var mf = r.ceil - L[i * nr + j];
        if (mf >= need) { var U = list[frontier[i]], V = list[rest[j]]; keep.push([frontier[i], rest[j], mf]); b.push(V.x, V.y, U.x, U.y, V.h, U.h); }
      }
      var Lb = await linkBatch(r, Float64Array.from(b), function (p, e1, e2) { return list[keep[p][1]].g(e1) + list[keep[p][0]].g(e2); }), fresh = [], end = -1;
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
  function planSite(s) { var r = planRows(s.ant).front; return { x: s.x, y: s.y, h: s.h, g: function (el) { return LL.elGain(r, el); }, c: covG(s.ant) }; }
  async function pointSearch(r, need, h, setStat) {
    var gR = planG(S.relayAnt), tg = { x: S.target.x, y: S.target.y, h: S.crew.h, g: function () { return 0; } }, D = Math.hypot(tg.x - S.base.x, tg.y - S.base.y);
    for (var pass = 0; pass < 2; pass++) {
      var whole = pass === 1, c = candidates(whole ? null : [S.base, tg], Math.max(1500, 0.35 * D), whole ? 700 : 500);
      var list = [planSite(S.base)].concat(c.sites.map(function (q) { return { x: q.x, y: q.y, h: h, g: gR }; }), [tg]), mask = new Uint8Array(list.length);
      mask[list.length - 1] = 1;
      var q = await chainSearch(r, need, list, function (hop) { setStat("Searching " + c.sites.length + " sites" + (whole ? " across the whole map" : "") + ", hop " + hop, hop / (MAX_RELAYS + 1)); }, [0], mask);
      if (q) return { mid: q.ids.slice(1, -1).map(function (i) { return list[i]; }), weak: q.weak, last: q.last, count: c.sites.length, spacing: c.spacing, whole: whole, cx: tg.x, cy: tg.y };
    }
    return null;
  }
  // Greedy along the route: from the first station out of contact, add the linked site that holds contact farthest, bridging with a fewest-hop chain when none can, then drop any relay the plan does not need.
  async function routeSearch(r, need, h, P, setStat) {
    var gR = planG(S.relayAnt), cR = covG(S.relayAnt), c = candidates(P.way, 2000, 700), list = [planSite(S.base)].concat(c.sites.map(function (q) { return { x: q.x, y: q.y, h: h, g: gR, c: cR }; })), m = list.length, ns = P.tx.length, u, k, o = 0;
    setStat("Checking " + c.sites.length + " sites against " + ns + " route points", 0.1);
    var a = new Float64Array(m * ns * 6);
    for (u = 0; u < m; u++) for (k = 0; k < ns; k++) { a[o++] = list[u].x; a[o++] = list[u].y; a[o++] = P.tx[k]; a[o++] = P.ty[k]; a[o++] = list[u].h; a[o++] = S.crew.h; }
    var L = await linkBatch(r, a, function (p, e1, e2) { return list[Math.floor(p / ns)].c(e1); }), cov = new Uint8Array(m * ns), any = new Uint8Array(ns), covered = new Uint8Array(ns);
    for (u = 0; u < m; u++) for (k = 0; k < ns; k++) if (r.ceil - L[u * ns + k] >= need) { cov[u * ns + k] = 1; any[k] = 1; }
    var chosen = [], hopM = new Float64Array(m).fill(-Infinity), edge = new Set();
    var addSite = async function (s) {
      chosen.push(s);
      for (var q = 0; q < ns; q++) if (cov[s * ns + q]) covered[q] = 1;
      var A = list[s], f = new Float64Array(m * 6), p = 0, v;
      for (v = 0; v < m; v++) { f[p++] = A.x; f[p++] = A.y; f[p++] = list[v].x; f[p++] = list[v].y; f[p++] = A.h; f[p++] = list[v].h; }
      var L1 = await linkBatch(r, f, function (p, e1, e2) { return A.g(e1) + list[p].g(e2); }), pass = [], b = [];
      for (v = 0; v < m; v++) if (v !== s && r.ceil - L1[v] >= need) { pass.push(v); b.push(list[v].x, list[v].y, A.x, A.y, list[v].h, A.h); }
      var L2 = await linkBatch(r, Float64Array.from(b), function (p, e1, e2) { return list[pass[p]].g(e1) + A.g(e2); });
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
  // ---- aim: widest-chain tree under planning gains, then each aimable antenna turns to the bearing that best serves its weakest tree neighbor, with a smaller share for the route points or target nearest to it
  async function aimAll(run) {
    if (!pool) return null;
    var list = sites(), n = list.length, r = radio(), i, j;
    if (n > 1 && list.some(function (s) { return aimable(s.ant); })) {
      var a = [], ends = [];
      for (i = 0; i < n; i++) for (j = 0; j < n; j++) if (i !== j) { a.push(list[i].x, list[i].y, list[j].x, list[j].y, list[i].h, list[j].h); ends.push([i, j]); }
      var L = await linkBatch(r, Float64Array.from(a), function (p, e1, e2) { return planG(list[ends[p][0]].ant)(e1) + planG(list[ends[p][1]].ant)(e2); });
      var M = list.map(function () { return new Array(n).fill(-Infinity); });
      ends.forEach(function (e, p) { M[e[0]][e[1]] = r.ceil - L[p]; });
      var par = LL.widestChain(M.map(function (row, u) { return row.map(function (v, w) { return u === w ? -Infinity : Math.min(v, M[w][u]); }); })).par;
      var pts = S.plan ? S.plan.tx.map(function (x, q) { return { x: x, y: S.plan.ty[q] }; }) : S.target ? [S.target] : [], serve = list.map(function () { return []; });
      pts.forEach(function (pt) {
        var bi = 0, bd = Infinity;
        list.forEach(function (s, u) { if (u > 0 && par[u] < 0) return; var d = Math.hypot(s.x - pt.x, s.y - pt.y); if (d < bd) { bd = d; bi = u; } });
        serve[bi].push(brg(list[bi], pt));
      });
      list.forEach(function (s, u) {
        if (!aimable(s.ant)) return;
        var nb = [], sv = serve[u], A = ANTS[s.ant], best = s.bore, bs = -Infinity;
        if (par[u] >= 0) nb.push(brg(s, list[par[u]]));
        list.forEach(function (t, w) { if (par[w] === u) nb.push(brg(s, t)); });
        if (!nb.length && !sv.length) return;
        for (var b = 0; b < 360; b += 2) {
          var mn = nb.length ? Infinity : 0, mean = 0;
          nb.forEach(function (x) { mn = Math.min(mn, A.gain(x - b, 0)); });
          sv.forEach(function (x) { mean += A.gain(x - b, 0) / sv.length; });
          var sc = mn + (nb.length ? 0.3 : 1) * mean;
          if (sc > bs + 1e-9) { bs = sc; best = b; }
        }
        s.bore = best;
      });
    }
    markStale(); renderNodes();
    return run ? simulate() : null;
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
      S.nodes = q.mid.map(function (w, k) { return relay("R" + (k + 1), w.x, w.y, h); });
      S.seq = n + 1;
      S.auto = drawn ? null : { cx: q.cx, cy: q.cy, from: n ? "R" + n : "B", last: q.last };
      fitPlan(); markStale(); renderPlan(); renderNodes(); renderLegend();
      return aimAll(true);
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
    var sim = S.sim; if (!sim) { profLine(); return; }
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
    profLine();
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
  var PAT_R = 58;
  function patR(g) { return PAT_R * Math.pow(10, (g - GREF) / 20); }
  function handlePos(s) { var t = s.bore * Math.PI / 180, rr = patR(ANTS[s.ant].gain(0, 0)) + 9; return { x: sx(s.x) + rr * Math.sin(t), y: sy(s.y) - rr * Math.cos(t) }; }
  function patterns() {
    if (!S.showPat) return;
    sites().forEach(function (s, i) {
      var A = ANTS[s.ant]; if (A.iso) return;
      var x = sx(s.x), y = sy(s.y), d, base = i === 0;
      ctx.beginPath();
      for (d = 0; d <= 360; d += 3) { var rr = patR(A.gain(d - s.bore, 0)), t = d * Math.PI / 180, px = x + rr * Math.sin(t), py = y - rr * Math.cos(t); if (d) ctx.lineTo(px, py); else ctx.moveTo(px, py); }
      ctx.closePath(); ctx.fillStyle = base ? "rgba(230,176,74,0.24)" : "rgba(242,244,245,0.2)"; ctx.fill();
      ctx.lineWidth = 3.5; ctx.strokeStyle = "rgba(8,11,14,0.55)"; ctx.stroke();
      ctx.lineWidth = 1.6; ctx.strokeStyle = base ? "#e6b04a" : "#f2f4f5"; ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, patR(0), 0, 7); ctx.setLineDash([3, 3]); ctx.lineWidth = 1; ctx.strokeStyle = "rgba(233,236,238,0.6)"; ctx.stroke(); ctx.setLineDash([]);
      if (aimable(s.ant)) {
        var h = handlePos(s);
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(h.x, h.y); ctx.lineWidth = 1.5; ctx.strokeStyle = base ? "#e6b04a" : "#f2f4f5"; ctx.stroke();
        ctx.beginPath(); ctx.arc(h.x, h.y, 5.5, 0, 7); ctx.fillStyle = base ? "#e6b04a" : "#f2f4f5"; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = "#0b0e11"; ctx.stroke();
      }
    });
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
    routeLine(); drawPreview(); patterns(); linkLines(); targetLink(); nodesDraw(); poleMark();
  }

  // ---- interaction
  var ptrs = new Map(), drag = null, pinch = null;
  function pos(e) { var r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function hit(p) {
    var tol = 20;
    if (S.showPat) { var all = sites(); for (var k = all.length - 1; k >= 0; k--) if (aimable(all[k].ant)) { var hp = handlePos(all[k]); if (Math.hypot(hp.x - p.x, hp.y - p.y) < 10) return { kind: "aim", site: all[k] }; } }
    for (var i = S.nodes.length - 1; i >= 0; i--) if (Math.hypot(sx(S.nodes[i].x) - p.x, sy(S.nodes[i].y) - p.y) < tol) return { kind: "node", node: S.nodes[i] };
    if (Math.hypot(sx(S.base.x) - p.x, sy(S.base.y) - p.y) < tol) return { kind: "base" };
    return null;
  }
  function clampDisk(q) {
    var dx = q.x - T.bx, dy = q.y - T.by, r = Math.hypot(dx, dy), lim = T.rdisk - 30;
    if (r > lim) { q.x = T.bx + dx * lim / r; q.y = T.by + dy * lim / r; }
  }
  function markStale() { S.stale = true; S.gen++; $("rd").classList.add("dim"); setChip("Out of date", "stale"); $("stat").textContent = "Press Simulate to update the results."; renderProfile(); persist(); draw(); }
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
    if (S.probing) { var pq = { x: wx(p.x), y: wy(p.y) }; clampDisk(pq); openProfile(probeFrom(), null, pq); drag = null; return; }
    if (S.placing) { addNode(wx(p.x), wy(p.y)); setPlacing(false); drag = null; return; }
    var h = hit(p);
    if (h && h.kind === "node") { S.sel = h.node; drag = h; renderNodes(); draw(); }
    else if (h && h.kind === "aim") { drag = h; if (h.site !== S.base) S.sel = h.site; renderNodes(); draw(); }
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
    if (drag.kind === "aim") { var as = drag.site; as.bore = Math.round(LL.bearing(as.x, as.y, wx(p.x), wy(p.y))) % 360; markStale(); renderNodes(); hintShow((as === S.base ? "Base" : as.id) + " antenna toward " + as.bore + "°", 1200); return; }
    if (drag.kind !== "pan") readAt(p.x, p.y, drag.node.id);
    if (drag.kind === "pan") { view.cx = drag.cx - (p.x - drag.x) / view.s; view.cy = drag.cy + (p.y - drag.y) / view.s; clampView(); draw(); }
    else if (drag.kind === "node") { var q = drag.node; q.x = wx(p.x); q.y = wy(p.y); clampDisk(q); markStale(); renderNodes(); }
  });
  var up = function (e) {
    var d0 = drag; ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null;
    if (ptrs.size !== 0) return;
    drag = null;
    if (e.type === "pointerup" && d0 && d0.kind === "pan") { var p = pos(e); if (Math.hypot(p.x - d0.x, p.y - d0.y) < 5) { var lk = hitLink(p); if (lk) openProfile(lk.a, lk.b); } }
  };
  cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);
  cv.addEventListener("wheel", function (e) { e.preventDefault(); var p = pos(e); zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0014)); }, { passive: false });
  cv.addEventListener("dblclick", function (e) { if (S.drawing) { finishDraw(); return; } var p = pos(e); if (!hit(p)) addNode(wx(p.x), wy(p.y)); });
  function setPlacing(on) { S.placing = on; $("add").setAttribute("aria-pressed", String(on)); $("app").classList.toggle("placing", on); if (on) hintShow("Tap the map to place the relay."); else $("hint").hidden = true; }
  var hintT = 0;
  function hintShow(t, ms) { var h = $("hint"); h.textContent = t; h.hidden = false; clearTimeout(hintT); if (ms) hintT = setTimeout(function () { h.hidden = true; }, ms); }
  function addNode(x, y) {
    if (S.nodes.length >= MAX_RELAYS) { hintShow("Twelve relays is the limit here.", 2500); return; }
    var q = relay("R" + S.seq++, x, y, 1.5); clampDisk(q); S.nodes.push(q); S.sel = q; markStale(); renderNodes();
  }
  function renumber() { S.nodes.forEach(function (q, i) { q.id = "R" + (i + 1); }); S.seq = S.nodes.length + 1; }

  // ---- panels
  function setChip(t, c) { var e = $("chip"); e.textContent = t; e.className = "chip " + c; }
  function banner(t) { var b = document.createElement("div"); b.className = "banner"; b.setAttribute("role", "alert"); b.textContent = t; $("wrap").appendChild(b); }
  function renderValid() {
    var r = radio();
    $("budget-note").textContent = "Allowed loss " + (r.ceil - r.fade).toFixed(1) + " dB";
    $("freq-v").textContent = fmtF(r.fMHz);
    $("rate-target-wrap").hidden = S.preset !== "free";
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
    var ar = document.createElement("div"), nm = i === 0 ? "the base" : q.id; ar.className = "antrow";
    var se = document.createElement("select"); se.setAttribute("aria-label", "Antenna of " + nm);
    antOptions(se); se.value = q.ant;
    se.addEventListener("change", function () { q.ant = se.value; markStale(); renderNodes(); renderLegend(); renderAnt(i === 0 ? "Base" : q.id, q.ant); });
    ar.appendChild(se);
    var bi = document.createElement("input"); bi.type = "number"; bi.min = 0; bi.max = 359; bi.step = 1; bi.value = Math.round(q.bore); bi.disabled = ANTS[q.ant].meta.family === "omni";
    bi.setAttribute("aria-label", "Antenna bearing of " + nm + " in degrees clockwise from map up");
    bi.addEventListener("change", function () { var v = parseFloat(bi.value); if (isFinite(v)) { q.bore = ((Math.round(v) % 360) + 360) % 360; markStale(); } bi.value = q.bore; });
    ar.appendChild(bi);
    var dg = document.createElement("span"); dg.textContent = "° aim"; ar.appendChild(dg);
    d.appendChild(ar);
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
    var h = "<table><thead><tr><th scope=\"col\">Link</th><th scope=\"col\">Forward dB</th><th scope=\"col\">Back dB</th><th scope=\"col\">Rate</th><th scope=\"col\">State</th><th scope=\"col\"><span class=\"vh\">Profile</span></th></tr></thead><tbody>";
    rows.forEach(function (q) {
      var A = sim.list[q.i].id, B = sim.list[q.j].id, ok = q.m >= r.fade;
      h += "<tr><td>" + A + "–" + B + (q.chain ? " chain" : "") + "</td><td>" + db(q.a) + "</td><td>" + db(q.b) + "</td><td>" + fmtRate(r.rate(r.ceil - q.m)) + "</td><td>" + (ok ? "● reliable" : q.m >= 0 ? "▲ marginal" : "✕ down") + "</td><td><button class=\"btn lk\" type=\"button\" data-a=\"" + sim.list[q.i].id + "\" data-b=\"" + sim.list[q.j].id + "\" aria-label=\"Profile of " + A + "–" + B + "\">Profile</button></td></tr>";
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
    if (S.showPat && sites().some(function (q) { return !ANTS[q.ant].iso; })) h += "<div class=\"opt\">Antenna shape: gain at the horizon, radius in proportion to free-space range. Dashed ring: 0 dBi." + (sites().some(function (q) { return aimable(q.ant); }) ? " Drag the dot to aim." : "") + "</div>";
    if (S.plan && $("t-route").checked) h += "<div class=\"opt\"><i style=\"background:#7fe0c2\"></i>Route, in contact</div><div class=\"opt\"><i style=\"background:#f0584a\"></i>Route, contact lost</div>";
    e.innerHTML = h;
  }
  function antOptions(sel) {
    sel.innerHTML = "";
    ALIB.antennas.forEach(function (a) { var o = document.createElement("option"); o.value = a.id; o.textContent = a.label; sel.appendChild(o); });
  }
  function antLine(id) {
    var A = ANTS[id], m = A.meta; if (A.iso) return "Isotropic: 0 dBi everywhere, the study's assumption.";
    var t = m.label + ": " + db(m.peak_dbi !== undefined ? m.peak_dbi : A.max) + " dBi peak, " + db(A.gain(180, 0)) + " dBi at the back, " + db(m.horizon_min_dbi) + " dBi worst at the horizon";
    if (m.hpbw_az_deg) t += ", " + Math.round(m.hpbw_az_deg) + "° wide";
    if (m.hpbw_el_deg) t += ", " + Math.round(m.hpbw_el_deg) + "° tall";
    t += ". " + (m.size ? m.size + ". " : "") + (m.notes || "");
    if (m.beams > 1) t += " Takes the best of " + m.beams + " beam states.";
    return t;
  }
  function polar(c, ox, oy, R, fn, title) {
    var lo = -20, hi = Math.max(12, Math.ceil(GREF)), k = function (g) { return R * Math.max(0, g - lo) / (hi - lo); };
    c.strokeStyle = "rgba(233,236,238,0.22)"; c.lineWidth = 1; c.fillStyle = "#9aa3ab"; c.font = "10px 'B612', 'Segoe UI', sans-serif"; c.textAlign = "left"; c.textBaseline = "middle";
    [-10, 0, 10].forEach(function (g) { if (g > hi) return; c.beginPath(); c.arc(ox, oy, k(g), 0, 7); c.stroke(); c.fillText(g + "", ox + 2, oy - k(g) + 6); });
    c.beginPath(); c.moveTo(ox - R, oy); c.lineTo(ox + R, oy); c.moveTo(ox, oy - R); c.lineTo(ox, oy + R); c.stroke();
    fn(k);
    c.fillStyle = "#e9ecee"; c.textAlign = "center"; c.fillText(title, ox, oy + R + 11);
  }
  // Preview of the antenna last chosen anywhere on the page: the base, all relays, or one site.
  function renderAnt(who, pick) {
    if (who) S.prev = { who: who, id: pick };
    var cv2 = $("antprev"), c = cv2.getContext("2d"), id = S.prev.id, A = ANTS[id], D = ANTS.dipole, w = cv2.width, h = cv2.height, R = Math.min(w / 4, h / 2 - 12) - 6;
    c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, w, h);
    var trace = function (k, g, color, dash, fill) {
      c.beginPath(); for (var d = 0; d <= 360; d += 2) { var rr = k(g(d)), t = d * Math.PI / 180, px = rr * Math.sin(t), py = -rr * Math.cos(t); if (d) c.lineTo(px, py); else c.moveTo(px, py); }
      c.closePath(); if (fill) { c.fillStyle = fill; c.fill(); } c.setLineDash(dash || []); c.lineWidth = 1.6; c.strokeStyle = color; c.stroke(); c.setLineDash([]);
    };
    polar(c, w / 4, h / 2 - 6, R, function (k) {
      c.save(); c.translate(w / 4, h / 2 - 6);
      if (D) trace(k, function (d) { return D.gain(d, 0); }, "rgba(233,236,238,0.7)", [3, 3]);
      trace(k, function (d) { return A.gain(d, 0); }, "#7fe0c2", null, "rgba(127,224,194,0.18)");
      c.restore();
    }, "Horizon, boresight up");
    polar(c, 3 * w / 4, h / 2 - 6, R, function (k) {
      c.save(); c.translate(3 * w / 4, h / 2 - 6);
      var cut = function (X) { return function (d) { var e = 90 - (d <= 180 ? d : 360 - d); return X.gain(d <= 180 ? 0 : 180, e); }; };
      if (D) trace(k, cut(D), "rgba(233,236,238,0.7)", [3, 3]);
      trace(k, cut(A), "#7fe0c2", null, "rgba(127,224,194,0.18)");
      c.restore();
    }, "Vertical, front right");
    $("ant-note").textContent = S.prev.who + ". " + antLine(id) + " Dashed: half-wave dipole. Rings at −10, 0 and +10 dBi.";
    cv2.setAttribute("aria-label", "Horizon and vertical pattern of the " + S.prev.who.toLowerCase() + " antenna, " + A.meta.label + ", against a half-wave dipole");
  }
  function renderAll() { renderValid(); renderResult(); renderPlan(); renderNodes(); renderLinks(); renderLegend(); }
  // ---- link profile: terrain in the model's curvature frame, the direct ray and first Fresnel zone, the obstacles the hybrid rounds, and the budget both ways
  var PARAMS = {}, DEGR = 180 / Math.PI;
  function paramsFor(f) { return PARAMS[f] || (PARAMS[f] = new LL.Params(f)); }
  function siteById(id) { return sites().filter(function (q) { return q.id === id; })[0] || null; }
  function siteName(q) { return q.crew ? "Crew" : q === S.base ? "Base" : q.id; }
  function openProfile(a, b, pt) {
    S.prof = { a: a, b: b || null, pt: pt || null, swap: false }; S.profHover = null; setProbing(false);
    renderProfile(); draw();
  }
  function closeProfile() { S.prof = null; S.profData = null; S.profHover = null; $("prof").hidden = true; $("wrap").classList.remove("has-prof"); draw(); }
  function profEnds() {
    var P = S.prof; if (!P) return null;
    var a = siteById(P.a); if (!a) return null;
    var b = P.pt ? { id: "Crew", crew: true, x: P.pt.x, y: P.pt.y, h: S.crew.h, ant: "iso", bore: 0 } : siteById(P.b);
    if (!b || b === a) return null;
    return P.swap ? [b, a] : [a, b];
  }
  function endGain(q, toward, el, rx) { return q.crew ? -S.crewLoss : rx ? gainRx(q, brg(q, toward), el) : gainAt(q, brg(q, toward), el); }
  function computeProfile() {
    var e = profEnds(); if (!e || !ter) return null;
    var A = e[0], B = e[1], r = radio(), p = paramsFor(r.f), q = ter.profile(A.x, A.y, B.x, B.y, ter.cell);
    if (q.D < 1) return null;
    var fw = LL.hybridProfile(q.z, q.N, q.D, A.h, B.h, p, false), runs = fw.runs.slice();
    var bk = LL.linkLoss(ter, B.x, B.y, A.x, A.y, B.h, A.h, p, false);
    var st = q.D / (q.N - 1), ze = new Float64Array(q.N), lam = LL.C0 / r.f, minC = Infinity, minAt = 0, i;
    for (i = 0; i < q.N; i++) { var d = i * st; ze[i] = q.z[i] + d * (q.D - d) / (2 * LL.R_MOON); }
    for (i = 1; i < q.N - 1; i++) {
      var dd = i * st, ray = fw.hts + (fw.hrs - fw.hts) * dd / q.D, c = (ray - ze[i]) / Math.sqrt(lam * dd * (q.D - dd) / q.D);
      if (c < minC) { minC = c; minAt = i; }
    }
    var gA = endGain(A, B, fw.elT, false), gB = endGain(B, A, fw.elR, true), gB2 = endGain(B, A, bk.elT, false), gA2 = endGain(A, B, bk.elR, true);
    return {
      A: A, B: B, r: r, z: q.z, ze: ze, N: q.N, D: q.D, st: st, lam: lam, fw: fw, bk: bk, runs: runs, gA: gA, gB: gB, gA2: gA2, gB2: gB2,
      fwd: r.ceil - fw.L + gA + gB, back: r.ceil - bk.L + gB2 + gA2, minC: minC, minAt: minAt,
      hybrid: fw.los ? NaN : fw.fspl + fw.A_obs + fw.A_tx + fw.A_rx
    };
  }
  function marginClass(m, r) { return m >= r.fade ? "good" : m >= 0 ? "warn" : "bad"; }
  function renderProfile() {
    if (!S.prof) return;
    if (!profEnds()) { closeProfile(); return; }
    var D = computeProfile(); if (!D) return;
    S.profData = D;
    var el = $("prof"), fw = D.fw, r = D.r, a = siteName(D.A), b = siteName(D.B), km = (D.D / 1000).toFixed(2) + " km";
    el.hidden = false; $("wrap").classList.add("has-prof");
    $("prof-t").textContent = a + " → " + b;
    $("prof-s").textContent = fw.los
      ? km + ", line of sight; tightest clearance " + D.minC.toFixed(2) + " of the first Fresnel zone at " + (D.minAt * D.st / 1000).toFixed(2) + " km"
      : km + ", diffracted over " + (D.runs.length === 1 ? "1 rounded obstacle" : D.runs.length + " rounded obstacles") + ", bending " + (fw.theta * DEGR).toFixed(2) + "° in all";
    var row = function (k, v, cls) { return "<tr" + (cls ? " class=\"" + cls + "\"" : "") + "><th scope=\"row\">" + k + "</th><td>" + v + "</td></tr>"; };
    var h = "<table><tbody>" + row("Free space", db(fw.fspl) + " dB");
    if (fw.los) h += row("Fresnel obstruction, P.526", db(fw.Ld) + " dB");
    else {
      var useH = fw.L > fw.L526 + 1e-9, off = useH ? "" : "off";
      h += row("Knife edge", db(fw.A_obs - fw.T) + " dB", off) + row("Rounded obstacles", db(fw.T) + " dB", off) +
        row("Ground near " + a, db(fw.A_tx) + " dB", off) + row("Ground near " + b, db(fw.A_rx) + " dB", off) +
        row("Hybrid" + (useH ? ", used" : ""), db(D.hybrid) + " dB", off) + row("P.526 general" + (useH ? "" : ", used"), db(fw.L526) + " dB", useH ? "off" : "");
    }
    h += row("Path loss", db(fw.L) + " dB", "tot");
    h += row(a + " antenna", D.A.crew ? sign(D.gA) + " dB, crew" : sign(D.gA) + " dBi at " + sign(fw.elT) + "°");
    h += row(b + " antenna", D.B.crew ? sign(D.gB) + " dB, crew" : sign(D.gB) + " dBi at " + sign(fw.elR) + "°");
    h += row("Budget", db(r.ceil) + " dB");
    h += "<tr class=\"tot\"><th scope=\"row\">Margin " + a + " → " + b + "</th><td class=\"" + marginClass(D.fwd, r) + "\">" + db(D.fwd) + " dB</td></tr>";
    h += "<tr><th scope=\"row\">Margin " + b + " → " + a + "</th><td class=\"" + marginClass(D.back, r) + "\">" + db(D.back) + " dB</td></tr>";
    var m = Math.min(D.fwd, D.back), state = m >= r.fade ? "● reliable" : m >= 0 ? "▲ marginal" : "✕ down";
    $("prof-m").innerHTML = "<span class=\"" + marginClass(m, r) + "\">" + state + ", margin " + db(D.fwd) + " / " + db(D.back) + " dB</span>";
    h += row("State", m >= r.fade ? "● reliable" : m >= 0 ? "▲ marginal" : "✕ down") + row("Needs", db(r.fade) + " dB fade margin") + row("Rate", fmtRate(r.rate(r.ceil - m)));
    h += "</tbody></table><p>Terrain includes the Moon's curvature, as the model sees it. Shaded: first Fresnel zone. Gold: what the model treats as rounded obstacles. Dashed: the diffracted path. Estimates are about ±" + (fw.los ? "3" : "7") + " dB against the PE.</p>";
    $("prof-k").innerHTML = h;
    $("wrap").style.setProperty("--prof-h", el.offsetHeight + "px");
    drawProfile();
  }
  function profTicks(a, b, n) {
    var s = (b - a) / n, p = Math.pow(10, Math.floor(Math.log10(s))), f = s / p, step = (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p, out = [];
    for (var v = Math.ceil(a / step) * step; v <= b + 1e-9; v += step) out.push(v);
    return out;
  }
  function profGeom() {
    var D = S.profData, c = $("prof-cv"), w = c.clientWidth, h = c.clientHeight, fw = D.fw;
    var L = 54, R = 12, Tp = 18, B = 22, pw = w - L - R, ph = h - Tp - B;
    var ray = function (d) { return fw.hts + (fw.hrs - fw.hts) * d / D.D; }, f1 = function (d) { return Math.sqrt(D.lam * d * Math.max(D.D - d, 0) / D.D); };
    var lo = Infinity, hi = -Infinity, i;
    for (i = 0; i < D.N; i++) { var d = i * D.st, rr = ray(d), ff = f1(d); lo = Math.min(lo, D.ze[i], rr - ff); hi = Math.max(hi, D.ze[i], rr + ff); }
    hi = Math.max(hi, fw.hts, fw.hrs);
    var apex = fw.los ? null : { d: fw.db, y: fw.hts + fw.Stim * fw.db };
    if (apex) hi = Math.max(hi, apex.y);
    var pad = (hi - lo) * 0.08 + 2; lo -= pad; hi += pad;
    return { w: w, h: h, L: L, R: R, Tp: Tp, B: B, pw: pw, ph: ph, lo: lo, hi: hi, ray: ray, f1: f1, apex: apex,
      X: function (d) { return L + pw * d / D.D; }, Y: function (y) { return Tp + ph * (hi - y) / (hi - lo); } };
  }
  function drawProfile() {
    var D = S.profData, c = $("prof-cv"); if (!D || $("prof").hidden) return;
    var w = c.clientWidth, h = c.clientHeight; if (!w || !h) return;
    var k = Math.min(window.devicePixelRatio || 1, 2);
    if (c.width !== Math.round(w * k) || c.height !== Math.round(h * k)) { c.width = Math.round(w * k); c.height = Math.round(h * k); }
    var g = c.getContext("2d"); g.setTransform(k, 0, 0, k, 0, 0); g.clearRect(0, 0, w, h);
    var G = profGeom(); if (G.pw < 40 || G.ph < 30) return;
    var fw = D.fw, X = G.X, Y = G.Y, N = D.N, st = D.st, i, d;
    g.font = "10px 'B612', 'Segoe UI', sans-serif"; g.textBaseline = "middle"; g.lineWidth = 1;
    profTicks(G.lo, G.hi, Math.max(2, Math.floor(G.ph / 34))).forEach(function (v) {
      g.strokeStyle = "rgba(233,236,238,0.08)"; g.beginPath(); g.moveTo(G.L, Y(v)); g.lineTo(G.L + G.pw, Y(v)); g.stroke();
      g.fillStyle = "#8f98a0"; g.textAlign = "right"; g.fillText(Math.round(v) + "", G.L - 6, Y(v));
    });
    g.textBaseline = "top";
    profTicks(0, D.D / 1000, Math.max(2, Math.floor(G.pw / 70))).forEach(function (v) {
      g.strokeStyle = "rgba(233,236,238,0.08)"; g.beginPath(); g.moveTo(X(v * 1000), G.Tp); g.lineTo(X(v * 1000), G.Tp + G.ph); g.stroke();
      g.fillStyle = "#8f98a0"; g.textAlign = "center"; g.fillText(+v.toFixed(2) + (v === 0 ? " km" : ""), X(v * 1000), G.Tp + G.ph + 5);
    });
    g.save(); g.translate(12, G.Tp + G.ph / 2); g.rotate(-Math.PI / 2); g.textAlign = "center"; g.textBaseline = "middle"; g.fillStyle = "#8f98a0"; g.fillText("height, m", 0, 0); g.restore();
    g.beginPath();
    for (i = 0; i < N; i++) { d = i * st; g.lineTo(X(d), Y(G.ray(d) + G.f1(d))); }
    for (i = N - 1; i >= 0; i--) { d = i * st; g.lineTo(X(d), Y(G.ray(d) - G.f1(d))); }
    g.closePath(); g.fillStyle = "rgba(127,224,194,0.13)"; g.fill();
    g.setLineDash([3, 3]); g.strokeStyle = "rgba(127,224,194,0.5)"; g.stroke(); g.setLineDash([]);
    g.beginPath(); g.moveTo(X(0), Y(G.lo));
    for (i = 0; i < N; i++) g.lineTo(X(i * st), Y(D.ze[i]));
    g.lineTo(X(D.D), Y(G.lo)); g.closePath(); g.fillStyle = "#3b434b"; g.fill();
    g.beginPath(); for (i = 0; i < N; i++) g.lineTo(X(i * st), Y(D.ze[i])); g.strokeStyle = "#aab2b9"; g.lineWidth = 1.2; g.stroke();
    D.runs.forEach(function (rn) {
      g.beginPath(); for (var j = rn.i0; j <= rn.i1; j++) g.lineTo(X(j * st), Y(D.ze[j]));
      g.lineWidth = 3.5; g.strokeStyle = "#e6b04a"; g.lineCap = "round"; g.stroke(); g.lineCap = "butt";
      if (rn.i0 === rn.i1) { g.beginPath(); g.arc(X(rn.i0 * st), Y(D.ze[rn.i0]), 3, 0, 7); g.fillStyle = "#e6b04a"; g.fill(); }
    });
    g.lineWidth = 1.6; g.strokeStyle = "#f2f4f5"; g.beginPath(); g.moveTo(X(0), Y(fw.hts)); g.lineTo(X(D.D), Y(fw.hrs)); g.stroke();
    g.strokeStyle = "#f0584a"; g.lineWidth = 2.2;
    for (i = 1; i < N - 1; i++) {
      d = i * st;
      if (D.ze[i] > G.ray(d)) { var d0 = (i - 0.5) * st, d1 = (i + 0.5) * st; g.beginPath(); g.moveTo(X(d0), Y(G.ray(d0))); g.lineTo(X(d1), Y(G.ray(d1))); g.stroke(); }
    }
    if (G.apex) {
      g.setLineDash([6, 4]); g.lineWidth = 1.6; g.strokeStyle = "#ffd640";
      g.beginPath(); g.moveTo(X(0), Y(fw.hts)); g.lineTo(X(G.apex.d), Y(G.apex.y)); g.lineTo(X(D.D), Y(fw.hrs)); g.stroke(); g.setLineDash([]);
    }
    [[0, D.ze[0], fw.hts, siteName(D.A), "left"], [D.D, D.ze[N - 1], fw.hrs, siteName(D.B), "right"]].forEach(function (m) {
      g.strokeStyle = "#f2f4f5"; g.lineWidth = 2; g.beginPath(); g.moveTo(X(m[0]), Y(m[1])); g.lineTo(X(m[0]), Y(m[2])); g.stroke();
      g.beginPath(); g.arc(X(m[0]), Y(m[2]), 3.5, 0, 7); g.fillStyle = "#f2f4f5"; g.fill();
      g.font = "600 12px 'Saira Semi Condensed', 'Segoe UI', sans-serif"; g.textBaseline = "bottom"; g.textAlign = m[4]; g.fillStyle = "#f2f4f5";
      g.fillText(m[3], X(m[0]) + (m[4] === "left" ? 4 : -4), Y(m[2]) - 5);
    });
    var ex = (G.ph / (G.hi - G.lo)) / (G.pw / D.D);
    g.font = "10px 'B612', 'Segoe UI', sans-serif"; g.textBaseline = "top"; g.textAlign = "right"; g.fillStyle = "#8f98a0";
    g.fillText("vertical ×" + (ex >= 10 ? Math.round(ex) : ex.toFixed(1)), G.L + G.pw, 3);
    if (S.profHover !== null) {
      var hi2 = S.profHover; d = hi2 * st;
      g.strokeStyle = "rgba(242,244,245,0.6)"; g.lineWidth = 1; g.beginPath(); g.moveTo(X(d), G.Tp); g.lineTo(X(d), G.Tp + G.ph); g.stroke();
      g.beginPath(); g.arc(X(d), Y(D.ze[hi2]), 3, 0, 7); g.fillStyle = "#aab2b9"; g.fill();
      g.beginPath(); g.arc(X(d), Y(G.ray(d)), 3, 0, 7); g.fillStyle = "#f2f4f5"; g.fill();
    }
  }
  function profRead(i) {
    var D = S.profData, e = $("prof-read");
    if (!D || i === null) { e.hidden = true; return; }
    var d = i * D.st, ray = D.fw.hts + (D.fw.hrs - D.fw.hts) * d / D.D, f1 = Math.sqrt(D.lam * d * Math.max(D.D - d, 0) / D.D), gap = ray - D.ze[i];
    var t = (d / 1000).toFixed(2) + " km: ground " + Math.round(D.z[i]) + " m (" + Math.round(D.ze[i]) + " m with curvature), ray " + Math.round(ray) + " m, ";
    t += gap < 0 ? "ray " + db(-gap) + " m below the ground" : f1 > 0.01 ? "clearance " + (gap / f1).toFixed(2) + " of the first Fresnel zone" : "at the end";
    e.textContent = t; e.hidden = false;
  }
  function profLine() {
    var D = S.profData; if (!D || !S.prof) return;
    var a = D.A, b = D.B;
    ctx.beginPath(); ctx.moveTo(sx(a.x), sy(a.y)); ctx.lineTo(sx(b.x), sy(b.y));
    ctx.lineWidth = 7; ctx.strokeStyle = "rgba(8,11,14,0.75)"; ctx.stroke();
    ctx.lineWidth = 3; ctx.strokeStyle = "#e6b04a"; ctx.stroke();
    var c = a.crew ? a : b.crew ? b : null;
    if (c) { ctx.beginPath(); ctx.arc(sx(c.x), sy(c.y), 6, 0, 7); ctx.fillStyle = "#0b0e11"; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = "#e6b04a"; ctx.stroke(); }
    if (S.profHover !== null) {
      var t = S.profHover / (D.N - 1);
      ctx.beginPath(); ctx.arc(sx(a.x + (b.x - a.x) * t), sy(a.y + (b.y - a.y) * t), 4.5, 0, 7); ctx.fillStyle = "#f2f4f5"; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = "#0b0e11"; ctx.stroke();
    }
  }
  function hitLink(p) {
    var sim = S.sim; if (!sim) return null;
    var L = sim.list, n = L.length, best = null, bd = 7;
    for (var i = 0; i < n; i++) for (var j = i + 1; j < n; j++) {
      if (!(sim.hop[i][j] >= 0) && !(sim.par[i] === j || sim.par[j] === i)) continue;
      var ax = sx(L[i].x), ay = sy(L[i].y), vx = sx(L[j].x) - ax, vy = sy(L[j].y) - ay, l2 = vx * vx + vy * vy; if (l2 < 1) continue;
      var t = Math.max(0, Math.min(1, ((p.x - ax) * vx + (p.y - ay) * vy) / l2)), dd = Math.hypot(p.x - ax - t * vx, p.y - ay - t * vy);
      if (dd < bd) { bd = dd; best = { a: L[i].id, b: L[j].id }; }
    }
    return best;
  }
  function probeFrom() { return S.sel && siteById(S.sel.id) ? S.sel.id : S.base.id; }
  function setProbing(on) {
    S.probing = on; $("probe").setAttribute("aria-pressed", String(on)); $("app").classList.toggle("placing", on || S.placing || S.drawing || S.picking);
    if (on) hintShow("Tap the map: profile from " + siteName(siteById(probeFrom())) + " to that point at crew height."); else if (!S.placing && !S.drawing && !S.picking) $("hint").hidden = true;
  }
  (function () {
    var pc = $("prof-cv");
    pc.addEventListener("pointermove", function (e) {
      var D = S.profData; if (!D) return;
      var G = profGeom(), r = pc.getBoundingClientRect(), d = (e.clientX - r.left - G.L) / G.pw * D.D;
      if (d < 0 || d > D.D) { S.profHover = null; profRead(null); } else { S.profHover = Math.round(d / D.st); profRead(S.profHover); }
      drawProfile(); draw();
    });
    pc.addEventListener("pointerleave", function () { S.profHover = null; profRead(null); drawProfile(); draw(); });
    $("prof-x").addEventListener("click", closeProfile);
    $("prof-swap").addEventListener("click", function () { if (!S.prof) return; S.prof.swap = !S.prof.swap; S.profHover = null; profRead(null); renderProfile(); draw(); });
    $("probe").addEventListener("click", function () { setPlacing(false); if (S.drawing) setDrawing(false); setPicking(false); setProbing(!S.probing); });
    $("links").addEventListener("click", function (e) { var b = e.target.closest("button[data-a]"); if (b) openProfile(b.getAttribute("data-a"), b.getAttribute("data-b")); });
  })();

  // ---- save, share and export: the plan in the page link and this browser, and a scenario JSON that terrain-sims/models/linktable.py builds a mesh-simulator link table from
  var STORE_KEY = "malapert-planner-v1", persistT = 0, applying = false;
  var LORA_IDS = ["sf12_62", "sf12_125", "sf9", "sf7_125", "sf7_500", "l24_7", "l24_5"];
  function r1(v) { return Math.round(v * 10) / 10; }
  function siteState(q, withXY) {
    var o = withXY ? { x: r1(q.x), y: r1(q.y) } : {};
    o.h = q.h; o.ant = q.ant; o.bore = Math.round(q.bore || 0);
    if (q.tilt) { o.tilt = q.tilt; o.tiltAz = q.tiltAz || 0; }
    return o;
  }
  function planState() {
    var P = S.plan, pi = P && !P.drawn ? PLANS.indexOf(P) : -1;
    return {
      v: 1, plan: pi >= 0 ? pi : null, way: P && P.drawn ? P.way.map(function (w) { return [r1(w.x), r1(w.y)]; }) : null,
      base: siteState(S.base, false), relays: S.nodes.map(function (q) { return siteState(q, true); }), relayAnt: S.relayAnt, rx: S.rxMode,
      preset: S.preset, f: r1(S.fMHz), rate: S.rateTarget, fade: S.fade, crew: S.crew.h, ov: S.overlay,
      psr: $("t-psr").checked, route: $("t-route").checked, pat: S.showPat
    };
  }
  function enc(o) {
    var b = new TextEncoder().encode(JSON.stringify(o)), s = "";
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function dec(t) {
    var s = atob(t.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((t.length + 3) % 4)), b = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(b));
  }
  function fromHash() { var m = /[#&]p=([A-Za-z0-9_-]+)/.exec(location.hash); if (!m) return null; try { return dec(m[1]); } catch (e) { return { bad: true }; } }
  function fromStore() { try { var t = localStorage.getItem(STORE_KEY); return t ? JSON.parse(t) : null; } catch (e) { return null; } }
  function persist(now) {
    if (applying) return;
    clearTimeout(persistT);
    var go = function () {
      var st = planState();
      try { history.replaceState(null, "", location.pathname + location.search + "#p=" + enc(st)); } catch (e) { }
      try { localStorage.setItem(STORE_KEY, JSON.stringify(st)); } catch (e) { }
    };
    if (now) go(); else persistT = setTimeout(go, 400);
  }
  function num(v, lo, hi, d) { v = +v; return isFinite(v) && v >= lo && v <= hi ? v : d; }
  function antId(a, d) { return typeof a === "string" && ANTS[a] ? a : d; }
  function applySite(q, o) {
    q.h = num(o.h, 0.5, 30, 1.5); q.ant = antId(o.ant, q.ant); q.bore = ((Math.round(num(o.bore, -720, 720, 0)) % 360) + 360) % 360;
    if (o.tilt) { q.tilt = num(o.tilt, 0, 45, 0); q.tiltAz = num(o.tiltAz, -360, 360, 0); } else { delete q.tilt; delete q.tiltAz; }
  }
  function syncControls() {
    $("preset").value = S.preset; $("freq").value = fToSlider(S.fMHz); $("rate-target").value = String(S.rateTarget); $("budget").value = String(S.fade);
    $("crewh").value = S.crew.h; $("ant-base").value = S.base.ant; $("ant-relay").value = S.relayAnt; $("ant-rx").value = S.rxMode; $("t-pat").checked = S.showPat;
    document.querySelectorAll("input[name=ov]").forEach(function (e) { e.checked = e.value === S.overlay; });
  }
  function applyState(st, run) {
    if (!st || typeof st !== "object" || st.v !== 1) throw new Error("not a version 1 planner state");
    var cut = false;
    applying = true;
    try {
      if (S.drawing) setDrawing(false);
      setPlacing(false); setPicking(false); setProbing(false);
      S.auto = null; S.target = null; S.solo = null; S.sel = null; S.plan = null;
      var way = Array.isArray(st.way) ? st.way.map(function (w) { return { x: +w[0], y: +w[1] }; }).filter(function (w) { return isFinite(w.x) && isFinite(w.y); }) : [];
      if (way.length >= 2) { way.forEach(clampDisk); buildRoute(way); }
      else if (st.plan !== null && st.plan !== undefined && PLANS[+st.plan]) S.plan = PLANS[+st.plan];
      applySite(S.base, st.base || {});
      S.relayAnt = antId(st.relayAnt, "iso");
      var rel = Array.isArray(st.relays) ? st.relays : [];
      cut = rel.length > MAX_RELAYS;
      S.nodes = [];
      rel.slice(0, MAX_RELAYS).forEach(function (o) {
        if (!o || !isFinite(+o.x) || !isFinite(+o.y)) return;
        var q = relay("R" + (S.nodes.length + 1), +o.x, +o.y, 1.5); q.ant = S.relayAnt; applySite(q, o); clampDisk(q); S.nodes.push(q);
      });
      S.seq = S.nodes.length + 1;
      S.rxMode = st.rx === "omni" ? "omni" : "best";
      var p = PRESETS.filter(function (q) { return q.id === st.preset; })[0] || PRESETS.filter(function (q) { return q.id === "sf9"; })[0];
      S.preset = p.id; S.fMHz = p.f || num(st.f, 50, 3500, 433);
      S.rateTarget = [1758, 10000, 100000, 1000000].indexOf(+st.rate) >= 0 ? +st.rate : 1758;
      S.fade = +st.fade === 22.5 ? 22.5 : FADE_STUDY;
      S.crew.h = num(st.crew, 0.5, 5, HR_DEFAULT);
      S.overlay = ["coverage", "slope", "winter", "none"].indexOf(st.ov) >= 0 ? st.ov : "coverage";
      $("t-psr").checked = !!st.psr; $("t-route").checked = st.route !== false; S.showPat = st.pat !== false;
      syncControls();
    } finally { applying = false; }
    fitPlan(); markStale(); renderAll(); renderAnt("Relays", S.relayAnt);
    if (cut) hintShow("Only the first " + MAX_RELAYS + " relays were loaded.", 3500);
    if (run) return simulate();
  }
  function trackTimes(P) {
    var dt = P.dt.map(function (v) { return v * 60; }), t = [0], tot = 0, i;
    for (i = 0; i < dt.length; i++) tot += dt[i];
    for (i = 1; i < dt.length; i++) t.push(t[i - 1] + (dt[i - 1] + dt[i]) / 2);
    var k = t[t.length - 1] > 0 ? tot / t[t.length - 1] : 1;
    return t.map(function (v) { return r1(v * k); });
  }
  function scenario() {
    var P = S.plan, nodes = [], t = P ? trackTimes(P) : null, slug = function (s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""); };
    var site = function (name, q) { var o = { name: name, x: r1(q.x), y: r1(q.y), h: q.h, ant: q.ant, bore: Math.round(q.bore || 0), start_s: 0 }; return o; };
    nodes.push(site("base", S.base));
    S.nodes.forEach(function (q) {
      var o = site(q.id, q);
      if (P && P.deployment !== "static") {
        var bk = -1, bd = 60;
        for (var k = 0; k < P.tx.length; k++) { var d = Math.hypot(P.tx[k] - q.x, P.ty[k] - q.y); if (d < bd) { bd = d; bk = k; } }
        if (bk >= 0) o.start_s = t[bk];
      }
      nodes.push(o);
    });
    if (P) nodes.push({ name: "crew", h: S.crew.h, ant: "iso", start_s: 0, track: { t: t, x: P.tx.map(r1), y: P.ty.map(r1) } });
    return {
      name: slug((P ? P.name : "placement") + " " + S.preset), preset: S.preset, step_s: 10, omni_listen: S.rxMode === "omni", nodes: nodes,
      note: "Malapert Node Planner export. Build a mesh-simulator link table with terrain-sims: python -B -m models.linktable <this file> -o <table>. Map coordinates in meters, y north; bearings clockwise from north. " +
        (LORA_IDS.indexOf(S.preset) < 0 ? "The link table supports LoRa presets only; this plan uses " + S.preset + ". " : "") +
        "Relays within 60 m of the route switch on when the crew reaches them" + (P && P.deployment === "static" ? " (not for this plan: its relays are placed beforehand)" : "") + ".",
      exported: new Date().toISOString(), planner: planState()
    };
  }
  function fromScenario(o) {
    var nd = o.nodes, b = nd[0] || {}, rel = [], way = null, crew = HR_DEFAULT;
    nd.slice(1).forEach(function (q) {
      if (q && q.track && Array.isArray(q.track.x)) {
        if (!way) { var n = q.track.x.length, step = Math.max(1, Math.ceil(n / 200)); way = []; for (var i = 0; i < n; i += step) way.push([q.track.x[i], q.track.y[i]]); way.push([q.track.x[n - 1], q.track.y[n - 1]]); crew = q.h || crew; }
      } else if (q) rel.push({ x: q.x, y: q.y, h: q.h, ant: q.ant, bore: q.bore });
    });
    return { v: 1, plan: null, way: way, base: { h: b.h, ant: b.ant, bore: b.bore }, relays: rel, relayAnt: "iso", rx: o.omni_listen ? "omni" : "best", preset: o.preset || "sf9", fade: FADE_STUDY, crew: crew };
  }
  function importText(text) {
    var o = JSON.parse(text);
    var st = o && o.v === 1 ? o : o && o.planner && o.planner.v === 1 ? o.planner : o && Array.isArray(o.nodes) ? fromScenario(o) : null;
    if (!st) throw new Error("the file has no planner state and no scenario nodes");
    return applyState(st, true);
  }
  function jsonText(o) {
    return JSON.stringify(o, null, 1).replace(/\[\s+([-\d.,\s]+?)\s+\]/g, function (m, inner) { return "[" + inner.replace(/\s+/g, "") + "]"; }) + "\n";
  }
  function exportJSON() {
    var sc = scenario(), a = document.createElement("a"), url = URL.createObjectURL(new Blob([jsonText(sc)], { type: "application/json" }));
    a.href = url; a.download = "malapert-" + sc.name + ".json"; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 0);
    hintShow("Exported " + a.download, 2500);
  }
  function copyLink() {
    persist(true);
    var url = location.href, done = function () { hintShow(location.protocol === "file:" ? "Link copied. A file link opens only on this computer; to share, use Export." : "Link copied.", 3000); };
    var fallback = function () { window.prompt("Copy this link:", url); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, fallback); else fallback();
  }
  (function () {
    $("copylink").addEventListener("click", copyLink);
    $("export").addEventListener("click", exportJSON);
    $("import").addEventListener("click", function () { $("importf").value = ""; $("importf").click(); });
    $("importf").addEventListener("change", function () {
      var f = $("importf").files[0]; if (!f) return;
      f.text().then(importText).then(function () { hintShow("Loaded " + f.name, 2500); }).catch(function (e) { hintShow("Could not load " + f.name + ": " + e.message, 5000); });
    });
    $("reset").addEventListener("click", function () {
      clearTimeout(persistT); applying = true;
      try { localStorage.removeItem(STORE_KEY); } catch (e) { }
      location.replace(location.pathname + location.search);
    });
    window.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (S.probing) setProbing(false); else if (S.prof && !S.placing && !S.drawing && !S.picking) closeProfile();
    });
    window.addEventListener("resize", function () { if (S.profData && !$("prof").hidden) { $("wrap").style.setProperty("--prof-h", $("prof").offsetHeight + "px"); drawProfile(); } });
    window.addEventListener("hashchange", function () { var st = fromHash(); if (st && !st.bad) { try { applyState(st, true); } catch (e) { hintShow("The plan in this link could not be read.", 4000); } } });
  })();

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
    S.nodes = P ? P.nodes.map(function (q, k) { return relay("R" + (k + 1), q[0], q[1], 1.5); }) : [];
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
  $("ant-rx").addEventListener("change", function () { S.rxMode = $("ant-rx").value; markStale(); });
  $("ant-base").addEventListener("change", function () { S.base.ant = $("ant-base").value; markStale(); renderNodes(); renderLegend(); renderAnt("Base", S.base.ant); });
  $("ant-relay").addEventListener("change", function () { S.relayAnt = $("ant-relay").value; S.nodes.forEach(function (q) { q.ant = S.relayAnt; }); markStale(); renderNodes(); renderLegend(); renderAnt("Relays", S.relayAnt); });
  $("aim").addEventListener("click", function () { if (S.busy) { hintShow("A run is still going. Try again when it finishes.", 2500); return; } aimAll(true); });
  $("t-pat").addEventListener("change", function () { S.showPat = $("t-pat").checked; renderLegend(); draw(); persist(); });
  document.querySelectorAll("input[name=ov]").forEach(function (e) { e.addEventListener("change", function () { S.overlay = e.value; renderLegend(); draw(); persist(); }); });
  $("t-psr").addEventListener("change", function () { renderLegend(); draw(); persist(); });
  $("t-route").addEventListener("change", function () { renderLegend(); draw(); persist(); });
  $("preset").addEventListener("change", function () {
    S.preset = $("preset").value;
    var p = PRESETS.filter(function (q) { return q.id === S.preset; })[0];
    if (p.f) { S.fMHz = p.f; $("freq").value = fToSlider(p.f); }
    renderValid(); markStale();
  });
  $("freq").addEventListener("input", function () { S.fMHz = sliderToF(+$("freq").value); S.preset = "free"; $("preset").value = "free"; renderValid(); markStale(); });
  $("rate-target").addEventListener("change", function () { S.rateTarget = +$("rate-target").value; renderValid(); markStale(); });
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
  antOptions($("ant-base")); antOptions($("ant-relay"));
  $("ant-base").value = S.base.ant; $("ant-relay").value = S.relayAnt; renderAnt();
  $("freq").value = fToSlider(433);
  resize();
  var firstPlan = PLANS.findIndex(function (p) { return p.case === "c2" && p.budget === "141"; });
  var pv = new Image(); pv.onload = function () { if (!overview) { overview = pv; draw(); } }; pv.src = META.preview;
  var saved = fromHash(), restored = false;
  if (saved && saved.bad) { saved = null; hintShow("The plan in this link could not be read, so the default plan is shown.", 5000); }
  else if (!saved) saved = fromStore();
  if (saved) { try { applyState(saved, false); restored = true; } catch (e) { hintShow("The saved plan could not be loaded: " + e.message, 5000); } }
  if (!restored) loadPlan(String(firstPlan), false);
  var ovw = new Image(); ovw.onload = function () { overview = ovw; draw(); }; ovw.src = "data/hill_overview.webp";
  loadData().then(function () {
    renderNodes(); draw();
    var tiltAt = function (x, y) { var d = 20, gx = (ter.sample(x + d, y) - ter.sample(x - d, y)) / (2 * d), gy = (ter.sample(x, y + d) - ter.sample(x, y - d)) / (2 * d), b = Math.atan2(-gx, -gy) * 180 / Math.PI; return { t: Math.atan(Math.hypot(gx, gy)) * 180 / Math.PI, ta: b < 0 ? b + 360 : b }; };
    window.malapert = { tiltAt: tiltAt, S: S, simulate: simulate, autoPlan: autoPlan, buildRoute: buildRoute, loadPlan: loadPlan, view: view, aimAll: aimAll, ANTS: ANTS, renderAll: renderAll, renderAnt: renderAnt,
      openProfile: openProfile, closeProfile: closeProfile, profile: function () { return S.profData; }, hitLink: hitLink, toScreen: function (x, y) { return { x: sx(x), y: sy(y) }; },
      planState: planState, scenario: scenario, applyState: applyState, importText: importText, enc: enc, dec: dec };
    return simulate();
  }).catch(function (e) {
    setChip("Not loaded", "stale"); $("stat").textContent = "";
    banner("The planner could not start: " + e.message + ". Reload the page to try again.");
  });
})();
