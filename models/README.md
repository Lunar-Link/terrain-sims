# models

Clean, reusable versions of the lunar RF study's core algorithms, extracted from `lunar-rf-study/docs` (milestone 1 R2 hybrid and P.526 chain, the parabolic-equation solver, and the milestone 2 route planner, PSR rim and 5G relay studies) and checked against the study code to 1e-9 dB. Import as a package (`from models import hybrid`); numpy and scipy only. DEM functions take a plain 2-D array `dem[row, col]` with square cells of `cell` meters, with x along columns and y along rows measured from the outer corner of cell [0, 0].

| File | Contents |
|---|---|
| `p526.py` | Lunar and regolith constants, free-space loss, knife-edge J(v), ITU-R P.526-16 sec. 4.5 general method on profiles |
| `hybrid.py` | R2 hybrid loss (P.526 plus convex-hull rounded runs and terminal image term, adopted FINAL settings), DEM sampling, `profiles`, `link_loss` |
| `pe.py` | Wide-angle split-step PE with shift-map terrain and regolith impedance ground, `pe_profile`, `pe_loss`, `pe_link` |
| `budgets.py` | Radio presets (LoRa, FLRC, 5G as on the routing website), 5G NR, Wi-Fi 6 and sidelink budgets, attenuated-Shannon rate, multi-hop share |
| `network.py` | Widest chain, reachability, route coverage and out-of-contact time, walking pace, greedy and exact (MILP) maximum coverage |
