# Dagster code-location image for the PhilSA POC pipelines.
#
# Used by the repo-root compose.orchestration.yml for both the webserver and
# the daemon. The repo is bind-mounted at runtime (nothing is baked in), so
# this image only carries the runtime: Dagster + the CLI tools the pipeline
# scripts shell out to (GDAL, curl, unzip).
#
# Known gaps, acceptable for the POC (run those two assets from the host):
#   - silver/ph_admin_pmtiles needs tippecanoe + aws CLI (not installed here)
#   - silver/raster_mosaics execs into the TiTiler container via docker compose
FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends gdal-bin curl unzip \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
    "dagster==1.13.*" "dagster-webserver==1.13.*" dagster-postgres dagster-pipes

# Repo bind-mounted here by compose; definitions live in pipelines/orchestration.
WORKDIR /opt/philsa/pipelines/orchestration
