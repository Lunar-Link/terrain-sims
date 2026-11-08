"""Terrain link tables for the mesh-network simulator: directed loss with antenna gains between every pair of nodes over time.

Usage:
    python -B -m models.linktable --plan 0 -o plan0.txt [--relay-ant dipole] [--step-s 10]
    python -B -m models.linktable scenario.json -o out.txt

A scenario is JSON: {"name", "preset", "step_s", "omni_listen", "nodes": [{"name", "x", "y", "h", "ant", "bore", "state",
"start_s"} or a mobile node with "track": {"t", "x", "y"} instead of x and y]}, map coordinates (y north), times in seconds.
Node 0 is the base. Output is the text format read by mesh-network/sim/sim_terrain.c.
"""
import argparse
import json
import math
import re
import sys

import numpy as np

from .budgets import PRESETS
from .site import Site

LORA = {"sf12_62": (12, 62500), "sf12_125": (12, 125000), "sf9": (9, 125000), "sf7_125": (7, 125000),
        "sf7_500": (7, 500000), "l24_7": (7, 406250), "l24_5": (5, 812500)}
SNR_MIN = {5: -2.5, 6: -5.0, 7: -7.5, 8: -10.0, 9: -12.5, 10: -15.0, 11: -17.5, 12: -20.0}
NF_DB = 6.0
CR = 1
PREAMBLE = 12
PER_REF = 0.1
PER_WIDTH_DB = 0.5
H_NODE = 1.5


def scenario_from_plan(site, i, base_ant="iso", relay_ant="iso", crew_ant="iso", h=H_NODE, preset="sf9", step_s=10.0,
                       omni_listen=False):
    p = site.plan(i)
    bx, by = site.base
    nodes = [dict(name="base", x=bx, y=by, h=h, ant=base_ant, start_s=0.0)]
    for k, r in enumerate(sorted(p["relays"], key=lambda r: r["t"])):
        nodes.append(dict(name=f"R{k + 1}", x=r["x"], y=r["y"], h=h, ant=relay_ant, start_s=r["t"]))
    tr = p["track"]
    nodes.append(dict(name="crew", h=h, ant=crew_ant, start_s=0.0, track=dict(t=tr["t"].tolist(), x=tr["x"].tolist(),
                                                                             y=tr["y"].tolist())))
    slug = re.sub(r"[^a-z0-9]+", "_", p["name"].lower()).strip("_")
    return dict(name=f"plan{i}_{slug}_{p['budget']:g}", preset=preset, step_s=step_s, omni_listen=omni_listen, nodes=nodes,
                plan=dict(index=i, name=p["name"], budget=p["budget"], weakest_db=p["weakest_db"], deployment=p["deployment"]))


def _positions(node, times):
    tr = node.get("track")
    if not tr:
        return np.full(len(times), float(node["x"])), np.full(len(times), float(node["y"])), None
    t, x, y = (np.asarray(tr[k], float) for k in ("t", "x", "y"))
    xs, ys = np.interp(times, t, x), np.interp(times, t, y)
    seg = np.hypot(np.diff(xs), np.diff(ys))
    return xs, ys, np.concatenate([[0.0], np.cumsum(seg)])


def build(site, sc, progress=None):
    nodes = sc["nodes"]
    step = float(sc.get("step_s", 10.0))
    end = max([max(n["track"]["t"]) for n in nodes if n.get("track")] + [step])
    times = np.arange(0.0, end + step / 2, step)
    pos = [_positions(n, times) for n in nodes]
    mobile = [n.get("track") is not None for n in nodes]
    omni = bool(sc.get("omni_listen", False))
    links = {}
    total = sum(1 for a in range(len(nodes)) for b in range(len(nodes)) if a != b)
    done = 0
    for a, na in enumerate(nodes):
        for b, nb in enumerate(nodes):
            if a == b:
                continue
            ks = range(len(times)) if mobile[a] or mobile[b] else [0]
            vals = []
            for k in ks:
                r = site.link(pos[a][0][k], pos[a][1][k], pos[b][0][k], pos[b][1][k], na.get("h", H_NODE), nb.get("h", H_NODE),
                              ant_tx=na.get("ant", "iso"), ant_rx=nb.get("ant", "iso"), bore_tx=na.get("bore", 0.0),
                              bore_rx=nb.get("bore", 0.0), state_tx=na.get("state"), state_rx=nb.get("state"),
                              omni_listen=omni)
                vals.append(r["loss_db"])
            links[(a, b)] = np.asarray(vals)
            done += 1
            if progress:
                progress(done, total)
    return dict(sc=sc, times=times, pos=pos, mobile=mobile, links=links)


def radio(preset):
    if preset not in LORA:
        raise ValueError(f"preset {preset} is not a LoRa preset; one of {', '.join(LORA)}")
    sf, bw = LORA[preset]
    p = PRESETS[preset]
    noise = -174.0 + 10 * math.log10(bw) + NF_DB
    return dict(preset=preset, f_hz=p["f_hz"], tx_dbm=p["tx"], sens_dbm=p["sens"], noise_dbm=noise, snr_min_db=SNR_MIN[sf],
                sf=sf, bw_hz=bw)


