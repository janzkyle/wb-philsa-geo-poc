"""Dagster definitions for the PhilSA POC pipelines.

Wraps the existing ``pipelines/`` scripts as software-defined assets via
Dagster Pipes subprocesses — the scripts themselves stay standalone and
unmodified (see ``pipelines/README.md`` for the script index and
``PLAN.md`` for the build-out plan).

Load locally with ``dagster dev`` from this directory, or validate with
``dagster definitions validate``.
"""

import dagster as dg

defs = dg.Definitions()
