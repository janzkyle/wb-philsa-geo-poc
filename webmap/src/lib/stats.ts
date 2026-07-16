// Per-AOI temporal zonal statistics for the time-series "Window average"
// feature: the mean of a single-band index over EACH uploaded area (its polygon
// or MultiPolygon), once per acquisition date, plus that area's across-dates
// average. The index is measured over each area's own geometry, never blended
// across areas — so the result is an area × date matrix, one row per area per
// date, exported as CSV.
//
// Computed by TiTiler's /cog/statistics endpoint straight from the silver COGs
// on R2 (no backend of ours involved). Nodata (declared in the COGs) is masked
// server-side, so out-of-swath pixels never pollute a mean and instead show up
// as reduced coverage.
//
// A date may stitch several granule COGs; each granule is queried with only the
// areas its bbox intersects (a polygon fully outside a COG would fail the whole
// TiTiler request), and an area split across granules (or a MultiPolygon whose
// fields fall in different granules) is pooled back together, weighted by
// valid-pixel count. TiTiler already returns one statistics block per feature,
// so keeping areas separate is free — we simply don't merge them.

import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import { TITILER } from "../config";
import { searchStac } from "./stac";
import { geojsonBbox } from "./geojson";
import type { Bbox } from "../state/mapStore";

export class StatsError extends Error {}

// One acquisition date's statistics for ONE area over its footprint.
export interface AreaDateStat {
  date: string;
  mean: number;
  min: number;
  max: number;
  std: number;
  // Valid-data coverage of the area on this date (0–100): how much of the
  // footprint the swath actually observed (cloud/swath gaps drop it). A
  // decimation-robust ratio from TiTiler's valid_percent, not a raw pixel
  // count — see the module note on why counts aren't comparable across areas.
  coveragePct: number;
  granules: number; // COGs that contributed valid pixels
}

// One area's whole time series over the window.
export interface AreaStats {
  id: string; // from the feature's id / a property / else aoi_N
  areaHa?: number; // area context, when the upload carries it
  rows: AreaDateStat[]; // dates WITH coverage, ascending
  average: number; // mean of rows' means (dates weigh equally); NaN if never covered
  skipped: string[]; // window dates with no coverage for this area
}

export interface TemporalStats {
  areas: AreaStats[]; // one per input polygon/MultiPolygon feature, input order
  dates: string[]; // the requested window, ascending
}

// Soft cap on area count: TiTiler computes stats per feature per COG, so
// thousands of areas × dates would grind for minutes server-side.
const MAX_AREAS = 500;
// Dates processed in parallel. Each date is 1–3 statistics POSTs, so this keeps
// at most ~9 requests in flight against the single-process tiler.
const DATE_CONCURRENCY = 3;
// Cap the raster read per request — TiTiler decimates through the COG overviews,
// keeping large-area requests fast at negligible cost to the mean.
const MAX_READ_SIZE = 1024;

// Property keys checked (in order) for a stable area identifier before falling
// back to a positional label.
const ID_KEYS = ["aoi_id", "parcel_id", "id", "name", "label", "OBJECTID", "fid"];

function featureId(f: Feature, i: number): string {
  if (f.id !== undefined && f.id !== null && f.id !== "") return String(f.id);
  const p = (f.properties ?? {}) as Record<string, unknown>;
  for (const k of ID_KEYS) {
    const v = p[k];
    if (v !== undefined && v !== null && v !== "") return String(v);
  }
  return `aoi_${i + 1}`;
}

