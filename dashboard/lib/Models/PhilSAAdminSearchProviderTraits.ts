import primitiveTrait from "terriajs/lib/Traits/Decorators/primitiveTrait";
import mixTraits from "terriajs/lib/Traits/mixTraits";
import LocationSearchProviderTraits from "terriajs/lib/Traits/SearchProviders/LocationSearchProviderTraits";

/**
 * Traits for the PhilSA admin-area search provider. `url` (from
 * LocationSearchProviderTraits) points at the generated name->bbox index
 * (build_admin_search_index.py); selecting a result flies the camera to that
 * admin unit's bounding box.
 */
export default class PhilSAAdminSearchProviderTraits extends mixTraits(
  LocationSearchProviderTraits
) {
  @primitiveTrait({
    type: "number",
    name: "Max results",
    description: "Maximum number of matching admin areas to return."
  })
  maxResults: number = 10;

  @primitiveTrait({
    type: "string",
    name: "Geometry base URL",
    description:
      "Base URL (no trailing slash) for the per-level spotlight geometry files " +
      "(ph_admin_geom_adm{0..3}.json). Defaults to the relative 'data' folder; " +
      "set to an R2/CDN base to serve them remotely. Remote hosts must send CORS " +
      "headers for the dashboard origin."
  })
  geomBaseUrl: string = "data";
}
