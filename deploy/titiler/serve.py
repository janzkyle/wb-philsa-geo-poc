# Caps concurrent blocking tile renders (the rasterio/GDAL work FastAPI runs in
# its threadpool) so a burst of tile requests queues instead of piling up in
# memory at once. Measured locally: idle ~147 MB, one cold mosaic tile render
# peaks ~324 MB - on Render's 512 MB free tier, a handful of concurrent renders
# (e.g. MapLibre's tile grid on a low-zoom pan) is what triggered the OOM kill.
# Serializing trades latency under a burst for not crashing.
import os

import anyio.to_thread
import uvicorn

from titiler.application.main import app

MAX_CONCURRENT_RENDERS = int(os.environ.get("TITILER_MAX_CONCURRENT_RENDERS", "1"))


@app.on_event("startup")
async def _limit_render_concurrency() -> None:
    anyio.to_thread.current_default_thread_limiter().total_tokens = MAX_CONCURRENT_RENDERS


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ["PORT"]))
