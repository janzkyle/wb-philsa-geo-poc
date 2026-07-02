"""Silver-tier Dagster assets — derived Sentinel COGs and mosaics → R2.

Wraps the ``pipelines/02-silver/`` shell scripts as Pipes subprocesses. The
scripts are unmodified: they take parameters via environment variables, load
the repo-root ``.env`` themselves, and skip work whose R2 output already
exists (set ``force`` in run config to rebuild). Empty config values are NOT
exported, so each script's own defaults apply.

Lineage note: ``build_flood.sh`` reads the EXISTING silver VV-dB COG (built by
``build_sar.sh``), not the raw bronze zip — so the flood asset depends on the
SAR asset, which in turn depends on bronze.
"""

import dagster as dg

from assets_bronze import REPO_ROOT, copphil_sentinel

SILVER_DIR = REPO_ROOT / "pipelines" / "02-silver"


def _run_silver_script(context, client, script_path, env):
    """Run a silver shell script via Pipes; env values that are empty are dropped
    so the script's own defaults take over. Scripts aren't Pipes-aware: a clean
    exit is the materialization (run() raises on a nonzero exit code)."""
    env = {k: str(v) for k, v in env.items() if v not in ("", None)}
    client.run(command=["bash", str(script_path)], context=context, env=env)
    return dg.MaterializeResult(
        metadata={"script": str(script_path.relative_to(REPO_ROOT)), **env}
    )


class SceneBuildConfig(dg.Config):
    """Common knobs for the per-scene S2 builders (see script headers)."""

    scene: str = ""  # bronze .SAFE.zip basename; empty = script default scene
    force: bool = False  # rebuild even if the R2 output already exists


class SarBuildConfig(SceneBuildConfig):
    pol: str = ""  # polarisation; empty = script default (vv)


class FloodBuildConfig(dg.Config):
    sar_name: str = ""  # silver VV-dB COG basename; empty = script default
    method: str = ""  # sigma | otsu | fixed; empty = script default (sigma)
    force: bool = False


class AdminGeoparquetConfig(dg.Config):
    tolerance_m: int = 0  # simplification tolerance in meters; 0 = full resolution
    levels: str = ""  # space-separated admin levels; empty = script default (0 1 2 3 4)


class AdminPmtilesConfig(dg.Config):
    levels: str = ""  # space-separated admin levels; empty = script default (0 1 2)
    dry_run: bool = False  # build PMTiles but skip the R2 upload


class MosaicsConfig(dg.Config):
    collections: str = ""  # space-separated; empty = script default (all three)
    stac_api: str = ""  # empty = script default (http://localhost:8082)


@dg.asset(
    key=dg.AssetKey(["silver", "sentinel2_ndvi"]),
    group_name="silver",
    kinds={"bash"},
    deps=[copphil_sentinel],
    description="NDVI Float32 COG from bronze S2 L2A → R2 02-silver/sentinel2-ndvi/ (build_ndvi.sh).",
)
def sentinel2_ndvi(
    context: dg.AssetExecutionContext,
    config: SceneBuildConfig,
    pipes_subprocess_client: dg.PipesSubprocessClient,
) -> dg.MaterializeResult:
    return _run_silver_script(
        context,
        pipes_subprocess_client,
        SILVER_DIR / "sentinel2-ndvi" / "build_ndvi.sh",
        {"SCENE": config.scene, "FORCE": "1" if config.force else ""},
    )


@dg.asset(
    key=dg.AssetKey(["silver", "sentinel2_truecolor"]),
    group_name="silver",
    kinds={"bash"},
    deps=[copphil_sentinel],
    description="True-colour 8-bit RGB COG from bronze S2 TCI → R2 02-silver/sentinel2-truecolor/ (build_truecolor.sh).",
)
def sentinel2_truecolor(
    context: dg.AssetExecutionContext,
    config: SceneBuildConfig,
    pipes_subprocess_client: dg.PipesSubprocessClient,
) -> dg.MaterializeResult:
    return _run_silver_script(
        context,
        pipes_subprocess_client,
        SILVER_DIR / "sentinel2-truecolor" / "build_truecolor.sh",
        {"SCENE": config.scene, "FORCE": "1" if config.force else ""},
    )


