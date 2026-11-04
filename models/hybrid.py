"""R2 hybrid lunar path loss (P.526 plus rounded hull runs and a terminal image term) and its DEM link wrapper.

References:
- ITU-R P.526-16 (11/2025), "Propagation by diffraction": sec. 4.5 general method (line-of-sight paths and floor);
  sec. 4.4 eq. (44) stretched string; sec. 4.2 eq. (32) to (38) rounded obstacle T(m, n) and the parabola fitted
  near the top; Attachment 1 to Annex 1 eq. (122) to (123) run radius from length over turning angle.
- Regolith constants as in p526.py.
"""
import math

import numpy as np
from scipy.spatial import ConvexHull, QhullError

from .p526 import C0, F433, J, R_MOON, REGOLITH_EPS, p526_general, regolith_sigma

GAP = 200.0
LMIN = 30.0
RMAX = 20000.0
Q = 0.5


def _upper_hull_chain(x, y):
    h = []
    for i in range(x.size):
        while len(h) >= 2:
            i1, i2 = h[-2], h[-1]
            if (x[i2] - x[i1]) * (y[i] - y[i1]) - (y[i2] - y[i1]) * (x[i] - x[i1]) >= 0:
                h.pop()
            else:
                break
        h.append(i)
    return h


def upper_hull(x, y):
    n = x.size
    if n < 3:
        return list(range(n))
    xs = (x - x[0]) / max(x[-1] - x[0], 1e-9)
    ys = (y - y.min()) / max(y.max() - y.min(), 1e-9)
    try:
        v = list(ConvexHull(np.column_stack([xs, ys])).vertices)
    except (QhullError, ValueError):
        return _upper_hull_chain(x, y)
    if (n - 1) not in v or 0 not in v:
        return _upper_hull_chain(x, y)
    k = v.index(n - 1)
    v = v[k:] + v[:k]
    return v[:v.index(0) + 1][::-1]


def hull_runs(d, y):
    hv = np.array(upper_hull(d, y))
    if hv.size <= 2:
        return []
    s = np.diff(y[hv]) / np.diff(d[hv])
    turn = s[:-1] - s[1:]
    inner = hv[1:-1]
    groups, cur = [], [0]
    for j in range(1, inner.size):
        if d[inner[j]] - d[inner[j - 1]] <= GAP:
            cur.append(j)
        else:
            groups.append(cur)
            cur = [j]
    groups.append(cur)
    out = []
    for g in groups:
        th = float(turn[g].sum())
        i0, i1 = int(inner[g[0]]), int(inner[g[-1]])
        ln = float(d[i1] - d[i0])
        out.append(dict(th=th, l=ln, R=max(ln, LMIN) / max(th, 1e-12), dc=0.5 * (d[i0] + d[i1]), i0=i0, i1=i1))
    return out


def T_mn(m, n):
    m = np.asarray(m, float)
    n = np.asarray(n, float)
    mn = m * n
    sm = np.sqrt(np.maximum(m, 0))
    a = 7.2 * sm - (2 - 12.5 * n) * m + 3.6 * m ** 1.5 - 0.8 * m ** 2
    b = -6 - 20 * np.log10(np.maximum(mn, 1e-30)) + 7.2 * sm - (2 - 17 * n) * m + 3.6 * m ** 1.5 - 0.8 * m ** 2
    return np.where(mn <= 4, a, b)


def run_T(run, D, lam, dth=0.0):
    th = run["th"] + dth
    if th <= 0:
        return 0.0
    d1 = max(run["dc"], 1.0)
    d2 = max(D - run["dc"], 1.0)
    R = min(run["R"], RMAX)
    k3 = (math.pi * R / lam) ** (1 / 3)
    m = R * (d1 + d2) / (d1 * d2) / k3
    n = th * k3 / m
    return max(float(T_mn(m, n)), 0.0)


def _prefix_moments(x, y, kmax_x=4, kmax_xy=2):
    z0 = np.zeros((x.shape[0], 1))
    cx = [np.concatenate([z0, np.cumsum(x ** kk, axis=1)], axis=1) for kk in range(kmax_x + 1)]
    cy = [np.concatenate([z0, np.cumsum(y * x ** kk, axis=1)], axis=1) for kk in range(kmax_xy + 1)]
    return cx, cy


