# Render build of the stac-fastapi-pgstac submodule with PINNED dependency
# versions, so fresh builds are reproducible.
#
# Why this exists: the submodule's own Dockerfile does `pip install .[server,
# catalogs]`, a fresh resolve. Its pyproject pins `stac-fastapi-catalogs-
# extension==0.4.0`, which now drags in a newer `stac-fastapi-extensions` (6.3+)
# where `core.fields` moved — so the app fails at import with
# `ModuleNotFoundError: No module named 'stac_fastapi.extensions.core.fields'`.
# The working local image (built 2026-06) has stac-fastapi-*==6.2.1 +
# catalogs-extension 0.3.0. We reproduce that known-good set here.
#
# The fork imports the external catalogs package at import time (its
# extensions/__init__.py does so unconditionally), so it must be installed — but
# at 0.3.0, NOT the 0.4.0 that pyproject's `[catalogs]` extra forces. We install
# `.[server]` plus `stac-fastapi-catalogs-extension==0.3.0` explicitly, with the
# stac-fastapi-* trio pinned to 6.2.1 via a constraints file.
#
# render.yaml sets dockerContext: ./stac-fastapi-pgstac and points
# dockerfilePath here, so COPY paths below are relative to the submodule root.
ARG PYTHON_VERSION=3.14

FROM python:${PYTHON_VERSION}-slim AS base
RUN apt-get update && apt-get -y upgrade && \
    apt-get install -y build-essential git && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
ENV CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt

FROM base AS builder
RUN python -m pip install -U pip
WORKDIR /app

COPY stac_fastapi/ stac_fastapi/
COPY scripts/wait-for-it.sh scripts/wait-for-it.sh
COPY pyproject.toml pyproject.toml
COPY README.md README.md

# Known-good pins (from the working local image `stac-utils/stac-fastapi-pgstac`).
RUN printf '%s\n' \
    'stac-fastapi-api==6.2.1' \
    'stac-fastapi-extensions==6.2.1' \
    'stac-fastapi-types==6.2.1' \
    'stac-pydantic==3.5.2' \
    > /tmp/constraints.txt
RUN python -m pip install -c /tmp/constraints.txt \
      .[server] "stac-fastapi-catalogs-extension==0.3.0"
RUN rm -rf stac_fastapi README.md

RUN groupadd -g 1000 user && \
    useradd -u 1000 -g user -s /bin/bash -m user
USER user

# render.yaml overrides this with `uvicorn ... --port $PORT`; kept for parity.
CMD ["uvicorn", "stac_fastapi.pgstac.app:app", "--host", "0.0.0.0", "--port", "8080"]
