// Time-series driver: pick a temporal collection and a start/end date window,
// then scrub or animate through the acquisition dates inside that window. It
// reuses the same layer factory as everything else, but pins the result to ONE
// stable layer id ("timeseries") so stepping a date swaps the raster in place
// instead of piling up a layer per date. Built layers are cached per date so
// scrubbing back and forth — and playback — don't rebuild.

import { useCallback, useEffect, useRef, useState } from "react";
import { RASTER_DEFS } from "../config";
import { buildRasterLayer, LayerBuildError } from "../lib/layers";
import { useMapStore } from "../state/mapStore";
import type { MapLayer } from "../state/mapStore";

const TS_ID = "timeseries";
const FRAME_MS = 900; // playback cadence

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

  const [collection, setCollection] = useState("");
  const [startIdx, setStartIdx] = useState(0); // window start (inclusive)
  const [endIdx, setEndIdx] = useState(0); // window end (inclusive)
  const [index, setIndex] = useState(0); // currently shown frame
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false); // building / prefetching

  const cacheRef = useRef<Map<string, MapLayer>>(new Map());
  const reqRef = useRef(0); // race guard so a slow build can't clobber a newer one
  const addedRef = useRef(false); // the TS layer is on the map and owned by us
  const windowInitRef = useRef<string | null>(null); // collection whose window was seeded from its date list

  // Whether our layer is currently in the store — used to notice when another
  // driver (panel ✕, AI remove_layers) takes it off the map.
  const tsOnMap = useMapStore((s) => s.layers.some((l) => l.id === TS_ID));

  // dates[collection] is referentially stable once loaded — safe as an effect dep
  // (unlike `?? []`, which would mint a new array every render).
  const dateList = collection ? dates[collection] : undefined;
  const defLabel =
    temporalDefs.find((d) => d.id === collection)?.label ?? collection;
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

  // Show the layer for the current index under the fixed id (swaps in place).
  useEffect(() => {
    if (!collection || !date) return;
    const req = ++reqRef.current;
    (async () => {
      const layer = await ensureBuilt(date);
      if (!layer || req !== reqRef.current) return; // superseded by a newer step
      addLayer({ ...layer, id: TS_ID, label: `${defLabel} — ${date}` });
      addedRef.current = true;
    })();
  }, [collection, date, defLabel, ensureBuilt, addLayer]);

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

  // Playback: advance the cursor within the window on an interval, looping.
  useEffect(() => {
    if (!playing || endIdx - startIdx < 1) return;
    const t = setInterval(
      () => setIndex((i) => (i >= endIdx ? startIdx : i + 1)),
      FRAME_MS,
    );
    return () => clearInterval(t);
  }, [playing, startIdx, endIdx]);

  // Remove the series layer if this panel ever unmounts.
  useEffect(
    () => () => {
      removeLayers([TS_ID]);
    },
    [removeLayers],
  );

  const choose = (id: string) => {
    setPlaying(false);
    addedRef.current = false;
    removeLayers([TS_ID]);
    cacheRef.current.clear();
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
    const newEnd = Math.max(endIdx, i);
    setStartIdx(i);
    setEndIdx(newEnd);
    setIndex((x) => Math.min(newEnd, Math.max(i, x)));
  };

  const changeEnd = (i: number) => {
    setPlaying(false);
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
    // Prebuild every frame in the window so playback doesn't stutter.
    setBusy(true);
    await Promise.all(
      dateList.slice(startIdx, endIdx + 1).map((d) => ensureBuilt(d)),
    );
    setBusy(false);
    setPlaying(true);
  };

  const step = (delta: number) => {
    setPlaying(false);
    setIndex((i) => Math.min(endIdx, Math.max(startIdx, i + delta)));
  };

  const clear = () => {
    setPlaying(false);
    addedRef.current = false;
    removeLayers([TS_ID]);
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
          </div>
        ) : (
          <span className="muted">loading dates…</span>
        ))}
    </div>
  );
}