def _win(c, i0, i1):
    return np.take_along_axis(c, (i1 + 1)[:, None], 1)[:, 0] - np.take_along_axis(c, i0[:, None], 1)[:, 0]


def _parabola_radius(d, ze, i0, i1, ic):
    xc = d - np.take_along_axis(d, ic[:, None], 1)
    cx, cy = _prefix_moments(xc, ze)
    S = [_win(c, i0, i1) for c in cx]
    Y = [_win(c, i0, i1) for c in cy]
    A = np.stack([np.stack([S[0], S[1], S[2]], -1), np.stack([S[1], S[2], S[3]], -1),
                  np.stack([S[2], S[3], S[4]], -1)], -2)
    b = np.stack(Y, -1)
    ok = (i1 - i0) >= 2
    A[~ok] = np.eye(3)
    coef = np.linalg.solve(A, b[..., None])[..., 0]
    c2 = np.where(ok, coef[:, 2], 0.0)
    return np.where(c2 < 0, -1.0 / (2 * np.minimum(c2, -1e-30)), np.inf)


def parabola_radius(d, ze, ic, w):
    N = d.shape[1]
    step = d[:, 1] - d[:, 0]
    nw = np.maximum(1, np.round(0.5 * w / step).astype(int))
    return _parabola_radius(d, ze, np.clip(ic - nw, 0, N - 1), np.clip(ic + nw, 0, N - 1), ic)


def parabola_radius_range(d, ze, i0, i1):
    return _parabola_radius(d, ze, i0, i1, i0)


def foreground_line(d, ze, i_end, from_end=False):
    M, N = d.shape
    cx, cy = _prefix_moments(d, ze, kmax_x=2, kmax_xy=1)
    if from_end:
        i0, i1 = i_end, np.full(M, N - 1)
    else:
        i0, i1 = np.zeros(M, int), i_end
    n = _win(cx[0], i0, i1)
    sx, sxx = _win(cx[1], i0, i1), _win(cx[2], i0, i1)
    sy, sxy = _win(cy[0], i0, i1), _win(cy[1], i0, i1)
    den = n * sxx - sx ** 2
    ok = (n >= 2) & (np.abs(den) > 1e-9)
    slope = np.where(ok, (n * sxy - sx * sy) / np.where(ok, den, 1.0), 0.0)
    icpt = (sy - slope * sx) / np.maximum(n, 1)
    d_term = d[:, -1] if from_end else d[:, 0]
    d_hor = np.take_along_axis(d, i_end[:, None], 1)[:, 0]
    return icpt + slope * d_term, icpt + slope * d_hor


def gamma_v(psi, eps, sig, f_hz):
    ec = eps - 1j * 60.0 * sig * (C0 / f_hz)
    s = np.sin(psi)
    rt = np.sqrt(ec - np.cos(psi) ** 2)
    return (ec * s - rt) / (ec * s + rt)


