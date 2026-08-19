"""Privacy-minimal product analytics for authoritative API outcomes."""

import json
import os

import requests

COLLECTOR = "https://analytics.tn07.dev/v1/events"
EVENT_SURFACES = {
    "top_up_completed": "wallet",
    "trade_completed": "trade",
}


def track_product_event(event: str, surface: str) -> None:
    if os.environ.get("K_SERVICE") != "follymarket-api":
        return
    if EVENT_SURFACES.get(event) != surface:
        return

    payload = {
        "event": event,
        "event_version": 1,
        "product": "follymarket",
        "surface": surface,
        "environment": "production",
        "authority": "server",
        "platform": "server",
        "properties": {},
    }
    try:
        requests.post(
            COLLECTOR,
            data=json.dumps(payload),
            headers={
                "Content-Type": "application/json",
                "Origin": "https://follymarket.tn07.dev",
            },
            timeout=2,
        )
    except requests.RequestException:
        pass
