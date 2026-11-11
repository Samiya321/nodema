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
    "vmess_uri": {"packet_encoding", "packetEncoding", "fragment"},
    "vless_uri": {"fragment", "packetEncoding", "packet_encoding", "ech"},
    "trojan_uri": {"ech", "fragment"},
    "hysteria2_uri": {"ech"},
}
# Dropped only when their value means "nothing".
DROP_IF_NONE = {"headerType", "header_type", "quicSecurity", "security"}
INSECURE_KEYS = ("skip-cert-verify", "allowInsecure", "insecure", "allow_insecure")
# Fields a VLESS entry sometimes inherits from VMess templates; VLESS ignores them.
VLESS_STRAY = {"alterId", "alter_id", "cipher"}


def _tls_insecure(d, value):
    if value in TRUE:
        d.setdefault("tls", {}).setdefault("insecure", True)
        return True
    return value in FALSE


def compatible(identity: dict) -> dict:
    """Return a copy with known extras mapped or dropped; unknown extras are kept."""
    extensions = identity.get("extensions")
    needs = (
        extensions
        or identity.get("transport", "tcp") is None
        or "header_type" in (identity.get("transport_options") or {})
    )
    if not needs:
        return identity
    d = copy.deepcopy(identity)
    if d.get("transport", "tcp") is None:
        d["transport"] = "tcp"  # Clash omits network for plain TCP (e.g. Reality)
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
