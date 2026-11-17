"""Checks pe.py at its default grid on 20 m posts against known answers: flat regolith, the smooth Moon and circular hills.

Usage:
    python -B -m models.check_pe

References:
- Flat ground: two-ray with the Sommerfeld-Norton surface wave, computed here.
- Smooth Moon and hills: excess loss from the Fock residue series for a sphere with a surface-impedance boundary
  (lunar-rf-study, models2/fock.py), 433 MHz, 1.5 m masts, regolith constants as in p526.py. The values are stored below.
"""
import math
import sys

import numpy as np
from scipy.special import wofz

from . import pe
from .p526 import C0, F433, REGOLITH_EPS, fspl_db, regolith_sigma

H = 1.5
POST = 20.0
MOON_EXACT = {2000: 34.207, 6000: 46.192, 10000: 54.143, 15000: 63.137}
HILL_EXACT = {2000.0: (27.824, 59.908, 94.142), 1000.0: (17.170, 41.576, 67.944)}
HILL_AT = (0.1, 0.2, 0.3)
TOL_FLAT, TOL_MOON, TOL_HILL = 0.05, 0.2, 1.0


def two_ray_norton(d, h1, h2, f_hz=F433):
    lam = C0 / f_hz
    k = 2 * math.pi / lam
    ec = complex(REGOLITH_EPS, 60 * lam * regolith_sigma(f_hz))
    r1 = np.hypot(d, h1 - h2)
    r2 = np.hypot(d, h1 + h2)
    s = (h1 + h2) / r2
    rt = np.sqrt(ec - (1 - s * s))
    g = (ec * s - rt) / (ec * s + rt)
    w = np.exp(1j * np.pi / 4) * np.sqrt(k * r2 / 2) * (s + rt / ec)
    g = g + (1 - g) * (1 + 1j * np.sqrt(np.pi) * w * wofz(w))

    def pattern(sn):
        return np.cos(np.pi / 2 * sn) / np.sqrt(1 - sn * sn)
    ratio = pattern(-(h1 + h2) / r2) / pattern((h2 - h1) / r1)
    return -20 * np.log10(np.abs(1 + g * ratio * (r1 / r2) * np.exp(1j * k * (r2 - r1))))


def excess(T, D, ae):
    x, L = pe.pe_profile(T, D, H, H, ae=ae)
    rng, _ = pe.geometry(x, T, H, H, ae)
    return x, L - fspl_db(np.maximum(rng, 1e-9))


def flat():
    x, e = excess(np.zeros(251), 5000.0, np.inf)
    m = x >= 100
    return [("flat regolith, 0.1 to 5 km, largest error", float(np.abs(e[m] - two_ray_norton(x[m], H, H)).max()), TOL_FLAT)]


def moon():
    out = []
    for D, ref in MOON_EXACT.items():
        e = pe.pe_loss(np.zeros(int(D / POST) + 1), float(D), H, H) - float(fspl_db(float(D)))
        out.append((f"smooth Moon, {D / 1000:g} km", abs(e - ref), TOL_MOON))
    return out


def hills():
    out = []
    for R, refs in HILL_EXACT.items():
        x = np.arange(0.0, 0.3 * R + POST / 2, POST)
        _, e = excess(np.sqrt(R * R - x * x) - R, float(x[-1]), np.inf)
        for at, ref in zip(HILL_AT, refs):
            i = int(round(at * R / POST))
            out.append((f"hill R {R / 1000:g} km, bend {math.degrees(math.asin(at)):.1f} deg", abs(float(e[i]) - ref), TOL_HILL))
    return out


def main():
    rows = flat() + moon() + hills()
    for name, err, tol in rows:
        print(f"{'ok  ' if err <= tol else 'FAIL'}  {name}: {err:.3f} dB (limit {tol:g})")
    bad = sum(err > tol for _, err, tol in rows)
    print(f"{len(rows) - bad} of {len(rows)} checks pass")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
