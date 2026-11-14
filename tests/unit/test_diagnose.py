import json

import pytest

from app.conversion import to_mihomo
from app.diagnose import _reason
from app.domain import Unsupported, field_label

UUID = "00000000-0000-4000-8000-000000000001"


def vless(**extra):
    return {
        "protocol": "vless",
        "server_host": "198.51.100.10",
        "server_port": 443,
        "uuid": UUID,
        **extra,
    }


def reason(identity):
    with pytest.raises(Unsupported) as caught:
        to_mihomo(identity, "x")
    assert caught.value.code == "RUNTIME_UNSUPPORTED"
    return caught.value.reason


def test_reasons_name_the_field_never_the_value():
    assert reason(vless(transport="kcp")) == "transport:kcp"
    assert reason(vless(security="tls", tls={"sni": "a.example", "ech_secret": "s3cr3t"})) == (
        "tls:ech_secret"
    )
    assert reason(vless(transport="tcp", protocol_options={"seed": "s3cr3t"})) == (
        "protocol_options:seed"
    )
    secret = vless(extensions={"clash": {"weird-key": "s3cr3t"}})
    assert reason(secret) == "ext:clash:weird-key"
    assert "s3cr3t" not in reason(secret)


def test_password_protocol_reasons():
    trojan = {
        "protocol": "trojan",
        "server_host": "198.51.100.11",
        "server_port": 443,
        "password": "pw",
        "security": "tls",
        "tls": {"sni": "a.example", "pinned_cert": "x"},
    }
    assert reason(trojan) == "tls:pinned_cert"
    assert reason({**trojan, "tls": {}, "password": ""}) == "password"


def test_field_label_hides_odd_names():
    assert field_label(["b", "a"]) == "a"
    assert field_label(["has space"]) == "other"
    assert field_label(["x" * 41]) == "other"


def test_reason_from_stored_config():
    assert _reason(json.dumps(vless(transport="kcp")).encode()) == "transport:kcp"
    assert _reason(json.dumps(vless()).encode()) == "convertible_now"
    assert _reason(b"not json") == "malformed"
