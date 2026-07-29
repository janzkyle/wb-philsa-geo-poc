# Render build of the stac-fastapi-pgstac submodule with PINNED dependency
# versions, so fresh builds are reproducible. The submodule's own Dockerfile
# resolves against open ranges, so what it installs depends on the day it runs;
# this one installs a fixed set.
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
    'stac-fastapi-api==6.3.2' \
    'stac-fastapi-extensions==6.3.2' \
    'stac-fastapi-types==6.3.2' \
    'stac-pydantic==3.6.0' \
    > /tmp/constraints.txt
RUN python -m pip install -c /tmp/constraints.txt .[server,catalogs]
RUN rm -rf stac_fastapi README.md

RUN groupadd -g 1000 user && \
    useradd -u 1000 -g user -s /bin/bash -m user
USER user

# render.yaml overrides this with `uvicorn ... --port $PORT`; kept for parity.
CMD ["uvicorn", "stac_fastapi.pgstac.app:app", "--host", "0.0.0.0", "--port", "8080"]
