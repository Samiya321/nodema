"""Explicit, loss-aware conversions shared by the runtime and subscription exporters."""

import base64
import copy
import json
from urllib.parse import quote, urlencode

from app.compat import compatible, without_client_preferences
from app.domain import PASSWORD_PROTOCOLS, Unsupported, field_label

TLS_KEYS = {"sni", "alpn", "client_fingerprint", "insecure", "reality", "pin_sha256"}
REALITY_KEYS = {"public_key", "short_id", "spider_x"}  # spider_x: client-side only
OPTION_KEYS = {"host", "path", "service_name", "headers", "header_type", "mode"}
# Mihomo v1.19 transports; HTTP Upgrade is its WebSocket mode, XHTTP is VLESS only.
TRANSPORTS = {
    "vless": ("tcp", "ws", "grpc", "httpupgrade", "xhttp"),
    "vmess": ("tcp", "ws", "grpc", "httpupgrade"),
}
PROTOCOL_KEYS = {"flow", "encryption", "alter_id", "cipher", "allowed_network"}
TCP_ONLY_NOT = {"host", "path", "headers", "service_name"}  # never on plain TCP


def unsupported(reason: str = "unknown"):
    raise Unsupported(reason)


def to_mihomo(identity: dict, name: str) -> dict:
    identity = compatible(identity)
    if identity["protocol"] in PASSWORD_PROTOCOLS:
        from app.password_conversion import to_mihomo as convert

        return convert(identity, name)
    d = identity
    protocol, transport, security = (
        d["protocol"],
        d.get("transport", "tcp"),
        d.get("security", "none"),
    )
    if protocol not in ("vless", "vmess"):
        unsupported("protocol")
    if transport not in TRANSPORTS[protocol]:
        unsupported("transport:" + field_label([transport]))
    if security not in ("none", "tls", "reality") or protocol == "vmess" and security == "reality":
        unsupported("security:" + field_label([security]))
    proxy = {
        "name": name,
        "type": protocol,
        "server": d["server_host"],
        "port": d["server_port"],
        "uuid": d["uuid"],
        "network": "ws" if transport == "httpupgrade" else transport,
        "tls": security != "none",
    }
    tls, options, proto = (
        d.get("tls", {}),
        d.get("transport_options", {}),
        d.get("protocol_options", {}),
    )
    if set(tls) - TLS_KEYS:
        unsupported("tls:" + field_label(set(tls) - TLS_KEYS))
    for source, target in (
        ("sni", "servername"),
        ("alpn", "alpn"),
        ("client_fingerprint", "client-fingerprint"),
        ("insecure", "skip-cert-verify"),
        ("pin_sha256", "fingerprint"),
    ):
        if source in tls:
            proxy[target] = tls[source]
    if "reality" in tls:
        reality = tls["reality"]
        if security != "reality":
            unsupported("reality_without_security")
        if set(reality) - REALITY_KEYS:
            unsupported("reality:" + field_label(set(reality) - REALITY_KEYS))
        proxy["reality-opts"] = {
            k.replace("_", "-"): v for k, v in reality.items() if k != "spider_x"
        }
    if security == "reality" and not proxy.get("reality-opts", {}).get("public-key"):
        unsupported("reality_public_key")
    if set(options) - OPTION_KEYS:
        unsupported("transport_options:" + field_label(set(options) - OPTION_KEYS))
    header_type = options.get("header_type")
    if header_type not in (None, "", "none") and (header_type != "http" or transport != "tcp"):
        unsupported("header_type:" + field_label([header_type]))
    if "mode" in options and transport != "xhttp":
        unsupported("mode")
    if transport in ("ws", "httpupgrade"):
        ws = {k: options[k] for k in ("path",) if k in options}
        headers = copy.deepcopy(options.get("headers", {}))
        if "host" in options:
            headers["Host"] = options["host"]
        if headers:
            ws["headers"] = headers
        if transport == "httpupgrade":
            ws["v2ray-http-upgrade"] = True
        proxy["ws-opts"] = ws
    elif transport == "xhttp":
        if "service_name" in options:
            unsupported("xhttp_options")
        proxy["xhttp-opts"] = {
            k: copy.deepcopy(options[k])
            for k in ("path", "host", "mode", "headers")
            if k in options
        }
    elif header_type == "http":
        # TCP with HTTP/1.1 header obfuscation: mihomo's "http" network.
        if "service_name" in options:
            unsupported("tcp_options:service_name")
        http = {"method": "GET", "path": [options.get("path") or "/"]}
        headers = {
            k: [v] if isinstance(v, str) else v for k, v in options.get("headers", {}).items()
        }
        if options.get("host"):
            headers["Host"] = [h.strip() for h in options["host"].split(",") if h.strip()]
        if headers:
            http["headers"] = headers
        proxy["network"], proxy["http-opts"] = "http", http
    elif transport == "grpc":
        if any(k in options for k in ("host", "path", "headers")):
            unsupported("grpc_options")
        proxy["grpc-opts"] = (
            {"grpc-service-name": options["service_name"]} if "service_name" in options else {}
        )
    elif set(options) & TCP_ONLY_NOT:
        unsupported("tcp_options:" + field_label(set(options) & TCP_ONLY_NOT))
    if set(proto) - PROTOCOL_KEYS:
        unsupported("protocol_options:" + field_label(set(proto) - PROTOCOL_KEYS))
    if proto.get("allowed_network") == "udp":
        unsupported("udp_only")  # HTTPS is not applicable to an explicitly UDP-only outbound.
    if "allowed_network" in proto:
        if proto["allowed_network"] != "tcp":
            unsupported("allowed_network")
        proxy["udp"] = False
    for source, target in (
        ("flow", "flow"),
        ("encryption", "encryption"),
        ("alter_id", "alterId"),
        ("cipher", "cipher"),
    ):
        if source in proto:
            proxy[target] = proto[source]
    if protocol == "vmess":
        proxy.setdefault("alterId", 0)
        proxy.setdefault("cipher", "auto")
    for dialect, extra in d.get("extensions", {}).items():
        extra = copy.deepcopy(extra)
        reality_metadata = extra.pop("reality-opts", None)
        if reality_metadata is not None:
            if (
                dialect != "clash"
                or security != "reality"
                or not isinstance(reality_metadata, dict)
                or set(reality_metadata) != {"_spider-x"}
                or not isinstance(reality_metadata["_spider-x"], str)
            ):
                unsupported(f"ext:{dialect}:reality-opts")
            # Sub-Store export metadata, not an authentication override. Preserve it
            # separately from the canonical public key/short ID when rendering YAML.
            proxy["reality-opts"].update(reality_metadata)
        allowed = {
            "udp",
            "packet-encoding",
            "smux",
            "global-padding",
            "authenticated-length",
            "tfo",
            "mptcp",
            "ip-version",
            "fingerprint",
            "name-cert-verify",
        }
        if dialect != "clash":
            unsupported(f"ext:{dialect}:" + field_label(extra or ["empty"]))
        if set(extra) - allowed:
            unsupported(f"ext:{dialect}:" + field_label(set(extra) - allowed))
        proxy.update(copy.deepcopy(extra))
    return proxy


