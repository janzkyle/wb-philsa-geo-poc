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

    limit: int = 1
    days: int = 0
    max_cloud: float = 100.0
    dry_run: bool = False


@dg.asset(
    key=dg.AssetKey(["bronze", "copphil_sentinel"]),
    group_name="bronze",
    kinds={"python"},
    description=(
        "Raw Sentinel-1/2 SAFE zips from the CopPhil OData mirror, uploaded to "
        "R2 under 01-bronze/copphil-sentinel/ (download_copphil_eodata.py)."
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
        "--limit", str(config.limit),
        "--days", str(config.days),
        "--max-cloud", str(config.max_cloud),
    ]
    if config.dry_run:
        cmd.append("--dry-run")

    pipes_subprocess_client.run(command=cmd, context=context)
    # Script isn't Pipes-aware; run() raised if the exit code was nonzero.
    return dg.MaterializeResult(
        metadata={
            "command": " ".join(cmd),
            "dry_run": config.dry_run,
            "r2_prefix": "01-bronze/copphil-sentinel",
        }
    )
