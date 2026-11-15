"""Share-link settings found in production: TCP header obfuscation, raw, REALITY spider_x
and bookkeeping fields convert; XHTTP, HTTP Upgrade and certificate pins stay
unsupported because real nodes failed once converted (2026-11-15 diagnosis)."""

import base64
import json
from urllib.parse import parse_qs, urlsplit

import pytest

from app.conversion import to_mihomo, to_singbox, to_uri
from app.domain import Unsupported
from app.parsers.core import parse_vless, parse_vmess

UUID = "11111111-2222-4333-8444-555555555555"


def vless_uri(**query):
    q = "&".join(f"{k}={v}" for k, v in query.items())
    return parse_vless(f"vless://{UUID}@vl.example:443?{q}#n").identity


def vmess_uri(**doc):
    data = {"v": "2", "ps": "n", "add": "vm.example", "port": "80", "id": UUID, "aid": "0"}
    data.update(doc)
    return parse_vmess("vmess://" + base64.b64encode(json.dumps(data).encode()).decode()).identity


def query(uri):
    return {k: v[0] for k, v in parse_qs(urlsplit(uri).query).items()}


def reason(identity):
    with pytest.raises(Unsupported) as caught:
        to_mihomo(identity, "n")
    return caught.value.reason


def test_xhttp_http_upgrade_and_pins_stay_unsupported():
    assert reason(vless_uri(type="xhttp", security="tls", path="/x")) == "transport:xhttp"
    assert reason(vmess_uri(net="httpupgrade", path="/u")) == "transport:httpupgrade"
    assert reason(vless_uri(security="tls", sni="a.example", pcs="ab" * 32)) == "ext:vless_uri:pcs"
    # An empty pin field pins nothing.
    assert "fingerprint" not in to_mihomo(vless_uri(security="tls", pcs=""), "n")


def test_vmess_tcp_http_header_obfuscation():
    identity = vmess_uri(net="tcp", type="http", host="a.example,b.example", path="/p")
    proxy = to_mihomo(identity, "n")
    assert proxy["network"] == "http"
    assert proxy["http-opts"] == {
        "method": "GET",
        "path": ["/p"],
        "headers": {"Host": ["a.example", "b.example"]},
    }
    with pytest.raises(Unsupported):
        to_singbox(identity, "n")
    doc = json.loads(base64.b64decode(to_uri(identity, "n")[8:]))
    assert doc["type"] == "http" and doc["net"] == "tcp"


def test_vless_header_type_http_from_share_link():
    proxy = to_mihomo(vless_uri(type="tcp", headerType="http", host="a.example"), "n")
    assert proxy["network"] == "http"


def test_raw_is_tcp_and_tcp_leftovers_are_dropped():
    proxy = to_mihomo(vless_uri(type="raw", security="tls", sni="a.example"), "n")
    assert proxy["network"] == "tcp"
    leftover = {
        "protocol": "vless",
        "server_host": "vl.example",
        "server_port": 443,
        "uuid": UUID,
        "transport": "tcp",
        "transport_options": {"path": "/"},
    }
    assert to_mihomo(leftover, "n")["network"] == "tcp"


def test_reality_spider_x_is_client_side_only():
    identity = vless_uri(security="reality", sni="a.example", pbk="KEY", sid="ab", spx="/s")
    proxy = to_mihomo(identity, "n")
    assert proxy["reality-opts"] == {"public-key": "KEY", "short-id": "ab"}
    assert "spider_x" not in to_singbox(identity, "n")["tls"]["reality"]
    assert query(to_uri(identity, "n"))["spx"] == "/s"


def test_vmess_bookkeeping_fields_are_dropped():
    proxy = to_mihomo(vmess_uri(net="ws", test_name="x", name="y"), "n")
    assert proxy["network"] == "ws"
