# models

Python models for lunar radio links: terrain diffraction, a parabolic-equation reference solver, link budgets, relay network search, antenna patterns, the Malapert site, and link tables for the mesh-network simulator. Needs numpy and scipy. Import as a package, for example `from models import hybrid`.

Terrain functions take a 2-D height array `dem[row, col]` in meters with square cells of `cell` meters. x runs along columns and y along rows, from the corner of cell [0, 0]. `site.py` converts from map coordinates (polar stereographic meters, y north), which the planner and the study use.

| File | Contents |
|---|---|
| `p526.py` | Lunar and regolith constants, free-space loss, knife-edge J(v), ITU-R P.526 general method |
| `hybrid.py` | R2 hybrid loss (P.526 plus rounded-hill and ground terms), terrain sampling, `link_loss` |
| `pe.py` | Split-step parabolic equation over terrain with a regolith ground, `pe_loss`, `pe_link` |
| `budgets.py` | Radio presets (LoRa, FLRC, 5G), 5G NR, Wi-Fi and sidelink budgets, data rate, multi-hop share |
| `network.py` | Widest chain, reachability, route coverage and out-of-contact time, walking pace, maximum coverage |
| `antennas.py` | The planner's 433 MHz pattern library (`routing-website/data/antennas.json`) plus a flat −6 dBi `suit`: bilinear gain, beam states, mast tilt, omni listening, planning rows, take-off elevations, and `link` with gains at both ends |
| `site.py` | Malapert from the planner's data: the 20 m DEM, grid, base, route plans with times and relay drop times, and `Site.link` in map coordinates |
| `linktable.py` | Link tables for `mesh-network/sim`: directed loss with antenna gains between every pair over time, from a route plan or a scenario JSON |

## Antennas

`antennas.json` holds free-space directivity from the lunar RF study's thin-wire method-of-moments solver (`lunar-rf-study/docs/milestone2/antennas/`), and HFSS realized gain on the node body for ids ending in `_inst` and `espar_plate`. Gains are read at the ray's take-off elevation at each end (study rule 6.4.2). Switched and phased arrays take their best beam unless a state is given. `antennas.link` and `Site.link` match the planner's engine to 1e-5 dB on path loss, take-off angle and gain.

## Link tables

```
python -B -m models.linktable --list
python -B -m models.linktable --plan 0 -o ../mesh-network/sim/terrain/plan0.txt
python -B -m models.linktable --plan 5 --relay-ant dipole_inst --step-s 10 -o plan5.txt
python -B -m models.linktable scenario.json -o out.txt
```

A plan puts node 0 at the summit base, the relays where the plan drops them (powered on when the crew reaches them, or at the start for static plans), and the crew on the plan's track. A scenario JSON gives any placement: `{"name", "preset", "step_s", "omni_listen", "nodes": [{"name", "x", "y", "h", "ant", "bore", "state", "start_s"}, ...]}`, with a mobile node carrying `"track": {"t", "x", "y"}` instead of `x` and `y`. Only LoRa presets are supported.

The table carries the radio (transmit power, sensitivity, noise floor from a 6 dB noise figure), the LoRa settings for airtime (CR 4/5, 12-symbol preamble, as the LR1121 driver), and the frame-loss curve: 10 % at sensitivity, 0.5 dB logistic width. The simulator adds model error per seed.
