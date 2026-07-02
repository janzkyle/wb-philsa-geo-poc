// Snapshots the live TerriaJS dashboard into a compact JSON object that the
// GenAI assistant reasons over. It reads Terria's in-memory model state (the
// workbench + current camera) — NOT the DOM — so answers reflect exactly what
// the user has enabled.
//
// Everything here is defensive: TerriaJS item shapes vary by catalog type and
// version, so we read through a loose structural interface and drop any field
// that is absent, keeping the payload small and token-efficient.

import Terria from "terriajs/lib/Models/Terria";

export interface InfoSection {
  name: string;
  content: string;
}

export interface LayerContext {
  name: string;
  type?: string;
  description?: string;
  info?: InfoSection[];
  bbox?: [number, number, number, number]; // [west, south, east, north] degrees
}

export interface DashboardContext {
  appName: string;
  capturedAt: string;
  cameraExtent?: {
    west: number;
    south: number;
    east: number;
    north: number;
  };
  layerCount: number;
  activeLayers: LayerContext[];
  note: string;
}

// --- loose structural views over Terria internals (read-only, all optional) ---

interface RectangleLike {
  west?: number;
  south?: number;
  east?: number;
  north?: number;
}

interface WorkbenchItemLike {
  name?: string;
  type?: string;
  description?: string;
  info?: { name?: string; content?: string }[];
  rectangle?: RectangleLike;
}

interface ViewerLike {
  getCurrentCameraView?: () => { rectangle?: RectangleLike } | undefined;
}

const RAD_TO_DEG = 180 / Math.PI;

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// Terria camera rectangles are in radians; workbench trait rectangles are in
// degrees. Detect by magnitude: anything within ±2π is treated as radians.
function toDegrees(rect: RectangleLike): DashboardContext["cameraExtent"] {
  const { west, south, east, north } = rect;
  if (
    west === undefined ||
    south === undefined ||
    east === undefined ||
    north === undefined
  ) {
    return undefined;
  }
  const looksRadians =
    Math.abs(east) <= Math.PI * 2 && Math.abs(west) <= Math.PI * 2;
  const f = looksRadians ? RAD_TO_DEG : 1;
  return {
    west: round(west * f),
    south: round(south * f),
    east: round(east * f),
    north: round(north * f)
  };
}

function cameraExtent(terria: Terria): DashboardContext["cameraExtent"] {
  try {
    const viewer = terria.currentViewer as unknown as ViewerLike;
    const view = viewer.getCurrentCameraView?.();
    if (view?.rectangle) {
      return toDegrees(view.rectangle);
    }
  } catch {
    // camera not ready / viewer swapping — extent is optional
  }
  return undefined;
}

function serializeLayer(raw: WorkbenchItemLike): LayerContext {
  const layer: LayerContext = {
    name: (raw.name ?? "Unnamed layer").trim()
  };

  if (raw.type) {
    layer.type = raw.type;
  }

  const description = raw.description?.trim();
  if (description) {
    layer.description = description;
  }

  const info = (raw.info ?? [])
    .filter((s) => s?.name && s?.content)
    .map((s) => ({ name: s.name!.trim(), content: s.content!.trim() }));
  if (info.length > 0) {
    layer.info = info;
  }

  const rect = raw.rectangle;
  if (rect) {
    const deg = toDegrees(rect);
    if (deg) {
      layer.bbox = [deg.west, deg.south, deg.east, deg.north];
    }
  }

  return layer;
}

/**
 * Build the JSON context describing the current dashboard view. Safe to call at
 * any time; returns an empty-layer snapshot rather than throwing if nothing is
 * loaded yet.
 */
export function captureDashboardContext(terria: Terria): DashboardContext {
  const items = (terria.workbench?.items ??
    []) as unknown as WorkbenchItemLike[];
  const activeLayers = items.map(serializeLayer);

  return {
    appName: terria.appName ?? "PhilSA POC Dashboard",
    capturedAt: new Date().toISOString(),
    cameraExtent: cameraExtent(terria),
    layerCount: activeLayers.length,
    activeLayers,
    note:
      "Snapshot of the layers currently enabled on the PhilSA POC map and the " +
      "visible map extent. Coordinates are decimal degrees (WGS84)."
  };
}
