"""Split-step parabolic-equation path loss over lunar terrain (wide angle, regolith impedance ground, vertical dipole) and its DEM link wrapper.

References:
- Levy, M. (2000), "Parabolic Equation Methods for Electromagnetic Wave Propagation", IEE Electromagnetic Waves
  Series 45: split-step Fourier PE.
- Feit-Fleck wide-angle split-step propagator exp(i dx (sqrt(k^2 - p^2) - k)).
- Barrios, A. E. (1994), "A terrain parabolic equation model for propagation in the troposphere", IEEE Trans.
  Antennas Propag. 42(1), 90-98: piecewise-linear shift map.
- Donohue, D. J. and Kuttler, J. R. (2000), "Propagation modeling over terrain using the parabolic wave equation",
  IEEE Trans. Antennas Propag. 48(2), 260-277: shift map.
- Kuttler, J. R. and Dockery, G. D. (1991), "Theoretical description of the parabolic approximation/Fourier
  split-step method of representing electromagnetic propagation in the troposphere", Radio Sci. 26(2), 381-393:
  discrete mixed Fourier transform.
- Dockery and Kuttler (1996): discrete mixed Fourier transform for the impedance boundary.
- Leontovich impedance boundary du/dz + alpha u = 0, vertical polarization.
- Regolith constants as in p526.py.
"""
import math

import numpy as np
import scipy.fft as sfft
from scipy.signal import lfilter

from .hybrid import profiles
from .p526 import C0, F433, R_MOON, REGOLITH_EPS, fspl_db, regolith_sigma

STEP_LIM = 0.85
MIN_RANGE = 25.0
DAMPING = (0.9, 1.0)
SUBSTEP = {150.0: 1, 260.0: 1, 433.0: 1, 915.0: 2, 2050.0: 5, 2442.0: 6, 2593.0: 6, 3550.0: 8}


def wavenumber(f_hz):
    return 2 * math.pi / (C0 / f_hz)


def dz_for(f_hz):
    return 1.5 / math.ceil(1.5 * 4.15 / (C0 / f_hz) - 1e-9)


def margin_for(f_hz):
    return 200.0 * max(1.0, 433e6 / f_hz)


def domain_for(T, margin=200.0):
    T = np.asarray(T, float)
    return float(max(200.0, T.max() - T.min() + margin))


def surface_alpha(f_hz):
    lam = C0 / f_hz
    k = 2 * math.pi / lam
    n2 = complex(REGOLITH_EPS, 60 * lam * regolith_sigma(f_hz))
    return 1j * k * np.sqrt(n2 - 1) / n2


def damping_rate(p, k, s1, gamma0):
    t = np.clip((np.asarray(p, float) / k - s1) / (1.0 - s1), 0.0, None)
    return gamma0 * t ** 4


def dipole_spectrum(p, k):
    s = np.clip(np.asarray(p, float) / k, -1, 1)
    c = np.sqrt(np.maximum(1 - s * s, 0))
    cs = np.where(c > 1e-9, c, 1.0)
    F = np.where(c > 1e-9, np.cos(np.pi / 2 * s) / cs ** 1.5, 0.0)
    th = np.degrees(np.arcsin(np.abs(s)))
    taper = np.where(th <= 60.0, 1.0, np.where(th >= 80.0, 0.0, 0.5 * (1 + np.cos(np.pi * (th - 60.0) / 20.0))))
    return F * taper


def aperture(z, h, k, n_p=8192, reach=80.0):
    p = np.linspace(-k, k, n_p)
    dp = p[1] - p[0]
    U = dipole_spectrum(p, k)
    out = np.zeros(z.size, complex)
    idx = np.where(np.abs(z - h) < reach)[0]
    for i0 in range(0, idx.size, 512):
        ii = idx[i0:i0 + 512]
        out[ii] = (np.exp(1j * np.outer(z[ii] - h, p)) @ U) * dp
    return out


def free_field_mag(r, theta, k):
    return np.abs(dipole_spectrum(k * np.sin(theta), k)) * np.cos(theta) * np.sqrt(2 * np.pi * k / r)


def geometry(x, T, h_tx, h_rx, ae=R_MOON):
    T = np.asarray(T, float)
    dh = (T + h_rx) - (T[0] + h_tx)
    rng = np.sqrt(x ** 2 + dh ** 2)
    theta = np.arctan2(dh - x ** 2 / (2 * ae), np.maximum(x, 1e-9))
    return rng, theta