def to_singbox(identity: dict, name: str) -> dict:
    identity = without_client_preferences(compatible(identity))
    if identity["protocol"] in PASSWORD_PROTOCOLS:
        from app.password_conversion import to_singbox as convert

        return convert(identity, name)
    to_mihomo(identity, name)  # reject values whose semantics we cannot preserve
    if identity.get("extensions"):
        unsupported()
    d = identity
    options = d.get("transport_options", {})
    if d.get("transport") == "xhttp" or options.get("header_type") == "http":
        unsupported("singbox_transport")  # no XHTTP or TCP header obfuscation in sing-box
    if "pin_sha256" in d.get("tls", {}):
        unsupported("singbox_certificate_pin")
    result = {
        "type": d["protocol"],
        "tag": name,
        "server": d["server_host"],
        "server_port": d["server_port"],
        "uuid": d["uuid"],
    }
    security, tls = d.get("security", "none"), d.get("tls", {})
    if security != "none" or tls:
        output = {"enabled": security != "none"}
        for source, target in (("sni", "server_name"), ("alpn", "alpn"), ("insecure", "insecure")):
            if source in tls:
                output[target] = tls[source]
        if "client_fingerprint" in tls:
            output["utls"] = {"enabled": True, "fingerprint": tls["client_fingerprint"]}
        if "reality" in tls:
            reality = {k: v for k, v in tls["reality"].items() if k != "spider_x"}
            output["reality"] = {"enabled": True, **reality}
        result["tls"] = output
    transport = d.get("transport", "tcp")
    if transport != "tcp":
        output = {"type": transport}
        for key in ("path", "service_name"):
            if key in options:
                output[key] = options[key]
        headers = copy.deepcopy(options.get("headers", {}))
        if "host" in options and transport == "httpupgrade":
            output["host"] = options["host"]
        elif "host" in options:
            headers["Host"] = options["host"]
        if headers:
            output["headers"] = headers
        result["transport"] = output
    proto = d.get("protocol_options", {})
    if d["protocol"] == "vless":
        if proto.get("encryption") not in (None, "none", ""):
            unsupported()
        if "flow" in proto:
            result["flow"] = proto["flow"]
    else:
        result.update(
            {"security": proto.get("cipher", "auto"), "alter_id": proto.get("alter_id", 0)}
        )
    if "allowed_network" in proto:
        result["network"] = proto["allowed_network"]
    return result


