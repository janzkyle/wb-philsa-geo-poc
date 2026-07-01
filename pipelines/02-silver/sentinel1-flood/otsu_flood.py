#!/usr/bin/env python3
"""
otsu_flood.py — classify open water / flood from a Sentinel-1 VV backscatter (dB) COG.

Reads the silver VV-dB raster (built by ../sentinel1-sar/build_sar.sh) and emits a
single-band Byte mask:  1 = water, 0 = land, 2 = permanent water, 255 = nodata.

Physical basis: smooth open water specularly reflects the radar pulse away from the
sensor, so it returns very low backscatter (dark) in VV dB. Flooded land therefore
appears as an anomalously dark patch. We split dark-from-bright with a threshold:

  --method otsu  (default)  global Otsu threshold over the valid-pixel histogram,
                            clamped to a plausible water window so a mostly-land
                            scene doesn't push the split into the land mode.
  --method fixed --threshold -17   a fixed dB cut (skip Otsu).

This is the POC route. It is NOT a validated flood product — no radiometric
calibration, speckle filtering or terrain correction, and SAR shadow / smooth dry
surfaces (roads, tarmac, dry sand) can read as false water. Pair it with the
authoritative Copernicus EMS / GFM layer. Optional masks reduce obvious errors:

  --perm-water <raster>   1 = permanent water; flagged separately (value 2) so the
                          *new* flood footprint (value 1) is distinguishable.
  --min-db <float>        pixels below this dB are treated as shadow/no-data, not
                          water (default -28).

The dB grid is data-driven: the histogram range and the threshold clamp are
derived from the scene's own statistics, so this works whether the input is
calibrated sigma0 (water ~ negative dB) or the uncalibrated 10*log10(DN^2) the
silver SAR builder emits (water ~ low positive dB, scene range ~25-57 dB). Water
is always the dark/low-backscatter mode (flood = dB <= threshold).

Processing is block-wise (a strip of rows at a time) so full-size GRD scenes
(~28k x 21k px) classify in bounded memory. Requires GDAL Python bindings (osgeo)
+ numpy — same stack as gdal_calc.py.
"""
import argparse
import sys

import numpy as np
from osgeo import gdal

gdal.UseExceptions()

WATER, LAND, PERM, NODATA = 1, 0, 2, 255
HIST_BINS = 512        # histogram resolution over the data-driven dB range
STRIP_ROWS = 2048      # rows per block — ~0.23 GB/float32 strip at 28k cols
CLAMP_STD = 3.0        # default Otsu clamp: [mean - CLAMP_STD*std, mean] (dark side)


