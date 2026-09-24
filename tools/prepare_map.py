"""
Build the map assets for the Whale Locator web app from GMRT bathymetry grids (ESRI ASCII).

Inputs  (data/raw/):  gmrt_california_*m.asc      whole-coast overview (optional but recommended)
                      gmrt_sf_monterey_*m.asc      detailed SF + Monterey (or gmrt_central_california_*m.asc)
                      gmrt_socal_*m.asc            detailed Santa Barbara Channel -> LA/Long Beach (optional)
Outputs (src/assets/):
    relief_<name>.webp   shaded-relief images (ocean colour ramp + hillshade), lon/lat aligned
    depth_<name>.bin     Int16 depth grids (m, negative = below sea level) for the simulation
    map_meta.json        bounds / sizes for every image + depth grid
    lines.json           coastline + depth contours (simplified), as [lon, lat] paths

Data: GMRT (Ryan et al. 2009, doi:10.1029/2008GC002332), Lamont-Doherty Earth Observatory, CC-BY 4.0.
Run:  python tools/prepare_map.py
"""
import json
import re
from pathlib import Path

import numpy as np
import pandas as pd
from PIL import Image
from matplotlib.colors import LightSource, LinearSegmentedColormap
from skimage import measure
from shapely.geometry import LineString, box
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "src" / "assets"
OUT.mkdir(parents=True, exist_ok=True)

MAX_IMG = {"california": 2400, "sf_monterey": 2400, "socal": 2400}
ENGINE_CELL_DEG = {"california": 0.017, "sf_monterey": 0.004, "socal": 0.004}   # ~1.6 km and ~400 m
CONTOURS = [-200, -1000, -2000, -3000, -4000]

# Ocean colour ramp: shallow shelf teal -> deep abyssal navy-black
OCEAN = LinearSegmentedColormap.from_list("ocean", [
    (0.00, "#2b6c7c"), (0.07, "#1f5669"), (0.20, "#15415a"), (0.42, "#0d2d47"),
    (0.70, "#081d33"), (1.00, "#040e1d")])


def read_asc(path):
    hdr = {}
    with open(path) as f:
        for _ in range(6):
            k, v = f.readline().split()
            hdr[k.lower()] = float(v)
    z = pd.read_csv(path, skiprows=6, header=None, sep=r"\s+", dtype=np.float32, engine="c").to_numpy()
    z = z[:, :int(hdr["ncols"])]
    z[z <= hdr["nodata_value"] + 1] = np.nan
    west, south, cs = hdr["xllcorner"], hdr["yllcorner"], hdr["cellsize"]
    north = south + cs * int(hdr["nrows"])
    east = west + cs * int(hdr["ncols"])
    return z, dict(west=west, east=east, south=south, north=north, cell=cs)   # row 0 = north


def find_grids():
    grids = {}
    for p in sorted(RAW.glob("gmrt_*m.asc")):
        m = re.match(r"gmrt_(.+)_(\d+)m\.asc", p.name)
        name = {"central_california": "sf_monterey"}.get(m.group(1), m.group(1))
        grids[name] = p
    return grids


def mask_delta(z, b):
    """The Sacramento-San Joaquin Delta islands are below sea level but are land (behind levees too thin for
    a 100 m grid). Treat shallow 'water' east of Suisun Bay as land so it isn't drawn as ocean."""
    ny, nx = z.shape
    lon = b["west"] + (np.arange(nx) + 0.5) * b["cell"]
    lat = b["north"] - (np.arange(ny) + 0.5) * b["cell"]
    LON, LAT = np.meshgrid(lon, lat)
    delta = (LON > -121.86) & (LAT > 37.75) & (LAT < 38.7) & (z > -20)
    z = z.copy()
    z[delta] = np.maximum(z[delta], 1.0)
    return z


def shade(z, cell_m):
    z = np.where(np.isnan(z), 0, z)
    ls = LightSource(azdeg=315, altdeg=40)
    ve = 0.16 if cell_m < 400 else 0.45
    hs = ls.hillshade(z, vert_exag=ve, dx=cell_m, dy=cell_m)
    ls2 = LightSource(azdeg=45, altdeg=50)
    hs2 = ls2.hillshade(z, vert_exag=ve, dx=cell_m, dy=cell_m)
    hs = 0.7 * hs + 0.3 * hs2
    depth = np.clip(-z, 0, 4600) / 4600
    rgb = OCEAN(np.sqrt(depth))[..., :3]
    ocean_rgb = rgb * (0.38 + 0.9 * hs[..., None])
    # land: dark graphite with soft relief, slightly warmer on high ground
    elev = np.clip(z, 0, 1500) / 1500
    land_base = np.stack([0.085 + 0.04 * elev, 0.09 + 0.035 * elev, 0.10 + 0.02 * elev], -1)
    land_rgb = land_base * (0.55 + 0.9 * hs[..., None])
    out = np.where((z >= 0)[..., None], land_rgb, ocean_rgb)
    return np.clip(out, 0, 1)


