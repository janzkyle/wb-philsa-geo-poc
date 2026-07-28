# TiTiler for Render. The upstream image hardcodes port 80; Render injects the
# port to listen on via $PORT, so we override the command to honour it.
# Everything else (R2/S3 GDAL config) is supplied as env vars by render.yaml,
# mirroring compose.viz.yml.
FROM ghcr.io/developmentseed/titiler:latest
# boto3 is missing from the upstream image (confirmed 2026-07-17) but required
# by cogeo-mosaic's S3 backend so /mosaicjson can read s3:// mosaicjson URLs;
# GDAL's /vsis3 driver already handles s3:// COG hrefs without it.
RUN python -m pip install --no-cache-dir boto3
COPY serve.py /app/serve.py
# Origin guard: refuses requests that didn't come through the edge gateway, so
# the public *.onrender.com hostname can't be used to bypass access control.
# No-ops unless GATEWAY_SHARED_SECRET is set — see deploy/AUTH.md.
COPY gateway_guard.py /app/gateway_guard.py
ENV PORT=8000
# TITILER_MAX_CONCURRENT_RENDERS (default 1, see serve.py) caps concurrent tile
# renders so a burst queues instead of OOMing the 512 MB free tier.
CMD ["python", "/app/serve.py"]
