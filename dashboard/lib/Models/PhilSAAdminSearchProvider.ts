import { makeObservable, runInAction } from "mobx";
import Rectangle from "terriajs-cesium/Source/Core/Rectangle";
import {
  Category,
  SearchAction
} from "terriajs/lib/Core/Analytics/analyticEvents";
import loadJson from "terriajs/lib/Core/loadJson";
import LocationSearchProviderMixin from "terriajs/lib/ModelMixins/SearchProviders/LocationSearchProviderMixin";
import CreateModel from "terriajs/lib/Models/Definition/CreateModel";
import Terria from "terriajs/lib/Models/Terria";
import SearchProviderResults from "terriajs/lib/Models/SearchProviders/SearchProviderResults";
import SearchResult from "terriajs/lib/Models/SearchProviders/SearchResult";
import { applyAdminFocusMask } from "./philsaAdminFocusMask";
import PhilSAAdminSearchProviderTraits from "./PhilSAAdminSearchProviderTraits";

interface AdminEntry {
  name: string; // disambiguated label, e.g. "Ilocos Sur, Region I (Ilocos Region)"
  tier: string; // "Country" | "Region" | "Province" | "City / Municipality"
  level: number; // 0..3 — which geometry file holds this unit
  pcode: string; // unique P-code, used to find the unit's geometry for the mask
  w: number;
  s: number;
  e: number;
  n: number;
}

// Coarser tiers rank above finer ones when scores tie (so "Region X" beats a
// same-named municipality).
const TIER_RANK: Record<string, number> = {
  Country: 0,
  Region: 1,
  Province: 2,
  "City / Municipality": 3
};

/**
 * A local search provider over the generated PH admin-area index
 * (build_admin_search_index.py). Typing a region / province / city name and
 * selecting a result flies the camera to that unit's bounding box — the
 * "admin-area filter" for the dashboard. Boundaries themselves are the `mvt`
 * layers in the catalog; this just drives navigation to them.
 */
export default class PhilSAAdminSearchProvider extends LocationSearchProviderMixin(
  CreateModel(PhilSAAdminSearchProviderTraits)
) {
  static readonly type = "philsa-admin-search-provider";

  private _indexPromise: Promise<AdminEntry[]> | undefined;

  get type() {
    return PhilSAAdminSearchProvider.type;
  }

  constructor(uniqueId: string | undefined, terria: Terria) {
    super(uniqueId, terria);
    makeObservable(this);
  }

  private loadIndex(): Promise<AdminEntry[]> {
    if (this._indexPromise === undefined) {
      this._indexPromise = Promise.resolve(loadJson(this.url)).then((data) =>
        Array.isArray(data) ? (data as AdminEntry[]) : []
      );
    }
    return this._indexPromise;
  }

  protected logEvent(searchText: string) {
    this.terria.analytics.logEvent(
      Category.search,
      SearchAction.gazetteer,
      searchText
    );
  }

  protected doSearch(
    searchText: string,
    searchResults: SearchProviderResults
  ): Promise<void> {
    searchResults.results.length = 0;
    searchResults.message = undefined;

    const query = searchText.trim().toLowerCase();
    if (query.length === 0) {
      return Promise.resolve();
    }

    return this.loadIndex()
      .then((index) => {
        if (searchResults.isCanceled) {
          return;
        }

        const scored: { entry: AdminEntry; score: number }[] = [];
        for (const entry of index) {
          const hay = entry.name.toLowerCase();
          const at = hay.indexOf(query);
          if (at < 0) {
            continue;
          }
          // Prefix match beats mid-string match; coarser tier breaks ties.
          const score = at * 10 + (TIER_RANK[entry.tier] ?? 9);
          scored.push({ entry, score });
        }
        scored.sort(
          (a, b) =>
            a.score - b.score || a.entry.name.localeCompare(b.entry.name)
        );

        const results = scored
          .slice(0, this.maxResults)
          .map(({ entry }) => this.toResult(entry));

        runInAction(() => {
          searchResults.results.push(...results);
        });

        if (searchResults.results.length === 0) {
          searchResults.message = {
            content: "translate#viewModels.searchNoLocations"
          };
        }
      })
      .catch(() => {
        if (searchResults.isCanceled) {
          return;
        }
        searchResults.message = {
          content: "translate#viewModels.searchErrorOccurred"
        };
      });
  }

  private toResult(entry: AdminEntry): SearchResult {
    const rectangle = Rectangle.fromDegrees(entry.w, entry.s, entry.e, entry.n);
    const terria = this.terria;
    const duration = this.flightDurationSeconds;
    const geomBaseUrl = this.geomBaseUrl;
    return new SearchResult({
      name: `${entry.name}  ·  ${entry.tier}`,
      location: {
        longitude: (entry.w + entry.e) / 2,
        latitude: (entry.s + entry.n) / 2
      },
      clickAction: function () {
        terria.currentViewer.zoomTo(rectangle, duration);
        // Spotlight filter: dim everything outside the picked unit so the other
        // (raster) layers only read inside it. Fire-and-forget; failures are
        // surfaced via Terria's own error handling, not the search box.
        applyAdminFocusMask(
          terria,
          geomBaseUrl,
          entry.level,
          entry.pcode,
          entry.name
        ).catch(() => {});
      }
    });
  }

  supportsAutocomplete(): boolean {
    return true;
  }
}
