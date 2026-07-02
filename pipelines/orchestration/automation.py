"""Automation for the CopPhil bronze→silver→gold chain — OFF by default.

Two triggers over the same asset job (`copphil_chain_refresh`, the bronze
download plus everything downstream of it):

- ``copphil_new_scene_sensor`` — polls the CopPhil OData catalogue (same
  public search the download script uses: newest product per collection,
  PH-AOI intersect, name-token match) and requests a run only when a scene
  newer than the cursor appears. Primary trigger.
- ``copphil_daily_schedule`` — plain daily run as a fallback; safe because
  every script in the chain is idempotent (skip-if-present / upsert).

Both ship ``DefaultSensorStatus/DefaultScheduleStatus.STOPPED`` — enable them
deliberately in the UI (Automation tab) or via `dagster sensor start` /
`dagster schedule start` once the deployment is real.

The OData query constants mirror ``download_copphil_eodata.py`` (endpoint and
AOI overridable via the same ``COPPHIL_CATALOGUE_URL`` / ``COPPHIL_AOI_WKT``
env vars); the sensor only *detects* new scenes — choosing what to download
remains the bronze script's job.
"""

import json
import os
import urllib.error
import urllib.parse
import urllib.request

import dagster as dg

from assets_bronze import copphil_sentinel

CATALOGUE = os.environ.get(
    "COPPHIL_CATALOGUE_URL",
    "https://catalogue.infra.copphil.philsa.gov.ph/odata/v1/Products",
).rstrip("/")
AOI_WKT = os.environ.get(
    "COPPHIL_AOI_WKT",
    "POLYGON((116.0 4.5,127.0 4.5,127.0 21.5,116.0 21.5,116.0 4.5))",
)
# (OData Collection/Name, product-name token) — same pair the bronze script targets.
COLLECTIONS = {
    "sentinel-1": ("SENTINEL-1", "IW_GRDH"),
    "sentinel-2": ("SENTINEL-2", "MSIL2A"),
}
TIMEOUT = 60

copphil_chain_job = dg.define_asset_job(
    "copphil_chain_refresh",
    selection=dg.AssetSelection.assets(copphil_sentinel).downstream(include_self=True),
    description="Bronze CopPhil download + all downstream silver COGs, mosaics, and gold catalog entries.",
)


def _latest_start(collection_name: str, name_token: str) -> str | None:
    """ContentDate/Start of the newest matching product, ISO string, or None."""
    filt = (
        f"Collection/Name eq '{collection_name}' "
        f"and contains(Name,'{name_token}') "
        f"and OData.CSC.Intersects(area=geography'SRID=4326;{AOI_WKT}')"
    )
    params = urllib.parse.urlencode(
        {"$filter": filt, "$orderby": "ContentDate/Start desc", "$top": "1"},
        quote_via=urllib.parse.quote,
    )
    req = urllib.request.Request(
        f"{CATALOGUE}?{params}", headers={"Accept": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        products = json.load(r).get("value", [])
    if not products:
        return None
    return products[0].get("ContentDate", {}).get("Start")


@dg.sensor(
    job=copphil_chain_job,
    minimum_interval_seconds=3600,
    default_status=dg.DefaultSensorStatus.STOPPED,
)
def copphil_new_scene_sensor(context: dg.SensorEvaluationContext):
    """Request a chain run when CopPhil publishes a scene newer than the cursor."""
    cursor = json.loads(context.cursor) if context.cursor else {}
    latest, fresh = {}, []
    for key, (coll, token) in COLLECTIONS.items():
        try:
            start = _latest_start(coll, token)
        except (urllib.error.URLError, OSError, ValueError) as e:
            context.log.warning(f"CopPhil poll failed for {key}: {e}")
            start = None
        latest[key] = start or cursor.get(key)
        if start and start > cursor.get(key, ""):
            fresh.append(f"{key}@{start}")

    if not fresh:
        return dg.SkipReason(f"no scenes newer than cursor {cursor or '{}'}")

    context.update_cursor(json.dumps(latest))
    return dg.RunRequest(run_key="copphil " + " ".join(sorted(fresh)))


copphil_daily_schedule = dg.ScheduleDefinition(
    job=copphil_chain_job,
    cron_schedule="0 6 * * *",
    execution_timezone="Asia/Manila",
    default_status=dg.DefaultScheduleStatus.STOPPED,
    name="copphil_daily_schedule",
)
