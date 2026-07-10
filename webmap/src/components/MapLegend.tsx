// Consolidated colour key for what's actually on the map: one entry per visible
// layer that carries a legend (the styled rasters). Floats in the map's
// top-right corner and hides itself when nothing legended is showing, so it
// stays out of the way. The per-layer legends in the side panel still exist for
// drilling into one layer; this gathers them where the user is looking.

import { useMapStore } from "../state/mapStore";
import LegendView from "./LegendView";

export default function MapLegend() {
  const layers = useMapStore((s) => s.layers);
  const legended = layers.filter((l) => l.visible && l.legend);
  if (legended.length === 0) return null;

  return (
    <div className="map-legend">
      {legended.map((l) => (
        <div className="map-legend-item" key={l.id}>
          <div className="map-legend-label">{l.label}</div>
          {/* filter guarantees l.legend is set */}
          <LegendView legend={l.legend!} />
        </div>
      ))}
    </div>
  );
}
