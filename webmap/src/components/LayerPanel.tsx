// The manual driver: browse the catalog, pick a date, add/remove/restyle
// layers. Everything goes through the same store + layer factory the AI's
// tools use, so the two drivers can never drift apart.

import { useEffect, useState } from "react";
import { RASTER_DEFS } from "../config";
import { collectionDates } from "../lib/stac";
import { buildRasterLayer, LayerBuildError } from "../lib/layers";
import { describePasses } from "../lib/passes";
import { useMapStore } from "../state/mapStore";
import LegendView from "./LegendView";

// Available acquisition dates per temporal collection, fetched once.
function useAvailableDates() {
  const [dates, setDates] = useState<Record<string, string[]>>({});
  useEffect(() => {
    let cancelled = false;
    for (const def of RASTER_DEFS.filter((d) => d.temporal)) {
      collectionDates(def.id)
        .then((ds) => {
          if (!cancelled) setDates((s) => ({ ...s, [def.id]: ds }));
        })
        .catch((e) => console.error(`dates(${def.id}):`, e));
    }
    return () => {
      cancelled = true;
    };
  }, []);
  return dates;
}

function AddRow({
  defId,
  label,
  temporal,
  dates,
  onError,
}: {
  defId: string;
  label: string;
  temporal: boolean;
  dates: string[];
  onError: (msg: string) => void;
}) {
  const addLayer = useMapStore((s) => s.addLayer);
  // empty = "latest available" — an explicit pick overrides it
  const [pickedDate, setPickedDate] = useState("");
  const [busy, setBusy] = useState(false);
  const date = pickedDate || (dates.length ? dates[dates.length - 1] : "");

  const add = async () => {
    setBusy(true);
    try {
      addLayer(await buildRasterLayer(defId, temporal ? date : undefined));
    } catch (e) {
      onError(e instanceof LayerBuildError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="addrow">
      <span className="addlabel">{label}</span>
      {temporal ? (
        dates.length ? (
          <select value={date} onChange={(e) => setPickedDate(e.target.value)}>
            {dates.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        ) : (
          <span className="muted">loading dates…</span>
        )
      ) : (
        <span className="muted">annual</span>
      )}
      <button
        type="button"
        disabled={busy || (temporal && !date)}
        onClick={add}
      >
        {busy ? "…" : "Add"}
      </button>
    </div>
  );
}

export default function LayerPanel() {
  const layers = useMapStore((s) => s.layers);
  const removeLayers = useMapStore((s) => s.removeLayers);
  const updateLayer = useMapStore((s) => s.updateLayer);
  const dates = useAvailableDates();
  const [error, setError] = useState("");
  const [legendOpen, setLegendOpen] = useState<Record<string, boolean>>({});

  const rasters = layers.filter((l) => l.kind !== "vector-pmtiles");
  const vectors = layers.filter((l) => l.kind === "vector-pmtiles");

  return (
    <div className="panel layerpanel">
      <h1>PhilSA POC — AI webmap</h1>

      <h2>On the map</h2>
      {rasters.length === 0 && (
        <p className="hint">
          No data layers yet — add one below, or just ask the assistant.
        </p>
      )}
      {rasters.map((l) => (
        <div key={l.id} className="layerrow">
          <div className="layerhead">
            <label>
              <input
                type="checkbox"
                checked={l.visible}
                onChange={(e) =>
                  updateLayer(l.id, { visible: e.target.checked })
                }
              />
              <span title={l.description}>{l.label}</span>
            </label>
            <span className="layerbtns">
              {l.legend && (
                <button
                  type="button"
                  className="mini"
                  title="Legend"
                  onClick={() =>
                    setLegendOpen((s) => ({ ...s, [l.id]: !s[l.id] }))
                  }
                >
                  {legendOpen[l.id] ? "▾" : "▸"}
                </button>
              )}
              <button
                type="button"
                className="mini"
                title="Remove layer"
                onClick={() => removeLayers([l.id])}
              >
                ✕
              </button>
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={l.opacity}
            title={`Opacity ${Math.round(l.opacity * 100)}%`}
            onChange={(e) => updateLayer(l.id, { opacity: +e.target.value })}
          />
          {l.passes && l.passes.length > 0 && (
            <div
              className={
                l.passes.length > 1 ? "passnote warn" : "passnote"
              }
              title={
                l.passes.length > 1
                  ? "This date stitches multiple satellite passes (different orbit/look geometry) into one mosaic — backscatter across them is not directly comparable."
                  : undefined
              }
            >
              {l.passes.length > 1 ? "⚠ " : ""}
              {describePasses(l.passes)}
            </div>
          )}
          {legendOpen[l.id] && l.legend && <LegendView legend={l.legend} />}
        </div>
      ))}

      <h2>Add data</h2>
      {error && (
        <p className="err" onClick={() => setError("")}>
          {error}
        </p>
      )}
      {RASTER_DEFS.map((d) => (
        <AddRow
          key={d.id}
          defId={d.id}
          label={d.label}
          temporal={d.temporal}
          dates={dates[d.id] ?? []}
          onError={setError}
        />
      ))}

      <h2>Boundaries</h2>
      {vectors.map((l) => (
        <label key={l.id} className="row">
          <input
            type="checkbox"
            checked={l.visible}
            onChange={(e) => updateLayer(l.id, { visible: e.target.checked })}
          />
          <span className="swatch" style={{ background: l.color }} />
          {l.label}
        </label>
      ))}

      <p className="hint">
        Rasters need the local STAC API (:8082) + TiTiler (:8083); the chat
        needs `npm run chat`. Boundaries stream from public R2.
      </p>
    </div>
  );
}
