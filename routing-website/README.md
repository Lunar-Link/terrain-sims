# Malapert Node Planner

A static web page for placing radio relays on the 16 km Malapert map and simulating links, coverage and data rate back to the summit base. It runs the R2 hybrid propagation model in the browser. Each site can carry an antenna from a library of 433 MHz designs, aimed by hand or along the chain, and its pattern is drawn on the map. Any link, or a path from a site to any point, opens as a terrain profile with its loss budget. A plan is kept in the page link and the browser, and exports as a scenario that the mesh-network simulator runs over the same terrain. Results are uncalibrated model estimates, about ±10 dB per link, and nothing has been field tested.

## Files

| Path | What |
|---|---|
| `index.html` | The page, built by `build.py`; engine, styles, route data and antenna tables are inside it |
| `src/engine.js` | Hybrid, P.526 chain, radial sweep, rasterizer, widest chain, rate models, antenna gain tables, worker jobs |
| `src/page.js`, `src/page.css`, `src/page_body.html` | Page logic, styles and markup |
| `data/*.b64.txt` | Terrain, overlays and winter sunlight as base64 gzip, loaded by the page |
| `data/hill_overview.webp`, `data/tiles/` | Hillshade: whole map at 20 m, and 60 tiles from the 5 m mosaic |
| `data/meta.json`, `data/validation.json` | Grid, tiles, route plans, band accuracy |
| `data/antennas.json` | Antenna patterns at 433 MHz, 2° in azimuth and elevation: free-space directivity from the lunar RF study's method-of-moments runs, plus HFSS realized gain on the node body (ids ending in `_inst`, and the `espar_plate` bench prototype) |
| `checks/antennas_engine.js` | Isotropic leaves every loss unchanged, the sweep and link gains agree, a dipole adds what the study found |
| `checks/antennas_browser.js` | Headless Chrome: isotropic default against a reference page, each antenna type with aiming, the relay search, phone width, console errors |
| `checks/antenna_trade.js` | Relays needed and contact kept on the study's routes for each antenna set |
| `checks/profile_browser.js` | Headless Chrome: profile margins equal Simulate's for every pair, map clicks, point profiles, swapping ends, live update while dragging, the page link and browser restore, export through `models/linktable.py` and `lmesh_sim`, import, phone width, console errors |
| `build.py` | Assembles `index.html` |

The data files are built in the lunar RF study (`lunar-rf-study/docs/milestone2/site_tool/`), which also holds the hybrid's validation against the PE.

## Build and check

```
python -B build.py
OLD_ENGINE=<engine.js before antennas> node checks/antennas_engine.js
SCRATCH_DIR=<dir> REF_INDEX=<index.html before antennas> node checks/antennas_browser.js
SCRATCH_DIR=<dir> node checks/profile_browser.js
SCRATCH_DIR=<dir> PLANS=1,5,9 node checks/antenna_trade.js
SCRATCH_DIR=<dir> MODE=fixed|robust ONLY=espar_inst,dipole_inst node checks/antenna_trade.js
```

## Techniques

- R2 hybrid as a line-by-line JavaScript port of the study's Python.
- Radial coverage sweep: incremental convex hulls in Bullington's curvature frame, prefix sums and tangent searches along each radial.
- Web Workers from a blob URL built from the page's own engine script, with azimuth blocks as the job unit and a per-site raster cache.
- Antenna gain from free-space pattern tables, bilinear in azimuth and elevation, at the ray's take-off elevation at each node (the horizon slope on diffracted paths, the direct ray on line of sight), as in the study's section 6.4.2; the crew or target end stays 0 dBi. Switched and phased arrays take their best beam state, or, when set to listen on their omni setting, receive on the pattern named by `omni_id` (the dipole if none). Tables ship as int8 in 0.25 dB steps.
- Planning gains for the relay search, chosen so it never promises more than Simulate gives: for hops, the weaker of front and back (what a straight chain gets when aimed along it), the front gain for the base, and the worst bearing for switched and phased arrays; for route points, the worst bearing.
- Aim along the chain: widest-chain tree under planning gains, then a max-min search over bearings toward each site's chain neighbors, with a smaller weight on the route points nearest to it.
- Map glyphs with radius in proportion to free-space range, and a draggable boresight handle.
- Widest-chain search, fewest-relays layered search to a point, and a greedy search along a drawn route.
- Link profile: the model's own profile (terrain raised by lunar curvature, so the direct ray is straight), the first Fresnel zone, the hull runs the hybrid rounds and the Bullington diffracted path, from extra fields on the engine's result; the loss budget names whichever of P.526 and the hybrid sets the loss, and both margins equal Simulate's to the last bit.
- Plan state as base64url JSON in the page link's fragment, written with `history.replaceState` and mirrored in `localStorage`; a fragment wins over the browser copy, and a bad one falls back to the default plan with a note.
- Export as a scenario JSON for `terrain-sims/models/linktable.py`: base, relays (switched on when the crew first comes within 60 m, except on static plans), the crew track with times from the plan's walking pace, and the planner state, which import restores exactly; a bare scenario imports as sites and a drawn route.

Browser checks run Chrome with the shared profile `%LOCALAPPDATA%\agent-chrome-profile` only, one at a time (see `Documents/Code/CLAUDE.md`).