def otsu_from_hist(hist, centers):
    """Classic Otsu on a precomputed histogram: the cut maximising between-class var."""
    w = hist.astype("float64")
    total = w.sum()
    if total == 0:
        return float(centers[len(centers) // 2])
    wsum = w.cumsum()
    msum = (w * centers).cumsum()
    grand = msum[-1]
    w0 = wsum
    w1 = total - w0
    valid = (w0 > 0) & (w1 > 0)
    mu0 = np.divide(msum, w0, out=np.zeros_like(msum), where=w0 > 0)
    mu1 = np.divide(grand - msum, w1, out=np.zeros_like(msum), where=w1 > 0)
    between = w0 * w1 * (mu0 - mu1) ** 2
    between[~valid] = -1
    return float(centers[int(np.argmax(between))])


def open_band(path):
    ds = gdal.Open(path)
    if ds is None:
        sys.exit(f"!! cannot open {path}")
    return ds, ds.GetRasterBand(1)


def iter_strips(h, step=STRIP_ROWS):
    y = 0
    while y < h:
        yield y, min(step, h - y)
        y += step


def valid_mask(db, nodata, min_db):
    m = np.isfinite(db)
    if nodata is not None:
        m &= db != nodata
    if min_db is not None:
        m &= db > min_db  # optional shadow / extreme-dark floor
    return m


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src", help="input VV backscatter dB COG/GeoTIFF")
    ap.add_argument("dst", help="output Byte flood mask GeoTIFF")
    ap.add_argument("--method", choices=["sigma", "otsu", "fixed"], default="sigma",
                    help="sigma = mean-k*std (default; robust on unimodal SAR); "
                         "otsu = histogram split (needs a distinct water mode); "
                         "fixed = --threshold")
    ap.add_argument("--threshold", type=float, default=None,
                    help="fixed dB cut (required for --method fixed)")
    ap.add_argument("--k", type=float, default=2.0,
                    help="sigma method: dark cut at mean - k*std (default 2.0)")
    ap.add_argument("--min-db", type=float, default=None,
                    help="optional dB floor: below this = shadow/no-data, not water")
    ap.add_argument("--water-window", type=float, nargs=2, default=None,
                    metavar=("LO", "HI"),
                    help="otsu method: clamp the threshold to this dB window "
                         "(default: data-driven [mean-3*std, mean])")
    ap.add_argument("--perm-water", help="optional 1=permanent-water mask raster")
    args = ap.parse_args()

    ds, band = open_band(args.src)
    nodata = band.GetNoDataValue()
    w, h = ds.RasterXSize, ds.RasterYSize

    # ---- threshold ----
    # Stats are approximate (from overviews) and cheap; they set both the sigma cut
    # and the Otsu histogram range, so this adapts to calibrated OR uncalibrated dB.
    if args.method == "fixed":
        if args.threshold is None:
            sys.exit("!! --method fixed requires --threshold")
        thr = args.threshold
    else:
        bmin, bmax, bmean, bstd = band.GetStatistics(True, True)
        print(f">> scene dB: min={bmin:.1f} max={bmax:.1f} mean={bmean:.1f} std={bstd:.1f}",
              file=sys.stderr)
        if args.method == "sigma":
            # water = the dark low tail, k std below the (land-dominated) mean. Robust
            # when there is no distinct water mode for Otsu to find (the common case on
            # uncalibrated, mostly-land scenes — Otsu would just return ~the mean).
            thr = bmean - args.k * bstd
        else:  # otsu — only sensible when water is a substantial, distinct mode
            lo, hi = args.water_window if args.water_window else (bmean - CLAMP_STD * bstd, bmean)
            edges = np.linspace(bmin, bmax, HIST_BINS + 1)
            centers = (edges[:-1] + edges[1:]) / 2.0
            hist = np.zeros(HIST_BINS, dtype="int64")
            for y, n in iter_strips(h):
                db = band.ReadAsArray(0, y, w, n).astype("float32")
                sample = db[valid_mask(db, nodata, args.min_db)]
                if sample.size:
                    hist += np.histogram(sample, bins=edges)[0]
            thr = min(max(otsu_from_hist(hist, centers), lo), hi)
    print(f">> threshold = {thr:.2f} dB ({args.method}); water = dB <= threshold",
          file=sys.stderr)

    # ---- output raster ----
    drv = gdal.GetDriverByName("GTiff")
    out = drv.Create(args.dst, w, h, 1, gdal.GDT_Byte,
                     options=["COMPRESS=DEFLATE", "TILED=YES"])
    out.SetGeoTransform(ds.GetGeoTransform())
    out.SetProjection(ds.GetProjection())
    oband = out.GetRasterBand(1)
    oband.SetNoDataValue(NODATA)

    pw_band = None
    if args.perm_water:
        pds, pw_band = open_band(args.perm_water)
        if (pds.RasterXSize, pds.RasterYSize) != (w, h):
            sys.exit("!! --perm-water raster must match the input grid")

    # classify + write, block by block (counts valid + water as it goes)
    water_px, valid_total = 0, 0
    for y, n in iter_strips(h):
        db = band.ReadAsArray(0, y, w, n).astype("float32")
        m = valid_mask(db, nodata, args.min_db)
        blk = np.full(db.shape, NODATA, dtype="uint8")
        blk[m] = np.where(db[m] <= thr, WATER, LAND)
        if pw_band is not None:
            pw = pw_band.ReadAsArray(0, y, w, n)
            blk[(blk == WATER) & np.isfinite(pw) & (pw == 1)] = PERM
        water_px += int((blk == WATER).sum())
        valid_total += int(m.sum())
        oband.WriteArray(blk, 0, y)
    out.FlushCache()
    out = None
    pct = 100.0 * water_px / valid_total if valid_total else float("nan")
    print(f">> flooded/water px = {water_px:,}"
          + (f" ({pct:.2f}% of valid)" if valid_total else ""), file=sys.stderr)
    print(f"+ wrote {args.dst}", file=sys.stderr)


if __name__ == "__main__":
    main()
