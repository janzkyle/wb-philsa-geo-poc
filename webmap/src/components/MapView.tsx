// Renders whatever the layer store says — MapView owns no layer state of its
// own. Two empty anchor layers fix the stacking order no matter when either
// driver adds a layer: basemaps + data rasters pin below `mask-slot`, the clip
// mask sits between `mask-slot` and `vector-slot` (so it covers every raster,
// even ones added later), and vector outlines + uploaded GeoJSON draw on top.

import { useEffect, useRef, useState } from "react";
import { Map, Source, Layer } from "react-map-gl/maplibre";
import type { MapRef } from "react-map-gl/maplibre";
import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";
import type { StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { INITIAL_VIEW } from "../config";
import { useMapStore } from "../state/mapStore";
import type { MapLayer } from "../state/mapStore";
import MapLegend from "./MapLegend";

// Register the pmtiles:// protocol with MapLibre once, at module load.
const protocol = new Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

// The two switchable basemaps. Both are rendered as ordinary raster layers
// pinned below `vector-slot`; the toggle just flips which one is visible, so
// switching never reloads the style (no flash, data/outline layers stay put).
type Basemap = "light" | "satellite";

const BASEMAPS: Record<
  Basemap,
  { label: string; tiles: string[]; attribution: string }
> = {
  light: {
    label: "Map",
    tiles: [
      "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
      "https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
    ],
    attribution:
      '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, © <a href="https://carto.com/attributions">CARTO</a>',
  },
  satellite: {
    label: "Satellite",
    // Esri World Imagery — free with attribution, no API key. Note z/y/x order.
    tiles: [
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    ],
    attribution:
      "Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community",
  },
};

// Minimal base: a neutral background plus two empty anchor layers — `mask-slot`
// caps the raster stack, `vector-slot` separates the clip mask from vector
// outlines. The basemaps themselves are declarative children (see Basemaps) so
// they can toggle live.
const baseStyle: StyleSpecification = {
  version: 8,
  sources: {
    empty: {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    },
  },
  layers: [
    { id: "bg", type: "background", paint: { "background-color": "#e9e9e9" } },
    { id: "mask-slot", type: "line", source: "empty" },
    { id: "vector-slot", type: "line", source: "empty" },
  ],
};

// Both basemaps mounted at once, below mask-slot (and thus below all data
// rasters, which insert into the same slot after these mount). Only the active
// one is visible.
function Basemaps({ active }: { active: Basemap }) {
  return (
    <>
      {(Object.keys(BASEMAPS) as Basemap[]).map((key) => (
        <Source
          key={key}
          id={`basemap-${key}`}
          type="raster"
          tiles={BASEMAPS[key].tiles}
          tileSize={256}
          attribution={BASEMAPS[key].attribution}
        >
          <Layer
            id={`basemap-${key}-r`}
            type="raster"
            beforeId="mask-slot"
            layout={{ visibility: key === active ? "visible" : "none" }}
          />
        </Source>
      ))}
    </>
  );
}

function RasterLayer({ layer }: { layer: MapLayer }) {
  return (
    <>
      {layer.tiles.map((tileUrl, i) => (
        <Source
          key={`${layer.id}:${i}`}
          id={`${layer.id}:${i}`}
          type="raster"
          tiles={[tileUrl]}
          tileSize={256}
        >
          <Layer
            id={`${layer.id}:${i}:r`}
            type="raster"
            beforeId="mask-slot"
            layout={{ visibility: layer.visible ? "visible" : "none" }}
            paint={{ "raster-opacity": layer.opacity }}
          />
        </Source>
      ))}
    </>
  );
}

function VectorLayer({ layer }: { layer: MapLayer }) {
  return (
    <Source id={`${layer.id}-src`} type="vector" url={layer.pmtilesUrl}>
      <Layer
        id={`${layer.id}-line`}
        type="line"
        source-layer={layer.sourceLayer}
        minzoom={layer.minzoom}
        layout={{
          visibility: layer.visible ? "visible" : "none",
          "line-join": "round",
        }}
        paint={{
          "line-color": layer.color ?? "#333",
          "line-width": layer.width ?? 1,
          "line-opacity": layer.opacity,
        }}
      />
    </Source>
  );
}

// The raster clip mask (world polygon minus the uploaded boundaries, built by
// buildClipMaskLayer): pinned between mask-slot and vector-slot so it covers
// every data raster — including ones added after it — while admin outlines and
// the uploaded boundary itself stay readable above. `opacity` is the dimming
// strength; 1 hides the outside entirely (a hard clip).
function MaskLayer({ layer }: { layer: MapLayer }) {
  return (
    <Source
      id={`${layer.id}-src`}
      type="geojson"
      data={layer.geojson ?? { type: "FeatureCollection", features: [] }}
    >
      <Layer
        id={`${layer.id}-fill`}
        type="fill"
        beforeId="vector-slot"
        layout={{ visibility: layer.visible ? "visible" : "none" }}
        paint={{ "fill-color": "#10151c", "fill-opacity": layer.opacity }}
      />
    </Source>
  );
}

// Locally-uploaded GeoJSON: one source feeding fill / line / circle layers so a
// mixed collection (polygons, lines, points) all draws. Sits above vector-slot
// so the user's data reads on top of the rasters. `data` is the parsed object —
// MapLibre renders it inline, nothing is fetched.
function GeojsonLayer({ layer }: { layer: MapLayer }) {
  const color = layer.color ?? "#e6550d";
  const vis = { visibility: layer.visible ? ("visible" as const) : ("none" as const) };
  return (
    <Source
      id={`${layer.id}-src`}
      type="geojson"
      data={layer.geojson ?? { type: "FeatureCollection", features: [] }}
    >
      <Layer
        id={`${layer.id}-fill`}
        type="fill"
        filter={["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false]}
        layout={vis}
        paint={{ "fill-color": color, "fill-opacity": 0.25 * layer.opacity }}
      />
      <Layer
        id={`${layer.id}-line`}
        type="line"
        filter={[
          "match",
          ["geometry-type"],
          ["LineString", "MultiLineString", "Polygon", "MultiPolygon"],
          true,
          false,
        ]}
        layout={{ ...vis, "line-join": "round" }}
        paint={{ "line-color": color, "line-width": 2, "line-opacity": layer.opacity }}
      />
      <Layer
        id={`${layer.id}-circle`}
        type="circle"
        filter={["match", ["geometry-type"], ["Point", "MultiPoint"], true, false]}
        layout={vis}
        paint={{
          "circle-radius": 5,
          "circle-color": color,
          "circle-opacity": layer.opacity,
          "circle-stroke-width": 1,
          "circle-stroke-color": "#fff",
        }}
      />
    </Source>
  );
}

export default function MapView() {
  const layers = useMapStore((s) => s.layers);
  const view = useMapStore((s) => s.view);
  const reportViewport = useMapStore((s) => s.reportViewport);
  const mapRef = useRef<MapRef>(null);
  const [basemap, setBasemap] = useState<Basemap>("satellite");

  // fitBounds requests come through the store (set_view tool / region search).
  useEffect(() => {
    const b = view.bbox;
    if (!b) return;
    mapRef.current?.fitBounds(
      [
        [b[0], b[1]],
        [b[2], b[3]],
      ],
      { padding: 60, duration: 1400, maxZoom: 12 },
    );
  }, [view.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const rasters = layers.filter(
    (l) => l.kind === "raster-mosaic" || l.kind === "raster-cogs",
  );
  const masks = layers.filter((l) => l.kind === "geojson-mask");
  const vectors = layers.filter((l) => l.kind === "vector-pmtiles");
  const geojsons = layers.filter((l) => l.kind === "geojson-local");

  return (
    <Map
      ref={mapRef}
      initialViewState={INITIAL_VIEW}
      mapStyle={baseStyle}
      attributionControl={{ compact: true }}
      onMoveEnd={(e) => {
        const b = e.target.getBounds();
        reportViewport([
          +b.getWest().toFixed(3),
          +b.getSouth().toFixed(3),
          +b.getEast().toFixed(3),
          +b.getNorth().toFixed(3),
        ]);
      }}
    >
      <Basemaps active={basemap} />

      <div className="basemap-switch">
        {(Object.keys(BASEMAPS) as Basemap[]).map((key) => (
          <button
            key={key}
            type="button"
            className={key === basemap ? "active" : ""}
            onClick={() => setBasemap(key)}
          >
            {BASEMAPS[key].label}
          </button>
        ))}
      </div>

      {rasters.map((l) => (
        <RasterLayer key={l.id} layer={l} />
      ))}
      {masks.map((l) => (
        <MaskLayer key={l.id} layer={l} />
      ))}
      {vectors.map((l) => (
        <VectorLayer key={l.id} layer={l} />
      ))}
      {geojsons.map((l) => (
        <GeojsonLayer key={l.id} layer={l} />
      ))}

      <MapLegend />
    </Map>
  );
}
