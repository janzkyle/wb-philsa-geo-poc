# Caps how many blocking rasterio/GDAL tile renders run at once (FastAPI
# dispatches sync endpoints to an AnyIO threadpool whose default size is 40).
#
# Without a cap, MapLibre asking for a whole tile grid at once - which is what a
# zoomed-out map does - starts dozens of renders in parallel, each peaking around
# 180 MB, and the 512 MB Render free tier gets OOM-killed. Capping makes the
# burst queue instead: slower under load, but it always answers.
#
# The default of 1 is the value that is safe everywhere, so a missing config can
# never OOM. Raise it per environment via TITILER_MAX_CONCURRENT_RENDERS, next
# to where that environment's resources are declared (render.yaml, compose.viz.yml).
import os
from contextlib import asynccontextmanager

import anyio.to_thread
import uvicorn

from gateway_guard import GatewayGuard
from titiler.application.main import app

MAX_CONCURRENT_RENDERS = int(os.environ.get("TITILER_MAX_CONCURRENT_RENDERS", "1"))

# Origin guard — see gateway_guard.py for the full rationale. In short: this
# service can read the PRIVATE R2 bucket and Render gives it a public hostname,
# so without a shared secret from the edge gateway anyone could render restricted
# imagery here and bypass every access check. Unset secret == fail open.
GATEWAY_SHARED_SECRET = os.environ.get("GATEWAY_SHARED_SECRET", "")


# The limiter is per-event-loop, so it can only be set once the loop is running.
# Wrapping the existing lifespan (rather than @app.on_event, which is deprecated)
# keeps TiTiler's own startup intact.
_titiler_lifespan = app.router.lifespan_context


@asynccontextmanager
async def _lifespan(fastapi_app):
    anyio.to_thread.current_default_thread_limiter().total_tokens = (
        MAX_CONCURRENT_RENDERS
    )
    print(f"max concurrent tile renders: {MAX_CONCURRENT_RENDERS}", flush=True)
    async with _titiler_lifespan(fastapi_app):
        yield


app.router.lifespan_context = _lifespan

# Wrap AFTER the lifespan swap above, so TiTiler's own startup still runs: the
# guard passes non-HTTP scopes (including "lifespan") straight through.
served_app = GatewayGuard(app, GATEWAY_SHARED_SECRET)


if __name__ == "__main__":
    print(
        "gateway guard: "
        + ("ENFORCING (X-Gateway-Auth required)" if GATEWAY_SHARED_SECRET
           else "OFF — GATEWAY_SHARED_SECRET unset, origin is publicly reachable"),
        flush=True,
    )
    uvicorn.run(served_app, host="0.0.0.0", port=int(os.environ["PORT"]))
