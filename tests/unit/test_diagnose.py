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


def test_parse_reports_unsupported_protocol_names():
    from app.parsers.core import parse_document as parse_text

    report = parse_text(
        b"tuic://u:p@198.51.100.1:443#a\ntuic://u:p@198.51.100.2:443#b\nssr://abc\n"
        + b"trojan://pw@198.51.100.3:443?sni=a.example#c\n"
    )
    summary = report.summary()
    assert summary["valid"] == 1
    assert summary["unsupported_protocols"] == {"tuic": 2, "ssr": 1}
    assert {"code": "UNSUPPORTED_PROTOCOL", "ordinal": 1, "detail": "tuic"} in summary["issues"]


def test_clash_unsupported_type_is_named():
    from app.parsers.core import parse_document as parse_text

    yaml = (
        "proxies:\n"
        "  - {name: a, type: wireguard, server: 198.51.100.1, port: 51820}\n"
        "  - {name: b, type: trojan, server: 198.51.100.2, port: 443,"
        " password: pw, sni: a.example}\n"
    )
    assert parse_text(yaml.encode()).summary()["unsupported_protocols"] == {"wireguard": 1}


def test_mapping_features():
    from app.diagnose import _features

    assert _features(vless(transport="xhttp", security="tls")) == ["xhttp"]
    assert _features(vless(transport="raw")) == ["raw"]
    pinned = vless(security="tls", extensions={"vless_uri": {"pcs": "ab" * 32}})
    assert _features(pinned) == ["pcs_fingerprint"]
    assert _features(vless()) == ["baseline"]
