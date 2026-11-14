"""Make real-world share-link and Clash extras convertible without guessing.

Parsers keep every field they do not model under identity["extensions"][dialect],
and the converters refuse anything they cannot express, so no option silently
disappears. Real subscriptions carry many extras that either have an exact
canonical equivalent or do not affect reaching the node at all. This module maps
the former and drops the latter, explicitly listed per dialect; anything else stays
in the extensions and is still rejected by the converters.

The same normalized identity is used by the health check and by every export, so a
subscription always contains exactly the configuration that was tested.
"""

import copy

TRUE = (True, 1, "1", "true", "True", "TRUE")
FALSE = (False, 0, "0", "false", "False", "FALSE", "", None)
NONE_VALUES = ("", "none", "None", None)
VMESS_CIPHERS = {"auto", "none", "zero", "aes-128-gcm", "chacha20-poly1305"}

# Options that do not change whether or how a proxy connection is established for an
# HTTP(S) request: bookkeeping from exporters/panels, UDP-only packet encodings, URI
# leftovers, TLS ClientHello fragmentation and optional ECH (the node is tested, and
# exported, without it), and a local interface name that only exists on the source's
# own machine.
DROP = {
    "clash": {
        "delay",
        "uid",
        "version",
        "sub_tag",
        "xudp",
        "interface-name",
        "ech-opts",
        "dialer-proxy-group",
    },
    # test_name/name: panel bookkeeping; ech: optional, as for VLESS.
    "vmess_uri": {"packet_encoding", "packetEncoding", "fragment", "test_name", "name", "ech"},
    "vless_uri": {"fragment", "packetEncoding", "packet_encoding", "ech"},
    "trojan_uri": {"ech", "fragment"},
    "hysteria2_uri": {"ech"},
}
# Dropped only when their value means "nothing".
DROP_IF_NONE = {"headerType", "header_type", "quicSecurity", "security"}
INSECURE_KEYS = ("skip-cert-verify", "allowInsecure", "insecure", "allow_insecure")
# Fields a VLESS entry sometimes inherits from VMess templates; VLESS ignores them.
VLESS_STRAY = {"alterId", "alter_id", "cipher"}
# v2rayN "pcs": SHA-256 pin of the server certificate (mihomo "fingerprint").
PIN_DIALECTS = ("vmess_uri", "vless_uri", "trojan_uri")
XHTTP_MODES = ("auto", "packet-up", "stream-up", "stream-one")
TRANSPORT_ALIASES = {"raw": "tcp"}  # Xray renamed TCP to RAW


def _pin(value):
    """One SHA-256 hex digest (colons allowed), lower-cased; None otherwise."""
    if not isinstance(value, str):
        return None
    digest = value.replace(":", "").strip().lower()
    if len(digest) == 64 and all(c in "0123456789abcdef" for c in digest):
        return digest
    return None


def _tls_insecure(d, value):
    if value in TRUE:
        d.setdefault("tls", {}).setdefault("insecure", True)
        return True
    return value in FALSE


def compatible(identity: dict) -> dict:
    """Return a copy with known extras mapped or dropped; unknown extras are kept."""
    d = copy.deepcopy(identity)
    if d.get("transport", "tcp") is None:
        d["transport"] = "tcp"  # Clash omits network for plain TCP (e.g. Reality)
    if d.get("transport") in TRANSPORT_ALIASES:
        d["transport"] = TRANSPORT_ALIASES[d["transport"]]
    kept = {}
    for dialect, extra in (d.pop("extensions", None) or {}).items():
        if not isinstance(extra, dict):
            kept[dialect] = extra
            continue
        rest = {}
        for key, value in extra.items():
            if key in DROP.get(dialect, ()):
                continue
            if key in DROP_IF_NONE and value in NONE_VALUES:
                continue
            if key in INSECURE_KEYS and d.get("security") in ("tls", "reality"):
                if _tls_insecure(d, value):
                    continue
            if (
                key in INSECURE_KEYS
                and d.get("security") == "none"
                and (value in TRUE or value in FALSE)
            ):
                continue  # certificate options without TLS have no effect
            if dialect == "vmess_uri" and key == "security" and d["protocol"] == "vmess":
                options = d.setdefault("protocol_options", {})
                if value in VMESS_CIPHERS and options.get("cipher", value) == value:
                    options["cipher"] = value
                    continue
            if key == "Host" and isinstance(value, str) and d.get("transport") in ("ws", "http"):
                options = d.setdefault("transport_options", {})
                if options.get("host", value) == value:
                    options["host"] = value
                    continue
            if dialect == "clash" and key in VLESS_STRAY and d["protocol"] == "vless":
                continue
            if dialect in PIN_DIALECTS and key == "pcs":
                if value in NONE_VALUES:
                    continue
                pin, tls = _pin(value), d.get("tls", {})
                secured = d.get("security") in ("tls", "reality") or (
                    d["protocol"] == "trojan" and d.get("security") is None
                )
                if pin and secured and tls.get("pin_sha256", pin) == pin:
                    d["tls"] = {**tls, "pin_sha256": pin}
                    continue
            if dialect == "vless_uri" and key == "mode" and d.get("transport") == "xhttp":
                if value in XHTTP_MODES:
                    d.setdefault("transport_options", {})["mode"] = value
                    continue
            if dialect == "vless_uri" and key == "headerType" and value == "http":
                options = d.setdefault("transport_options", {})
                if d.get("transport") == "tcp" and options.get("header_type", value) == value:
                    options["header_type"] = value
                    continue
            if dialect == "clash" and key == "auth" and d["protocol"] == "hysteria2":
                if d.get("password") in (None, "", value):
                    d["password"] = value
                    continue
            rest[key] = value
        if rest:
            kept[dialect] = rest
    if kept:
        d["extensions"] = kept
    options = d.get("transport_options") or {}
    # Header type only exists for TCP ("http" obfuscation); generators also write the
    # VMess cipher or "auto" into it. Elsewhere, or with any other value, it means none.
    if "header_type" in options and (
        d.get("transport") != "tcp" or options["header_type"] != "http"
    ):
        options.pop("header_type")
        if not options:
            d.pop("transport_options", None)
    # TCP carries no host/path unless an HTTP header type asks for it: URI leftovers.
    if d.get("transport") == "tcp" and options.get("header_type") in NONE_VALUES:
        for key in ("host", "path", "service_name", "header_type"):
            options.pop(key, None)
        if not options:
            d.pop("transport_options", None)
    return d


# Client-side connection preferences in Clash entries. Mihomo output keeps them; sing-box
# and URI outputs cannot express them, and leaving them out does not change whether
# the node can be reached (UDP relay, TCP Fast Open, MPTCP, IP family, multiplexing).
CLIENT_PREFERENCES = {"udp", "tfo", "mptcp", "ip-version", "smux"}


def without_client_preferences(identity: dict) -> dict:
    clash = (identity.get("extensions") or {}).get("clash")
    if not isinstance(clash, dict) or not set(clash) & CLIENT_PREFERENCES:
        return identity
    d = copy.deepcopy(identity)
    rest = {k: v for k, v in clash.items() if k not in CLIENT_PREFERENCES}
    if rest:
        d["extensions"]["clash"] = rest
    else:
        del d["extensions"]["clash"]
        if not d["extensions"]:
            del d["extensions"]
    return d
