import json

import pytest

from config_blob import ENV_VAR, load_config_blob

PEM = "-----BEGIN PRIVATE KEY-----\nabc\ndef\n-----END PRIVATE KEY-----\n"


def test_expands_every_key():
    env = {ENV_VAR: json.dumps({"FOLLY_DISCORD_WEBHOOK": "w", "FOLLY_VAPID_PRIVATE_PEM": PEM})}
    load_config_blob(env)
    assert env["FOLLY_DISCORD_WEBHOOK"] == "w"
    assert env["FOLLY_VAPID_PRIVATE_PEM"] == PEM


def test_existing_env_var_wins():
    env = {ENV_VAR: json.dumps({"FOLLY_DISCORD_WEBHOOK": "from-blob"}), "FOLLY_DISCORD_WEBHOOK": "explicit"}
    load_config_blob(env)
    assert env["FOLLY_DISCORD_WEBHOOK"] == "explicit"


def test_absent_is_a_no_op_locally():
    env = {"OTHER": "x"}
    load_config_blob(env)
    assert env == {"OTHER": "x"}


def test_absent_on_cloud_run_raises():
    with pytest.raises(RuntimeError):
        load_config_blob({"K_SERVICE": "follymarket-api"})


def test_malformed_json_raises():
    with pytest.raises(json.JSONDecodeError):
        load_config_blob({ENV_VAR: "{not json"})


def test_non_object_raises():
    with pytest.raises(ValueError):
        load_config_blob({ENV_VAR: "[1, 2]"})
