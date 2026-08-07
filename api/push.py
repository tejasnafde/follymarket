"""Web push, the plain VAPID kind. No FCM SDK, no Firebase console step.

The private key arrives as a PEM in the environment and is written to a file once,
because pywebpush's documented input is a path to a PEM file. Sends run on a small
thread pool inside the request rather than in a background task: Cloud Run can
throttle CPU after the response is sent, so a background send is not reliable.
Ten players means one extra round trip, not a fan-out problem.
"""

import hashlib
import json
import logging
import os
import tempfile
from concurrent.futures import ThreadPoolExecutor

from pywebpush import WebPushException, webpush

log = logging.getLogger("push")

PUBLIC = os.environ.get("FOLLY_VAPID_PUBLIC", "").strip()
SUBJECT = os.environ.get("FOLLY_VAPID_SUBJECT", "mailto:tejas@tn07.dev").strip()
SITE = os.environ.get("FOLLY_SITE", "https://follymarket.tn07.dev").rstrip("/")

_PEM_PATH = None
_pem = os.environ.get("FOLLY_VAPID_PRIVATE_PEM", "")
if _pem.strip():
    fd, _PEM_PATH = tempfile.mkstemp(suffix=".pem")
    with os.fdopen(fd, "w") as f:
        f.write(_pem.replace("\\n", "\n"))

ENABLED = bool(PUBLIC and _PEM_PATH)


def sub_id(endpoint: str) -> str:
    """A push endpoint is a long URL with slashes, so it cannot be a document id."""
    return hashlib.sha256(endpoint.encode()).hexdigest()[:40]


def _send(subscription: dict, payload: str) -> str | None:
    """Returns "gone" when the browser has thrown the subscription away."""
    try:
        webpush(subscription_info=subscription, data=payload,
                vapid_private_key=_PEM_PATH, vapid_claims={"sub": SUBJECT},
                timeout=4)
        return None
    except WebPushException as e:
        code = getattr(e.response, "status_code", None)
        if code in (404, 410):
            return "gone"
        log.warning("push failed: %s %s", code, e)
        return None
    except Exception as e:                      # never let a push break a trade
        log.warning("push error: %s", e)
        return None


def send_many(subs: list[tuple[str, dict]], title: str, body: str, url: str,
              tag: str | None = None) -> list[str]:
    """Send one notification to many subscriptions.

    `subs` is (document id, subscription) pairs. Returns the ids that are dead and
    should be deleted by the caller, which owns the database.
    """
    if not ENABLED or not subs:
        return []
    payload = json.dumps({"title": title, "body": body,
                          "url": url if url.startswith("http") else SITE + url,
                          "tag": tag or ""})
    dead = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(_send, sub, payload): sid for sid, sub in subs}
        for fut, sid in futures.items():
            try:
                if fut.result(timeout=5) == "gone":
                    dead.append(sid)
            except Exception as e:
                log.warning("push worker died: %s", e)
    return dead


def valid_subscription(sub: object) -> bool:
    """Trust boundary: this object is handed to a signing library and stored."""
    if not isinstance(sub, dict):
        return False
    ep = sub.get("endpoint")
    keys = sub.get("keys")
    if not isinstance(ep, str) or not ep.startswith("https://") or len(ep) > 1000:
        return False
    if not isinstance(keys, dict):
        return False
    p256, auth = keys.get("p256dh"), keys.get("auth")
    return (isinstance(p256, str) and isinstance(auth, str)
            and 0 < len(p256) <= 200 and 0 < len(auth) <= 100)
