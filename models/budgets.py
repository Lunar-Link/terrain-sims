"""Radio presets, link budgets (5G NR, Wi-Fi 6, NR sidelink, LoRa and FLRC), attenuated-Shannon rate and multi-hop share.

References:
- 3GPP TS 38.101-1 V19.7.0 (2026-10): UE power classes (Table 6.2.1-1), sidelink REFSENS for n38 at 10 and 30 MHz.
- 3GPP TS 38.104 V19.6.0 (2026-09): Local Area base-station power (Table 6.2.1-1) and the implied noise figure.
- 3GPP TR 38.830 V17.0.0: uplink allocations per rate tier (Table A.1-2) and required SNR (Annex B results).
- 3GPP TR 38.875 V17.0.0: wearable antenna loss (low suit-antenna case).
- 3GPP TR 36.942, Annex A.2: attenuated Shannon rate model.
- Nokia Bell Labs, "Future Lunar Surface Network Study, Final Report" (NASA, 2024, NTRS 20240003815), Table 13:
  noise figure, NIB antenna gain, cable loss and the reference budget in nokia().
- HPE Aruba AP-535 data sheet and Wallys DR6018 datasheet: Wi-Fi 6 power and sensitivity; MathWorks 802.11ac
  receiver minimum input sensitivity test for the -82 dBm low case.
- Semtech LR1121 datasheet Rev 2.1, Tables 3-6 to 3-11: 433 MHz and 2.4 GHz LoRa presets (SF9 -129 dBm is the
  study's placeholder, not a datasheet row).
- Semtech LR2021: FLRC presets, sensitivity specified at 915 MHz.
"""
import math

FADE = 10.0
CASES = ("low", "likely", "high")
UE_TX = dict(low=20.0, likely=23.0, high=26.0)
NIB_TX = dict(low=24.0, likely=30.0, high=37.0)
NIB_NF = dict(low=13.0, likely=8.4, high=5.0)
G_UE = dict(low=-3.0, likely=1.7, high=3.8)
G_NIB = dict(low=0.0, likely=5.0, high=5.5)
CABLE = dict(low=2.5, likely=1.0, high=0.0)
TIERS = {
    "100k": dict(label="100 kb/s, 4 PRB", bw=1.44e6, snr=dict(low=0.0, likely=-5.0, high=-8.0)),
    "1M": dict(label="1 Mb/s, 30 PRB", bw=10.8e6, snr=dict(low=-1.0, likely=-4.0, high=-6.0)),
    "10M": dict(label="10 Mb/s, 273 PRB", bw=98.28e6, snr=dict(low=0.0, likely=-3.0, high=-5.0)),
}
WIFI = dict(tx=dict(low=14.0, likely=18.0, high=23.0), sens=dict(low=-82.0, likely=-92.0, high=-92.0),
            div=dict(low=0.0, likely=3.0, high=6.0))
SIDELINK_TX = dict(low=20.0, likely=23.0, high=23.0)
SIDELINK_REFSENS_30MHZ = -91.7
SIDELINK_REFSENS_10MHZ = -96.1
UL_SHARE = 0.229
SE_ALPHA, SE_MIN_DB, SE_MAX = 0.75, -6.5, 4.8
NR_BW = (0.36e6, 1.44e6, 3.6e6, 10.8e6, 20e6, 40e6, 100e6)
HOP_SHARE = ((1, 1.0), (2, 0.5), (3, 0.3), (4, 0.2), (8, 0.05))