def lines_from_grid(z, b, levels, tol_deg):
    """Contour lines -> list of (level, LineString in lon/lat)."""
    ny, nx = z.shape
    zz = np.where(np.isnan(z), 0, z)
    out = []
    for lev in levels:
        for c in measure.find_contours(zz, lev):
            if len(c) < 8:
                continue
            lon = b["west"] + (c[:, 1] + 0.5) * b["cell"]
            lat = b["north"] - (c[:, 0] + 0.5) * b["cell"]
            ls = LineString(np.column_stack([lon, lat])).simplify(tol_deg, preserve_topology=False)
            if ls.length > tol_deg * 6:
                out.append((lev, ls))
    return out


def main():
    grids = find_grids()
    if not grids:
        raise SystemExit(f"No grids found in {RAW}")
    print("Grids:", {k: v.name for k, v in grids.items()})
    meta = {"images": [], "depth": [], "source": "GMRT (Lamont-Doherty Earth Observatory), CC-BY 4.0"}
    all_lines = []
    fine_boxes = []
    for name in ["california", "sf_monterey", "socal"]:
        if name not in grids:
            continue
        z, b = read_asc(grids[name])
        z = mask_delta(z, b)
        cell_m = b["cell"] * 111_000 * np.cos(np.radians((b["south"] + b["north"]) / 2))
        print(f"{name}: {z.shape}, cell ~{cell_m:.0f} m, depth {np.nanmin(z):.0f}..{np.nanmax(z):.0f} m")
        # --- shaded image ---
        img = (shade(z, cell_m) * 255).astype(np.uint8)
        if name != "california":
            # feather the edges so the detailed map blends into the overview map underneath
            ny_, nx_ = img.shape[:2]
            f = max(8, int(0.025 * max(ny_, nx_)))
            ry = np.minimum(np.arange(ny_), np.arange(ny_)[::-1])[:, None] / f
            rx = np.minimum(np.arange(nx_), np.arange(nx_)[::-1])[None, :] / f
            alpha = (np.clip(np.minimum(ry, rx), 0, 1) ** 1.5 * 255).astype(np.uint8)
            img = np.dstack([img, alpha])
        im = Image.fromarray(img)
        scale = min(1.0, MAX_IMG[name] / max(im.size))
        if scale < 1:
            im = im.resize((int(im.size[0] * scale), int(im.size[1] * scale)), Image.LANCZOS)
        f_img = OUT / f"relief_{name}.webp"
        im.save(f_img, "WEBP", quality=88, method=6)
        meta["images"].append({"name": name, "file": f_img.name, "bounds": [b["west"], b["south"], b["east"], b["north"]],
                               "size": im.size, "detail": name != "california"})
        # --- engine depth grid ---
        step = max(1, int(round(ENGINE_CELL_DEG[name] / b["cell"])))
        ny, nx = (z.shape[0] // step) * step, (z.shape[1] // step) * step
        zc = np.nanmedian(z[:ny, :nx].reshape(ny // step, step, nx // step, step), axis=(1, 3))
        zc = np.nan_to_num(zc, nan=-3000).clip(-32000, 32000).astype("<i2")
        f_bin = OUT / f"depth_{name}.bin"
        f_bin.write_bytes(zc.tobytes())
        meta["depth"].append({"name": name, "file": f_bin.name, "nx": zc.shape[1], "ny": zc.shape[0],
                              "west": b["west"], "north": b["north"], "cell": b["cell"] * step,
                              "detail": name != "california"})
        # --- vector lines ---
        tol = 0.0012 if name != "california" else 0.004
        lines = lines_from_grid(z, b, [0] + CONTOURS, tol)
        region = box(b["west"], b["south"], b["east"], b["north"])
        if name == "california":
            fine_boxes_placeholder = None
            all_lines += [(lev, ls, region) for lev, ls in lines]
        else:
            fine_boxes.append(region.buffer(-0.01))
            all_lines += [(lev, ls, None) for lev, ls in lines]
        print(f"  image {im.size}, depth grid {zc.shape}, {len(lines)} lines, "
              f"{f_img.stat().st_size / 1e3:.0f} kB img, {f_bin.stat().st_size / 1e3:.0f} kB depth")
    # drop overview lines inside detailed areas (the detailed ones are drawn instead)
    fine = unary_union(fine_boxes) if fine_boxes else None
    features = []
    for lev, ls, region in all_lines:
        geom = ls.difference(fine) if (fine is not None and region is not None) else ls
        for g in getattr(geom, "geoms", [geom]):
            if g.is_empty or g.length < 0.005:
                continue
            features.append({"level": int(lev), "path": [[round(x, 4), round(y, 4)] for x, y in g.coords]})
    (OUT / "lines.json").write_text(json.dumps(features, separators=(",", ":")))
    (OUT / "map_meta.json").write_text(json.dumps(meta, indent=1))
    print(f"lines.json: {len(features)} paths, {(OUT / 'lines.json').stat().st_size / 1e3:.0f} kB")


if __name__ == "__main__":
    main()
