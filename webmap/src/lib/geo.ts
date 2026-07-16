// Small geodesy helpers shared by the AI tools. Kept dependency-free - the map
// only needs approximate boxes, not geodesic precision.

import type { FeatureCollection } from "geojson";
import type { Bbox, MapLayer } from "../state/mapStore";

// Fixed id so re-highlighting a new location replaces the marker instead of
// stacking them (addLayer is replace-on-same-id), and the AI can clear it with
// remove_layers(["highlight"]).
export const HIGHLIGHT_LAYER_ID = "highlight";

// Build a WGS84 bounding box of half-size `radiusKm` around a lat/lon point,
// the counterpart to resolveRegion's name→bbox lookup for when the user gives
// an explicit coordinate. One degree of latitude is ~111.32 km everywhere; a
// degree of longitude shrinks by cos(latitude) toward the poles. Results are
// clamped to valid lon/lat ranges so a large radius near an edge stays legal.
export function pointToBbox(lat: number, lon: number, radiusKm: number): Bbox {
  const KM_PER_DEG = 111.32;
  const dLat = radiusKm / KM_PER_DEG;
  // Guard the cos term against ~0 at the poles so dLon stays finite.
  const cosLat = Math.max(Math.cos((lat * Math.PI) / 180), 1e-6);
  const dLon = radiusKm / (KM_PER_DEG * cosLat);
  const clampLat = (v: number) => Math.max(-90, Math.min(90, v));
  const clampLon = (v: number) => Math.max(-180, Math.min(180, v));
  return [
    clampLon(lon - dLon),
    clampLat(lat - dLat),
    clampLon(lon + dLon),
    clampLat(lat + dLat),
  ];
}

// A geojson-local layer that visually marks a resolved location: the bbox as a
// translucent rectangle plus a pin at its center. Reuses the same inline
// renderer as uploaded GeoJSON (fill + outline + circle in MapView's
// GeojsonLayer), so no data is fetched. The stable id means each new highlight
// supersedes the previous one.
export function buildHighlightLayer(bbox: Bbox, label?: string): MapLayer {
  const [w, s, e, n] = bbox;
  const cx = (w + e) / 2;
  const cy = (s + n) / 2;
  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [w, s],
              [e, s],
              [e, n],
              [w, n],
              [w, s],
            ],
          ],
        },
      },
      {
        type: "Feature",
        properties: {},
        geometry: { type: "Point", coordinates: [cx, cy] },
      },
    ],
  };
  return {
    id: HIGHLIGHT_LAYER_ID,
    kind: "geojson-local",
    label: label ? `Highlight: ${label}` : "Highlight",
    tiles: [],
    geojson: fc,
    color: "#ff5722", // deep orange - reads over both light and satellite basemaps
    opacity: 1,
    visible: true,
    description: label
      ? `Highlighted location: ${label} (rendered locally, not saved)`
      : "Highlighted location (rendered locally, not saved)",
  };
}
