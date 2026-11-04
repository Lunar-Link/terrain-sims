"""ITU-R P.526 diffraction loss on terrain profiles (Bullington knife edge plus smooth-sphere term) with lunar constants.

References:
- ITU-R P.526-16 (11/2025), "Propagation by diffraction": eq. (31) knife-edge loss J(v); sec. 3.1.1 and 3.2
  smooth spherical earth; sec. 4.5.1 Bullington construction; sec. 4.5.2 complete general method.
- Regolith eps_r 2.5: Dong et al. (2021), "Properties of Lunar Regolith on the Moon's Farside Unveiled by Chang'E-4
  Lunar Penetrating Radar", JGR Planets 126(6); Li et al. (2022), "The Lunar Regolith Structure and Electromagnetic
  Properties of Chang'E-5 Landing Site", Remote Sensing 14(18), 4539.
- Regolith loss tangent 0.004: Feng, Siegler and White (2022), "Dielectric properties and stratigraphy of regolith in
  the lunar South Pole-Aitken basin: Observations from the Lunar Penetrating Radar", A&A, arXiv:2203.02840.
"""
import math

import numpy as np

C0 = 299_792_458.0
EPS0 = 8.8541878128e-12
R_MOON = 1_737_400.0
F433 = 433.0e6
REGOLITH_EPS = 2.5
REGOLITH_TAN_D = 0.004


def regolith_sigma(f_hz):
    return 2 * math.pi * f_hz * EPS0 * REGOLITH_EPS * REGOLITH_TAN_D


def fspl_db(r, f_hz=F433):
    return 20 * np.log10(4 * np.pi * np.asarray(r, float) / (C0 / f_hz))


def J(v):
    v = np.asarray(v, dtype=float)
    out = 6.9 + 20 * np.log10(np.sqrt((v - 0.1) ** 2 + 1) + v - 0.1)
    return np.where(v > -0.78, out, 0.0)


def bullington(z, d, D, hts, hrs, lam, ae):
    zi, di = z[:, 1:-1], d[:, 1:-1]
    Dc = D[:, None]
    ze = zi + di * (Dc - di) / (2 * ae)
    s_t = (ze - hts[:, None]) / di
    itim = np.argmax(s_t, axis=1)
    Stim = np.take_along_axis(s_t, itim[:, None], 1)[:, 0]
    Str = (hrs - hts) / D
    hl = (hts[:, None] * (Dc - di) + hrs[:, None] * di) / Dc
    v = (ze - hl) * np.sqrt(2 * Dc / (lam * di * (Dc - di)))
    imax = np.argmax(v, axis=1)
    vmax = np.take_along_axis(v, imax[:, None], 1)[:, 0]
    s_r = (ze - hrs[:, None]) / (Dc - di)
    irim = np.argmax(s_r, axis=1)
    Srim = np.take_along_axis(s_r, irim[:, None], 1)[:, 0]
    los = Stim < Str
    den = np.where(los, 1.0, np.maximum(Stim + Srim, 1e-12))
    db = np.clip((hrs - hts + Srim * D) / den, 1e-3, D - 1e-3)
    vb = (hts + Stim * db - (hts * (D - db) + hrs * db) / D) * np.sqrt(2 * D / (lam * db * (D - db)))
    Luc = np.where(los, J(vmax), J(vb))
    Lb = Luc + (1 - np.exp(-Luc / 6)) * (10 + 0.02 * D / 1000)
    det = dict(los=los, vmax=vmax, imax=imax + 1, itim=itim + 1, irim=irim + 1, Stim=Stim,
               Srim=Srim, db=np.where(los, np.nan, db), vb=np.where(los, np.nan, vb), Luc=Luc)
    return Lb, det


def _first_term(d, h1, h2, ae, f_hz, eps, sig):
    f = f_hz / 1e6
    ae_km = ae / 1000
    KH = 0.36 * (ae_km * f) ** (-1 / 3) * ((eps - 1) ** 2 + (18000 * sig / f) ** 2) ** (-0.25)
    K = KH * np.sqrt(eps ** 2 + (18000 * sig / f) ** 2)
    beta = (1 + 1.6 * K ** 2 + 0.67 * K ** 4) / (1 + 4.5 * K ** 2 + 1.53 * K ** 4)
    X = 2.188 * beta * f ** (1 / 3) * ae_km ** (-2 / 3) * (d / 1000)
    F = np.where(X >= 1.6, 11 + 10 * np.log10(X) - 17.6 * X, -20 * np.log10(X) - 5.6488 * X ** 1.425)

    def G(h):
        Y = 9.575e-3 * beta * f ** (2 / 3) * ae_km ** (-1 / 3) * h
        B = beta * Y
        g = np.where(B > 2, 17.6 * np.sqrt(np.maximum(B - 1.1, 1e-9)) - 5 * np.log10(np.maximum(B - 1.1, 1e-9)) - 8,
                     20 * np.log10(B + 0.1 * B ** 3))
        return np.maximum(g, 2 + 20 * np.log10(K))
    return F + G(h1) + G(h2)


