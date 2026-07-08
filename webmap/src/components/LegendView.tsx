// Colour key for a layer: a gradient bar for a continuous ramp, or a swatch
// list for a categorical layer. Mirrors the layer's TiTiler styling.

import type { Legend } from "../config";

export default function LegendView({ legend }: { legend: Legend }) {
  if (legend.kind === "ramp") {
    return (
      <div className="legend">
        <div
          className="rampbar"
          style={{
            background: `linear-gradient(to right, ${legend.stops.join(", ")})`,
          }}
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
