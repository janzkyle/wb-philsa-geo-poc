# PCIC × PhilSA Webmap — Process Use Cases

How the Philippine Crop Insurance Corporation (PCIC) can leverage the PhilSA
Earth-observation webmap to make its three core processes more efficient.

_Last updated: 2026-07-14_

---

## Context & priorities (from PCIC)

These answers reframe every recommendation below — they are the operating
assumptions for this document.

| Question | Answer |
|---|---|
| **Insurance model** | **Index-based / parametric** — payouts triggered by a satellite index, not by physical per-farm loss adjustment |
| **Index unit** | **The individual farm — its polygon (or MultiPolygon)**, *not* an administrative zone. The index is measured over each insured farm's own geometry. |
| **Crop focus** | **Mixed / all crops** — keep recommendations crop-agnostic |
| **Parcel data quality** | **Combination** — some GPS/GIS polygons, some point locations, some paper/non-spatial records |
| **Biggest bottlenecks to relieve** | **1. Field-inspection volume/cost** and **2. Claims turnaround time** |

### The key shift this drives

The model is **parametric** (a satellite index drives payouts, with no physical
loss adjustment), but the **index unit is the individual farm**: the index is
computed over each farm's own polygon and compared against that farm's own
threshold. When a farm's index breaches, **that farm pays** — no field visit, no
manual adjustment. Administrative boundaries are **not** the index unit; they
serve only as navigation, batching and reporting context.

**Why the farm is the right unit:** measuring the index over the actual insured
field — rather than a whole barangay — minimises **basis risk**, the gap between
the index and the farm's real loss, because nothing is averaged across unrelated
fields. A farm made of several disjoint fields is a single **MultiPolygon** and
resolves to a single index (verified: the tiler pools a MultiPolygon's parts
into one statistic), so one policy stays one row.

**Consequence for the mixed parcel data — completeness now matters.** Because the
unit is the farm's footprint, each insured farm needs a geometry to be indexed:

- **Polygon / MultiPolygon farms (GPS/GIS)** — indexed directly; the ideal path.
- **Point-only farms** — buffer the point to a nominal parcel (e.g. a square of
  average local farm size) to approximate a footprint; adds some error but keeps
  the farm inside the automated flow.
- **Paper / non-spatial records** — must be geolocated/digitised before a
  per-farm index can run; until then they stay on the manual path.

This corrects a tempting shortcut: farm-level indexing does **not** let PCIC
ignore parcel geometry — it makes geometry a prerequisite. What keeps it
tractable is that the webmap's *upload → area → per-farm index → CSV export*
tooling makes ingesting and operationalising those polygons cheap, and
point-buffering bridges the partial-data portfolio.

---

## What the webmap provides today

- **Farm parcels — the index unit.** Upload-your-own-GeoJSON farms (polygons and
  **MultiPolygons**); the map auto-computes each farm's `area_ha` (sum-insured
  input) and zooms to extent. ~69,000 OSM-derived farmland polygons ship as a
  reference layer. The **time-series tools average an index over each farm's
  geometry and export the per-farm results as CSV** — the operational core of the
  three processes below.
- **PH admin boundaries** — adm0–adm4 toggleable vector overlays. **Context
  only:** navigation, batching farms by municipality, and rolling per-farm
  results up for portfolio reporting. *Not* the index unit.
