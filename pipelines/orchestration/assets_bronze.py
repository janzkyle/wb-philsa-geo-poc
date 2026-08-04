"""Bronze-tier Dagster assets — raw CopPhil Sentinel scenes → R2.

Wraps ``pipelines/01-bronze/copphil-sentinel/download_copphil_eodata.py`` as a
Pipes subprocess. The script is unmodified and not Pipes-aware: it loads the
repo-root ``.env`` itself, is idempotent (HEAD-then-skip uploads), and signals
failure via exit code — so the asset treats a clean exit as the
materialization and reports its own result.
"""

import sys
from pathlib import Path

import dagster as dg

REPO_ROOT = Path(__file__).resolve().parents[2]

BRONZE_SCRIPT = (
    REPO_ROOT / "pipelines" / "01-bronze" / "copphil-sentinel" / "download_copphil_eodata.py"
)


class CopphilDownloadConfig(dg.Config):
    """Mirrors the script's CLI flags (see its --help for semantics)."""

    aoi: str = ""  # WGS84 WKT to narrow the search ("" = the script's PH-wide default)
    dates: int = 3  # fetch every scene from the N most recent acquisition dates over the AOI
    fetch_all: bool = False  # --all: no date window, every scene for the other filters
    limit: int = 0  # cap scenes per collection (0 = no cap)
    days: int = 0
    max_cloud: float = 20.0  # Sentinel-2 cloudCover ceiling (100 = no filter)
    to_r2: bool = False  # also upload as bronze to R2 (default: local only)
    dry_run: bool = False


@dg.asset(
    key=dg.AssetKey(["bronze", "copphil_sentinel"]),
    group_name="bronze",
    kinds={"python"},
    description=(
        "Raw Sentinel-1/2 SAFE zips from the CopPhil OData mirror — the latest "
        "N cloud-free acquisition dates over the AOI (default: nationwide, "
        "S2 cloud ≤ 20%%), downloaded to local eodata/ for the downstream silver "
        "step (download_copphil_eodata.py; pass to_r2 to also upload them as "
        "bronze under 01-bronze/copphil-sentinel/). A nationwide run is large — "
        "set limit, days, or aoi to bound it."
    ),
)
def copphil_sentinel(
    context: dg.AssetExecutionContext,
    config: CopphilDownloadConfig,
    pipes_subprocess_client: dg.PipesSubprocessClient,
) -> dg.MaterializeResult:
    cmd = [
        sys.executable,
        str(BRONZE_SCRIPT),
        "--dates", str(config.dates),
        "--limit", str(config.limit),
        "--days", str(config.days),
        "--max-cloud", str(config.max_cloud),
    ]
    if config.aoi:
        cmd += ["--aoi", config.aoi]
    if config.fetch_all:
        cmd.append("--all")  # overrides --dates in the script
    if config.to_r2:
        cmd.append("--r2")
    if config.dry_run:
        cmd.append("--dry-run")

    pipes_subprocess_client.run(command=cmd, context=context)
    # Script isn't Pipes-aware; run() raised if the exit code was nonzero.
    return dg.MaterializeResult(
        metadata={
            "command": " ".join(cmd),
            "dry_run": config.dry_run,
            "fetch_all": config.fetch_all,
            "to_r2": config.to_r2,
            "dest": "01-bronze/copphil-sentinel (R2)" if config.to_r2 else "local eodata/",
        }
    )
