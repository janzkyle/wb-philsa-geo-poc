// Temporal zonal statistics for the time-series "Window average" feature: the
// mean of a single-band index over an area, once per acquisition date, plus
// the across-dates average — computed by TiTiler's /cog/statistics endpoint
// straight from the silver COGs on R2 (no backend of ours involved). Nodata
// (declared in the COGs) is masked server-side, so out-of-swath pixels never
// pollute a mean.
//
// A date may stitch several granule COGs; each granule is queried with only
// the AOI polygons its bbox intersects (a polygon fully outside a COG would
// fail the whole TiTiler request), and the per-feature results are pooled into
// one value per date, weighted by valid-pixel count (min/max take the
// extremes; std pools via E[x²] − mean²).

import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import { TITILER } from "../config";
import { searchStac } from "./stac";
import { geojsonBbox } from "./geojson";
import type { Bbox } from "../state/mapStore";

export class StatsError extends Error {}

// One acquisition date's pooled zonal statistics over the AOI.
export interface DateStat {
  date: string;
  mean: number;
  min: number;
  max: number;
  std: number;
  validPixels: number;
  granules: number; // COGs that contributed valid pixels
}

export interface TemporalStats {
  rows: DateStat[]; // ascending by date; only dates with valid pixels
  average: number; // arithmetic mean of the per-date means (dates weigh equally)
  skipped: string[]; // window dates with no valid pixels over the AOI
}

// Soft cap on AOI polygon count: TiTiler computes stats per feature per COG,
// so thousands of parcels × dates would grind for minutes server-side.
const MAX_AOI_FEATURES = 500;
// Dates processed in parallel. Each date is 1–3 statistics POSTs, so this
// keeps at most ~9 requests in flight against the single-process tiler.
const DATE_CONCURRENCY = 3;
// Cap the raster read per request — TiTiler decimates through the COG
// overviews, keeping large-AOI requests fast at negligible cost to the mean.
const MAX_READ_SIZE = 1024;

interface AoiFeature {
  feature: Feature<Polygon | MultiPolygon>;
  bbox: Bbox;
}

const boxesIntersect = (a: Bbox, b: Bbox): boolean =>
  a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

// One band's entry in TiTiler's statistics response (`count` = valid pixels).
interface BandStats {
  min: number;
  max: number;
  mean: number;
  std: number;
  count: number;
}