function featureAreaHa(f: Feature): number | undefined {
  const v = (f.properties ?? {})["area_ha"];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

interface Area {
  feature: Feature<Polygon | MultiPolygon>;
  bbox: Bbox;
  id: string;
  areaHa?: number;
}

const boxesIntersect = (a: Bbox, b: Bbox): boolean =>
  a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

// One band's entry in TiTiler's statistics response (`count` = valid pixels,
// `valid_percent` = valid / read-window).
interface BandStats {
  min: number;
  max: number;
  mean: number;
  std: number;
  count: number;
  valid_percent?: number;
}

// POST the features to /cog/statistics for one COG. TiTiler echoes the
// FeatureCollection with `properties.statistics` injected per feature; we return
// the first band's stats in input order (null where nothing usable).
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

// Running pool of one area's granule stats for a single date.
interface Accum {
  wSum: number;
  sqSum: number;
  w: number;
  min: number;
  max: number;
  covWSum: number; // Σ valid_percent · count
  covW: number; // Σ count
  granules: number;
}

// Per-area pooled statistics for one date, aligned with `areas` (null where an
// area had no valid pixels that day — swath missed it or it was fully masked).
async function statsForDate(
  collection: string,
  date: string,
  areas: Area[],
  aoiBbox: Bbox,
): Promise<(AreaDateStat | null)[]> {
  const items = await searchStac({ collections: [collection], datetime: date, limit: 100 });
  const granules = items.filter(
    (i) => i.cogHref && (!i.bbox || boxesIntersect(i.bbox, aoiBbox)),
  );

  // Query each granule with only the areas it covers, in parallel, then fold
  // the per-feature results back onto their area index.
  const perGranule = await Promise.all(
    granules.map(async (g) => {
      const idxs = areas
        .map((_, i) => i)
        .filter((i) => !g.bbox || boxesIntersect(areas[i].bbox, g.bbox!));
      if (!idxs.length) return { idxs, stats: [] as (BandStats | null)[] };
      const stats = await granuleStats(g.cogHref!, idxs.map((i) => areas[i].feature));
      return { idxs, stats };
    }),
  );

  const acc: (Accum | null)[] = areas.map(() => null);
  for (const { idxs, stats } of perGranule) {
    idxs.forEach((fi, k) => {
      const s = stats[k];
      if (!s) return;
      const a =
        acc[fi] ??
        (acc[fi] = {
          wSum: 0,
          sqSum: 0,
          w: 0,
          min: Infinity,
          max: -Infinity,
          covWSum: 0,
          covW: 0,
          granules: 0,
        });
      a.wSum += s.mean * s.count;
      a.sqSum += (s.std * s.std + s.mean * s.mean) * s.count;
      a.w += s.count;
      if (s.min < a.min) a.min = s.min;
      if (s.max > a.max) a.max = s.max;
      a.covWSum += (s.valid_percent ?? 100) * s.count;
      a.covW += s.count;
      a.granules++;
    });
  }

  return acc.map((a) => {
    if (!a || a.w <= 0) return null;
    const mean = a.wSum / a.w;
    return {
      date,
      mean,
      min: a.min,
      max: a.max,
      std: Math.sqrt(Math.max(0, a.sqSum / a.w - mean * mean)),
      coveragePct: a.covW > 0 ? a.covWSum / a.covW : 0,
      granules: a.granules,
    };
  });
}

// Per-area zonal mean of `collection` for every date in the window. Throws
// StatsError with a user-readable reason when the AOI is unusable or nothing
// overlaps any area.
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
  if (polys.length > MAX_AREAS) {
    throw new StatsError(
      `${polys.length} areas is too many for on-the-fly statistics (max ${MAX_AREAS}) — split the file or narrow the selection.`,
    );
  }
  const areas: Area[] = [];
  polys.forEach((f, i) => {
    const bbox = geojsonBbox({ type: "FeatureCollection", features: [f] });
    if (bbox) areas.push({ feature: f, bbox, id: featureId(f, i), areaHa: featureAreaHa(f) });
  });
  if (!areas.length) {
    throw new StatsError(
      "The chosen area contains no polygons — per-AOI statistics need polygon footprints.",
    );
  }
  const aoiBbox = areas.reduce<Bbox>(
    (acc, a) => [
      Math.min(acc[0], a.bbox[0]),
      Math.min(acc[1], a.bbox[1]),
      Math.max(acc[2], a.bbox[2]),
      Math.max(acc[3], a.bbox[3]),
    ],
    [Infinity, Infinity, -Infinity, -Infinity],
  );

  // perDate[dateIdx][areaIdx] — filled by a small pool of date workers.
  const perDate: (AreaDateStat | null)[][] = new Array(opts.dates.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < opts.dates.length) {
      if (opts.isCancelled?.()) throw new StatsError("cancelled");
      const i = next++;
      try {
        perDate[i] = await statsForDate(opts.collection, opts.dates[i], areas, aoiBbox);
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

  // Transpose date-major results into one time series per area.
  const out: AreaStats[] = areas.map((area, fi) => {
    const rows: AreaDateStat[] = [];
    const skipped: string[] = [];
    opts.dates.forEach((d, di) => {
      const s = perDate[di]?.[fi] ?? null;
      if (s) rows.push(s);
      else skipped.push(d);
    });
    return {
      id: area.id,
      areaHa: area.areaHa,
      rows,
      average: rows.length ? rows.reduce((x, r) => x + r.mean, 0) / rows.length : NaN,
      skipped,
    };
  });

  if (out.every((a) => a.rows.length === 0)) {
    throw new StatsError(
      "No valid pixels over any area on any date in the window — the imagery may not cover this area.",
    );
  }
  return { areas: out, dates: opts.dates };
}

// Render the result as CSV: `#` metadata lines, then one row per area per
// window date (blank stats where that date had no coverage, so every area × date
// cell is explicit), then a per-AOI summary block. Four decimals — well past
// the sensor noise floor of these indices.
export function statsToCsv(meta: {
  collectionLabel: string;
  unit: string;
  aoiName: string;
  stats: TemporalStats;
}): string {
  const f = (n: number) => (Number.isFinite(n) ? n.toFixed(4) : "");
  const c = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : "");
  const { areas, dates } = meta.stats;
  const uncovered = areas.filter((a) => a.rows.length === 0).map((a) => a.id);

  const lines = [
    `# ${meta.collectionLabel} — per-AOI zonal mean per acquisition date`,
    `# source: ${meta.aoiName}`,
    `# unit: ${meta.unit}`,
    `# areas: ${areas.length} · dates: ${dates.length}`,
  ];
  if (meta.unit.includes("dB")) {
    lines.push(
      "# note: means are computed in dB, i.e. the geometric mean of the linear ratio",
    );
  }
  lines.push(
    "# coverage_pct = valid-data % of the area on that date (cloud/swath gaps lower it)",
  );
  if (uncovered.length) {
    lines.push(`# no coverage on any date: ${uncovered.join(", ")}`);
  }

  // Full area × date matrix.
  lines.push("aoi_id,area_ha,date,mean,min,max,std,coverage_pct,granules");
  for (const a of areas) {
    const byDate = new Map(a.rows.map((r) => [r.date, r]));
    for (const d of dates) {
      const r = byDate.get(d);
      lines.push(
        [
          a.id,
          a.areaHa ?? "",
          d,
          r ? f(r.mean) : "",
          r ? f(r.min) : "",
          r ? f(r.max) : "",
          r ? f(r.std) : "",
          r ? c(r.coveragePct) : "0",
          r ? r.granules : "0",
        ].join(","),
      );
    }
  }

  // Per-AOI bottom line used to set each area's threshold.
  lines.push("");
  lines.push("# per-AOI summary");
  lines.push("aoi_id,area_ha,dates_covered,dates_total,average_mean,min_mean,max_mean");
  for (const a of areas) {
    const means = a.rows.map((r) => r.mean);
    lines.push(
      [
        a.id,
        a.areaHa ?? "",
        a.rows.length,
        dates.length,
        f(a.average),
        means.length ? f(Math.min(...means)) : "",
        means.length ? f(Math.max(...means)) : "",
      ].join(","),
    );
  }
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
