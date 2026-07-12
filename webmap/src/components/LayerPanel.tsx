// The manual driver: browse the catalog, pick a date, add/remove/restyle
// layers. Everything goes through the same store + layer factory the AI's
// tools use, so the two drivers can never drift apart.

import { useEffect, useRef, useState } from "react";
import { RASTER_DEFS } from "../config";
import { collectionDates } from "../lib/stac";
import { buildRasterLayer, LayerBuildError } from "../lib/layers";
import {
  buildClipMaskLayer,
  buildGeojsonLayer,
  geojsonBbox,
  GeoJsonError,
  GEOJSON_COLORS,
  parseGeoJson,
} from "../lib/geojson";
import { describePasses } from "../lib/passes";
import { useMapStore } from "../state/mapStore";
import LegendView from "./LegendView";
import TimeSeries from "./TimeSeries";

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
      <span className="addlabel" title={label}>
        {label}
      </span>
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

// Load a local GeoJSON file and render it client-side — no server round-trip,
// mirroring TerriaJS' "Add data > upload". Reads the file in the browser, parses
// it, drops it in the store as a geojson-local layer, flies to its extent and —
// when the file contains polygons — adds a clip mask so the rasters read only
// inside the uploaded boundaries (its layer row un-clips: opacity / hide / ✕).
function UploadRow({ onError }: { onError: (msg: string) => void }) {
  const addLayer = useMapStore((s) => s.addLayer);
  const setViewBbox = useMapStore((s) => s.setViewBbox);
  const layers = useMapStore((s) => s.layers);
  const inputRef = useRef<HTMLInputElement>(null);

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset the input so picking the same file again re-fires onChange.
    e.target.value = "";
    if (!file) return;
    try {
      const fc = parseGeoJson(await file.text());
      if (fc.features.length === 0) {
        throw new GeoJsonError("No features in this GeoJSON.");
      }
      const color =
        GEOJSON_COLORS[
          layers.filter((l) => l.kind === "geojson-local").length %
            GEOJSON_COLORS.length
        ];
      const name = file.name.replace(/\.(geo)?json$/i, "");
      addLayer(buildGeojsonLayer(name, fc, color));
      const mask = buildClipMaskLayer(name, fc);
      if (mask) addLayer(mask);
      const bbox = geojsonBbox(fc);
      if (bbox) setViewBbox(bbox);
    } catch (err) {
      onError(err instanceof GeoJsonError ? err.message : String(err));
    }
  };

  return (
    <>
      <div className="addrow">
        <span className="addlabel">Local GeoJSON file</span>
        <input
          ref={inputRef}
          type="file"
          accept=".geojson,.json,application/geo+json,application/json"
          style={{ display: "none" }}
          onChange={onPick}
        />
        <button type="button" onClick={() => inputRef.current?.click()}>
          Upload
        </button>
      </div>
      <p className="hint">
        Uploaded polygons clip the imagery and can be picked as the area under
        “Time series” to average an index (e.g. radar vegetation) across dates
        and export the result as CSV.
      </p>
    </>
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
      <UploadRow onError={setError} />

      <h2>Time series</h2>
      <TimeSeries dates={dates} onError={setError} />

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
    </div>
  );
}
