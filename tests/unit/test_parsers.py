import base64
import json

import pytest

from app.domain import AssetError, InputFormat
from app.parsers import (
    parse_clash_yaml,
    parse_document,
    parse_singbox_json,
    parse_vless,
    parse_vmess,
)
from app.security.crypto import fingerprint

URI = "vless://00000000-0000-4000-8000-000000000001@edge.example:443"


@pytest.mark.parametrize(
    "filename",
    [
        "sample_vless.txt",
        "sample_vmess.txt",
        "sample_clash.yaml",
        "sample_singbox.json",
        "sample_base64.txt",
    ],
)
def test_formats(fixture_bytes, filename):
    report = parse_document(fixture_bytes(filename))
    assert report.complete and len(report.nodes) == 1
    assert "00000000-0000-4000" not in repr(report)
    assert "00000000-0000-4000" not in repr(report.nodes[0])


def test_cross_format_identity(fixture_bytes):
    nodes = [
        parse_document(fixture_bytes(f)).nodes[0]
        for f in (
            "sample_vless.txt",
            "sample_clash.yaml",
            "sample_singbox.json",
            "sample_base64.txt",
        )
    ]
    assert len({fingerprint(n, b"H" * 32) for n in nodes}) == 1
    assert len({n.original_name for n in nodes}) == 3


def test_vmess_protocol_security_is_separate_from_tls(fixture_bytes):
    vmess = parse_vmess(fixture_bytes("sample_vmess.txt").decode().strip())
    assert vmess.identity["security"] == "tls"
    assert vmess.identity["protocol_options"]["cipher"] == "auto"
    payload = {
        "outbounds": [
            {
                "type": "vmess",
                "server": "edge.example",
                "server_port": 443,
                "uuid": "00000000-0000-4000-8000-000000000001",
                "security": "auto",
                "network": "udp",
                "transport": {"type": "ws"},
            }
        ]
    }
    node = parse_singbox_json(json.dumps(payload).encode()).nodes[0]
    assert node.identity["transport"] == "ws"
    assert "security" not in node.identity
    assert node.identity["protocol_options"]["allowed_network"] == "udp"


def test_ipv6_encoding_and_reality():
    node = parse_vless(
        URI.replace("edge.example", "[2001:db8::1]")
        + "?type=grpc&security=reality&pbk=synthetic-public&sid=abcd&"
        "serviceName=test%2Fservice&flow=xtls-rprx-vision#%E6%B5%8B%E8%AF%95"
    )
    assert node.identity["server_host"] == "2001:db8::1"
    assert node.identity["tls"]["reality"]["short_id"] == "abcd"
    assert node.identity["transport_options"]["service_name"] == "test/service"
    assert node.original_name == "测试"


def test_unknown_and_missing_fields_are_not_silently_merged():
    missing = parse_vless(URI)
    explicit = parse_vless(URI + "?type=tcp")
    extra = parse_vless(URI + "?future=synthetic-extension")
    assert len({fingerprint(n, b"H" * 32) for n in (missing, explicit, extra)}) == 3
    assert extra.identity["extensions"]["vless_uri"]["future"] == "synthetic-extension"


@pytest.mark.parametrize(
    "suffix",
    [
        ":0",
        ":65536",
        ":true",
        ":443?type=ws&type=tcp",
        ":443?path=%xx",
    ],
)
def test_bad_vless_is_safe(suffix):
    with pytest.raises(AssetError) as error:
        parse_vless(URI.rsplit(":", 1)[0] + suffix)
    assert "vless://" not in str(error.value)


def test_invalid_uuid_and_vmess():
    with pytest.raises(AssetError, match="INVALID_UUID"):
        parse_vless(URI.replace("00000000-0000-4000-8000-000000000001", "not-a-uuid"))
    for value in ("vmess://!invalid", "vmess://" + base64.b64encode(b"[]").decode()):
        with pytest.raises(AssetError):
            parse_vmess(value)


