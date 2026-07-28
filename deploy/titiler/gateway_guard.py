"""Origin guard: let only the PhilSA edge gateway reach this service.

Why this exists
---------------
TiTiler holds R2 credentials that can read the PRIVATE bucket, and Render gives
it a public ``*.onrender.com`` hostname. Without this guard, anyone who knows
that hostname renders restricted imagery by passing ``?url=s3://<private>/...``
— straight past the edge gateway that is supposed to be the only way in.
(Verified before this landed: the origin served a real PNG tile of a restricted
scene to an anonymous caller.) Access control at the gateway is worth nothing if
the origin answers to everyone.

So the gateway injects a shared secret on every request it forwards
(``deploy/gateway/worker.js``) and this refuses anything without it.

Fail-OPEN when the secret is unset, deliberately:

* it makes the rollout ordering safe — deploy the gateway first so it starts
  sending the header, then set the secret here to switch enforcement on;
* a missing env var degrades to the previous behaviour instead of 403-ing every
  tile, including the open ones the public demo depends on.

Kept in its own module so it can be unit-tested without installing TiTiler.
"""

import hmac
import json

# Health checks are exempt: Render probes them, and the gateway's keep-warm cron
# hits the origin directly (it is waking the service, not proxying a user).
# They expose nothing.
HEALTH_PATHS = frozenset({"/healthz", "/health", "/ping"})

HEADER = b"x-gateway-auth"

_DENIED = json.dumps({
    "detail": "This tile server is reachable only through the PhilSA API gateway. "
              "Use https://philsa-tiles-gateway.philsa.workers.dev (see deploy/AUTH.md)."
}).encode()


class GatewayGuard:
    """ASGI middleware allowing only requests that carry the gateway's secret."""

    def __init__(self, app, secret):
        self.app = app
        self.secret = secret or ""

    @property
    def enforcing(self):
        return bool(self.secret)

    async def __call__(self, scope, receive, send):
        # Non-HTTP scopes ("lifespan", "websocket") pass through untouched, so
        # wrapping the app does not disturb its startup/shutdown handlers.
        if scope.get("type") != "http" or not self.secret:
            await self.app(scope, receive, send)
            return
        if scope.get("path", "") in HEALTH_PATHS:
            await self.app(scope, receive, send)
            return

        presented = b""
        for name, value in scope.get("headers") or []:
            if name.lower() == HEADER:
                presented = value
                break
        # compare_digest, not ==, so a wrong secret can't be recovered byte by byte.
        if not hmac.compare_digest(presented.decode("latin-1"), self.secret):
            await send({
                "type": "http.response.start",
                "status": 403,
                "headers": [(b"content-type", b"application/json"),
                            (b"content-length", str(len(_DENIED)).encode())],
            })
            await send({"type": "http.response.body", "body": _DENIED})
            return

        await self.app(scope, receive, send)
