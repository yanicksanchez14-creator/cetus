"""
Real ship traffic for Cetus "Ships as sensors" mode.

Downloads two consecutive days of AIS (the position beacons large ships must broadcast) from
NOAA/BOEM MarineCadastre.gov, keeps large commercial ships (cargo, tanker, passenger; >= 60 m) off
California, resamples each track to one position every 3 minutes and writes a compact file the app replays:

    src/assets/traffic.json   (~1-2 MB)

Why two days: the simulated voyage leaves Oakland at 06:00 local time (13:00 UTC) and takes ~23 h.

Run (from the cetus folder, in the Anaconda Prompt with the oceansound environment):
    python tools/fetch_traffic.py                      # default: 14-15 Aug 2024 (peak blue whale season)
    python tools/fetch_traffic.py --date 2024-07-10    # any other start date

Each daily file is a few hundred MB; the download is streamed to a temp file and deleted afterwards.
"""
import argparse
import json
import os
import tempfile
import zipfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import requests

URL = "https://coast.noaa.gov/htdata/CMSP/AISDataHandler/{y}/AIS_{y}_{m:02d}_{d:02d}.zip"
LAT_MIN, LAT_MAX = 32.4, 38.6       # San Diego .. north of San Francisco
LON_MIN, LON_MAX = -125.5, -117.0   # ~300 km offshore .. coast
STEP_S = 180                        # resample every 3 minutes
T0_HOUR_UTC = 13                    # voyage starts 06:00 PDT = 13:00 UTC
SPAN_H = 27                         # voyage (~23 h) + margin
MIN_LEN_M = 60
OUT = Path(__file__).resolve().parents[1] / "src" / "assets" / "traffic.json"
CACHE = Path(__file__).resolve().parents[1] / "data" / "ais"


def vessel_class(vt):
    if pd.isna(vt):
        return None
    vt = int(vt)
    if 70 <= vt <= 79 or vt in (1003, 1004, 1016):
        return "cargo"
    if 80 <= vt <= 89 or vt == 1024:
        return "tanker"
    if 60 <= vt <= 69 or vt == 1012:
        return "passenger"
    return None


def fetch_day(day: date) -> pd.DataFrame:
    CACHE.mkdir(parents=True, exist_ok=True)
    cached = CACHE / f"ca_{day:%Y%m%d}.csv"
    if cached.exists():
        print(f"  {day}: using cached {cached.name}")
        return pd.read_csv(cached)
    url = URL.format(y=day.year, m=day.month, d=day.day)
    print(f"  {day}: downloading {url}")
    with requests.get(url, stream=True, timeout=600) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length", 0))
        fd, tmp = tempfile.mkstemp(suffix=".zip")
        done = 0
        with os.fdopen(fd, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
                done += len(chunk)
                if total:
                    print(f"\r    {done / 1e6:,.0f} / {total / 1e6:,.0f} MB", end="", flush=True)
        print()
    try:
        parts = []
        with zipfile.ZipFile(tmp) as z:
            name = [n for n in z.namelist() if n.lower().endswith(".csv")][0]
            with z.open(name) as f:
                for chunk in pd.read_csv(f, chunksize=1_000_000, low_memory=False):
                    chunk.columns = [c.lower() for c in chunk.columns]
                    m = chunk.lat.between(LAT_MIN, LAT_MAX) & chunk.lon.between(LON_MIN, LON_MAX)
                    if m.any():
                        c = chunk.loc[m, ["mmsi", "basedatetime", "lat", "lon", "sog", "vesselname", "vesseltype", "length"]]
                        c = c[c.vesseltype.map(vessel_class).notna() & (c.length.fillna(0) >= MIN_LEN_M)]
                        parts.append(c)
        df = pd.concat(parts, ignore_index=True) if parts else pd.DataFrame()
        df.to_csv(cached, index=False)
        print(f"    kept {len(df):,} positions from {df.mmsi.nunique() if len(df) else 0} large ships")
        return df
    finally:
        os.remove(tmp)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default="2024-08-14", help="first UTC day (YYYY-MM-DD); the next day is fetched too")
    a = ap.parse_args()
    d0 = datetime.strptime(a.date, "%Y-%m-%d").date()
    print(f"Real ship traffic off California, {d0} and {d0 + timedelta(days=1)} (MarineCadastre AIS)")
    df = pd.concat([fetch_day(d0), fetch_day(d0 + timedelta(days=1))], ignore_index=True)
    if df.empty:
        raise SystemExit("No positions found - check the date.")
    df["t"] = pd.to_datetime(df.basedatetime, utc=True)
    t0 = datetime(d0.year, d0.month, d0.day, T0_HOUR_UTC, tzinfo=timezone.utc)
    df["ts"] = (df.t - pd.Timestamp(t0)).dt.total_seconds()
    df = df[(df.ts >= -1800) & (df.ts <= SPAN_H * 3600 + 1800)].sort_values(["mmsi", "ts"])
    grid = np.arange(0, SPAN_H * 3600 + 1, STEP_S)
    ships = []
    for mmsi, g in df.groupby("mmsi"):
        if len(g) < 5:
            continue
        ts, lat, lon, sog = g.ts.to_numpy(), g.lat.to_numpy(), g.lon.to_numpy(), g.sog.to_numpy()
        # present only where real reports exist within 20 min (no inventing positions across long gaps)
        idx = np.searchsorted(ts, grid)
        near = np.minimum(np.abs(ts[np.clip(idx, 0, len(ts) - 1)] - grid), np.abs(ts[np.clip(idx - 1, 0, len(ts) - 1)] - grid))
        ok = near <= 1200
        if ok.sum() < 5:
            continue
        la, lo, sp = np.interp(grid, ts, lat), np.interp(grid, ts, lon), np.interp(grid, ts, np.nan_to_num(sog))
        # split into continuous segments; delta-encode positions (1e-4 deg ~ 10 m) to keep the file small
        segs = []
        k = 0
        while k < len(grid):
            if not ok[k]:
                k += 1
                continue
            j = k
            while j + 1 < len(grid) and ok[j + 1]:
                j += 1
            if j - k >= 3:
                qlo = np.round(lo[k:j + 1] * 1e4).astype(int)
                qla = np.round(la[k:j + 1] * 1e4).astype(int)
                segs.append({
                    "s": int(k),
                    "lo": [int(qlo[0])] + np.diff(qlo).astype(int).tolist(),
                    "la": [int(qla[0])] + np.diff(qla).astype(int).tolist(),
                    "v": np.round(sp[k:j + 1]).astype(int).tolist(),
                })
            k = j + 1
        if not segs:
            continue
        last = g.iloc[-1]
        ships.append({
            "id": int(mmsi),
            "n": str(last.vesselname).title() if isinstance(last.vesselname, str) else "",
            "c": vessel_class(last.vesseltype),
            "L": int(last.length) if pd.notna(last.length) else 0,
            "seg": segs,
        })
    out = {
        "source": "NOAA/BOEM MarineCadastre.gov AIS (free public data)",
        "t0Utc": t0.isoformat(),
        "stepS": STEP_S,
        "steps": int(len(grid)),
        "box": [LON_MIN, LAT_MIN, LON_MAX, LAT_MAX],
        "ships": ships,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    n_by = pd.Series([s["c"] for s in ships]).value_counts().to_dict()
    print(f"\nSaved {OUT}  ({OUT.stat().st_size / 1e6:.1f} MB): {len(ships)} ships {n_by}")
    print("Done - tell Claude it finished.")


if __name__ == "__main__":
    main()
