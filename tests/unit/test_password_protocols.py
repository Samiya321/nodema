import base64
import copy
import json
from urllib.parse import quote

import pytest
import yaml

from app.conversion import to_mihomo, to_singbox, to_uri
from app.domain import PROTOCOLS, AssetError
from app.parsers import parse_document, parse_password_uri, parse_shadowsocks
from app.security.crypto import fingerprint


def identities(fixture_bytes):
    return {
        n.identity["protocol"]: n for n in parse_document(fixture_bytes("protocols_all.txt")).nodes
    }


@pytest.mark.parametrize("protocol", PROTOCOLS)
def test_six_protocols_cross_format_and_exports(fixture_bytes, protocol):
    source = identities(fixture_bytes)[protocol]
    for filename in ("protocols_all.yaml", "protocols_all.json"):
        report = parse_document(fixture_bytes(filename))
        assert report.complete, report.summary()
        parsed = next(n for n in report.nodes if n.identity["protocol"] == protocol)
        assert fingerprint(parsed, b"H" * 32) == fingerprint(source, b"H" * 32)
    d = source.identity
    outputs = [
        to_uri(d, "renamed").encode(),
        yaml.safe_dump({"proxies": [to_mihomo(d, "renamed")]}).encode(),
        json.dumps({"outbounds": [to_singbox(d, "renamed")]}).encode(),
    ]
    for output in outputs:
        report = parse_document(output)
        assert report.complete, report.summary()
        assert report.nodes[0].identity == d


@pytest.mark.parametrize("protocol", PROTOCOLS[:4])
def test_password_is_opaque_and_changes_identity(fixture_bytes, protocol):
    node = identities(fixture_bytes)[protocol]
    assert "password" in node.identity and "uuid" not in node.identity
    changed = copy.deepcopy(node)
    changed.identity["password"] += ":different"
    assert fingerprint(node, b"H" * 32) != fingerprint(changed, b"H" * 32)
    assert node.identity["password"] not in repr(node)


def test_sip002_legacy_base64_unicode_and_ipv6():
    password = "synthetic:密码@#? /"
    userinfo = "aes-128-gcm:" + password
    modern = (
        "ss://"
        + base64.urlsafe_b64encode(userinfo.encode()).decode().rstrip("=")
        + "@[2001:db8::1]:8388/#test"
    )
    legacy = (
        "ss://" + base64.b64encode((userinfo + "@[2001:db8::1]:8388").encode()).decode() + "#test"
    )
    node = parse_shadowsocks(modern)
    assert node.identity["password"] == password
    plain = parse_shadowsocks(
        "ss://aes-128-gcm:" + quote(password, safe="") + "@[2001:db8::1]:8388"
    )
    assert plain.identity == node.identity
    basic = "aes-128-gcm:synthetic-password@[2001:db8::1]:8388"
    assert (
        parse_shadowsocks("ss://" + base64.b64encode(basic.encode()).decode()).identity[
            "server_host"
        ]
        == "2001:db8::1"
    )
    assert parse_shadowsocks(legacy).identity == node.identity


def test_shadowsocks_2022_and_plugin_round_trip():
    key = base64.b64encode(b"S" * 16).decode()
    node = parse_shadowsocks(
        "ss://2022-blake3-aes-128-gcm:" + quote(key, safe="") + "@ss.example:443"
    )
    output = to_uri(node.identity, "2022")
    assert output.startswith("ss://2022-blake3-aes-128-gcm:")
    assert parse_shadowsocks(output).identity == node.identity
    plugin = "v2ray-plugin;tls;host=cdn.example;path=/x\\;a\\=b"
    uri = "ss://aes-128-gcm:synthetic@ss.example:443/?plugin=" + quote(plugin, safe="")
    source = parse_shadowsocks(uri)
    assert source.identity["protocol_options"]["plugin"]["options"]["path"] == "/x;a=b"
    assert parse_shadowsocks(to_uri(source.identity, "plugin")).identity == source.identity
    assert to_mihomo(source.identity, "ss")["plugin-opts"]["mode"] == "websocket"
    for output in (
        yaml.safe_dump({"proxies": [to_mihomo(source.identity, "ss")]}),
        json.dumps({"outbounds": [to_singbox(source.identity, "ss")]}),
    ):
        assert parse_document(output.encode()).nodes[0].identity == source.identity


def test_hysteria_alias_userpass_ipv6_and_hopping():
    raw = "hy2://synthetic-user:synthetic-password@[2001:db8::2]:443,1000-1010/?obfs=salamander&obfs-password=synthetic&sni=tls.example"
    node = parse_password_uri(raw)
    assert node.identity["protocol"] == "hysteria2"
    assert node.identity["password"] == "synthetic-user:synthetic-password"
    assert node.identity["protocol_options"]["server_ports"] == ["443", "1000-1010"]
    assert parse_password_uri(to_uri(node.identity, "hopping")).identity == node.identity
    sb = to_singbox(node.identity, "hopping")
    assert "server_port" not in sb and sb["server_ports"] == ["443", "1000:1010"]
    assert (
        parse_document(json.dumps({"outbounds": [sb]}).encode()).nodes[0].identity == node.identity
    )