def to_uri(identity: dict, name: str) -> str:
    identity = without_client_preferences(compatible(identity))
    if identity["protocol"] in PASSWORD_PROTOCOLS:
        from app.password_conversion import to_uri as convert

        return convert(identity, name)
    to_mihomo(identity, name)  # reject values whose semantics we cannot preserve
    if identity.get("extensions"):
        unsupported()  # URI cannot represent opaque extension options
    tls, options, proto = (
        identity.get(k, {}) for k in ("tls", "transport_options", "protocol_options")
    )
    if options.get("headers") or "allowed_network" in proto:
        unsupported()
    if identity["protocol"] == "vless" and proto.get("encryption") not in (None, "none", ""):
        unsupported()
    if identity["protocol"] == "vmess":
        if tls.get("insecure") is not None:
            unsupported()  # share dialects disagree; do not drop verification behavior
        doc = {
            "v": "2",
            "ps": name,
            "add": identity["server_host"],
            "port": str(identity["server_port"]),
            "id": identity["uuid"],
            "aid": str(proto.get("alter_id", 0)),
            "scy": proto.get("cipher", "auto"),
            "net": identity.get("transport", "tcp"),
            "tls": "tls" if identity.get("security") == "tls" else "",
        }
        for key in ("host", "path"):
            if key in options:
                doc[key] = options[key]
        if options.get("header_type") == "http":
            doc["type"] = "http"
        if "pin_sha256" in tls:
            doc["pcs"] = tls["pin_sha256"]
        if "service_name" in options:
            unsupported()  # not universally represented by the VMess JSON share format
        for source, target in (("sni", "sni"), ("client_fingerprint", "fp")):
            if source in tls:
                doc[target] = tls[source]
        if "alpn" in tls:
            doc["alpn"] = ",".join(tls["alpn"])
        return "vmess://" + base64.b64encode(json.dumps(doc, ensure_ascii=False).encode()).decode()
    host = identity["server_host"]
    host = f"[{host}]" if ":" in host else host
    query = {"type": identity.get("transport", "tcp"), "security": identity.get("security", "none")}
    for source, target in (("sni", "sni"), ("client_fingerprint", "fp")):
        if source in tls:
            query[target] = tls[source]
    if "alpn" in tls:
        query["alpn"] = ",".join(tls["alpn"])
    if "insecure" in tls:
        query["allowInsecure"] = "1" if tls["insecure"] else "0"
    for source, target in (("public_key", "pbk"), ("short_id", "sid"), ("spider_x", "spx")):
        if source in tls.get("reality", {}):
            query[target] = tls["reality"][source]
    if "pin_sha256" in tls:
        query["pcs"] = tls["pin_sha256"]
    for source, target in (
        ("host", "host"),
        ("path", "path"),
        ("service_name", "serviceName"),
        ("mode", "mode"),
        ("header_type", "headerType"),
    ):
        if source in options:
            query[target] = options[source]
    query.update({k: proto[k] for k in ("flow", "encryption") if k in proto})
    return f"vless://{identity['uuid']}@{host}:{identity['server_port']}?{urlencode(query)}#{quote(name)}"
