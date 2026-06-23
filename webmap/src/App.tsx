import { useCallback, useEffect, useMemo, useState } from "react";
import { Map, Source, Layer } from "react-map-gl/maplibre";
import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";
import type { StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { ADMIN_LAYERS, RASTER_LAYERS, INITIAL_VIEW, mosaicJsonUrl } from "./config";
import type { Legend } from "./config";
import { useStacRasters, mosaicTileUrl } from "./useStacRasters";
import "./App.css";

// Register the pmtiles:// protocol with MapLibre once, at module load.
const protocol = new Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

// Minimal base style: a light CARTO raster basemap for geographic context.
const baseStyle: StyleSpecification = {
  version: 8,
  sources: {
    carto: {
      type: "raster",
      tiles: [
        "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
        "https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
      ],
      tileSize: 256,
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, © <a href="https://carto.com/attributions">CARTO</a>',
    },
  },
  layers: [
    { id: "bg", type: "background", paint: { "background-color": "#e9e9e9" } },
    { id: "carto", type: "raster", source: "carto" },
  ],
};

// The YYYY-MM-DD portion of an item's RFC 3339 datetime (or "" if none).
const dayOf = (dt?: string) => (dt ? dt.slice(0, 10) : "");

// Colour key for a layer in the guide: a gradient bar for a continuous ramp,
// or a swatch list for a categorical layer. Mirrors the layer's TiTiler styling.
function LayerLegend({ legend }: { legend: Legend }) {
  if (legend.kind === "ramp") {
    return (
      <div className="legend">
        <div
          className="rampbar"
          style={{ background: `linear-gradient(to right, ${legend.stops.join(", ")})` }}
        />
        <div className="ramplabels">
          <span>{legend.minLabel}</span>
          <span>{legend.maxLabel}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="legend classlegend">
      {legend.items.map((c) => (
        <span className="classitem" key={c.label}>
          <span className="classswatch" style={{ background: c.color }} />
          {c.label}
        </span>
      ))}
    </div>
  );
}

// One STAC collection rendered as the single seamless mosaic for the selected
// acquisition date. Each date is a hosted MosaicJSON served through TiTiler's
// /mosaicjson tiler, so that day's overlapping/partial granules read as one
// continuous "tile-like" layer. Renders nothing if this collection has no data
// on `date` (the panel shows a "no data" indicator in that case).
function RasterCollection({
  collection,
  params,
  visible,
  date,
  temporal,
  onDates,
}: {
  collection: string;
  params: string;
  visible: boolean;
  date: string;
  temporal: boolean;
  onDates: (collection: string, dates: string[]) => void;
}) {
  const { items } = useStacRasters(collection, params);

  // Distinct acquisition dates present in this collection (sorted ascending).
  const dates = useMemo(() => {
    const s = new Set<string>();
    for (const it of items) {
      const d = dayOf(it.datetime);
      if (d) s.add(d);
    }
    return [...s].sort();
  }, [items]);

  // Report dates up so the picker + indicators know real coverage. A
  // date-independent layer (e.g. annual LULC) must NOT feed the date filter.
  useEffect(() => {
    if (temporal) onDates(collection, dates);
  }, [temporal, collection, dates, onDates]);

  // Date-independent layer: render each COG item directly (no per-date mosaic,
  // no date gating). Visible whenever toggled on, regardless of selected date.
  if (!temporal) {
    return (
      <>
        {items.map((it) => (
          <Source
            key={`${collection}:${it.id}`}
            id={`${collection}:${it.id}`}
            type="raster"
            tiles={[it.tileUrl]}
            tileSize={256}
          >
            <Layer
              id={`${collection}:${it.id}:layer`}
              type="raster"
              layout={{ visibility: visible ? "visible" : "none" }}
              paint={{ "raster-opacity": 1 }}
              beforeId="admin-anchor"
            />
          </Source>
        ))}
      </>
    );
  }

  if (!date || !dates.includes(date)) return null;

  return (
    // `key` ties the source's React identity to the date: react-map-gl forbids
    // mutating a source id in place ("source id changed"), so changing the date
    // must remount (remove + re-add) rather than update the existing source.
    <Source
      key={`${collection}:${date}`}
      id={`${collection}:${date}`}
      type="raster"
      tiles={[mosaicTileUrl(mosaicJsonUrl(collection, date), params)]}
      tileSize={256}
    >
      <Layer
        id={`${collection}:${date}:layer`}
        type="raster"
        layout={{ visibility: visible ? "visible" : "none" }}
        paint={{ "raster-opacity": 1 }}
        beforeId="admin-anchor"
      />
    </Source>
  );
}

function App() {
  // toggle state for each layer group
  const [adminOn, setAdminOn] = useState<Record<string, boolean>>(
    Object.fromEntries(ADMIN_LAYERS.map((l) => [l.id, true])),
  );
  const [rasterOn, setRasterOn] = useState<Record<string, boolean>>(
    Object.fromEntries(RASTER_LAYERS.map((l) => [l.id, l.defaultOn])),
  );

  // Single selected acquisition date for the raster (COG) layers.
  const [selectedDate, setSelectedDate] = useState("");

  // "About the layers" guide — collapsible, expanded by default.
  const [guideOpen, setGuideOpen] = useState(true);

  // Acquisition dates available per raster collection (reported by each one).
  const [datesByColl, setDatesByColl] = useState<Record<string, string[]>>({});
  const onDates = useCallback((collection: string, dates: string[]) => {
    setDatesByColl((s) => {
      const prev = s[collection];
      if (prev && prev.length === dates.length && prev.every((d, i) => d === dates[i]))
        return s; // unchanged — avoid a re-render loop
      return { ...s, [collection]: dates };
    });
  }, []);

  // Union of all dates across collections, sorted ascending.
  const allDates = useMemo(() => {
    const set = new Set<string>();
    for (const list of Object.values(datesByColl))
      for (const d of list) set.add(d);
    return [...set].sort();
  }, [datesByColl]);

  // Default to (and keep valid against) the latest available date.
  useEffect(() => {
    if (allDates.length && !allDates.includes(selectedDate))
      setSelectedDate(allDates[allDates.length - 1]);
  }, [allDates, selectedDate]);

  const dateIdx = allDates.indexOf(selectedDate);
  const stepDate = (delta: number) => {
    const next = dateIdx + delta;
    if (next >= 0 && next < allDates.length) setSelectedDate(allDates[next]);
  };
  // Does a given raster collection have imagery on the selected date?
  const hasDataOn = (collection: string) =>
    !!selectedDate && (datesByColl[collection] ?? []).includes(selectedDate);

  const initialViewState = useMemo(() => INITIAL_VIEW, []);

  return (
    <div className="app">
      <Map
        initialViewState={initialViewState}
        mapStyle={baseStyle}
        attributionControl={{ compact: true }}
      >
        {/* Raster COG layers (drawn below the admin outlines). */}
        {RASTER_LAYERS.map((r) => (
          <RasterCollection
            key={r.id}
            collection={r.collection}
            params={r.titilerParams}
            visible={!!rasterOn[r.id]}
            date={selectedDate}
            temporal={r.temporal !== false}
            onDates={onDates}
          />
        ))}

        {/* Invisible anchor so rasters can insert beneath admin outlines. */}
        <Source
          id="admin-anchor-src"
          type="geojson"
          data={{ type: "FeatureCollection", features: [] }}
        >
          <Layer id="admin-anchor" type="line" />
        </Source>

        {/* Admin-boundary outlines from PMTiles on R2. */}
        {ADMIN_LAYERS.map((a) => (
          <Source key={a.id} id={`${a.id}-src`} type="vector" url={a.url}>
            <Layer
              id={`${a.id}-line`}
              type="line"
              source-layer={a.sourceLayer}
              minzoom={a.minzoom}
              layout={{
                visibility: adminOn[a.id] ? "visible" : "none",
                "line-join": "round",
              }}
              paint={{ "line-color": a.color, "line-width": a.width }}
            />
          </Source>
        ))}
      </Map>

      <div className="panel">
        <h1>PhilSA POC — webmap</h1>

        <h2>Acquisition date</h2>
        {allDates.length ? (
          <>
            <div className="daterow">
              <button
                type="button"
                className="step"
                disabled={dateIdx <= 0}
                onClick={() => stepDate(-1)}
                aria-label="Previous date"
              >
                ◀
              </button>
              <select
                className="dateselect"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
              >
                {allDates.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="step"
                disabled={dateIdx >= allDates.length - 1}
                onClick={() => stepDate(1)}
                aria-label="Next date"
              >
                ▶
              </button>
            </div>
            <p className="hint" style={{ margin: "4px 0 0" }}>
              {dateIdx + 1} of {allDates.length} dates
            </p>
          </>
        ) : (
          <p className="hint" style={{ margin: "4px 0 0" }}>
            loading dates…
          </p>
        )}

        <h2>Raster (COG via TiTiler)</h2>
        {RASTER_LAYERS.map((r) => {
          // Date-independent layers (annual LULC) are always available; only
          // per-date layers show a "no data" indicator for the selected date.
          const dateless = r.temporal === false;
          const has = dateless || hasDataOn(r.collection);
          return (
            <label key={r.id} className="row">
              <input
                type="checkbox"
                checked={!!rasterOn[r.id]}
                onChange={(e) =>
                  setRasterOn((s) => ({ ...s, [r.id]: e.target.checked }))
                }
              />
              <span className={`dot ${has ? "on" : "off"}`} />
              <span className={has ? undefined : "muted"}>{r.label}</span>
              {dateless && <span className="nodata">annual</span>}
              {!dateless && !has && <span className="nodata">no data</span>}
            </label>
          );
        })}

        <h2>Admin boundaries (PMTiles)</h2>
        {ADMIN_LAYERS.map((a) => (
          <label key={a.id} className="row">
            <input
              type="checkbox"
              checked={!!adminOn[a.id]}
              onChange={(e) =>
                setAdminOn((s) => ({ ...s, [a.id]: e.target.checked }))
              }
            />
            <span className="swatch" style={{ background: a.color }} />
            {a.label}
          </label>
        ))}

        <p className="hint">
          Rasters need the local STAC API (:8082) + TiTiler (:8083). Admin
          boundaries stream straight from public R2.
        </p>
      </div>

      <div className={`panel guide${guideOpen ? "" : " collapsed"}`}>
        <button
          type="button"
          className="guidetoggle"
          aria-expanded={guideOpen}
          onClick={() => setGuideOpen((o) => !o)}
        >
          <span>About the layers</span>
          <span className="chevron">{guideOpen ? "▾" : "▸"}</span>
        </button>
        {guideOpen &&
          RASTER_LAYERS.map((r) => (
            <div key={r.id} className="guideitem">
              <div className="guidename">{r.label}</div>
              <div className="guidedesc">{r.description}</div>
              {r.legend && <LayerLegend legend={r.legend} />}
            </div>
          ))}
      </div>
    </div>
  );
}

export default App;
