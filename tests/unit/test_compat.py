"""Real-world extras: mapped when equivalent, dropped when irrelevant, else rejected."""

import copy

import pytest

from app.compat import compatible
from app.conversion import to_mihomo, to_singbox, to_uri
from app.domain import AssetError
from app.export_render import Renderer

VMESS = {
    "protocol": "vmess",
    "server_host": "vm.example",
    "server_port": 443,
    "uuid": "11111111-2222-4333-8444-555555555555",
    "transport": "ws",
    "security": "tls",
    "tls": {"sni": "cdn.example"},
    "transport_options": {"host": "cdn.example", "path": "/ws", "header_type": "auto"},
    "protocol_options": {"alter_id": 0},
    "extensions": {"vmess_uri": {"security": "auto", "skip-cert-verify": True}},
}


def vless(**changes):
    node = {
        "protocol": "vless",
        "server_host": "vl.example",
        "server_port": 443,
        "uuid": "11111111-2222-4333-8444-555555555555",
        "transport": "ws",
        "security": "tls",
        "tls": {"sni": "vl.example"},
        "transport_options": {"host": "vl.example", "path": "/"},
        "protocol_options": {},
    }
    node.update(changes)
    return node


def test_vmess_share_link_extras_map_to_canonical_fields():
    original = copy.deepcopy(VMESS)
    proxy = to_mihomo(VMESS, "n")
    assert proxy["skip-cert-verify"] is True and proxy["cipher"] == "auto"
    assert proxy["ws-opts"]["headers"]["Host"] == "cdn.example"
    assert VMESS == original  # stored identities are never modified
    assert to_singbox(VMESS, "n")["tls"]["insecure"] is True
    with pytest.raises(AssetError, match="RUNTIME_UNSUPPORTED"):
        to_uri(VMESS, "n")  # VMess share links have no agreed skip-verify field
    secure = copy.deepcopy(VMESS)
    secure["extensions"]["vmess_uri"]["skip-cert-verify"] = False
    assert to_uri(secure, "n").startswith("vmess://")


@pytest.mark.parametrize(
    "extensions",
    [
        {"vless_uri": {"fragment": "1,40-60,30-50"}},
        {"vless_uri": {"ech": "AEn+DQBF..."}},
        {"vless_uri": {"headerType": "none", "quicSecurity": "none", "packetEncoding": "xudp"}},
        {"clash": {"delay": 120, "uid": 3, "version": 2, "sub_tag": "a"}},
        {"clash": {"alterId": 0, "cipher": "auto"}},  # VMess template fields on VLESS
        {"clash": {"interface-name": "eth0", "ech-opts": {"enable": True}}},
    ],
)
def test_irrelevant_extras_are_dropped(extensions):
    node = vless(extensions=extensions)
    assert to_mihomo(node, "n")["type"] == "vless"
    assert "extensions" not in compatible(node)


def test_clash_preferences_stay_in_mihomo_but_not_block_other_formats():
    node = vless(extensions={"clash": {"udp": True, "tfo": True}})
    assert to_mihomo(node, "n")["udp"] is True
    assert to_singbox(node, "n")["type"] == "vless"
    assert to_uri(node, "n").startswith("vless://")


@pytest.mark.parametrize(
    "extensions",
    [
        {"vless_uri": {"mode": "auto", "extra": "{}"}},  # xhttp details we cannot express
        {"clash": {"fingerprint": "AA:BB"}},  # a certificate pin is not dropped silently
        {"unknown_dialect": {"x": 1}},
        {"vmess_uri": {"security": "rot13"}},
    ],
)
def test_meaningful_or_unknown_extras_are_still_rejected(extensions):
    with pytest.raises(AssetError, match="RUNTIME_UNSUPPORTED"):
        to_singbox(vless(extensions=extensions), "n")
    if "clash" not in extensions:
        with pytest.raises(AssetError, match="RUNTIME_UNSUPPORTED"):
            to_mihomo(vless(extensions=extensions), "n")


def test_header_type_only_matters_for_tcp_http():
    for value in ("auto", "chacha20-poly1305", "none"):
        node = vless(transport_options={"path": "/", "header_type": value})
        assert to_mihomo(node, "n")["network"] == "ws"
    plain = vless(transport="tcp", transport_options={"host": "x", "header_type": "none"})
    assert "transport_options" not in compatible(plain)
    reality = vless(
        transport=None,
        security="reality",
        tls={"sni": "www.example.com", "reality": {"public_key": "synthetic"}},
        transport_options={},
    )
    assert to_mihomo(reality, "n")["network"] == "tcp"


@pytest.mark.parametrize("cipher", ["aes-256-cfb", "rc4-md5", "chacha20-ietf", "aes-128-ctr"])
def test_legacy_shadowsocks_ciphers(cipher):
    node = {
        "protocol": "shadowsocks",
        "server_host": "ss.example",
        "server_port": 8388,
        "password": "synthetic",
        "transport": "tcp",
        "security": "none",
        "protocol_options": {"cipher": cipher},
    }
    assert to_mihomo(node, "n")["cipher"] == cipher
    assert to_singbox(node, "n")["method"] == cipher
    assert to_uri(node, "n").startswith("ss://")


def test_exports_skip_nodes_a_format_cannot_express_instead_of_failing():
    renderer = Renderer("uri")
    pinned = vless(extensions={"clash": {"fingerprint": "AA:BB"}})
    assert renderer.append({"id": "a", "name": "A", "short_id": "N1"}, vless()) is True
    assert renderer.append({"id": "b", "name": "B", "short_id": "N2"}, pinned) is False
    assert renderer.count == 1 and renderer.skipped == 1
    assert renderer.finish().decode().count("vless://") == 1