- **Satellite layers, each viewable on a specific date (time series):**
  - **Sentinel-2 True Colour** (10 m optical — daylight, cloud-free only)
  - **Sentinel-2 NDVI** (vegetation greenness/health; green = healthy, red = bare/water)
  - **Radar Vegetation (VH/VV)** (radar crop-growth index — rises with canopy,
    **works through cloud**; NDVI's wet-season sibling)
  - **Sentinel-1 SAR (VV)** (raw radar backscatter — **sees through cloud, day or
    night**; critical in wet-season PH)
  - **Flood extent** (radar-derived water mask — ⚠️ POC proxy, not yet validated)
  - **ESRI Land Cover 10 m 2025** (crops vs built-up vs water vs trees vs bare)
- **AI chat** — resolve place name → location, toggle layers, filter by area in plain language.

### Which layer answers which question

Each layer earns its place by answering a *different* PCIC question — none is
redundant. The flood mask and the two vegetation indices are **decision layers**
(they feed each farm's index and trigger); raw SAR and true colour are
**evidence/context layers** (they justify and communicate what the decision
layers claim); the farm parcels are the **unit** every decision is measured over,
and admin boundaries only **frame and aggregate** them.

| Layer | PCIC question it answers | How to read it | Process |
|---|---|---|---|
| **Farm parcels (upload + OSM)** | "Which farms am I insuring, over what footprint?" | **The index unit** — each polygon/MultiPolygon is the geometry every index and trigger is measured over; `area_ha` → sum-insured | All three |
| **Admin boundaries (adm0–adm4)** | "Where is this, and how do results roll up?" | Context for navigation, batching farms, and aggregating per-farm outcomes into reports — *not* the index unit | All three (context) |
| **ESRI Land Cover** | "Is this footprint actually cropland?" | Crop-class pixels confirm a farm polygon sits on crop (not built-up/water) and flag mixed footprints — a data-quality check on the parcel | Underwriting |
| **Sentinel-2 NDVI** | "Is this farm growing — or did it fail?" (optical) | Green = healthy canopy, red = bare/failed over the farm; sharpest signal but needs a cloud-free day | Post-plant · Claims · Underwriting (burn cost) |
| **Radar Vegetation (VH/VV)** | Same question, **through cloud** | Ratio rises with the farm's canopy; keeps post-plant checks and triggers working through the monsoon when NDVI has no clear view | Post-plant · Claims (trigger fallback) |
| **Flood extent** | "Did this farm flood?" (decision) | % of the farm's footprint flagged as water is the per-farm trigger input — ⚠️ POC proxy until a validated source backs it | Claims |
| **Sentinel-1 SAR (VV)** | "What did radar actually see over this farm?" (evidence) | Raw backscatter: dark = smooth/water, bright = rough/built-up — the layer behind the flood mask, shown when a payout is questioned; also all-weather situational view during a typhoon | Claims (evidence) |
| **Sentinel-2 True Colour** | "What does this farm actually look like?" | Natural-colour context for communication and orientation; daylight + cloud-free only | All three (context) |

Note the deliberate SAR pairing: **VV** carries the *absolute* radar signal
(water detection, evidence) while **VH/VV** cancels it to isolate *vegetation
structure* (crop index). Neither substitutes for the other.

---

## Process 1 — Policy Issuance / Underwriting

**Goal: register each farm's footprint and price its risk — desk-based, no field survey.**

- **Ingest & validate farm geometry.** Upload the farm polygons/MultiPolygons;
  the map computes each farm's `area_ha` (sum-insured) and lets you check the
  footprint against Land Cover (is it actually crop?). Point-only records are
  buffered to a nominal footprint; paper records are digitised here or flagged
  for it. This is where the mixed-quality portfolio gets turned into indexable
  geometry.
- **Per-farm burn-cost pricing.** Replay the NDVI / VH-VV / flood **time series**
  over each farm's polygon to build *that farm's* historical index distribution →
  set its trigger threshold and premium. The **window-average + CSV export**
  produces this per-farm index history directly (one row per farm per date).
  Basis risk is low because the index is measured over the actual field.
- **Sum-insured** rolls up from each farm's `area_ha`; admin boundaries are used
  only to batch farms and aggregate the portfolio for reporting.

## Process 2 — Post-plant Inspection

**Goal: confirm each farm planted, and open its risk window — remotely, in batch.**

- **Confirm planting per farm.** Green-up over each farm polygon — NDVI on clear
  days, the **Radar Vegetation (VH/VV) index** through cloud — confirms the farm
  was actually planted and *when*, setting that farm's coverage window. Run across
  the whole uploaded portfolio in a single pass (one CSV row per farm) instead of
  visiting fields one by one.
- **Radar is essential here.** Post-plant is wet season = cloud that blocks
  optical; the VH/VV index reads each farm's canopy growth through it (and raw
  SAR shows flooded-then-growing rice paddies cleanly).
- **Net effect:** a batch per-farm satellite check replaces per-farm site visits
  — the single biggest cut to field-inspection volume.

## Process 3 — Claims Processing

**Goal: automatic, per-farm satellite-triggered payouts — collapse turnaround time.**

- **The trigger *is* the farm's own index.** Area-average **NDVI drop**,
  **flood-extent %** of the farm's footprint, or **SAR-detected inundation** —
  each measured over the farm polygon. When a farm's index breaches its threshold,
  that farm pays — **no field visit, no manual adjustment** → this is what
  collapses claims turnaround.
- **Post-disaster batch run.** After a typhoon/drought, average the event-date
  layer (flood extent / NDVI / SAR) over every farm in the affected area, flag
  which farms breach their trigger, and drive payouts — with SAR keeping it
  working under typhoon cloud when optical is useless.
- **Transparent evidence.** The map view over the specific farm is the visual
  justification behind its automatic payout, reducing disputes.

---

## ⚠️ Honesty flags before go-live

- The current **flood layer is a POC proxy, not a validated product** (per the
  webmap config). Before it drives real parametric triggers, PCIC needs a
  validated flood source (e.g. Copernicus EMS / GFM) or ground calibration.
- **NDVI / SAR thresholds must be calibrated** against historical loss records
  before they can drive payouts — otherwise basis risk is unquantified.
- **Per-farm indexing requires per-farm geometry.** Point-only farms are
  approximated by buffering (some error); paper/non-spatial farms cannot be
  auto-indexed until geolocated. The share of the portfolio the automated flow
  can cover is bounded by how many farms have a usable footprint — geometry
  ingestion is a real prerequisite, not an afterthought.
- **Small-farm / coverage caveat.** A small farm may contain only a handful of
  satellite pixels, and a given date's swath or cloud gap may cover it only
  partly. Report each farm's **valid-data coverage %** alongside its index (a
  cloud/swath-robust ratio, unlike raw pixel counts) so low-confidence farms are
  flagged rather than silently trusted at farm scale.

---

## Bottleneck → mechanism summary

| Bottleneck | How the webmap relieves it |
|---|---|
| **Field-inspection volume/cost** | Batch per-farm satellite checks replace per-parcel field visits across all three processes; underwriting and post-plant become desk-based once farm geometry is ingested. |
| **Claims turnaround time** | Per-farm parametric triggers computed directly from EO layers over each farm's polygon → automatic payouts with no manual loss adjustment; SAR keeps assessment working under typhoon cloud. |
