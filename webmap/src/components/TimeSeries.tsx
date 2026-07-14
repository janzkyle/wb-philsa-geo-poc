// Time-series driver: pick a temporal collection and a start/end date window,
// then scrub or animate through the acquisition dates inside that window. It
// reuses the same layer factory as everything else, but pins the result to ONE
// stable layer id ("timeseries") whose `frames` carry every window date —
// MapView pre-mounts those as hidden raster layers (FrameStack), so stepping a
// date is an opacity flip instead of a tile refetch. Playback is load-gated:
// each frame dwells FRAME_MS, then waits for the next frame's tiles to finish
// loading before advancing, so the animation can never outrun TiTiler.

import { useCallback, useEffect, useRef, useState } from "react";
import { useMap } from "react-map-gl/maplibre";
import type { FeatureCollection } from "geojson";
import { RASTER_DEFS } from "../config";
import { buildRasterLayer, LayerBuildError, tsFrameSourceId } from "../lib/layers";
import {
  computeTemporalStats,
  downloadCsv,
  StatsError,
  statsToCsv,
  type TemporalStats,
} from "../lib/stats";
import { useMapStore } from "../state/mapStore";
import type { MapLayer } from "../state/mapStore";

const TS_ID = "timeseries";
const FRAME_MS = 900; // minimum dwell per frame
const READY_POLL_MS = 120; // how often to re-check the next frame's tiles
const MAX_FRAME_WAIT_MS = 8000; // stuck-tile cap so playback can't freeze
// How many frames past the cursor to keep loading in the background. Small on
// purpose: TiTiler renders every tile on demand, so arming the whole window at
// once would starve the frame the user is actually looking at.
const FRAME_LOOKAHEAD = 2;

