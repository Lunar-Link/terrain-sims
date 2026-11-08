"""433 MHz antenna patterns from the planner's antennas.json and their use on terrain links, as in routing-website/src/engine.js and page.js.

Patterns are free-space gain on a 2 degree grid, az clockwise from boresight seen from above, el from the horizon. On a link the
gain is read at the ray's take-off elevation at each end: the horizon slope on diffracted paths and the direct ray on line of
sight, both in Bullington's curvature frame (study rule 6.4.2). Switched and phased arrays take their best beam state unless a
state is given. Bearings are in map coordinates, clockwise from north (+y); `link` takes DEM coordinates (y along rows, so north
is -y) like hybrid.link_loss.
"""
import json
import math
import os

import numpy as np

from .hybrid import hybrid_loss, profiles
from .p526 import C0, F433, R_MOON, bullington

PATTERNS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "routing-website", "data", "antennas.json")
BEAMS = {"switched": 6, "phased": 16}
SUIT_DB = -6.0
DEG = 180.0 / math.pi


class Antenna:
    def __init__(self, spec, az_step, el_step, el_min, quantized=False):
        self.id = spec["id"]
        self.meta = {k: v for k, v in spec.items() if k != "g"}
        g = np.asarray(spec["g"], float)
        self.g = np.clip(np.round(4 * g), -128, 127) / 4 if quantized else g
        self.nel, self.naz = self.g.shape
        self.az_step, self.el_step, self.el_min = float(az_step), float(el_step), float(el_min)
        self.beams = BEAMS.get(spec.get("family"), 1)
        self.omni_id = spec.get("omni_id")
        self.iso = self.id == "iso"
        self.el = self.el_min + self.el_step * np.arange(self.nel)

    def __repr__(self):
        return f"Antenna({self.id!r}, peak {self.meta.get('peak_dbi')} dBi, {self.beams} beam{'s' if self.beams > 1 else ''})"

    def raw(self, az, el):
        az, el = np.broadcast_arrays(np.asarray(az, float), np.asarray(el, float))
        fa = np.mod(az, 360.0) / self.az_step
        fe = (el - self.el_min) / self.el_step
        a0 = np.floor(fa).astype(int)
        ta = fa - a0
        e0 = np.floor(fe).astype(int)
        te = fe - e0
        lo, hi = e0 < 0, e0 >= self.nel - 1
        e0 = np.where(lo, 0, np.where(hi, self.nel - 2, e0))
        te = np.where(lo, 0.0, np.where(hi, 1.0, te))
        a0 %= self.naz
        a1 = (a0 + 1) % self.naz
        g = self.g
        return (1 - te) * ((1 - ta) * g[e0, a0] + ta * g[e0, a1]) + te * ((1 - ta) * g[e0 + 1, a0] + ta * g[e0 + 1, a1])

    def gain(self, az, el, state=None):
        if self.iso:
            return np.zeros(np.broadcast(np.asarray(az), np.asarray(el)).shape)
        az = np.asarray(az, float)
        if self.beams == 1:
            return self.raw(az, el)
        st = 360.0 / self.beams
        if state is not None:
            return self.raw(az - state * st, el)
        return np.max([self.raw(az - k * st, el) for k in range(self.beams)], axis=0)

    def best_state(self, az, el=0.0):
        if self.beams == 1:
            return 0
        st = 360.0 / self.beams
        return int(np.argmax([float(self.raw(az - k * st, el)) for k in range(self.beams)]))

    def gain_tilted(self, az, el, tilt, tilt_az, bore=0.0, state=None):
        if self.iso:
            return np.zeros(np.broadcast(np.asarray(az), np.asarray(el)).shape)
        x, y, z = tilt_frame(tilt, tilt_az)
        b = np.radians(np.asarray(az, float) + bore)
        e = np.radians(np.asarray(el, float))
        d = np.stack(np.broadcast_arrays(np.sin(b) * np.cos(e), np.cos(b) * np.cos(e), np.sin(e)), axis=-1)
        dx, dy, dz = d @ x, d @ y, d @ z
        return self.gain(np.degrees(np.arctan2(dx, dy)) - bore, np.degrees(np.arcsin(np.clip(dz, -1, 1))), state)

    def horizon(self, el=0.0):
        az = np.arange(0.0, 360.0, self.az_step)
        return az, self.gain(az, el)


def tilt_frame(t, ta):
    tr, ar = math.radians(t), math.radians(ta)
    h = (math.sin(ar), math.cos(ar))
    z = np.array([math.sin(tr) * h[0], math.sin(tr) * h[1], math.cos(tr)])
    y = np.array([-z[1] * z[0], 1 - z[1] * z[1], -z[1] * z[2]])
    y /= np.linalg.norm(y)
    return np.cross(y, z), y, z


