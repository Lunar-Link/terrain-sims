"""The Malapert site from the planner's data: 20 m DEM, grid, base and route plans, map-to-DEM coordinates and terrain links in map coordinates.

Map coordinates are polar stereographic meters with y north, as in the planner and the study. The DEM frame of hybrid.py has x
along columns and y along rows from the corner of cell [0, 0]; row 0 is the grid's top (north) edge.
"""
import base64
import gzip
import json
import os

import numpy as np

from . import antennas
from .p526 import F433, R_MOON

DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "routing-website", "data")


class Site:
    def __init__(self, data_dir=None):
        self.data_dir = data_dir or DATA
        with open(os.path.join(self.data_dir, "meta.json"), encoding="utf-8") as f:
            self.meta = json.load(f)
        t = self.meta["terrain"]
        self.n, self.x0, self.ytop, self.cell = t["n"], t["x0"], t["ytop"], t["cell"]
        self.base = (t["bx"], t["by"])
        self.rdisk = t["rdisk"]
        self.plans = self.meta["plans"]
        self._dem = None

    @property
    def dem(self):
        if self._dem is None:
            with open(os.path.join(self.data_dir, "dem20.b64.txt"), encoding="ascii") as f:
                raw = gzip.decompress(base64.b64decode(f.read().strip()))
            planes = np.frombuffer(raw, np.uint8).reshape(4, -1)
            self._dem = planes.T.copy().view("<f4").reshape(self.n, self.n).astype(np.float64)
        return self._dem

    def to_dem(self, x, y):
        return np.asarray(x, float) - self.x0 + self.cell / 2, self.ytop - np.asarray(y, float) + self.cell / 2

    def height(self, x, y):
        from .hybrid import sample
        xd, yd = self.to_dem(x, y)
        return sample(self.dem, self.cell, xd, yd)

    def inside(self, x, y):
        return np.hypot(np.asarray(x, float) - self.base[0], np.asarray(y, float) - self.base[1]) <= self.rdisk

    @staticmethod
    def scale(x1, y1, x2, y2):
        xm, ym = (x1 + x2) / 2, (y1 + y2) / 2
        return 1 + (xm * xm + ym * ym) / (4 * R_MOON * R_MOON)

    def link(self, x1, y1, x2, y2, h_tx, h_rx, f_hz=F433, **ant):
        a, b = self.to_dem(x1, y1)
        c, d = self.to_dem(x2, y2)
        return antennas.link(self.dem, self.cell, float(a), float(b), float(c), float(d), h_tx, h_rx, f_hz=f_hz,
                             scale=self.scale(x1, y1, x2, y2), **ant)

    def plan(self, i):
        p = self.plans[i]
        dt = np.asarray(p["dt"], float) * 60.0
        t = np.concatenate([[0.0], np.cumsum((dt[:-1] + dt[1:]) / 2)])
        t *= dt.sum() / t[-1]
        s = np.asarray(p["s"], float) * 1000.0
        relays = [dict(x=n[0], y=n[1], s=n[2] * 1000.0,
                       t=0.0 if p.get("deployment") == "static" else float(np.interp(n[2] * 1000.0, s, t)))
                  for n in p["nodes"]]
        return dict(name=p["name"], budget=float(p["budget"]), deployment=p.get("deployment"), weakest_db=p["weakest_db"],
                    track=dict(t=t, x=np.asarray(p["tx"], float), y=np.asarray(p["ty"], float), s=s), relays=relays)
