import copy
import json

import pytest
import yaml

from app.domain import AssetError
from app.parsers import parse_clash_yaml, parse_singbox_json, parse_vless
from app.security.crypto import fingerprint


def test_reality_equivalence_and_extensions(fixture_bytes):
    clash = yaml.safe_load(fixture_bytes("sample_clash.yaml"))
    item = clash["proxies"][0]
    item["network"] = "grpc"
    item.pop("ws-opts")
    item["grpc-opts"] = {"grpc-service-name": "demo"}
    item.pop("servername")
    item["reality-opts"] = {"public-key": "synthetic-key", "short-id": "abcd"}
    uri = (
        "vless://00000000-0000-4000-8000-000000000001@edge.example:443"
        "?type=grpc&security=reality&pbk=synthetic-key&sid=abcd&serviceName=demo"
    )
    node = parse_clash_yaml(yaml.safe_dump(clash).encode()).nodes[0]
    assert fingerprint(node, b"H" * 32) == fingerprint(parse_vless(uri), b"H" * 32)
    item["reality-opts"]["future-key"] = "a"
    item["reality-opts"]["future_key"] = "b"
    node = parse_clash_yaml(yaml.safe_dump(clash).encode()).nodes[0]
    assert node.identity["extensions"]["clash"]["reality-opts"] == {
        "future-key": "a",
        "future_key": "b",
    }


def test_header_case_collisions_are_rejected(fixture_bytes):
    payload = yaml.safe_load(fixture_bytes("sample_clash.yaml"))
    payload["proxies"][0]["ws-opts"]["headers"] = {"Host": "a.example", "host": "b.example"}
    report = parse_clash_yaml(yaml.safe_dump(payload).encode())
    assert not report.complete and report.issues[0].code == "DUPLICATE_FIELD"


def test_singbox_reality_utls_and_disabled_extensions(fixture_bytes):
    payload = json.loads(fixture_bytes("sample_singbox.json"))
    item = payload["outbounds"][0]
    item["tls"]["utls"] = {"enabled": True, "fingerprint": "chrome"}
    item["tls"]["reality"] = {"enabled": True, "public_key": "synthetic", "short_id": "abcd"}
    node = parse_singbox_json(json.dumps(payload).encode()).nodes[0]
    assert node.identity["security"] == "reality"
    assert node.identity["tls"]["client_fingerprint"] == "chrome"
    modified = copy.deepcopy(payload)
    modified["outbounds"][0]["tls"]["reality"].pop("enabled")
    node = parse_singbox_json(json.dumps(modified).encode()).nodes[0]
    assert node.identity["extensions"]["singbox"]["tls"]["reality"]["short_id"] == "abcd"


def test_reality_requires_enabled_tls(fixture_bytes):
    payload = json.loads(fixture_bytes("sample_singbox.json"))
    item = payload["outbounds"][0]
    item["tls"] = {"enabled": False, "reality": {"enabled": True, "public_key": "synthetic"}}
    report = parse_singbox_json(json.dumps(payload).encode())
    assert report.issues[0].code == "REALITY_REQUIRES_TLS"
    clash = yaml.safe_load(fixture_bytes("sample_clash.yaml"))
    clash["proxies"][0].update({"tls": False, "reality-opts": {"public-key": "synthetic"}})
    report = parse_clash_yaml(yaml.safe_dump(clash).encode())
    assert report.issues[0].code == "REALITY_REQUIRES_TLS"


def test_enabled_utls_is_never_lost_when_fingerprint_is_missing(fixture_bytes):
    payload = json.loads(fixture_bytes("sample_singbox.json"))
    before = parse_singbox_json(json.dumps(payload).encode()).nodes[0]
    payload["outbounds"][0]["tls"]["utls"] = {"enabled": True}
    after = parse_singbox_json(json.dumps(payload).encode()).nodes[0]
    assert after.identity["tls"]["utls_enabled"] is True
    assert fingerprint(before, b"H" * 32) != fingerprint(after, b"H" * 32)


@pytest.mark.parametrize("adapter,field", [("clash", "dialer-proxy"), ("singbox", "detour")])
def test_dependency_is_explicitly_unsupported(fixture_bytes, adapter, field):
    if adapter == "clash":
        payload = yaml.safe_load(fixture_bytes("sample_clash.yaml"))
        payload["proxies"][0][field] = "other"
        report = parse_clash_yaml(yaml.safe_dump(payload).encode())
    else:
        payload = json.loads(fixture_bytes("sample_singbox.json"))
        payload["outbounds"][0][field] = "other"
        report = parse_singbox_json(json.dumps(payload).encode())
    assert report.issues[0].code == "UNSUPPORTED_DEPENDENCY"


def test_extremely_large_integer_has_safe_error():
    with pytest.raises(AssetError):
        parse_vless("vless://00000000-0000-4000-8000-000000000001@edge.example:" + "9" * 5000)
