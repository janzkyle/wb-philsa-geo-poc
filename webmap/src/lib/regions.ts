// Name → bbox lookup over the PH admin index (adm0–adm3, ~1,700 units) that
// build_admin_search_index.py publishes to public R2. Fetched once, cached.
// This is the whole implementation of the AI's resolve_region tool - region
// knowledge lives in this data, not in the model.

import { ADMIN_INDEX_URL } from "../config";
import type { Bbox } from "../state/mapStore";

export interface AdminUnit {
  name: string;
  tier: string; // "Country" | "Region" | "Province" | "City / Municipality"
  level: number; // 0..3
  pcode: string;
  bbox: Bbox;
}

interface RawEntry {
  name: string;
  tier: string;
  level: number;
  pcode: string;
  w: number;
  s: number;
  e: number;
  n: number;
}

let indexPromise: Promise<AdminUnit[]> | undefined;

export function loadAdminIndex(): Promise<AdminUnit[]> {
  indexPromise ??= fetch(ADMIN_INDEX_URL)
    .then((r) => {
      if (!r.ok) throw new Error(`admin index ${r.status}`);
      return r.json();
    })
    .then((raw: RawEntry[]) =>
      raw.map((e) => ({
        name: e.name,
        tier: e.tier,
        level: e.level,
        pcode: e.pcode,
        bbox: [e.w, e.s, e.e, e.n] as Bbox,
      })),
    )
    .catch((err) => {
      indexPromise = undefined; // allow retry on transient failure
      throw err;
    });
  return indexPromise;
}

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

// Rank matches: exact > starts-with > substring > all-query-tokens-present.
// Lower administrative levels win ties (a Region beats a same-named town).
export async function resolveRegion(
  query: string,
  level?: number,
): Promise<AdminUnit[]> {
  const units = await loadAdminIndex();
  const q = norm(query.trim());
  if (!q) return [];
  const tokens = q.split(/\s+/);

  const scored: { u: AdminUnit; score: number }[] = [];
  for (const u of units) {
    if (level !== undefined && u.level !== level) continue;
    const n = norm(u.name);
    let score = 0;
    if (n === q) score = 100;
    else if (n.startsWith(q)) score = 80;
    else if (n.includes(q)) score = 60;
    else if (tokens.every((t) => n.includes(t))) score = 40;
    if (score > 0) scored.push({ u, score: score - u.level });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5).map((s) => s.u);
}
