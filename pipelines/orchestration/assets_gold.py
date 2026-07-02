"""Gold-tier Dagster assets — silver COGs registered in pgSTAC by reference.

Wraps ``pipelines/03-gold/catalog_silver.py`` (unmodified) as a Pipes
subprocess. The script lists the silver R2 prefixes itself, reads COG
geo-metadata via gdalinfo, and upserts Collections + Items into the pgSTAC
API (POST → PUT on 409), so re-runs converge. Needs the STAC API up
(default http://localhost:8082) and, when run outside --dry-run, GDAL.
"""

import sys

import dagster as dg

from assets_bronze import REPO_ROOT
from assets_silver import (
    raster_mosaics,
    sentinel1_flood,
    sentinel1_sar,
    sentinel2_ndvi,
    sentinel2_truecolor,
)

GOLD_SCRIPT = REPO_ROOT / "pipelines" / "03-gold" / "catalog_silver.py"


class CatalogSilverConfig(dg.Config):
    dry_run: bool = False  # build + list, no writes to pgSTAC
    only: str = ""  # space-separated collection ids; empty = all
    stac_api: str = ""  # STAC API base URL; empty = script default (localhost:8082)


@dg.asset(
    key=dg.AssetKey(["gold", "stac_catalog"]),
    group_name="gold",
    kinds={"python"},
    deps=[sentinel2_ndvi, sentinel2_truecolor, sentinel1_sar, sentinel1_flood, raster_mosaics],
    description=(
        "Silver COGs registered as STAC Collections + Items in pgSTAC by "
        "reference, with render-extension hints (catalog_silver.py)."
    ),
)
def stac_catalog(
    context: dg.AssetExecutionContext,
    config: CatalogSilverConfig,
    pipes_subprocess_client: dg.PipesSubprocessClient,
) -> dg.MaterializeResult:
    cmd = [sys.executable, str(GOLD_SCRIPT)]
    if config.dry_run:
        cmd.append("--dry-run")
    if config.only:
        cmd += ["--only", *config.only.split()]

    env = {"STAC_API": config.stac_api} if config.stac_api else {}
    pipes_subprocess_client.run(command=cmd, context=context, env=env)
    # Script isn't Pipes-aware; run() raised if the exit code was nonzero.
    return dg.MaterializeResult(metadata={"command": " ".join(cmd), **env})
