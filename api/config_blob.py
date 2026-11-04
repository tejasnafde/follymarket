"""Expand FOLLYMARKET_CONFIG, one JSON secret holding every credential.

Secret Manager bills per secret version per month, not per byte, so two
secrets cost twice what one JSON object holding the same two values
costs. Cloud Run maps one secret to one env var, so the fan-out happens here.

The secret is `follymarket-config`, keyed by CONTAINER env names
(FOLLY_DISCORD_WEBHOOK, not FOLLYMARKET_DISCORD_WEBHOOK). The multi-line
FOLLY_VAPID_PRIVATE_PEM survives as a JSON string with its newlines escaped.

main.py calls this before any other import or env read. Existing environment
variables win (os.environ.setdefault), so a locally exported value or a
per-secret ref still overrides the blob.

Malformed JSON raises at import, so a bad revision fails to start and Cloud Run
keeps serving the previous one. On Cloud Run (K_SERVICE is set) the blob is
mandatory, so a deploy that forgets --set-secrets fails loudly at startup
instead of silently dropping Discord alerts and push.
"""
import json
import os

ENV_VAR = "FOLLYMARKET_CONFIG"
SECRET = "follymarket-config"


def load_config_blob(environ=os.environ) -> None:
    raw = environ.get(ENV_VAR)
    if not raw:
        if environ.get("K_SERVICE"):
            raise RuntimeError(
                f"{ENV_VAR} is not set but this is Cloud Run. The deploy must "
                f"pass --set-secrets={ENV_VAR}={SECRET}:latest."
            )
        return
    blob = json.loads(raw)
    if not isinstance(blob, dict):
        raise ValueError(f"{ENV_VAR} must be a JSON object")
    for key, value in blob.items():
        environ.setdefault(key, str(value))
