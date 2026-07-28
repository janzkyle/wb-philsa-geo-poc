"""Unit tests for the TiTiler origin guard.

    cd deploy/titiler && python3 -m unittest test_gateway_guard -v

Stdlib only, and it never imports TiTiler — the guard lives in its own module
precisely so this runs anywhere.
"""

import asyncio
import json
import unittest

from gateway_guard import GatewayGuard

SECRET = "s3cr3t-value"


async def _inner(scope, receive, send):
    """Stand-in for TiTiler: records that it was reached, answers 200."""
    _inner.reached = True
    await send({"type": "http.response.start", "status": 200,
                "headers": [(b"content-type", b"text/plain")]})
    await send({"type": "http.response.body", "body": b"tile"})


def call(guard, path="/cog/info", headers=None, scope_type="http"):
    """Drive the middleware once; return (status, body, reached_inner)."""
    _inner.reached = False
    sent = []

    async def send(msg):
        sent.append(msg)

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    scope = {"type": scope_type, "path": path, "headers": headers or []}
    asyncio.run(guard(scope, receive, send))
    status = next((m["status"] for m in sent if m["type"] == "http.response.start"), None)
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return status, body, _inner.reached


class GuardEnforcing(unittest.TestCase):
    def setUp(self):
        self.guard = GatewayGuard(_inner, SECRET)

    def test_reports_enforcing(self):
        self.assertTrue(self.guard.enforcing)

    def test_correct_secret_passes_through(self):
        status, body, reached = call(self.guard, headers=[(b"x-gateway-auth", SECRET.encode())])
        self.assertEqual(status, 200)
        self.assertEqual(body, b"tile")
        self.assertTrue(reached)

    def test_header_name_is_case_insensitive(self):
        # HTTP header names are case-insensitive and ASGI servers may not
        # normalise them; matching only lowercase would be a silent lockout.
        status, _, reached = call(self.guard, headers=[(b"X-Gateway-Auth", SECRET.encode())])
        self.assertEqual(status, 200)
        self.assertTrue(reached)

    def test_missing_header_is_refused(self):
        status, body, reached = call(self.guard)
        self.assertEqual(status, 403)
        self.assertFalse(reached, "the wrapped app must never run for a refused request")
        self.assertIn("gateway", json.loads(body)["detail"].lower())

    def test_wrong_secret_is_refused(self):
        status, _, reached = call(self.guard, headers=[(b"x-gateway-auth", b"nope")])
        self.assertEqual(status, 403)
        self.assertFalse(reached)

    def test_empty_header_is_refused(self):
        status, _, reached = call(self.guard, headers=[(b"x-gateway-auth", b"")])
        self.assertEqual(status, 403)
        self.assertFalse(reached)

    def test_prefix_of_the_secret_is_refused(self):
        status, _, reached = call(self.guard, headers=[(b"x-gateway-auth", SECRET[:-1].encode())])
        self.assertEqual(status, 403)
        self.assertFalse(reached)

    def test_health_paths_stay_open(self):
        # Render probes these and the gateway's keep-warm cron hits the origin
        # directly; locking them would make the service look dead.
        for path in ("/healthz", "/health", "/ping"):
            with self.subTest(path=path):
                status, _, reached = call(self.guard, path=path)
                self.assertEqual(status, 200)
                self.assertTrue(reached)

    def test_health_prefix_is_not_a_loophole(self):
        # "/healthz" is exempt; "/healthz/../cog/info" style paths are not.
        status, _, reached = call(self.guard, path="/healthzzz")
        self.assertEqual(status, 403)
        self.assertFalse(reached)

    def test_lifespan_scope_passes_through_without_a_header(self):
        # If the guard swallowed lifespan events, TiTiler's startup — and the
        # concurrency limiter serve.py installs there — would never run. Note the
        # scope carries NO header: startup must not need the gateway secret.
        seen = []

        async def lifespan_app(scope, receive, send):
            seen.append(scope["type"])
            await send({"type": "lifespan.startup.complete"})

        async def receive():
            return {"type": "lifespan.startup"}

        sent = []

        async def send(msg):
            sent.append(msg["type"])

        guard = GatewayGuard(lifespan_app, SECRET)
        asyncio.run(guard({"type": "lifespan"}, receive, send))
        self.assertEqual(seen, ["lifespan"], "guard must delegate lifespan to the app")
        self.assertEqual(sent, ["lifespan.startup.complete"])


class GuardFailOpen(unittest.TestCase):
    """Unset secret must behave exactly as before the guard existed."""

    def setUp(self):
        self.guard = GatewayGuard(_inner, "")

    def test_reports_not_enforcing(self):
        self.assertFalse(self.guard.enforcing)

    def test_requests_pass_without_a_header(self):
        status, body, reached = call(self.guard)
        self.assertEqual(status, 200)
        self.assertEqual(body, b"tile")
        self.assertTrue(reached)

    def test_none_secret_is_treated_as_unset(self):
        status, _, reached = call(GatewayGuard(_inner, None))
        self.assertEqual(status, 200)
        self.assertTrue(reached)


if __name__ == "__main__":
    unittest.main()
