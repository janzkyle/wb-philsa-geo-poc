// Satellite "pass" metadata derived from a date's STAC granules.
//
// A per-date mosaic stitches every granule acquired that day into one layer.
// Adjacent frames of the SAME overpass (seconds apart) are contiguous and merge
// seamlessly - that's the point of the mosaic. But a single calendar date can
// also hold granules from DIFFERENT passes: another satellite (S1A vs S1D), a
// different orbit, or an ascending-vs-descending overpass. SAR backscatter
// depends on look geometry, so those are not directly comparable - one "date"
// is then really several observations. Summarising the passes behind a date
// lets both drivers (the layer panel and the AI) make the user aware of that.

import type { StacItemLite } from "./stac";

export interface PassSummary {
  platform: string; // "S1A", "S1D", "S2A", … ("?" when unknown)
  orbit?: string; // absolute orbit number, when encoded in the granule id
  time: string; // "HH:MM UTC" of the pass's first frame
  datetime?: string; // full RFC 3339 of the first frame (sort key)
  frames: number; // granules belonging to this pass
}

// Sentinel-1 product ids encode mission + acquisition, e.g.
//   S1A_IW_GRDH_1SDV_20260618T214655_20260618T214720_065029_082C11_233A_…
//        └mission                    └sensing-start   └stop  └abs-orbit
// The absolute-orbit field is what cleanly separates two same-evening passes
// (e.g. S1A orbit 065029 at 21:46 vs S1D orbit 003296 at 21:54).
const S1_RE = /(S1[A-D])_.*?_(\d{8}T\d{6})_\d{8}T\d{6}_(\d{6})_/;
const MISSION_RE = /\b(S[12][A-D])\b/;

function hhmm(datetime?: string): string {
  const t = datetime?.slice(11, 16); // "HH:MM" out of RFC 3339
  return t ? `${t} UTC` : "??:?? UTC";
}

interface ParsedFrame {
  platform: string;
  orbit?: string;
  datetime?: string;
  key: string; // frames sharing a key belong to the same pass
}

function parseFrame(item: StacItemLite): ParsedFrame {
  const dt = item.datetime;
  const s1 = S1_RE.exec(item.id);
  if (s1) {
    const [, platform, , orbit] = s1;
    return { platform, orbit, datetime: dt, key: `${platform}:${orbit}` };
  }
  // No orbit in the id (e.g. Sentinel-2): key on the acquisition minute, so
  // genuinely separate overpasses stay distinct while adjacent frames (seconds
  // apart, same minute) collapse into one pass.
  const platform = MISSION_RE.exec(item.id)?.[1] ?? "?";
  return { platform, datetime: dt, key: `${platform}:${dt?.slice(0, 16) ?? item.id}` };
}

// Distinct passes behind a set of same-date granules, earliest first.
export function summarizePasses(items: StacItemLite[]): PassSummary[] {
  const groups = new Map<string, ParsedFrame[]>();
  for (const it of items) {
    const f = parseFrame(it);
    const arr = groups.get(f.key);
    if (arr) arr.push(f);
    else groups.set(f.key, [f]);
  }
  const passes = [...groups.values()].map((frames) => {
    frames.sort((a, b) => (a.datetime ?? "").localeCompare(b.datetime ?? ""));
    const first = frames[0];
    return {
      platform: first.platform,
      orbit: first.orbit,
      time: hhmm(first.datetime),
      datetime: first.datetime,
      frames: frames.length,
    };
  });
  passes.sort((a, b) => (a.datetime ?? "").localeCompare(b.datetime ?? ""));
  return passes;
}

// One pass as a chip, e.g. "S1A 21:46 UTC (2 frames)".
export function formatPass(p: PassSummary): string {
  return `${p.platform} ${p.time}${p.frames > 1 ? ` (${p.frames} frames)` : ""}`;
}

// One-line summary of all passes behind a date, e.g.
//   "2 passes: S1A 21:46 UTC (2 frames) · S1D 21:54 UTC (2 frames)"
export function describePasses(passes: PassSummary[]): string {
  const n = passes.length;
  return `${n} pass${n === 1 ? "" : "es"}: ${passes.map(formatPass).join(" · ")}`;
}