// POST the features to /cog/statistics for one COG. TiTiler echoes the
// FeatureCollection with `properties.statistics` injected per feature; we
// return the first band's stats in input order (null where nothing usable).
async function granuleStats(
  cogUrl: string,
  features: Feature[],
): Promise<(BandStats | null)[]> {
  const qs = `url=${encodeURIComponent(cogUrl)}&max_size=${MAX_READ_SIZE}`;
  const res = await fetch(`${TITILER}/cog/statistics?${qs}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "FeatureCollection", features }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new StatsError(`TiTiler statistics failed (${res.status}): ${detail}`);
  }
  const fc = (await res.json()) as {
    features?: { properties?: { statistics?: Record<string, BandStats> } }[];
  };
  return (fc.features ?? []).map((f) => {
    const bands = f.properties?.statistics;
    const first = bands ? bands[Object.keys(bands)[0]] : undefined;
    return first && Number.isFinite(first.mean) && first.count > 0 ? first : null;
  });
}

// Pool one date's granule × feature stats into a single DateStat, or null when
// no granule had valid pixels over the AOI (e.g. the swath missed it that day).
async function statsForDate(
  collection: string,
  date: string,
  aoi: AoiFeature[],
  aoiBbox: Bbox,
): Promise<DateStat | null> {
  const items = await searchStac({ collections: [collection], datetime: date, limit: 100 });
  const granules = items.filter(
    (i) => i.cogHref && (!i.bbox || boxesIntersect(i.bbox, aoiBbox)),
  );
  const perGranule = await Promise.all(
    granules.map((g) => {
      const feats = g.bbox ? aoi.filter((a) => boxesIntersect(a.bbox, g.bbox!)) : aoi;
      if (!feats.length) return Promise.resolve<(BandStats | null)[]>([]);
      return granuleStats(g.cogHref!, feats.map((a) => a.feature));
    }),
  );

  let wSum = 0;
  let sqSum = 0;
  let w = 0;
  let min = Infinity;
  let max = -Infinity;
  let granuleCount = 0;
  for (const stats of perGranule) {
    let contributed = false;
    for (const s of stats) {
      if (!s) continue;
      contributed = true;
      wSum += s.mean * s.count;
      sqSum += (s.std * s.std + s.mean * s.mean) * s.count;
      w += s.count;
      if (s.min < min) min = s.min;
      if (s.max > max) max = s.max;
    }
    if (contributed) granuleCount++;
  }
  if (w <= 0) return null;
  const mean = wSum / w;
  return {
    date,
    mean,
    min,
    max,
    std: Math.sqrt(Math.max(0, sqSum / w - mean * mean)),
    validPixels: Math.round(w),
    granules: granuleCount,
  };
}

// Zonal mean of `collection` over `aoi` for every date in the window, plus the
// across-dates average. Throws StatsError with a user-readable reason when the
// AOI is unusable or nothing overlaps it.
export async function computeTemporalStats(opts: {
  collection: string;
  dates: string[]; // the window, ascending
  aoi: FeatureCollection;
  onProgress?: (done: number, total: number) => void;
  isCancelled?: () => boolean;
}): Promise<TemporalStats> {
  const polys = opts.aoi.features.filter(
    (f): f is Feature<Polygon | MultiPolygon> =>
      f.geometry?.type === "Polygon" || f.geometry?.type === "MultiPolygon",
  );
  if (polys.length > MAX_AOI_FEATURES) {
    throw new StatsError(
      `${polys.length} polygons is too many for on-the-fly statistics (max ${MAX_AOI_FEATURES}) — upload a smaller boundary file or use the current view.`,
    );
  }
  const aoi: AoiFeature[] = [];
  for (const f of polys) {
    const bbox = geojsonBbox({ type: "FeatureCollection", features: [f] });
    if (bbox) aoi.push({ feature: f, bbox });
  }
  if (!aoi.length) {
    throw new StatsError(
      "The chosen area contains no polygons — statistics need a polygon boundary.",
    );
  }
  const aoiBbox = aoi.reduce<Bbox>(
    (acc, a) => [
      Math.min(acc[0], a.bbox[0]),
      Math.min(acc[1], a.bbox[1]),
      Math.max(acc[2], a.bbox[2]),
      Math.max(acc[3], a.bbox[3]),
    ],
    [Infinity, Infinity, -Infinity, -Infinity],
  );

  const results: (DateStat | null)[] = new Array(opts.dates.length).fill(null);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < opts.dates.length) {
      if (opts.isCancelled?.()) throw new StatsError("cancelled");
      const i = next++;
      try {
        results[i] = await statsForDate(opts.collection, opts.dates[i], aoi, aoiBbox);
      } catch (e) {
        next = opts.dates.length; // stop the other workers pulling new dates
        throw e;
      }
      opts.onProgress?.(++done, opts.dates.length);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(DATE_CONCURRENCY, opts.dates.length) }, worker),
  );

  const rows = results.filter((r): r is DateStat => r !== null);
  if (!rows.length) {
    throw new StatsError(
      "No valid pixels over the chosen area on any date in the window — the imagery may not cover it.",
    );
  }
  return {
    rows,
    average: rows.reduce((a, r) => a + r.mean, 0) / rows.length,
    skipped: opts.dates.filter((_, i) => results[i] === null),
  };
}

// Render the result as CSV: `#` metadata lines, one row per date, then a final
// `average` row. Four decimals — well past the sensor noise floor of these
// indices.
export function statsToCsv(meta: {
  collectionLabel: string;
  unit: string;
  aoiName: string;
  stats: TemporalStats;
}): string {
  const f = (n: number) => n.toFixed(4);
  const lines = [
    `# ${meta.collectionLabel} — zonal mean per acquisition date`,
    `# area: ${meta.aoiName}`,
    `# unit: ${meta.unit}`,
  ];
  if (meta.unit.includes("dB")) {
    lines.push(
      "# note: means are computed in dB, i.e. the geometric mean of the linear ratio",
    );
  }
  if (meta.stats.skipped.length) {
    lines.push(`# no coverage: ${meta.stats.skipped.join(", ")}`);
  }
  lines.push("date,mean,min,max,std,valid_pixels,granules");
  for (const r of meta.stats.rows) {
    lines.push(
      [r.date, f(r.mean), f(r.min), f(r.max), f(r.std), r.validPixels, r.granules].join(","),
    );
  }
  lines.push(`average,${f(meta.stats.average)},,,,,`);
  return lines.join("\n") + "\n";
}

// Client-side download — the CSV never touches a server.
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