class PE:

    def __init__(self, dz, dx, z_field, f_hz=F433, ae=R_MOON, z_abs=None):
        k = wavenumber(f_hz)
        self.k, self.dz, self.dx, self.ae = k, dz, dx, ae
        if z_abs is None:
            z_abs = max(150.0, 0.5 * z_field) * max(1.0, 433e6 / f_hz)
        N = sfft.next_fast_len(int(math.ceil((z_field + z_abs) / dz)))
        self.N = N
        self.z = np.arange(N + 1) * dz
        t = np.clip((self.z - z_field) / (self.z[-1] - z_field), 0, 1)
        self.win = np.where(self.z <= z_field, 1.0, 0.5 * (1 + np.cos(np.pi * t)))
        self.refr = np.exp(1j * k * dx * self.z / ae)
        self.alpha = surface_alpha(f_hz)
        p = np.pi * np.arange(1, N) / (N * dz)
        self.prop = self._propagator(p ** 2) * np.exp(-damping_rate(p, k, *DAMPING) * dx)
        self._setup_dmft()

    def _propagator(self, p2):
        k = self.k
        kz = np.sqrt((k * k - np.asarray(p2)).astype(complex))
        kz = np.where(kz.imag < 0, -kz, kz)
        return np.exp(1j * self.dx * (kz - k))

    def _setup_dmft(self):
        N, dz = self.N, self.dz
        a = self.alpha * dz
        r = -a + np.sqrt(1 + a * a)
        if abs(r) >= 1:
            r = -a - np.sqrt(1 + a * a)
        self.r1 = complex(r)
        m = np.arange(N + 1)
        rp = r ** m
        wt = np.ones(N + 1)
        wt[0] = wt[-1] = 0.5
        self.Pw = wt * rp
        self.kern = rp - r ** N * (-r) ** (N - m)
        self.Pk = np.sum(self.Pw * self.kern)
        ad = -np.log(r) / dz
        self.mode_prop = complex(self._propagator(np.array([-(ad * ad)]))[0])

    def _dmft_join(self, w, c):
        N, dz, r = self.N, self.dz, self.r1
        vp = np.zeros(N + 1, complex)
        vp[2:] = lfilter([1.0], [1.0, -r], 2 * dz * w)
        y = lfilter([1.0], [1.0, r], r * vp[N:0:-1])
        up = np.zeros(N + 1, complex)
        up[:N] = y[::-1]
        beta = (c - np.dot(self.Pw, up)) / self.Pk
        return up + beta * self.kern

    def _step(self, u):
        c = np.dot(self.Pw, u)
        w = (u[2:] - u[:-2]) / (2 * self.dz) + self.alpha * u[1:-1]
        w = sfft.idst(sfft.dst(w, type=1, norm="ortho") * self.prop, type=1, norm="ortho")
        u = self._dmft_join(w, c * self.mode_prop)
        return u * self.refr * self.win

    def run(self, T, h_tx, rx_heights):
        T = np.asarray(T, float)
        n = T.size - 1
        u = aperture(self.z, h_tx, self.k)
        u[-1] = 0.0
        u *= self.win
        s = np.diff(T) / self.dx
        s_prev = 0.0
        rxi = [h / self.dz for h in rx_heights]
        out = np.zeros((len(rx_heights), n + 1), complex)

        def sample(u):
            vals = []
            for q in rxi:
                i0 = int(math.floor(q + 1e-9))
                f = q - i0
                vals.append(u[i0] if f < 1e-9 else u[i0] * (1 - f) + u[i0 + 1] * f)
            return vals
        out[:, 0] = sample(u)
        zk = self.k * self.z
        for i in range(n):
            ds = s[i] - s_prev
            if ds != 0.0:
                u = u * np.exp(-1j * ds * zk)
            s_prev = s[i]
            u = self._step(u)
            out[:, i + 1] = sample(u)
        return np.arange(n + 1) * self.dx, out


def limit_steps(z, dx, lim=STEP_LIM):
    z = z.copy()
    for _ in range(400):
        bad = np.flatnonzero(np.abs(np.diff(z)) / dx > lim)
        if bad.size == 0:
            break
        ii = np.unique(np.clip(np.r_[bad, bad + 1], 1, z.size - 2))
        z[ii] = (z[ii - 1] + z[ii] + z[ii + 1]) / 3
    return z


def subdivide(z, m):
    z = np.asarray(z, float)
    if m == 1:
        return z
    n = z.size - 1
    return np.interp(np.arange(n * m + 1) / m, np.arange(n + 1), z)


@np.errstate(divide="ignore", invalid="ignore")
def pe_profile(z, D, h_tx, h_rx, f_hz=F433, substep=1, ae=R_MOON):
    z = subdivide(z, substep)
    pe = PE(dz_for(f_hz), D / (z.size - 1), domain_for(z, margin_for(f_hz)), f_hz, ae)
    x, u = pe.run(z, h_tx, (h_rx,))
    rng, th = geometry(x, z, h_tx, h_rx, ae)
    pf = 20 * np.log10(np.abs(u[0]) / free_field_mag(rng, th, pe.k))
    return x, fspl_db(rng, f_hz) - pf


def pe_loss(z, D, h_tx, h_rx, f_hz=F433, substep=1):
    z = np.asarray(z, float)
    if D < MIN_RANGE:
        return float(fspl_db(max(math.hypot(D, z[-1] + h_rx - z[0] - h_tx), 1.0), f_hz))
    dx = D / (z.size - 1)
    if float((np.abs(np.diff(z)) / dx).max()) > STEP_LIM:
        z = limit_steps(z, dx)
    return float(pe_profile(z, D, h_tx, h_rx, f_hz, substep)[1][-1])


def pe_link(dem, cell, x1, y1, x2, y2, h_tx, h_rx, step=None, f_hz=F433, substep=1, scale=1.0):
    z, _, D = profiles(dem, cell, float(x1), float(y1), float(x2), float(y2), step or cell, scale)
    return pe_loss(z[0], float(D[0]), h_tx, h_rx, f_hz, substep)
