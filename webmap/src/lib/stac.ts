// Thin client over the pgSTAC API - shared by the layer panel and the AI's
// search_catalog tool. Responses are trimmed to what either driver needs;
// tool results in particular must stay token-light.

import { STAC_API } from "../config";
import { summarizePasses, type PassSummary } from "./passes";
import type { Bbox } from "../state/mapStore";

export interface StacItemLite {
  id: string;
  collection: string;
  date?: string; // YYYY-MM-DD
  datetime?: string; // full RFC 3339
  bbox?: Bbox;
  cogHref?: string; // the `data` asset, when present
}

export interface CollectionLite {
  id: string;
  title?: string;
  description?: string;
  extent?: { temporal?: (string | null)[][] };
}

const dayOf = (dt?: string) => (dt ? dt.slice(0, 10) : undefined);

interface StacFeature {
  id: string;
  collection?: string;
  bbox?: number[];
  properties?: { datetime?: string; start_datetime?: string };
  assets?: Record<string, { href?: string }>;
}

function toLite(f: StacFeature, fallbackCollection?: string): StacItemLite {
  const dt = f.properties?.datetime ?? f.properties?.start_datetime;
  return {
    id: f.id,
    collection: f.collection ?? fallbackCollection ?? "",
    date: dayOf(dt),
    datetime: dt,
    bbox: f.bbox?.length === 4 ? (f.bbox as Bbox) : undefined,
    cogHref: f.assets?.data?.href,
  };
}

export async function listCollections(): Promise<CollectionLite[]> {
  const res = await fetch(`${STAC_API}/collections`);
  if (!res.ok) throw new Error(`STAC /collections ${res.status}`);
  const body = await res.json();
  interface StacCollection {
    id: string;
    title?: string;
    description?: string;
    extent?: { temporal?: { interval?: (string | null)[][] } };
  }
  return ((body.collections ?? []) as StacCollection[]).map((c) => ({
    id: c.id,
    title: c.title,
    description: c.description,
    extent: { temporal: c.extent?.temporal?.interval },
  }));
}

export interface SearchParams {
  collections?: string[];
  bbox?: Bbox;
  datetime?: string; // "start/end" or single RFC 3339 / YYYY-MM-DD
  limit?: number;
}

// Normalize a YYYY-MM-DD (or bare range) into the RFC 3339 interval pgSTAC
// expects; full datetimes pass through untouched.
export function normalizeDatetime(dt?: string): string | undefined {
  if (!dt) return undefined;
  const expand = (d: string, end: boolean) =>
    /^\d{4}-\d{2}-\d{2}$/.test(d)
      ? `${d}T${end ? "23:59:59" : "00:00:00"}Z`
      : d;
  if (dt.includes("/")) {
    const [a, b] = dt.split("/");
    return `${a === ".." ? ".." : expand(a, false)}/${b === ".." ? ".." : expand(b, true)}`;
  }
  // single day → whole-day interval
  if (/^\d{4}-\d{2}-\d{2}$/.test(dt))
    return `${dt}T00:00:00Z/${dt}T23:59:59Z`;
  return dt;
}

export async function searchStac(p: SearchParams): Promise<StacItemLite[]> {
  const body: Record<string, unknown> = { limit: p.limit ?? 100 };
  if (p.collections?.length) body.collections = p.collections;
  if (p.bbox) body.bbox = p.bbox;
  const dt = normalizeDatetime(p.datetime);
  if (dt) body.datetime = dt;
  const res = await fetch(`${STAC_API}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`STAC /search ${res.status}`);
  const fc = await res.json();
  return ((fc.features ?? []) as StacFeature[]).map((f) => toLite(f));
}

// All items of one collection, following pgSTAC's `next` links so a growing
// archive doesn't silently truncate the date lists. Page cap bounds the worst
// case (20 × 200 = 4,000 items) - raise it if a collection ever outgrows that.
export async function collectionItems(
  collection: string,
): Promise<StacItemLite[]> {
  const out: StacItemLite[] = [];
  let url: string | undefined =
    `${STAC_API}/collections/${collection}/items?limit=200`;
  for (let page = 0; url && page < 20; page++) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`STAC ${collection}/items ${res.status}`);
    const fc = await res.json();
    out.push(
      ...((fc.features ?? []) as StacFeature[]).map((f) =>
        toLite(f, collection),
      ),
    );
    const next = ((fc.links ?? []) as { rel?: string; href?: string }[]).find(
      (l) => l.rel === "next",
    )?.href;
    // hrefs are normally absolute; resolve just in case a proxy makes them relative
    url = next ? new URL(next, `${STAC_API}/`).toString() : undefined;
  }
  return out;
}

// Distinct acquisition dates in a collection, ascending.
export async function collectionDates(collection: string): Promise<string[]> {
  const items = await collectionItems(collection);
  return [...new Set(items.map((i) => i.date).filter((d): d is string => !!d))].sort();
}

// Satellite passes behind each acquisition date. A date with >1 pass is one
// whose per-date mosaic combines separate overpasses (different satellite/orbit/
// look geometry) - callers use this to warn that the mosaic isn't a single
// coherent observation.
export async function collectionPassesByDate(
  collection: string,
): Promise<Record<string, PassSummary[]>> {
  const items = await collectionItems(collection);
  const byDate: Record<string, StacItemLite[]> = {};
  for (const it of items) {
    if (it.date) (byDate[it.date] ??= []).push(it);
  }
  const out: Record<string, PassSummary[]> = {};
  for (const [date, its] of Object.entries(byDate)) out[date] = summarizePasses(its);
  return out;
}
