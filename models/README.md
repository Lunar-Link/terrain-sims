# models

Python models for lunar radio links: terrain diffraction, a parabolic-equation reference solver, link budgets and relay network search. Needs numpy and scipy. Import as a package, for example `from models import hybrid`.

Terrain functions take a 2-D height array `dem[row, col]` in meters with square cells of `cell` meters. x runs along columns and y along rows, from the corner of cell [0, 0].

| File | Contents |
|---|---|
| `p526.py` | Lunar and regolith constants, free-space loss, knife-edge J(v), ITU-R P.526 general method |
| `hybrid.py` | R2 hybrid loss (P.526 plus rounded-hill and ground terms), terrain sampling, `link_loss` |
| `pe.py` | Split-step parabolic equation over terrain with a regolith ground, `pe_loss`, `pe_link` |
| `budgets.py` | Radio presets (LoRa, FLRC, 5G), 5G NR, Wi-Fi and sidelink budgets, data rate, multi-hop share |
| `network.py` | Widest chain, reachability, route coverage and out-of-contact time, walking pace, maximum coverage |