@dg.asset(
    key=dg.AssetKey(["silver", "sentinel1_sar"]),
    group_name="silver",
    kinds={"bash"},
    deps=[copphil_sentinel],
    description="Geocoded VV backscatter (dB) COG from bronze S1 GRD → R2 02-silver/sentinel1-sar/ (build_sar.sh).",
)
def sentinel1_sar(
    context: dg.AssetExecutionContext,
    config: SarBuildConfig,
    pipes_subprocess_client: dg.PipesSubprocessClient,
) -> dg.MaterializeResult:
    return _run_silver_script(
        context,
        pipes_subprocess_client,
        SILVER_DIR / "sentinel1-sar" / "build_sar.sh",
        {"SCENE": config.scene, "POL": config.pol, "FORCE": "1" if config.force else ""},
    )


@dg.asset(
    key=dg.AssetKey(["silver", "sentinel1_flood"]),
    group_name="silver",
    kinds={"bash"},
    deps=[sentinel1_sar],
    description=(
        "POC flood/water Byte mask COG thresholded from the silver VV-dB COG "
        "→ R2 02-silver/sentinel1-flood/ (build_flood.sh; not a validated product)."
    ),
)
def sentinel1_flood(
    context: dg.AssetExecutionContext,
    config: FloodBuildConfig,
    pipes_subprocess_client: dg.PipesSubprocessClient,
) -> dg.MaterializeResult:
    return _run_silver_script(
        context,
        pipes_subprocess_client,
        SILVER_DIR / "sentinel1-flood" / "build_flood.sh",
        {
            "SAR_NAME": config.sar_name,
            "METHOD": config.method,
            "FORCE": "1" if config.force else "",
        },
    )


@dg.asset(
    key=dg.AssetKey(["silver", "ph_admin_geoparquet"]),
    group_name="silver",
    kinds={"bash"},
    description=(
        "PH admin boundary GeoParquet (adm0–adm4) from the OCHA COD-AB "
        "geodatabase on HDX → R2 02-silver/ph-admin-boundaries/ "
        "(build_ph_admin_geoparquet.sh). Manual-run: source is external, "
        "no upstream asset."
    ),
)
def ph_admin_geoparquet(
    context: dg.AssetExecutionContext,
    config: AdminGeoparquetConfig,
    pipes_subprocess_client: dg.PipesSubprocessClient,
) -> dg.MaterializeResult:
    return _run_silver_script(
        context,
        pipes_subprocess_client,
        SILVER_DIR / "ph-admin-boundaries" / "build_ph_admin_geoparquet.sh",
        {
            "TOLERANCE_M": str(config.tolerance_m) if config.tolerance_m else "",
            "LEVELS": config.levels,
        },
    )


@dg.asset(
    key=dg.AssetKey(["silver", "ph_admin_pmtiles"]),
    group_name="silver",
    kinds={"bash"},
    deps=[ph_admin_geoparquet],
    description=(
        "PH admin boundary PMTiles (adm0–adm2) for the webmap, tiled from the "
        "GeoParquet already on R2 → 02-silver/ph-admin-boundaries/pmtiles/ "
        "(build_ph_admin_pmtiles.sh; needs tippecanoe + aws CLI)."
    ),
)
def ph_admin_pmtiles(
    context: dg.AssetExecutionContext,
    config: AdminPmtilesConfig,
    pipes_subprocess_client: dg.PipesSubprocessClient,
) -> dg.MaterializeResult:
    return _run_silver_script(
        context,
        pipes_subprocess_client,
        SILVER_DIR / "ph-admin-boundaries" / "build_ph_admin_pmtiles.sh",
        {"LEVELS": config.levels, "DRY_RUN": "1" if config.dry_run else ""},
    )


@dg.asset(
    key=dg.AssetKey(["silver", "raster_mosaics"]),
    group_name="silver",
    kinds={"bash"},
    deps=[sentinel2_ndvi, sentinel2_truecolor, sentinel1_sar, sentinel1_flood],
    description=(
        "Per-date MosaicJSON stitching same-day COG granules per collection "
        "→ R2 02-silver/<coll>/mosaics/ (build_raster_mosaics.sh; needs the "
        "STAC API and the compose.viz.yml TiTiler container running)."
    ),
)
def raster_mosaics(
    context: dg.AssetExecutionContext,
    config: MosaicsConfig,
    pipes_subprocess_client: dg.PipesSubprocessClient,
) -> dg.MaterializeResult:
    return _run_silver_script(
        context,
        pipes_subprocess_client,
        SILVER_DIR / "build_raster_mosaics.sh",
        {"COLLECTIONS": config.collections, "STAC_API": config.stac_api},
    )
