import json
import os

import product_analytics


def test_event_payload_has_no_user_or_market_identifiers(monkeypatch):
    calls = []
    monkeypatch.setenv("K_SERVICE", "follymarket-api")
    monkeypatch.setattr(product_analytics.requests, "post", lambda url, **kwargs: calls.append((url, kwargs)))

    product_analytics.track_product_event("trade_completed", "trade")

    assert len(calls) == 1
    payload = json.loads(calls[0][1]["data"])
    assert payload["event"] == "trade_completed"
    assert payload["event_version"] == 1
    assert payload["product"] == "follymarket"
    assert payload["authority"] == "server"
    assert payload["platform"] == "server"
    assert payload["properties"] == {}
    assert not any(key in json.dumps(payload) for key in ("user", "market_id", "email"))


def test_unknown_event_is_rejected(monkeypatch):
    monkeypatch.setenv("K_SERVICE", "follymarket-api")
    called = False

    def post(*args, **kwargs):
        nonlocal called
        called = True

    monkeypatch.setattr(product_analytics.requests, "post", post)
    product_analytics.track_product_event("balance_viewed", "wallet")
    assert called is False
