"""Relay network algorithms: widest chain to the base, reachability, route coverage and out-of-contact time, walking pace, greedy and exact maximum coverage.

References:
- HiGHS mixed-integer solver through scipy.optimize.milp: exact maximum coverage.
- NASA EVA-EXP-0042 Rev B, xEVA Concept of Operations: 2 km/h walking pace (sec. 4.2.1.3.1) and 20 deg slope limit
  (sec. 7.2) used as the speed_tau defaults; the slowdown law 1 + (slope / limit)^2 is a study assumption.
"""
import numpy as np
from scipy.optimize import Bounds, LinearConstraint, milp
from scipy.sparse import coo_matrix, csr_matrix


def widest_chain(hop):
    n = hop.shape[0]
    best = np.full(n, -np.inf)
    best[0] = np.inf
    par = np.full(n, -1)
    done = np.zeros(n, bool)
    for _ in range(n):
        i = int(np.argmax(np.where(done, -np.inf, best)))
        if best[i] == -np.inf:
            break
        done[i] = True
        for j in range(n):
            if not done[j]:
                w = min(best[i], hop[i, j])
                if w > best[j]:
                    best[j], par[j] = w, i
    return par, best


def reachable(hop, active, fade):
    n = hop.shape[0]
    seen = np.zeros(n, bool)
    seen[0] = True
    stack = [0]
    while stack:
        i = stack.pop()
        for j in range(n):
            if not seen[j] and active[j] and hop[i, j] >= fade:
                seen[j] = True
                stack.append(j)
    return seen


def coverage_mask(marg, hop, drops, fade, deploy="causal"):
    K, S = marg.shape[0] - 1, marg.shape[1]
    cov = marg[0] >= fade
    if K == 0:
        return cov
    if deploy == "static":
        act = reachable(hop, np.ones(K + 1, bool), fade)
        return cov | (marg[1:][act[1:]] >= fade).any(axis=0)
    cov = cov.copy()
    order = np.argsort(drops, kind="stable")
    active = np.zeros(K + 1, bool)
    active[0] = True
    bounds = [int(drops[i]) for i in order] + [S]
    for k, i in enumerate(order):
        active[i + 1] = True
        ok = reachable(hop, active, fade)
        j0, j1 = bounds[k], bounds[k + 1]
        if j1 > j0:
            live = np.flatnonzero(ok[1:])
            if live.size:
                cov[j0:j1] |= (marg[1:][live][:, j0:j1] >= fade).any(axis=0)
    return cov


def out_of_comms(dt, covered):
    tot = float(dt[~covered].sum())
    longest, cur = 0.0, 0.0
    for d, ok in zip(dt, covered):
        cur = 0.0 if ok else cur + d
        longest = max(longest, cur)
    return tot, longest


def speed_tau(slope, v0_kmh=2.0, s_ref=20.0):
    return (1.0 + (slope / s_ref) ** 2) * 60.0 / (v0_kmh * 1000.0)


def greedy(A, kmax):
    covered = np.zeros(A.shape[1], bool)
    picks, frac = [], []
    for _ in range(kmax):
        gain = (A & ~covered).sum(axis=1)
        j = int(np.argmax(gain))
        if gain[j] == 0 and picks:
            break
        picks.append(j)
        covered |= A[j]
        frac.append(float(covered.mean()))
    return picks, frac


def reduce_matrix(A):
    cols, w = np.unique(A.T, axis=0, return_counts=True)
    B = cols.T
    keep_w = cols.any(axis=1)
    B, w = B[:, keep_w], w[keep_w]
    B_u, idx = np.unique(B, axis=0, return_index=True)
    n = B_u.shape[0]
    order = np.argsort(-(B_u @ w))
    dom = np.zeros(n, bool)
    X = B_u[order]
    for i in range(n):
        if dom[i]:
            continue
        dom[i + 1:] |= ~(X[i + 1:] & ~X[i]).any(axis=1)
    kept = order[~dom]
    return B_u[kept], w, idx[kept]


def max_cover(A, k, time_limit=60.0):
    if not A.any():
        return [], 0.0, True
    B, w, ids = reduce_matrix(A)
    nc, nt = B.shape
    if nc <= k:
        return [int(i) for i in ids], float((A[ids].any(axis=0)).mean()), True
    c = np.concatenate((np.zeros(nc), -w.astype(float)))
    rows, cols = np.nonzero(B.T)
    a = csr_matrix(coo_matrix((-np.ones(rows.size), (rows, cols)), shape=(nt, nc + nt)))
    eye = coo_matrix((np.ones(nt), (np.arange(nt), nc + np.arange(nt))), shape=(nt, nc + nt)).tocsr()
    card = csr_matrix((np.ones(nc), (np.zeros(nc, int), np.arange(nc))), shape=(1, nc + nt))
    res = milp(c, constraints=[LinearConstraint(a + eye, -np.inf, 0.0), LinearConstraint(card, 0, k)],
               integrality=np.concatenate((np.ones(nc), np.zeros(nt))), bounds=Bounds(0, 1),
               options=dict(time_limit=time_limit, mip_rel_gap=0.0))
    if res.x is None:
        p, f = greedy(A, k)
        return p, f[-1], False
    sel = [int(ids[j]) for j in np.flatnonzero(res.x[:nc] > 0.5)]
    return sel, float(A[sel].any(axis=0).mean()), bool(res.status == 0)


def curve(A, kmax=6, time_limit=60.0):
    rows = []
    gp, gf = greedy(A, kmax)
    for k in range(1, kmax + 1):
        sel, f, opt = max_cover(A, k, time_limit)
        g = gf[min(k, len(gf)) - 1] if gf else 0.0
        if g > f:
            sel, f = gp[:k], g
        rows.append(dict(k=k, exact=f, greedy=g, proven=opt, nodes=sel))
        if f >= 1.0:
            break
    need = {}
    for t in (0.80, 0.90, 0.95):
        hit = [r["k"] for r in rows if r["exact"] >= t - 1e-12]
        need[t] = hit[0] if hit else None
    return rows, need
