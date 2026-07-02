"""Dagster definitions for the PhilSA POC pipelines.

Wraps the existing ``pipelines/`` scripts as software-defined assets via
Dagster Pipes subprocesses — the scripts themselves stay standalone and
unmodified (see ``pipelines/README.md`` for the script index and
``PLAN.md`` for the build-out plan).

Load locally with ``dagster dev`` from this directory, or validate with
``dagster definitions validate``.
"""

import dagster as dg

import assets_bronze
import assets_gold
import assets_silver

defs = dg.Definitions(
    assets=dg.load_assets_from_modules([assets_bronze, assets_silver, assets_gold]),
    resources={"pipes_subprocess_client": dg.PipesSubprocessClient()},
)
