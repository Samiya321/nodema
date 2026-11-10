import base64

import pytest
import yaml

from app.conversion import to_mihomo
from app.domain import AssetError
from app.parsers import parse_document

UUID = "00000000-0000-4000-8000-000000000001"


def test_loon_vmess_and_surge_vmess_preserve_equivalent_identity():
    loon = (
        f'Loon = vmess, vmess.example, 443, auto, "{UUID}", transport=ws, '
        "path=/private, host=ws.example, over-tls=true, tls-name=tls.example, "
        "skip-cert-verify=false, alterId=0, udp=true"
    )
    surge = (
        f"Surge = vmess, vmess.example, 443, username={UUID}, encrypt-method=auto, "
        "vmess-aead=true, ws=true, ws-path=/private, ws-headers=Host:ws.example, "
        "tls=true, sni=tls.example, skip-cert-verify=false, udp-relay=true"
    )
    a, b = [parse_document(s.encode()) for s in (loon, surge)]
    assert a.complete and b.complete
    assert a.nodes[0].identity == b.nodes[0].identity
    proxy = to_mihomo(a.nodes[0].identity, "synthetic")
    assert proxy["uuid"] == UUID and proxy["ws-opts"]["headers"]["Host"] == "ws.example"
    assert proxy["skip-cert-verify"] is False


def test_quantumult_trojan_ipv6_and_opaque_password():
    raw = (
        'trojan=[2001:db8::1]:443,password="p,a=ss +/%",over-tls=true,'
        'tls-host=tls.example,tls-verification=true,udp-relay=true,tag="Synthetic, QX"'
    )
    report = parse_document(raw.encode())
    assert report.complete
    node = report.nodes[0]
    assert node.identity["password"] == "p,a=ss +/%"
    assert node.identity["server_host"] == "2001:db8::1"
    assert node.original_name == "Synthetic, QX"
    assert node.identity["tls"]["insecure"] is False


def test_proxy_sections_do_not_fetch_remote_sources_or_parse_rule_actions():
    raw = f"""[General]
remote-resource = https://subscription.example/private
[Proxy]
good = vmess, vmess.example,443,username={UUID},vmess-aead=true
unknown = snell, snell.example,443,psk=synthetic
broken = vmess, vmess.example,443,username=invalid
[Rule]
FINAL,good
"""
    report = parse_document(raw.encode())
    assert len(report.nodes) == 1
    assert [i.code for i in report.issues] == ["UNSUPPORTED_PROTOCOL", "INVALID_UUID"]


def test_unknown_parameters_remain_canonical_identity_extensions():
    raw = "trojan=trojan.example:443,password=synthetic,over-tls=true,new-option=keep,tag=synthetic"
    report = parse_document(raw.encode())
    assert report.complete
    identity = report.nodes[0].identity
    assert identity["extensions"]["quantumult_x"] == {"new-option": "keep"}
    with pytest.raises(AssetError, match="RUNTIME_UNSUPPORTED"):
        to_mihomo(identity, "synthetic")


@pytest.mark.parametrize(
    "option", ["underlying-proxy=another", "dialer-proxy=another", "detour=another"]
)
def test_proxy_dependencies_are_never_silently_removed(option):
    r = parse_document(
        f"trojan=trojan.example:443,password=synthetic,{option},tag=synthetic".encode()
    )
    assert r.summary()["issues"][0]["code"] == "UNSUPPORTED_DEPENDENCY"


def test_quoted_loon_password_and_qx_unquoted_comma_password():
    for raw, expected in [
        ('Loon = trojan, trojan.example,443,"p,a=ss",over-tls=true', "p,a=ss"),
        ("trojan=trojan.example:443,password=p,art,over-tls=true,tag=synthetic", "p,art"),
    ]:
        r = parse_document(raw.encode())
        assert r.complete and r.nodes[0].identity["password"] == expected


def test_base64_proxy_list_and_item_limits():
    raw = b"trojan=trojan.example:443,password=synthetic,tag=one"
    assert len(parse_document(base64.b64encode(raw)).nodes) == 1
    with pytest.raises(AssetError, match="TOO_MANY_ITEMS"):
        parse_document(raw + b"\n" + raw, max_items=1)


