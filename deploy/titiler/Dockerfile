# TiTiler for Render. The upstream image hardcodes port 80; Render injects the
# port to listen on via $PORT, so we override the command to honour it.
# Everything else (R2/S3 GDAL config) is supplied as env vars by render.yaml,
# mirroring compose.viz.yml.
FROM ghcr.io/developmentseed/titiler:latest
# boto3 is missing from the upstream image (confirmed 2026-07-17) but required
# by cogeo-mosaic's S3 backend so /mosaicjson can read s3:// mosaicjson URLs;
# GDAL's /vsis3 driver already handles s3:// COG hrefs without it.
RUN python -m pip install --no-cache-dir boto3
ENV PORT=8000
CMD ["sh", "-c", "uvicorn titiler.application.main:app --host 0.0.0.0 --port ${PORT}"]