@np.errstate(all="ignore")
def hybrid_loss(z, d, D, h_tx, h_rx, f_hz=F433, ae=R_MOON, eps=REGOLITH_EPS, sig=None):
    if sig is None:
        sig = regolith_sigma(f_hz)
    lam = C0 / f_hz
    k = 2 * math.pi / lam
    z = np.asarray(z, float)
    d = np.asarray(d, float)
    D = np.asarray(D, float)
    M, N = z.shape
    Ld, det, ex = p526_general(z, d, D, h_tx, h_rx, f_hz, ae, eps, sig)
    fspl = ex["fspl"]
    L526 = fspl + Ld
    los = det["los"]
    dif = ~los
    hts, hrs = ex["hts"], ex["hrs"]
    vb = np.where(dif, det["vb"], 0.0)
    th = np.where(dif, det["Stim"] + det["Srim"], 0.0)
    ze = z + d * (D[:, None] - d) / (2 * ae)
    it = det["itim"].astype(int)
    ir = det["irim"].astype(int)
    A_knife = J(vb)
    a1g = np.maximum(np.take_along_axis(d, it[:, None], 1)[:, 0], 1.0)
    a2g = np.maximum(D - np.take_along_axis(d, ir[:, None], 1)[:, 0], 1.0)

    runs_of = {}
    T = np.zeros(M)
    for i in np.where(dif)[0]:
        y = ze[i].copy()
        y[0], y[-1] = hts[i], hrs[i]
        runs = hull_runs(d[i], y)
        for r in runs:
            if r["l"] < LMIN:
                ic = np.array([(r["i0"] + r["i1"]) // 2])
                r["R"] = min(r["R"], float(parabola_radius(d[i:i + 1], ze[i:i + 1], ic, 2 * LMIN)[0]))
        runs_of[i] = runs
        T[i] = sum(run_T(r, D[i], lam) for r in runs)
    A_obs = np.where(dif, A_knife + T, det["Luc"])

    A_t = {}
    for side in ("tx", "rx"):
        if side == "tx":
            ih, ant, a = it, hts, a1g
            l_term, l_hor = foreground_line(d, ze, ih)
            Rf = parabola_radius_range(d, ze, np.zeros(M, int), ih)
        else:
            ih, ant, a = ir, hrs, a2g
            l_term, l_hor = foreground_line(d, ze, ih, from_end=True)
            Rf = parabola_radius_range(d, ze, ih, np.full(M, N - 1))
        hp = np.maximum(ant - l_term, 0.05)
        he = np.take_along_axis(ze, ih[:, None], 1)[:, 0] - l_hor
        dth = 2 * hp / a
        psi = np.maximum((hp + he) / a, 0.0)
        s = np.where(th > 0, (th + dth) / np.maximum(th, 1e-12), 1.0)
        dJ = J(vb * s) - A_knife
        Ai = A_obs.copy()
        Radj = np.full(M, np.inf)
        for i, runs in runs_of.items():
            if not runs:
                continue
            r0 = runs[0] if side == "tx" else runs[-1]
            Ai[i] = A_obs[i] + dJ[i] + run_T(r0, D[i], lam, dth[i]) - run_T(r0, D[i], lam)
            Radj[i] = r0["R"]
        r = 10 ** (-(np.where(dif, Ai, A_obs) - A_obs) / 20)
        wgt = np.where(np.isfinite(Radj), np.clip(1 - Radj / Rf, 0.0, 1.0), 1.0)
        g = gamma_v(psi, eps, sig, f_hz) * r * wgt
        phi = k * 2 * hp * np.maximum(he, 0) / a
        qa = Q * phi
        sinc = np.where(qa > 1e-9, np.sin(qa) / np.where(qa > 1e-9, qa, 1.0), 1.0)
        P = 1 + np.abs(g) ** 2 + 2 * np.real(g * np.exp(-1j * phi)) * sinc
        A_t[side] = np.where(dif & (th > 0), -10 * np.log10(np.maximum(P, 1e-20)), 0.0)

    L = np.where(dif, np.maximum(L526, fspl + A_obs + A_t["tx"] + A_t["rx"]), L526)
    return L, dict(L526=L526, fspl=fspl, los=los, theta=th, A_obs=A_obs, T=T, A_tx=A_t["tx"], A_rx=A_t["rx"])


def sample(dem, cell, x, y):
    nr, nc = dem.shape
    c = x / cell - 0.5
    r = y / cell - 0.5
    c0 = np.clip(np.floor(c).astype(np.int64), 0, nc - 2)
    r0 = np.clip(np.floor(r).astype(np.int64), 0, nr - 2)
    fc = c - c0
    fr = r - r0
    top = (1 - fc) * dem[r0, c0] + fc * dem[r0, c0 + 1]
    bot = (1 - fc) * dem[r0 + 1, c0] + fc * dem[r0 + 1, c0 + 1]
    return (1 - fr) * top + fr * bot


def profiles(dem, cell, x1, y1, x2, y2, step, scale=1.0):
    x2 = np.atleast_1d(np.asarray(x2, float))
    y2 = np.atleast_1d(np.asarray(y2, float))
    dm = np.hypot(x2 - x1, y2 - y1)
    N = max(3, int(math.ceil(dm.max() / step)) + 1)
    t = np.linspace(0.0, 1.0, N)
    z = sample(dem, cell, x1 + (x2 - x1)[:, None] * t, y1 + (y2 - y1)[:, None] * t).astype(np.float64)
    D = dm / scale
    return z, D[:, None] * t, D


def link_loss(dem, cell, x1, y1, x2, y2, h_tx, h_rx, step=None, f_hz=F433, scale=1.0):
    z, d, D = profiles(dem, cell, float(x1), float(y1), float(x2), float(y2), step or cell, scale)
    return float(hybrid_loss(z, d, D, h_tx, h_rx, f_hz)[0][0])