def sph_earth(d, h1, h2, ae, lam, f_hz, eps, sig):
    d, h1, h2 = (np.asarray(a, dtype=float) for a in (d, h1, h2))
    dlos = np.sqrt(2 * ae) * (np.sqrt(h1) + np.sqrt(h2))
    A_beyond = -_first_term(d, h1, h2, ae, f_hz, eps, sig)
    c = (h1 - h2) / (h1 + h2)
    m = d ** 2 / (4 * ae * (h1 + h2))
    arg = np.clip(1.5 * c * np.sqrt(3 * m / (m + 1) ** 3), -1, 1)
    b = 2 * np.sqrt((m + 1) / (3 * m)) * np.cos(np.pi / 3 + np.arccos(arg) / 3)
    d1 = d / 2 * (1 + b)
    d2 = d - d1
    hc = ((h1 - d1 ** 2 / (2 * ae)) * d2 + (h2 - d2 ** 2 / (2 * ae)) * d1) / d
    hreq = 0.552 * np.sqrt(np.maximum(d1 * d2, 0) * lam / d)
    aem = 0.5 * (d / (np.sqrt(h1) + np.sqrt(h2))) ** 2
    Ah = -_first_term(d, h1, h2, aem, f_hz, eps, sig)
    A_within = np.where(hc > hreq, 0.0, np.where(Ah < 0, 0.0, (1 - hc / hreq) * Ah))
    return np.where(d >= dlos, A_beyond, A_within)


@np.errstate(all="ignore")
def p526_general(z, d, D, h_tx, h_rx, f_hz=F433, ae=R_MOON, eps=REGOLITH_EPS, sig=None):
    if sig is None:
        sig = regolith_sigma(f_hz)
    z = np.asarray(z, float)
    d = np.asarray(d, float)
    D = np.asarray(D, float)
    lam = C0 / f_hz
    hts = z[:, 0] + h_tx
    hrs = z[:, -1] + h_rx
    Lba, det = bullington(z, d, D, hts, hrs, lam, ae)
    dd = np.diff(d, axis=1)
    v1 = np.sum(dd * (z[:, 1:] + z[:, :-1]), axis=1)
    v2 = np.sum(dd * (z[:, 1:] * (2 * d[:, 1:] + d[:, :-1]) + z[:, :-1] * (d[:, 1:] + 2 * d[:, :-1])), axis=1)
    hstip = (2 * v1 * D - v2) / D ** 2
    hsrip = (v2 - v1 * D) / D ** 2
    zi, di, Dc = z[:, 1:-1], d[:, 1:-1], D[:, None]
    hobi = zi - (hts[:, None] * (Dc - di) + hrs[:, None] * di) / Dc
    hobs = hobi.max(axis=1)
    aobt = (hobi / di).max(axis=1)
    aobr = (hobi / (Dc - di)).max(axis=1)
    pos = hobs > 0
    den = np.where(pos, aobt + aobr, 1.0)
    hstp = np.where(pos, hstip - hobs * aobt / den, hstip)
    hsrp = np.where(pos, hsrip - hobs * aobr / den, hsrip)
    hst = np.minimum(hstp, z[:, 0])
    hsr = np.minimum(hsrp, z[:, -1])
    htse, hrse = hts - hst, hrs - hsr
    Lbs, _ = bullington(np.zeros_like(z), d, D, htse, hrse, lam, ae)
    Lsph = sph_earth(D, htse, hrse, ae, lam, f_hz, eps, sig)
    L = Lba + np.maximum(Lsph - Lbs, 0.0)
    rng = np.sqrt(D ** 2 + (hrs - hts) ** 2)
    fspl = 20 * np.log10(4 * np.pi * rng / lam)
    return L, det, dict(Lba=Lba, Lbs=Lbs, Lsph=Lsph, fspl=fspl, hts=hts, hrs=hrs, htse=htse, hrse=hrse)