PRESETS = {
    "sf12_62": dict(label="433 MHz LoRa SF12 / 62.5 kHz", f_hz=433e6, tx=22.0, sens=-144.0, bps=146.484),
    "sf12_125": dict(label="433 MHz LoRa SF12 / 125 kHz", f_hz=433e6, tx=22.0, sens=-141.0, bps=292.969),
    "sf9": dict(label="433 MHz LoRa SF9 / 125 kHz (study)", f_hz=433e6, tx=22.0, sens=-129.0, bps=1757.812),
    "sf7_125": dict(label="433 MHz LoRa SF7 / 125 kHz", f_hz=433e6, tx=22.0, sens=-127.0, bps=5468.75),
    "sf7_500": dict(label="433 MHz LoRa SF7 / 500 kHz", f_hz=433e6, tx=22.0, sens=-121.0, bps=21875.0),
    "l24_7": dict(label="2.4 GHz LoRa SF7 / 406 kHz", f_hz=2442e6, tx=11.5, sens=-114.0, bps=17773.438),
    "l24_5": dict(label="2.4 GHz LoRa SF5 / 812 kHz", f_hz=2442e6, tx=11.5, sens=-108.0, bps=101562.5),
    "fl195": dict(label="433 MHz FLRC 195 kb/s, 300 kHz", f_hz=433e6, tx=22.0, sens=-111.0, bps=195000.0),
    "fl487": dict(label="433 MHz FLRC 487 kb/s, 600 kHz", f_hz=433e6, tx=22.0, sens=-107.0, bps=487500.0),
    "fl975": dict(label="433 MHz FLRC 975 kb/s, 1.2 MHz", f_hz=433e6, tx=22.0, sens=-104.5, bps=975000.0),
    "fl975_915": dict(label="915 MHz FLRC 975 kb/s, 1.2 MHz", f_hz=915e6, tx=22.0, sens=-104.5, bps=975000.0),
    "n41": dict(label="5G n41, 2593 MHz, 1 Mb/s tier", f_hz=2593e6, nr=True, ceil=128.0),
    "n78": dict(label="5G n78, 3550 MHz, 1 Mb/s tier", f_hz=3550e6, nr=True, ceil=128.0),
}
NR_PRESET_RATE = dict(tx=23.0, gains=5.7, nf=8.4)


def thermal(bw):
    return -174.0 + 10 * math.log10(bw)


def access(tier, case, antennas=True):
    t = TIERS[tier]
    l0 = UE_TX[case] - (thermal(t["bw"]) + NIB_NF[case] + t["snr"][case]) - FADE
    return l0 + (G_UE[case] + G_NIB[case] - CABLE[case] if antennas else 0.0)


def nib_hop(tier, case):
    t = TIERS[tier]
    return NIB_TX[case] - (thermal(t["bw"]) + NIB_NF[case] + t["snr"][case]) - FADE + 2 * G_NIB[case] - CABLE[case]


def sidelink_hop(case, refsens=SIDELINK_REFSENS_30MHZ):
    return SIDELINK_TX[case] - refsens - FADE + 2 * G_UE[case] - CABLE[case]


def wifi(case, antennas=True):
    return (WIFI["tx"][case] - WIFI["sens"][case] + WIFI["div"][case] - FADE
            + (G_UE[case] + G_NIB[case] - CABLE[case] if antennas else 0.0))


def nokia(tx=23.0, tier="1M", snr_2rx=-1.9):
    return tx - 1.0 + 10.0 - (thermal(TIERS[tier]["bw"]) + 8.4 + snr_2rx) - FADE


def rate_bps(loss_db, tx=23.0, gains=0.0, nf=7.0, fade=FADE, bw_max=100e6, share=UL_SHARE):
    best = 0.0
    for bw in NR_BW[:-1] + (min(100e6, bw_max),):
        if bw > bw_max:
            continue
        snr = tx + gains - loss_db - fade - (thermal(bw) + nf)
        if snr < SE_MIN_DB:
            continue
        se = min(SE_ALPHA * math.log2(1 + 10 ** (snr / 10)), SE_MAX)
        best = max(best, share * bw * se)
    return best


def hop_share(n):
    if n <= 1:
        return 1.0
    for (a, u), (b, v) in zip(HOP_SHARE[:-1], HOP_SHARE[1:]):
        if n <= b:
            return u + (v - u) * (n - a) / (b - a)
    return 0.05


def allowed_loss(preset):
    p = PRESETS[preset]
    return p["ceil"] if p.get("nr") else p["tx"] - p["sens"]


def preset_rate(preset, loss_db, fade=FADE):
    p = PRESETS[preset]
    if p.get("nr"):
        return rate_bps(loss_db, fade=fade, **NR_PRESET_RATE)
    return p["bps"] if p["tx"] - p["sens"] - loss_db >= fade else 0.0