def test_bad_flags_quotes_conflicts_and_duplicate_options_are_safe():
    for raw in [
        'trojan=trojan.example:443,password="unclosed,tag=synthetic',
        "trojan=trojan.example:443,password=p,over-tls=maybe,tag=synthetic",
        "trojan=trojan.example:443,password=p,password=q,tag=synthetic",
        "trojan=trojan.example:443,password=p,tls-verification=true,skip-cert-verify=true",
    ]:
        r = parse_document(raw.encode())
        assert not r.complete and not r.nodes
        assert "trojan.example" not in str(r.summary())


def test_explicit_structured_formats_take_precedence_over_text_detection():
    raw = yaml.safe_dump(
        {
            "proxies": [
                {
                    "name": "trojan=synthetic",
                    "type": "trojan",
                    "server": "trojan.example",
                    "port": 443,
                    "password": "synthetic",
                }
            ]
        }
    )
    assert parse_document(raw.encode()).complete


def test_substore_reality_metadata_does_not_overwrite_authentication():
    raw = yaml.safe_dump(
        {
            "proxies": [
                {
                    "name": "synthetic",
                    "type": "vless",
                    "server": "reality.example",
                    "port": 443,
                    "uuid": UUID,
                    "tls": True,
                    "reality-opts": {
                        "public-key": "A" * 43,
                        "short-id": "0123456789abcdef",
                        "_spider-x": "/",
                    },
                }
            ]
        }
    )
    identity = parse_document(raw.encode()).nodes[0].identity
    before = repr(identity)
    proxy = to_mihomo(identity, "synthetic")
    assert proxy["reality-opts"] == {
        "public-key": "A" * 43,
        "short-id": "0123456789abcdef",
        "_spider-x": "/",
    }
    assert repr(identity) == before


def test_shadowsocks_explicit_false_verification_is_preserved_for_mihomo():
    from app.conversion import to_singbox, to_uri

    raw = yaml.safe_dump(
        {
            "proxies": [
                {
                    "name": "synthetic",
                    "type": "ss",
                    "server": "ss.example",
                    "port": 443,
                    "cipher": "aes-128-gcm",
                    "password": "synthetic",
                    "skip-cert-verify": False,
                }
            ]
        }
    )
    identity = parse_document(raw.encode()).nodes[0].identity
    assert to_mihomo(identity, "synthetic")["skip-cert-verify"] is False
    for convert in (to_singbox, to_uri):
        with pytest.raises(AssetError, match="RUNTIME_UNSUPPORTED"):
            convert(identity, "synthetic")


def test_surge_and_quantumult_vmess_defaults_follow_their_own_dialect():
    surge = parse_document(f"Name = vmess,vmess.example,443,username={UUID}".encode())
    qx = parse_document(f"vmess=vmess.example:443,password={UUID},tag=Name".encode())
    assert surge.nodes[0].identity["protocol_options"] == {"cipher": "aes-128-gcm", "alter_id": 1}
    assert qx.nodes[0].identity["protocol_options"] == {"cipher": "none", "alter_id": 0}


def test_quoted_alias_and_password_escapes_are_preserved():
    raw = r'''"Name=with, punctuation" = trojan,trojan.example,443,"p\"a\\ss"'''
    r = parse_document(raw.encode())
    assert r.complete and r.nodes[0].original_name == "Name=with, punctuation"
    assert r.nodes[0].identity["password"] == 'p"a\\ss'


def test_conflicting_positional_cipher_is_rejected():
    raw = f'Name=vmess,vmess.example,443,auto,"{UUID}",method=none'
    r = parse_document(raw.encode())
    assert [issue.code for issue in r.issues] == ["CONFLICTING_FIELDS"]


@pytest.mark.parametrize(
    "headers",
    [
        '"Host:"ws.example"|X-Synthetic:"value""',
        '"Host:ws.example|X-Synthetic:value"',
        '"Host":"ws.example"|"X-Synthetic":"value"',
    ],
)
def test_surge_exported_nested_header_quotes(headers):
    raw = f"Name=vmess,vmess.example,443,username={UUID},ws=true,ws-headers={headers}"
    r = parse_document(raw.encode())
    assert r.complete
    proxy = to_mihomo(r.nodes[0].identity, "synthetic")
    assert proxy["ws-opts"]["headers"] == {"Host": "ws.example", "x-synthetic": "value"}