@pytest.mark.parametrize(
    "payload",
    [
        b"proxies: []\nproxies: []",
        b"proxies: !!python/object:secret {}",
        b"a: &a [x, x]\nb: &b [*a, *a]\nc: &c [*b, *b]\nd: &d [*c, *c]\n"
        + b"".join(
            b"e%d: &e%d [*%s, *%s]\n" % (i, i, prev, prev)
            for i, prev in zip(
                range(1, 25), [b"d"] + [b"e%d" % i for i in range(1, 24)], strict=True
            )
        )
        + b"proxies: []",  # "billion laughs": 2^28 expanded nodes from a few lines
        b"proxies: &p [*p]",  # recursive alias
        b"base: &b {type: ss}\nproxies:\n  - {<<: *b, name: a, name: b}",  # duplicate key
        b"proxies: [" + b"[" * 65 + b"]" * 65 + b"]",
    ],
)
def test_yaml_rejects_unsafe_or_ambiguous_structures(payload):
    with pytest.raises(AssetError):
        parse_clash_yaml(payload)


@pytest.mark.parametrize(
    "payload",
    [
        b'{"outbounds": [], "outbounds": []}',
        b'{"outbounds": [NaN]}',
        b'{"outbounds": {}}',
    ],
)
def test_json_strict(payload):
    with pytest.raises(AssetError):
        parse_singbox_json(payload)


def test_partial_unsupported_and_ignored():
    report = parse_document((URI + "\ntrojan://synthetic\ninvalid\n").encode())
    assert len(report.nodes) == 1 and len(report.issues) == 2 and not report.complete
    assert parse_singbox_json(b'{"outbounds":[{"type":"direct"}]}').ignored_count == 1
    assert parse_clash_yaml(b"proxies: []").complete


def test_limits_and_no_recursive_base64(fixture_bytes):
    raw = fixture_bytes("sample_vless.txt")
    with pytest.raises(AssetError, match="INPUT_TOO_LARGE"):
        parse_document(raw, max_bytes=2)
    with pytest.raises(AssetError, match="TOO_MANY_ITEMS"):
        parse_document(raw * 2, max_items=1)
    for raw in (b"", b"  ", b"# comment only"):
        with pytest.raises(AssetError, match="EMPTY_INPUT"):
            parse_document(raw, InputFormat.URI)
    report = parse_document(base64.b64encode(base64.b64encode(raw or b"test")))
    assert not report.complete


def test_yaml_name_on_stays_string(fixture_bytes):
    node = parse_clash_yaml(fixture_bytes("sample_clash.yaml").replace(b"Synthetic B", b"ON"))
    assert node.nodes[0].original_name == "ON"


def test_synthetic_100(fixture_bytes):
    report = parse_document(fixture_bytes("synthetic_100.txt"))
    assert report.complete and len(report.nodes) == 100


def test_clash_yaml_anchors_and_merge_keys_are_accepted():
    payload = b"""
common: &common
  type: ss
  cipher: aes-128-gcm
  password: synthetic
  udp: true
servers: &servers [sg.example, jp.example]
proxies:
  - <<: *common
    name: SG
    server: sg.example
    port: 443
  - <<: [*common]
    name: JP
    server: jp.example
    port: 8443
    cipher: chacha20-ietf-poly1305
proxy-groups:
  - {name: auto, type: select, proxies: [SG, JP]}
"""
    report = parse_clash_yaml(payload)
    assert report.complete and len(report.nodes) == 2
    sg, jp = (n.identity for n in report.nodes)
    assert sg["protocol"] == jp["protocol"] == "shadowsocks"
    assert sg["protocol_options"]["cipher"] == "aes-128-gcm"
    assert jp["protocol_options"]["cipher"] == "chacha20-ietf-poly1305"  # explicit key wins
    assert (sg["server_host"], jp["server_port"]) == ("sg.example", 8443)
