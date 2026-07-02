"""Reference-lane Dagster assets — by-reference catalog loaders.

Wraps the ``pipelines/reference/`` loaders (unmodified) as Pipes subprocesses.
These sit outside the medallion flow: they copy only STAC metadata into pgSTAC
and leave pixels at their original source, so they have no upstream assets and
are manual-run. Both need the STAC API up (default http://localhost:8082) and
are idempotent (POST → PUT on 409).
"""

import sys

import dagster as dg

from assets_bronze import REPO_ROOT

REFERENCE_DIR = REPO_ROOT / "pipelines" / "reference"


class PhilsaMirrorConfig(dg.Config):
    dry_run: bool = False  # report without writing
    only: str = ""  # space-separated collection ids; empty = all
    max_items: int = 0  # cap items per collection; 0 = all
    collections_only: bool = False  # skip items


class EsriLulcConfig(dg.Config):
    year: int = 0  # LULC year; 0 = script default (2025)
    tiles: str = ""  # MGRS grid-zone tiles; empty = script default (PH coverage)


@dg.asset(
    key=dg.AssetKey(["reference", "philsa_catalog"]),
    group_name="reference",
    kinds={"python"},
    description=(
        "PhilSA Satellite Imagery Catalog (Diwata-2, SkySat, PlanetScope) "
        "mirrored into pgSTAC by reference (mirror_philsa_catalog.py)."
    ),
)
def philsa_catalog(
    context: dg.AssetExecutionContext,
    config: PhilsaMirrorConfig,
    pipes_subprocess_client: dg.PipesSubprocessClient,
) -> dg.MaterializeResult:
    cmd = [sys.executable, str(REFERENCE_DIR / "philsa-catalog" / "mirror_philsa_catalog.py")]
    if config.dry_run:
        cmd.append("--dry-run")
    if config.only:
        cmd += ["--only", *config.only.split()]
    if config.max_items:
        cmd += ["--max-items", str(config.max_items)]
    if config.collections_only:
        cmd.append("--collections-only")

    pipes_subprocess_client.run(command=cmd, context=context)
    # Script isn't Pipes-aware; run() raised if the exit code was nonzero.
    return dg.MaterializeResult(metadata={"command": " ".join(cmd)})


@dg.asset(
    key=dg.AssetKey(["reference", "esri_lulc"]),
    group_name="reference",
    kinds={"bash"},
    description=(
        "ESRI 10 m Annual LULC COGs over the Philippines registered in pgSTAC "
        "by reference to the public Azure blobs (load_esri_lulc.sh)."
    ),
)
def esri_lulc(
    context: dg.AssetExecutionContext,
    config: EsriLulcConfig,
    pipes_subprocess_client: dg.PipesSubprocessClient,
) -> dg.MaterializeResult:
    env = {}
    if config.year:
        env["YEAR"] = str(config.year)
    if config.tiles:
        env["TILES"] = config.tiles

    pipes_subprocess_client.run(
        command=["bash", str(REFERENCE_DIR / "esri-lulc" / "load_esri_lulc.sh")],
        context=context,
        env=env,
    )
    return dg.MaterializeResult(metadata={"script": "pipelines/reference/esri-lulc/load_esri_lulc.sh", **env})
