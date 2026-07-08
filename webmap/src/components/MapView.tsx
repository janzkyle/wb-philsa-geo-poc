// Renders whatever the layer store says — MapView owns no layer state of its
// own. Rasters pin below the `vector-slot` anchor so admin outlines always
// draw on top, regardless of when either driver adds a layer.

import { useEffect, useRef } from "react";
import { Map, Source, Layer } from "react-map-gl/maplibre";
import type { MapRef } from "react-map-gl/maplibre";
import maplibregl from "maplibre-gl";
import { Protocol } from "pmtiles";
import type { StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { INITIAL_VIEW } from "../config";
import { useMapStore } from "../state/mapStore";
import type { MapLayer } from "../state/mapStore";

// Register the pmtiles:// protocol with MapLibre once, at module load.
const protocol = new Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

// Light CARTO raster basemap + an empty anchor layer that separates the
// raster stack (below) from vector outlines (above).
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
    empty: {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    },
  },
  layers: [
    { id: "bg", type: "background", paint: { "background-color": "#e9e9e9" } },
    { id: "carto", type: "raster", source: "carto" },
    { id: "vector-slot", type: "line", source: "empty" },
  ],
};

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
            beforeId="vector-slot"
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

export default function MapView() {
  const layers = useMapStore((s) => s.layers);
  const view = useMapStore((s) => s.view);
  const reportViewport = useMapStore((s) => s.reportViewport);
  const mapRef = useRef<MapRef>(null);

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

  const rasters = layers.filter((l) => l.kind !== "vector-pmtiles");
  const vectors = layers.filter((l) => l.kind === "vector-pmtiles");

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
      {rasters.map((l) => (
        <RasterLayer key={l.id} layer={l} />
      ))}
      {vectors.map((l) => (
        <VectorLayer key={l.id} layer={l} />
      ))}
    </Map>
  );
}