def constant(aid, dbi, label, path=None):
    lib = load(path)
    ref = lib["iso"]
    spec = dict(id=aid, label=label, family="omni", peak_dbi=dbi, horizon_min_dbi=dbi, fb_db=0.0,
                g=np.full((ref.nel, ref.naz), float(dbi)))
    return Antenna(spec, ref.az_step, ref.el_step, ref.el_min)


_LIB = {}


def load(path=None, quantized=False):
    key = (os.path.abspath(path or PATTERNS), quantized)
    if key not in _LIB:
        with open(key[0], encoding="utf-8") as f:
            data = json.load(f)
        lib = {a["id"]: Antenna(a, data["az_step"], data["el_step"], data["el_min"], quantized) for a in data["antennas"]}
        _LIB[key] = lib
        if "suit" not in lib:
            lib["suit"] = constant("suit", SUIT_DB, f"Crew suit antenna, flat {SUIT_DB:g} dBi (study robustness case)", path)
    return _LIB[key]


def get(aid, path=None, quantized=False):
    return aid if isinstance(aid, Antenna) else load(path, quantized)[aid]


def ids(path=None):
    return list(load(path))


def receive_id(aid, omni_listen=False):
    a = get(aid)
    return (a.omni_id or "dipole") if omni_listen and a.beams > 1 else a.id


def plan_rows(aid, omni_listen=False):
    a = get(aid)
    n = a.nel
    hop, cov, front = np.zeros(n), np.zeros(n), np.zeros(n)
    if a.iso:
        return dict(el=a.el, hop=hop, cov=cov, front=front)
    az = np.arange(0.0, 360.0, 2.0)
    for e, el in enumerate(a.el):
        mn = float(np.min(a.gain(az, el)))
        cov[e] = mn
        front[e] = mn if a.beams > 1 else float(a.gain(0.0, el))
        hop[e] = mn if a.beams > 1 else min(float(a.gain(0.0, el)), float(a.gain(180.0, el)))
        if omni_listen and a.beams > 1:
            dg = float(get(receive_id(aid, True)).gain(0.0, el))
            cov[e] = min(mn, dg)
            front[e] = hop[e] = (mn + dg) / 2
    return dict(el=a.el, hop=hop, cov=cov, front=front)


def bearing(x1, y1, x2, y2):
    return math.degrees(math.atan2(x2 - x1, y2 - y1)) % 360.0


def takeoff(z, d, D, h_tx, h_rx, f_hz=F433, ae=R_MOON):
    z = np.asarray(z, float)
    d = np.asarray(d, float)
    D = np.asarray(D, float)
    hts, hrs = z[:, 0] + h_tx, z[:, -1] + h_rx
    _, det = bullington(z, d, D, hts, hrs, C0 / f_hz, ae)
    cvv = D / (2 * ae)
    s0 = (hrs - hts) / D
    los = det["los"]
    el_tx = np.degrees(np.arctan(np.where(los, s0 - cvv, det["Stim"] - cvv)))
    el_rx = np.degrees(np.arctan(np.where(los, -s0 - cvv, det["Srim"] - cvv)))
    return el_tx, el_rx, los


def _site_gain(a, brg, el, bore, state, tilt):
    if tilt:
        return float(a.gain_tilted(brg - bore, el, tilt[0], tilt[1], bore, state))
    return float(a.gain(brg - bore, el, state))


def link(dem, cell, x1, y1, x2, y2, h_tx, h_rx, ant_tx="iso", ant_rx="iso", bore_tx=0.0, bore_rx=0.0, state_tx=None,
         state_rx=None, tilt_tx=None, tilt_rx=None, omni_listen=False, step=None, f_hz=F433, scale=1.0):
    z, d, D = profiles(dem, cell, float(x1), float(y1), float(x2), float(y2), step or cell, scale)
    path_db = float(hybrid_loss(z, d, D, h_tx, h_rx, f_hz)[0][0])
    el_tx, el_rx, los = takeoff(z, d, D, h_tx, h_rx, f_hz)
    brg_tx = bearing(x1, -y1, x2, -y2)
    brg_rx = (brg_tx + 180.0) % 360.0
    a_tx = get(ant_tx)
    a_rx = get(receive_id(ant_rx, omni_listen))
    g_tx = _site_gain(a_tx, brg_tx, float(el_tx[0]), bore_tx, state_tx, tilt_tx)
    g_rx = _site_gain(a_rx, brg_rx, float(el_rx[0]), bore_rx, state_rx, tilt_rx)
    return dict(loss_db=path_db - g_tx - g_rx, path_db=path_db, g_tx=g_tx, g_rx=g_rx, el_tx=float(el_tx[0]),
                el_rx=float(el_rx[0]), brg_tx=brg_tx, brg_rx=brg_rx, los=bool(los[0]))
