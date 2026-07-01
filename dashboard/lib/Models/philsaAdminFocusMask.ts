import loadJson from "terriajs/lib/Core/loadJson";
import GeoJsonCatalogItem from "terriajs/lib/Models/Catalog/CatalogItems/GeoJsonCatalogItem";
import CommonStrata from "terriajs/lib/Models/Definition/CommonStrata";
import updateModelFromJson from "terriajs/lib/Models/Definition/updateModelFromJson";
import Terria from "terriajs/lib/Models/Terria";

const MASK_ID = "philsa-admin-focus-mask";

// Generous rectangle around the Philippines. The spotlight mask fills this
// rectangle *minus* the selected unit (the unit's rings become holes), so only
// that area's imagery shows through. Kept regional (not the whole world) to avoid
// antimeridian/large-polygon issues — ample for a PH-focused dashboard.
const OUTER: number[][] = [
  [100, -5],
  [145, -5],
  [145, 30],
  [100, 30],
  [100, -5]
];

const geomCache: Record<string, Promise<any>> = {};

function loadLevelGeometry(baseUrl: string, level: number): Promise<any> {
  // Cache per (base, level) so switching hosts (e.g. local -> R2) doesn't
  // return stale geometry. Trailing slash on baseUrl is tolerated.
  const url = `${baseUrl.replace(/\/+$/, "")}/ph_admin_geom_adm${level}.json`;
  if (!(url in geomCache)) {
    geomCache[url] = Promise.resolve(loadJson(url));
  }
  return geomCache[url];
}

// Exterior rings of a Polygon / MultiPolygon — each becomes a hole in the mask.
function exteriorRings(geometry: any): number[][][] {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return [geometry.coordinates[0]];
  if (geometry.type === "MultiPolygon")
    return geometry.coordinates.map((poly: number[][][]) => poly[0]);
  return [];
}

/**
 * Spotlight filter: dim everything outside the selected admin unit so only that
 * area's imagery is visible. Adds/updates a single GeoJSON "Focus area" item in
 * the workbench (so the user can toggle its opacity or remove it to clear).
 */
export async function applyAdminFocusMask(
  terria: Terria,
  baseUrl: string,
  level: number,
  pcode: string,
  name: string
): Promise<void> {
  const fc = await loadLevelGeometry(baseUrl, level);
  const feature = (fc?.features ?? []).find(
    (f: any) => f?.properties?.pcode === pcode
  );
  const rings = exteriorRings(feature?.geometry);
  if (rings.length === 0) return;

  const maskData = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [OUTER, ...rings] }
      }
    ]
  };

  let item = terria.getModelById(GeoJsonCatalogItem, MASK_ID);
  if (item === undefined) {
    item = new GeoJsonCatalogItem(MASK_ID, terria);
    terria.addModel(item);
  }
  updateModelFromJson(item, CommonStrata.user, {
    name: `Focus area: ${name}`,
    geoJsonData: maskData,
    clampToGround: true,
    style: {
      fill: "#0a1626",
      "fill-opacity": 0.55,
      stroke: "#0a1626",
      "stroke-opacity": 0,
      "stroke-width": 0
    }
  });
  (await item.loadMapItems()).raiseError(terria);
  if (!terria.workbench.contains(item)) {
    (await terria.workbench.add(item)).raiseError(terria);
  }
}
