// The manual driver: browse the catalog, pick a date, add/remove/restyle
// layers. Everything goes through the same store + layer factory the AI's
// tools use, so the two drivers can never drift apart.

import { useEffect, useRef, useState } from "react";
import { DATA_SOURCE, RASTER_DEFS, stacBrowserCollectionUrl } from "../config";
import { collectionDates, StacAccessDeniedError } from "../lib/stac";
import type { DateStatus } from "../lib/stac";
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

// Available acquisition dates per temporal collection, fetched once, plus how
// that fetch turned out. The status matters because the panel lists collections
// from the hardcoded RASTER_DEFS, not from the catalog: a collection the caller
// may not see still gets a row, and without a status it sat on "loading dates…"
// forever, which reads as a broken app rather than a governed layer.
function useAvailableDates() {
  const temporal = RASTER_DEFS.filter((d) => d.temporal);
  const [dates, setDates] = useState<Record<string, string[]>>({});
  const [status, setStatus] = useState<Record<string, DateStatus>>(() =>
    Object.fromEntries(temporal.map((d) => [d.id, "loading" as DateStatus])),
  );
  useEffect(() => {
    let cancelled = false;
    for (const def of RASTER_DEFS.filter((d) => d.temporal)) {
      collectionDates(def.id)
        .then((ds) => {
          if (cancelled) return;
          setDates((s) => ({ ...s, [def.id]: ds }));
          setStatus((s) => ({ ...s, [def.id]: ds.length ? "ready" : "unavailable" }));
        })
        .catch((e) => {
          if (cancelled) return;
          const denied = e instanceof StacAccessDeniedError;
          // Being refused a restricted collection is the policy working, not a
          // fault — don't log it as an error every page load.
          if (!denied) console.error(`dates(${def.id}):`, e);
          setStatus((s) => ({ ...s, [def.id]: denied ? "restricted" : "unavailable" }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, []);
  return { dates, status };
}

// Effective date for one collection's dropdown given the shared pick: the
// picked date itself when this collection has it, otherwise the nearest more
// recent one, falling back to the latest available. ISO dates sort lexically.
function resolveDate(dates: string[], picked: string): string {
  if (!dates.length) return "";
  if (!picked) return dates[dates.length - 1]; // no pick yet = latest
  if (dates.includes(picked)) return picked;
  return dates.find((d) => d > picked) ?? dates[dates.length - 1];
}

function AddRow({
  defId,
  label,
  temporal,
  dates,
  status = "ready",
  sharedDate,
  onPickDate,
  onError,
}: {
  defId: string;
  label: string;
  temporal: boolean;
  dates: string[];
  status?: DateStatus;
  sharedDate: string;
  onPickDate: (date: string) => void;
  onError: (msg: string) => void;
}) {
  const addLayer = useMapStore((s) => s.addLayer);
  const [busy, setBusy] = useState(false);
  // One date pick drives every dropdown: choosing here re-seeds the others to
  // the same date (or their nearest more recent one) via the shared state.
  const date = resolveDate(dates, sharedDate);

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
        <a
          className="infobtn"
          href={stacBrowserCollectionUrl(defId)}
          target="_blank"
          rel="noopener noreferrer"
          title="Dataset details in the STAC catalog"
          aria-label={`${label} - dataset details in the STAC catalog`}
        >
          i
        </a>
      </span>
      {temporal ? (
        dates.length ? (
          <select value={date} onChange={(e) => onPickDate(e.target.value)}>
            {dates.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        ) : (
          <span
            className="muted"
            title={
              status === "restricted"
                ? `${label} is part of the PhilSA restricted tier. It needs a partner ` +
                  `credential — open data stays available without one.`
                : status === "unavailable"
                  ? `No acquisitions are currently published for ${label}.`
                  : undefined
            }
          >
            {status === "restricted"
              ? "restricted"
              : status === "unavailable"
                ? "unavailable"
                : "loading dates…"}
          </span>
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

// Load a local GeoJSON file and render it client-side - no server round-trip,
// mirroring TerriaJS' "Add data > upload". Reads the file in the browser, parses
// it, drops it in the store as a geojson-local layer, flies to its extent and -
// when the file contains polygons - adds a clip mask so the rasters read only
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
        Each uploaded polygon is treated as one area of interest (AOI): pick the
        file as the area under “Time series” to average an index (e.g. radar
        vegetation) over every AOI across dates and export the per-AOI table as
        CSV.
      </p>
    </>
  );
}

export default function LayerPanel() {
  const layers = useMapStore((s) => s.layers);
  const removeLayers = useMapStore((s) => s.removeLayers);
  const updateLayer = useMapStore((s) => s.updateLayer);
  const { dates, status: dateStatus } = useAvailableDates();
  const [error, setError] = useState("");
  const [legendOpen, setLegendOpen] = useState<Record<string, boolean>>({});
  const [addTab, setAddTab] = useState<"single" | "series">("single");
  // Shared across every Single Date dropdown: picking a date in one row
  // pre-selects the same date (or the nearest more recent one) everywhere.
  const [sharedDate, setSharedDate] = useState("");

  const rasters = layers.filter((l) => l.kind !== "vector-pmtiles");
  const vectors = layers.filter((l) => l.kind === "vector-pmtiles");

  return (
    <div className="panel layerpanel">
      <h1>PhilSA POC - Geo webmap</h1>

      <h2>On the map</h2>
      {rasters.length === 0 && (
        <p className="hint">
          No data layers yet - add one below, or just ask the assistant.
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
                  ? "This date stitches multiple satellite passes (different orbit/look geometry) into one mosaic - backscatter across them is not directly comparable."
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
      <div className="addtabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={addTab === "single"}
          className={addTab === "single" ? "active" : ""}
          onClick={() => setAddTab("single")}
        >
          Single Date
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={addTab === "series"}
          className={addTab === "series" ? "active" : ""}
          onClick={() => setAddTab("series")}
        >
          Time Series
        </button>
      </div>
      {/* Both tabs stay mounted (hidden, not unmounted) so switching away from
          Time Series doesn't tear down its layer and playback state. */}
      <div hidden={addTab !== "single"}>
        {RASTER_DEFS.filter((d) => d.temporal).map((d) => (
          <AddRow
            key={d.id}
            defId={d.id}
            label={d.label}
            temporal={d.temporal}
            dates={dates[d.id] ?? []}
            status={dateStatus[d.id]}
            sharedDate={sharedDate}
            onPickDate={setSharedDate}
            onError={setError}
          />
        ))}
      </div>
      <div hidden={addTab !== "series"}>
        <TimeSeries dates={dates} status={dateStatus} onError={setError} />
      </div>
      <UploadRow onError={setError} />

      <h2>ESRI</h2>
      {RASTER_DEFS.filter((d) => !d.temporal).map((d) => (
        <AddRow
          key={d.id}
          defId={d.id}
          label={d.label}
          temporal={d.temporal}
          dates={dates[d.id] ?? []}
          status={dateStatus[d.id]}
          sharedDate={sharedDate}
          onPickDate={setSharedDate}
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

      <div className="apisource">
        <span className="apisource-label">Data via PhilSA Open Data API</span>
        <p className="hint">
          This map is a reference consumer - it draws every layer from public
          standards-based endpoints any agency can call. Point your own map or
          pipeline at the same URLs.
        </p>
        <a href={DATA_SOURCE.stacApi} target="_blank" rel="noreferrer">
          STAC catalog (discovery) ↗
        </a>
        <a href={DATA_SOURCE.browser} target="_blank" rel="noreferrer">
          Browse the catalog ↗
        </a>
      </div>
    </div>
  );
}