def write(tab, path):
    sc, times = tab["sc"], tab["times"]
    rd = radio(sc.get("preset", "sf9"))
    n = len(sc["nodes"])
    f6 = lambda v: f"{v:.2f}"
    with open(path, "w", encoding="ascii", newline="\n") as f:
        f.write("lmesh-terrain 1\n")
        f.write(f"name {sc['name']}\n")
        if "plan" in sc:
            pl = sc["plan"]
            f.write(f"# plan {pl['index']} \"{pl['name']}\" budget {pl['budget']:g} dB, study weakest margin {pl['weakest_db']} dB, "
                    f"{pl['deployment']} deployment\n")
        f.write(f"radio {rd['preset']} f_hz {rd['f_hz']:.0f} tx_dbm {rd['tx_dbm']:g} sens_dbm {rd['sens_dbm']:g} "
                f"noise_dbm {rd['noise_dbm']:.2f} per_ref {PER_REF:g} per_width_db {PER_WIDTH_DB:g}\n")
        f.write(f"lora sf {rd['sf']} bw_hz {rd['bw_hz']} cr {CR} preamble {PREAMBLE}\n")
        f.write(f"times {len(times)} {float(sc.get('step_s', 10.0)):g}\n")
        f.write(f"nodes {n}\n")
        for i, nd in enumerate(sc["nodes"]):
            f.write(f"node {i} {nd['name']} {float(nd.get('start_s', 0.0)):.1f} {int(tab['mobile'][i])} {nd.get('h', H_NODE):g} "
                    f"{nd.get('ant', 'iso')}\n")
        for i in range(n):
            xs, ys, dist = tab["pos"][i]
            if tab["mobile"][i]:
                f.write(f"xy {i} {len(xs)} " + " ".join(f"{x:.1f} {y:.1f}" for x, y in zip(xs, ys)) + "\n")
                f.write(f"dist {i} {len(dist)} " + " ".join(f"{d:.1f}" for d in dist) + "\n")
            else:
                f.write(f"xy {i} 1 {xs[0]:.1f} {ys[0]:.1f}\n")
        for (a, b), v in tab["links"].items():
            f.write(f"link {a} {b} {len(v)} " + " ".join(f6(x) for x in v) + "\n")
        f.write("end\n")


def summary(tab):
    sc = tab["sc"]
    rd = radio(sc.get("preset", "sf9"))
    budget = rd["tx_dbm"] - rd["sens_dbm"]
    names = [n["name"] for n in sc["nodes"]]
    out = []
    for (a, b), v in tab["links"].items():
        if a < b:
            m = budget - np.maximum(v, tab["links"][(b, a)])
            out.append(f"  {names[a]}-{names[b]}: margin min {m.min():.1f} dB, max {m.max():.1f} dB")
    return "\n".join(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Build a terrain link table for the mesh simulator.")
    ap.add_argument("scenario", nargs="?", help="scenario JSON (or use --plan)")
    ap.add_argument("--plan", type=int, help="route plan index in the planner's meta.json")
    ap.add_argument("-o", "--out")
    ap.add_argument("--preset", default="sf9")
    ap.add_argument("--step-s", type=float, default=10.0)
    ap.add_argument("--base-ant", default="iso")
    ap.add_argument("--relay-ant", default="iso")
    ap.add_argument("--crew-ant", default="iso")
    ap.add_argument("--height", type=float, default=H_NODE)
    ap.add_argument("--omni-listen", action="store_true", help="switched and phased arrays receive on their omni setting")
    ap.add_argument("--list", action="store_true", help="list route plans and exit")
    a = ap.parse_args(argv)
    site = Site()
    if a.list:
        for i, p in enumerate(site.plans):
            print(f"{i:2d}  {p['name']}, budget {p['budget']} dB, {p['relays']} relays, {p['km']} km, {p['t_min']} min, {p['deployment']}")
        return 0
    if not a.out:
        ap.error("-o is required")
    if a.plan is not None:
        sc = scenario_from_plan(site, a.plan, a.base_ant, a.relay_ant, a.crew_ant, a.height, a.preset, a.step_s, a.omni_listen)
    elif a.scenario:
        with open(a.scenario, encoding="utf-8") as f:
            sc = json.load(f)
    else:
        ap.error("give a scenario file or --plan")
    tab = build(site, sc, lambda d, t: print(f"\r{d}/{t} links", end="", file=sys.stderr))
    print(file=sys.stderr)
    write(tab, a.out)
    print(f"{a.out}: {len(sc['nodes'])} nodes, {len(tab['times'])} times")
    print(summary(tab))
    return 0


if __name__ == "__main__":
    sys.exit(main())
