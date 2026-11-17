"""Over-terrain radio range for time-of-flight ranging: the stretched-string path between two antennas and its excess over
the straight chord.

The path is taken in the vertical plane through both antennas, on a spherical Moon: each profile sample sits at radius
R + z and arc angle d / R, the antennas are raised by their heights, and the string is the upper convex hull between them.
Paths that bend sideways around a hill are not modeled. ITU-R P.526-16 sec. 4.4 uses the same string for loss.
"""
import numpy as np

from .hybrid import profiles
from .p526 import R_MOON

STEP = 10.0
H_NODE = 1.5


def plane(z, d, h1, h2, R=R_MOON):
    r = R + np.asarray(z, float)
    r[..., 0] += h1
    r[..., -1] += h2
    a = np.asarray(d, float) / R
    return r * np.sin(a), r * np.cos(a) - R


def string(X, Y, tol=1e-6):
    total = 0.0
    turns = 0
    stack = [(0, X.size - 1)]
    while stack:
        i, j = stack.pop()
        dx, dy = X[j] - X[i], Y[j] - Y[i]
        if j - i > 1:
            up = (Y[i + 1:j] - Y[i]) * dx - (X[i + 1:j] - X[i]) * dy
            k = int(np.argmax(up))
            if up[k] > tol * np.hypot(dx, dy):
                stack.append((i, i + 1 + k))
                stack.append((i + 1 + k, j))
                turns += 1
                continue
        total += float(np.hypot(dx, dy))
    return total, turns


def ranges(site, x1, y1, x2, y2, h1=H_NODE, h2=H_NODE, step=STEP):
    x2 = np.atleast_1d(np.asarray(x2, float))
    y2 = np.atleast_1d(np.asarray(y2, float))
    a, b = site.to_dem(x1, y1)
    c, d = site.to_dem(x2, y2)
    z, dd, _ = profiles(site.dem, site.cell, float(a), float(b), c, d, step, site.scale(x1, y1, x2, y2))
    X, Y = plane(z, dd, h1, h2)
    dx, dy = X[:, -1:] - X[:, :1], Y[:, -1:] - Y[:, :1]
    chord = np.hypot(dx, dy)[:, 0]
    up = ((Y - Y[:, :1]) * dx - (X - X[:, :1]) * dy)[:, 1:-1]
    blocked = up.max(axis=1) > 1e-6 * chord
    length = chord.copy()
    turns = np.zeros(chord.size, int)
    for k in np.flatnonzero(blocked):
        length[k], turns[k] = string(X[k], Y[k])
    return length, chord, turns


def link_range(site, x1, y1, x2, y2, h1=H_NODE, h2=H_NODE, step=STEP):
    length, chord, turns = ranges(site, x1, y1, [x2], [y2], h1, h2, step)
    return dict(range_m=float(length[0]), chord_m=float(chord[0]), excess_m=float(length[0] - chord[0]), vertices=int(turns[0]))