def test_anytls_tuning_and_hysteria_bandwidth_preserved():
    source = {
        "type": "anytls",
        "name": "synthetic",
        "server": "a.example",
        "port": 443,
        "password": "synthetic",
        "idle-session-check-interval": 30,
        "idle-session-timeout": 60,
        "min-idle-session": 2,
    }
    node = parse_document(yaml.safe_dump({"proxies": [source]}).encode()).nodes[0]
    sb = to_singbox(node.identity, "tuned")
    assert sb["idle_session_timeout"] == "60s"
    assert (
        parse_document(json.dumps({"outbounds": [sb]}).encode()).nodes[0].identity == node.identity
    )
    with pytest.raises(AssetError, match="RUNTIME_UNSUPPORTED"):
        to_uri(node.identity, "cannot-drop-tuning")
    source = {
        "type": "hysteria2",
        "name": "synthetic",
        "server": "a.example",
        "port": 443,
        "password": "synthetic",
        "up": "10 Mbps",
        "down": "10000 Kbps",
        "hop-interval": 30,
        "ports": "443,8443",
    }
    node = parse_document(yaml.safe_dump({"proxies": [source]}).encode()).nodes[0]
    assert (
        node.identity["protocol_options"]["up_mbps"]
        == node.identity["protocol_options"]["down_mbps"]
        == 10
    )
    assert to_singbox(node.identity, "bandwidth")["hop_interval"] == "30s"
    with pytest.raises(AssetError):
        to_uri(node.identity, "cannot-drop-bandwidth")


@pytest.mark.parametrize(
    "raw",
    [
        "ss://aes-128-gcm:@ss.example:443",
        "ss://!invalid@ss.example:443",
        "trojan://synthetic@a.example:0",
        "anytls://synthetic@a.example:443?insecure=2",
        "hy2://synthetic@a.example:65536",
        "hy2://synthetic@a.example:1000-999",
        "hy2://synthetic@a.example:443?sni=a&sni=b",
        "anytls://synthetic@a.example:443?sni=%xx",
    ],
)
def test_malformed_password_uris_are_safe(raw):
    report = parse_document(raw.encode())
    assert not report.complete and not report.nodes
    assert "synthetic" not in str(report.summary())


@pytest.mark.parametrize("protocol", PROTOCOLS[:4])
def test_unknown_parameters_cannot_be_silently_dropped(fixture_bytes, protocol):
    d = copy.deepcopy(identities(fixture_bytes)[protocol].identity)
    d["extensions"] = {protocol + "_uri": {"future-auth": "synthetic"}}
    for convert in (to_mihomo, to_singbox, to_uri):
        with pytest.raises(AssetError, match="RUNTIME_UNSUPPORTED"):
            convert(d, "unsupported")


def test_anytls_reality_and_unknown_plugins_rejected(fixture_bytes):
    d = copy.deepcopy(identities(fixture_bytes)["anytls"].identity)
    d["security"] = "reality"
    d["tls"]["reality"] = {"public_key": "synthetic"}
    with pytest.raises(AssetError):
        to_mihomo(d, "unsupported")
    d = copy.deepcopy(identities(fixture_bytes)["shadowsocks"].identity)
    d["protocol_options"]["plugin"] = {"name": "shell-command", "options": {"cmd": "synthetic"}}
    with pytest.raises(AssetError):
        to_mihomo(d, "unsupported")


@pytest.mark.parametrize("protocol", ["trojan", "anytls", "hysteria2"])
def test_singbox_missing_tls_enabled_is_not_silently_upgraded(protocol):
    raw = json.dumps(
        {
            "outbounds": [
                {
                    "type": protocol,
                    "server": "synthetic.example",
                    "server_port": 443,
                    "password": "synthetic",
                    "tls": {"server_name": "tls.example"},
                }
            ]
        }
    ).encode()
    report = parse_document(raw)
    assert report.complete and report.nodes[0].identity["security"] == "none"
    with pytest.raises(AssetError, match="RUNTIME_UNSUPPORTED"):
        to_mihomo(report.nodes[0].identity, "must-not-change-security")


def test_hysteria_bandwidth_bps_unit_and_invalid_protocol_type():
    from app.parsers.passwords import bandwidth

    assert bandwidth("1000000 bps") == bandwidth("1000 Kbps") == bandwidth("1 Mbps") == 1
    assert bandwidth("0.001 Gbps") == 1
    report = parse_document(b"proxies: [{type: [ss], server: invalid}]")
    assert report.issues[0].code == "UNSUPPORTED_PROTOCOL"
