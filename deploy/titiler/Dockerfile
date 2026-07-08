# TiTiler for Render. The upstream image hardcodes port 80; Render injects the
# port to listen on via $PORT, so we override the command to honour it.
# Everything else (R2/S3 GDAL config) is supplied as env vars by render.yaml,
# mirroring compose.viz.yml.
FROM ghcr.io/developmentseed/titiler:latest
ENV PORT=8000
CMD ["sh", "-c", "uvicorn titiler.application.main:app --host 0.0.0.0 --port ${PORT}"]
