# Dagster code-location image for the PhilSA POC pipelines.
#
# Used by the repo-root compose.orchestration.yml for both the webserver and
# the daemon. The repo is bind-mounted at runtime (nothing is baked in), so
# this image only carries the runtime: Dagster + the CLI tools the pipeline
# scripts shell out to.
#
# Self-sufficient for the automated CopPhil chain AND the manual admin-boundary
# path — everything runs in-container, no host tools or docker socket needed:
#   - GDAL (gdal-bin)                     raster warps / NDVI / SAR / flood / catalog
#   - cogeo-mosaic (pip)                  silver/raster_mosaics builds the MosaicJSON
#                                         locally (no exec into the TiTiler container)
#   - tippecanoe (built below) + aws CLI  silver/ph_admin_pmtiles
# The GDAL/AWS S3 env that lets the local mosaic build read COGs from R2 is set
# on the compose service (compose.orchestration.yml), mirroring compose.viz.yml.

# --- stage 1: build tippecanoe from source (no apt package on Debian) ---
FROM python:3.12-slim AS tippecanoe
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git build-essential libsqlite3-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch 2.79.0 https://github.com/felt/tippecanoe.git /tmp/tippecanoe \
    && make -C /tmp/tippecanoe -j"$(nproc)" \
    && make -C /tmp/tippecanoe install

# --- stage 2: runtime ---
FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends gdal-bin curl unzip \
    && rm -rf /var/lib/apt/lists/*

# tippecanoe binary from stage 1 (writes PMTiles directly; no pmtiles CLI needed).
COPY --from=tippecanoe /usr/local/bin/tippecanoe /usr/local/bin/tippecanoe

RUN pip install --no-cache-dir \
    "dagster==1.13.*" "dagster-webserver==1.13.*" dagster-postgres dagster-pipes \
    cogeo-mosaic awscli

# Repo bind-mounted here by compose; definitions live in pipelines/orchestration.
WORKDIR /opt/philsa/pipelines/orchestration