export default function TimeSeries({
  dates,
  onError,
}: {
  dates: Record<string, string[]>;
  onError: (msg: string) => void;
}) {
  const temporalDefs = RASTER_DEFS.filter((d) => d.temporal);
  const addLayer = useMapStore((s) => s.addLayer);
  const removeLayers = useMapStore((s) => s.removeLayers);
  const layers = useMapStore((s) => s.layers); // uploaded AOIs for the window average
  const { main: mapRef } = useMap(); // frame tile-load polling + viewport AOI

  const [collection, setCollection] = useState("");
  const [startIdx, setStartIdx] = useState(0); // window start (inclusive)
  const [endIdx, setEndIdx] = useState(0); // window end (inclusive)
  const [index, setIndex] = useState(0); // currently shown frame
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false); // building / prefetching
  // Bumped whenever a frame finishes building so the publish effect re-runs
  // and the frame stack fills in (the cache itself is a ref, invisible to React).
  const [cacheVersion, setCacheVersion] = useState(0);

  // Window-average state: AOI choice ("view" or a geojson-local layer id), the
  // computed stats (kept with the AOI name + unit so the CSV export matches
  // what was computed), and per-date progress. The run ref invalidates
  // in-flight computes when the collection, window, or AOI changes under them.
  const [aoiSel, setAoiSel] = useState("view");
  const [statsResult, setStatsResult] = useState<{
    stats: TemporalStats;
    aoiName: string;
    unit: string;
  } | null>(null);
  const [statsBusy, setStatsBusy] = useState(false);
  const [statsDone, setStatsDone] = useState(0);
  const [statsTotal, setStatsTotal] = useState(0);
  const statsRunRef = useRef(0);

  const cacheRef = useRef<Map<string, MapLayer>>(new Map());
  const addedRef = useRef(false); // the TS layer is on the map and owned by us
  const windowInitRef = useRef<string | null>(null); // collection whose window was seeded from its date list
  // Grow-only high-water mark of which frames are armed (mounted hidden on the
  // map): everything up to cursor + FRAME_LOOKAHEAD, reset when the window
  // changes. Maintained inside the publish effect.
  const armedHiRef = useRef(0);
  const armedWindowRef = useRef(""); // window signature the mark belongs to

  // Whether our layer is currently in the store — used to notice when another
  // driver (panel ✕, AI remove_layers) takes it off the map.
  const tsOnMap = useMapStore((s) => s.layers.some((l) => l.id === TS_ID));

  // dates[collection] is referentially stable once loaded — safe as an effect dep
  // (unlike `?? []`, which would mint a new array every render).
  const dateList = collection ? dates[collection] : undefined;
  const def = temporalDefs.find((d) => d.id === collection);
  const defLabel = def?.label ?? collection;
  const date = dateList?.[index];

  // Build (or reuse from cache) the raster for one date. Null on failure.
  const ensureBuilt = useCallback(
    async (d: string): Promise<MapLayer | null> => {
      const key = `${collection}:${d}`;
      const hit = cacheRef.current.get(key);
      if (hit) return hit;
      try {
        const layer = await buildRasterLayer(collection, d);
        cacheRef.current.set(key, layer);
        return layer;
      } catch (e) {
        onError(e instanceof LayerBuildError ? e.message : String(e));
        return null;
      }
    },
    [collection, onError],
  );

  // Make sure the frame under the cursor is built; bump cacheVersion once the
  // build lands so the publish effect below picks it up.
  useEffect(() => {
    if (!collection || !date || cacheRef.current.has(`${collection}:${date}`))
      return;
    void ensureBuilt(date).then((l) => {
      if (l) setCacheVersion((v) => v + 1);
    });
  }, [collection, date, ensureBuilt]);

  // Publish the stack under the fixed id: `tiles`/`label` describe the current
  // frame (what the panel and AI snapshot see), `frames` carries the window's
  // dates so MapView pre-mounts the armed ones hidden. Re-runs as builds land
  // (cacheVersion), filling frames in while scrubbing or playing. Until the
  // current frame is built the previous one stays visible — no blank flash.
  useEffect(() => {
    if (!collection || !date || !dateList) return;
    const cur = cacheRef.current.get(`${collection}:${date}`);
    if (!cur) return;
    const rel = index - startIdx;
    const windowKey = `${collection}:${startIdx}:${endIdx}`;
    if (armedWindowRef.current !== windowKey) {
      armedWindowRef.current = windowKey;
      armedHiRef.current = 0;
    }
    armedHiRef.current = Math.max(
      armedHiRef.current,
      Math.min(rel + FRAME_LOOKAHEAD, endIdx - startIdx),
    );
    const frames = dateList.slice(startIdx, endIdx + 1).map((d, fi) => {
      const built =
        fi <= armedHiRef.current
          ? cacheRef.current.get(`${collection}:${d}`)
          : undefined;
      return { key: d, tiles: built?.tiles ?? [], tileBounds: built?.tileBounds };
    });
    addLayer({
      ...cur,
      id: TS_ID,
      label: `${defLabel} — ${date}`,
      frames,
      frameIndex: rel,
    });
    addedRef.current = true;
  }, [collection, date, dateList, startIdx, endIdx, index, cacheVersion, defLabel, addLayer]);

  // If another driver removed our layer, reset the controls instead of
  // resurrecting it on the next scrub.
  useEffect(() => {
    if (!addedRef.current || tsOnMap) return;
    addedRef.current = false;
    setPlaying(false);
    setCollection("");
    setStartIdx(0);
    setEndIdx(0);
    setIndex(0);
    cacheRef.current.clear();
    statsRunRef.current++;
    setStatsBusy(false);
    setStatsResult(null);
  }, [tsOnMap]);

  // Seed the full window once the collection's dates arrive (they may still be
  // loading when the user picks the collection), and keep the window/cursor
  // valid if the list ever shrinks.
  useEffect(() => {
    if (!collection || !dateList) return;
    const last = Math.max(0, dateList.length - 1);
    if (windowInitRef.current !== collection && dateList.length) {
      windowInitRef.current = collection;
      setStartIdx(0);
      setEndIdx(last);
      setIndex(0);
      return;
    }
    setStartIdx((s) => Math.min(s, last));
    setEndIdx((e) => Math.min(e, last));
    setIndex((i) => Math.min(i, last));
  }, [collection, dateList]);

  // True once every tile source of a frame has finished loading its tiles for
  // the current viewport. Frames that never built (or aren't mounted yet)
  // report ready so a failed date can't wedge the loop.
  const frameReady = useCallback(
    (d: string): boolean => {
      const built = cacheRef.current.get(`${collection}:${d}`);
      if (!built) return true;
      const map = mapRef?.getMap();
      if (!map) return true;
      return built.tiles.every((_, i) => {
        const id = tsFrameSourceId(d, i);
        return !!map.getSource(id) && map.isSourceLoaded(id);
      });
    },
    [collection, mapRef],
  );

  // Playback: dwell FRAME_MS on the current frame, then advance once the next
  // frame's tiles are actually loaded (its source is pre-mounted hidden by
  // FrameStack, so it's been loading in the background). The cap advances
  // anyway if a tile stalls. Looping stays cheap: after the first pass every
  // frame is warm, so the loop runs at a steady FRAME_MS.
  useEffect(() => {
    if (!playing || !dateList || endIdx - startIdx < 1) return;
    const next = index >= endIdx ? startIdx : index + 1;
    const nextDate = dateList[next];
    const started = performance.now();
    let timer: number;
    const tick = () => {
      const waited = performance.now() - started;
      if (waited >= FRAME_MS && (frameReady(nextDate) || waited > MAX_FRAME_WAIT_MS)) {
        setIndex(next);
      } else {
        timer = window.setTimeout(tick, READY_POLL_MS);
      }
    };
    timer = window.setTimeout(tick, FRAME_MS);
    return () => window.clearTimeout(timer);
  }, [playing, index, startIdx, endIdx, dateList, frameReady]);

  // Remove the series layer if this panel ever unmounts.
  useEffect(
    () => () => {
      removeLayers([TS_ID]);
    },
    [removeLayers],
  );

  // Drop any computed/in-flight average — the collection, window, or AOI it
  // was computed over has changed.
  const invalidateStats = () => {
    statsRunRef.current++;
    setStatsBusy(false);
    setStatsResult(null);
  };

  const choose = (id: string) => {
    setPlaying(false);
    addedRef.current = false;
    removeLayers([TS_ID]);
    cacheRef.current.clear();
    invalidateStats();
    setCollection(id);
    const ds = id ? dates[id] ?? [] : [];
    const last = ds.length ? ds.length - 1 : 0;
    // If the dates haven't loaded yet, the seeding effect widens the window
    // once they arrive.
    windowInitRef.current = ds.length ? id : null;
    setStartIdx(0);
    setEndIdx(last);
    setIndex(0); // sit on the start of the window
  };

  // Window edits keep end ≥ start and pull the cursor back inside the window.
  const changeStart = (i: number) => {
    setPlaying(false);
    invalidateStats();
    const newEnd = Math.max(endIdx, i);
    setStartIdx(i);
    setEndIdx(newEnd);
    setIndex((x) => Math.min(newEnd, Math.max(i, x)));
  };

  const changeEnd = (i: number) => {
    setPlaying(false);
    invalidateStats();
    const newStart = Math.min(startIdx, i);
    setStartIdx(newStart);
    setEndIdx(i);
    setIndex((x) => Math.min(i, Math.max(newStart, x)));
  };

  const togglePlay = async () => {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (!dateList || endIdx - startIdx < 1) return;
    // Prebuild every frame in the window (STAC search + mosaic probe per date)
    // so playback only ever waits on tiles, then publish the lot.
    setBusy(true);
    await Promise.all(
      dateList.slice(startIdx, endIdx + 1).map((d) => ensureBuilt(d)),
    );
    setCacheVersion((v) => v + 1);
    setBusy(false);
    setPlaying(true);
  };

  const step = (delta: number) => {
    setPlaying(false);
    setIndex((i) => Math.min(endIdx, Math.max(startIdx, i + delta)));
  };

  // --- per-farm window average ----------------------------------------------
  // Mean of the index over EACH farm (upload feature) for every date in the
  // window (TiTiler statistics over the COGs), plus each farm's across-dates
  // average — PCIC's per-farm index unit, exported as a farm × date CSV. AOI is
  // either an uploaded polygon layer (many farms) or the current viewport (one).

  const uploads = layers.filter((l) => l.kind === "geojson-local" && l.geojson);
  // Fall back to the viewport if the selected upload has been removed.
  const aoiValue =
    aoiSel === "view" || uploads.some((u) => u.id === aoiSel) ? aoiSel : "view";

  const computeStats = async () => {
    if (!dateList || !def?.statsUnit) return;
    let aoi: FeatureCollection;
    let aoiName: string;
    if (aoiValue === "view") {
      const b = mapRef?.getMap()?.getBounds();
      if (!b) return;
      const [w, s, e, n] = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
      aoi = {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            id: "current view",
            properties: {},
            geometry: {
              type: "Polygon",
              coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
            },
          },
        ],
      };
      aoiName = "current view";
    } else {
      const upload = uploads.find((u) => u.id === aoiValue);
      if (!upload?.geojson) return;
      aoi = upload.geojson;
      aoiName = upload.label;
    }
    const windowDates = dateList.slice(startIdx, endIdx + 1);
    const run = ++statsRunRef.current;
    setStatsResult(null);
    setStatsBusy(true);
    setStatsDone(0);
    setStatsTotal(windowDates.length);
    try {
      const stats = await computeTemporalStats({
        collection,
        dates: windowDates,
        aoi,
        isCancelled: () => statsRunRef.current !== run,
        onProgress: (done) => {
          if (statsRunRef.current === run) setStatsDone(done);
        },
      });
      if (statsRunRef.current === run)
        setStatsResult({ stats, aoiName, unit: def.statsUnit });
    } catch (e) {
      if (statsRunRef.current === run)
        onError(e instanceof StatsError ? e.message : String(e));
    } finally {
      if (statsRunRef.current === run) setStatsBusy(false);
    }
  };

  const exportCsv = () => {
    if (!statsResult || !dateList) return;
    const csv = statsToCsv({
      collectionLabel: defLabel,
      unit: statsResult.unit,
      aoiName: statsResult.aoiName,
      stats: statsResult.stats,
    });
    const slug =
      statsResult.aoiName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "aoi";
    downloadCsv(
      `${collection}_${slug}_${dateList[startIdx]}_${dateList[endIdx]}_per-farm.csv`,
      csv,
    );
  };

  const clear = () => {
    setPlaying(false);
    addedRef.current = false;
    removeLayers([TS_ID]);
    invalidateStats();
    setCollection("");
    setStartIdx(0);
    setEndIdx(0);
    setIndex(0);
    cacheRef.current.clear();
  };

  return (
    <div className="timeseries">
      <div className="addrow">
        <span className="addlabel">Collection</span>
        <select value={collection} onChange={(e) => choose(e.target.value)}>
          <option value="">— choose —</option>
          {temporalDefs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
        {collection && (
          <button type="button" onClick={clear} title="Clear time series">
            Clear
          </button>
        )}
      </div>

      {collection &&
        (dateList && dateList.length ? (
          <div className="ts-controls">
            <div className="ts-range">
              <label>
                Start
                <select
                  value={startIdx}
                  onChange={(e) => changeStart(+e.target.value)}
                >
                  {dateList.map((d, i) => (
                    <option key={d} value={i} disabled={i > endIdx}>
                      {d}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                End
                <select
                  value={endIdx}
                  onChange={(e) => changeEnd(+e.target.value)}
                >
                  {dateList.map((d, i) => (
                    <option key={d} value={i} disabled={i < startIdx}>
                      {d}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="ts-transport">
              <button
                type="button"
                className="mini"
                onClick={() => step(-1)}
                disabled={index <= startIdx || busy}
                title="Previous date"
              >
                ◀
              </button>
              <button
                type="button"
                className="mini"
                onClick={togglePlay}
                disabled={busy || endIdx - startIdx < 1}
                title={playing ? "Pause" : "Play"}
              >
                {busy ? "…" : playing ? "❚❚" : "▶"}
              </button>
              <button
                type="button"
                className="mini"
                onClick={() => step(1)}
                disabled={index >= endIdx || busy}
                title="Next date"
              >
                ▶
              </button>
              <span className="ts-date">
                {date} · {index - startIdx + 1}/{endIdx - startIdx + 1}
              </span>
            </div>

            <input
              type="range"
              min={startIdx}
              max={endIdx}
              step={1}
              value={index}
              title="Scrub date"
              onChange={(e) => {
                setPlaying(false);
                setIndex(+e.target.value);
              }}
            />

            {def?.statsUnit && (
              <div className="ts-stats">
                <span
                  className="ts-statslabel"
                  title="Averages the index over each farm's footprint for every date in the window (one row per farm per date), then exports the farm × date table as CSV. Upload your farm polygons under Add data; the current map view works as a single area."
                >
                  Per-farm average — farms
                </span>
                <div className="ts-statsrow">
                  <select
                    value={aoiValue}
                    onChange={(e) => {
                      invalidateStats();
                      setAoiSel(e.target.value);
                    }}
                  >
                    <option value="view">Current map view</option>
                    {uploads.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={computeStats}
                    disabled={statsBusy}
                    title="Average the index over each farm's footprint for every date in the window"
                  >
                    {statsBusy ? `${statsDone}/${statsTotal}…` : "Compute"}
                  </button>
                </div>
                {statsResult &&
                  (() => {
                    const { farms } = statsResult.stats;
                    const covered = farms.filter((f) => f.rows.length > 0);
                    const uncovered = farms.length - covered.length;
                    const avgs = covered.map((f) => f.average);
                    const lo = avgs.length ? Math.min(...avgs) : NaN;
                    const hi = avgs.length ? Math.max(...avgs) : NaN;
                    return (
                      <div className="ts-statsresult">
                        <span>
                          {farms.length === 1 ? (
                            <>
                              mean <b>{avgs.length ? avgs[0].toFixed(2) : "—"}</b>{" "}
                              {statsResult.unit} · {covered[0]?.rows.length ?? 0}/
                              {statsResult.stats.dates.length} dates
                            </>
                          ) : (
                            <>
                              <b>{farms.length}</b> farms ·{" "}
                              {statsResult.stats.dates.length} dates · mean{" "}
                              <b>
                                {lo.toFixed(2)}–{hi.toFixed(2)}
                              </b>{" "}
                              {statsResult.unit}
                              {uncovered > 0 && ` · ${uncovered} without coverage`}
                            </>
                          )}
                        </span>
                        <button
                          type="button"
                          onClick={exportCsv}
                          title="Download the per-farm, per-date means (and each farm's average) as CSV"
                        >
                          Export CSV
                        </button>
                      </div>
                    );
                  })()}
              </div>
            )}
          </div>
        ) : (
          <span className="muted">loading dates…</span>
        ))}
    </div>
  );
}
