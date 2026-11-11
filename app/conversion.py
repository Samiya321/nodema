"""Explicit, loss-aware conversions shared by the runtime and subscription exporters."""

import base64
import copy
import json
from urllib.parse import quote, urlencode

from app.compat import compatible, without_client_preferences
from app.domain import PASSWORD_PROTOCOLS, AssetError


def unsupported():
    raise AssetError("RUNTIME_UNSUPPORTED")


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
    if protocol not in ("vless", "vmess") or transport not in ("tcp", "ws", "grpc"):
        unsupported()
    if security not in ("none", "tls", "reality") or protocol == "vmess" and security == "reality":
        unsupported()
    proxy = {
        "name": name,
        "type": protocol,
        "server": d["server_host"],
        "port": d["server_port"],
        "uuid": d["uuid"],
        "network": transport,
        "tls": security != "none",
    }
    tls, options, proto = (
        d.get("tls", {}),
        d.get("transport_options", {}),
        d.get("protocol_options", {}),
    )
    if set(tls) - {"sni", "alpn", "client_fingerprint", "insecure", "reality"}:
        unsupported()
    for source, target in (
        ("sni", "servername"),
        ("alpn", "alpn"),
        ("client_fingerprint", "client-fingerprint"),
        ("insecure", "skip-cert-verify"),
    ):
        if source in tls:
            proxy[target] = tls[source]
    if "reality" in tls:
        reality = tls["reality"]
        if security != "reality" or set(reality) - {"public_key", "short_id"}:
            unsupported()
        proxy["reality-opts"] = {k.replace("_", "-"): v for k, v in reality.items()}
    if security == "reality" and not proxy.get("reality-opts", {}).get("public-key"):
        unsupported()
    if set(options) - {"host", "path", "service_name", "headers", "header_type"}:
        unsupported()
    if options.get("header_type") not in (None, "", "none"):
        unsupported()
    if transport == "ws":
        ws = {k: options[k] for k in ("path",) if k in options}
        headers = copy.deepcopy(options.get("headers", {}))
        if "host" in options:
            headers["Host"] = options["host"]
        if headers:
            ws["headers"] = headers
        proxy["ws-opts"] = ws
    elif transport == "grpc":
        if any(k in options for k in ("host", "path", "headers")):
            unsupported()
        proxy["grpc-opts"] = (
            {"grpc-service-name": options["service_name"]} if "service_name" in options else {}
        )
    elif any(k in options for k in ("host", "path", "headers", "service_name")):
        unsupported()
    if set(proto) - {"flow", "encryption", "alter_id", "cipher", "allowed_network"}:
        unsupported()
    if proto.get("allowed_network") == "udp":
        unsupported()  # HTTPS is not applicable to an explicitly UDP-only outbound.
    if "allowed_network" in proto:
        if proto["allowed_network"] != "tcp":
            unsupported()
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
                unsupported()
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
        if dialect != "clash" or set(extra) - allowed:
            unsupported()
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
            output["reality"] = {"enabled": True, **tls["reality"]}
        result["tls"] = output
    options = d.get("transport_options", {})
    transport = d.get("transport", "tcp")
    if transport != "tcp":
        output = {"type": transport}
        for key in ("path", "service_name"):
            if key in options:
                output[key] = options[key]
        headers = copy.deepcopy(options.get("headers", {}))
        if "host" in options:
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
    to_singbox(identity, name)  # URI cannot represent opaque extension options
    tls, options, proto = (
        identity.get(k, {}) for k in ("tls", "transport_options", "protocol_options")
    )
    if options.get("headers") or "allowed_network" in proto:
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
    for source, target in (("public_key", "pbk"), ("short_id", "sid")):
        if source in tls.get("reality", {}):
            query[target] = tls["reality"][source]
    for source, target in (("host", "host"), ("path", "path"), ("service_name", "serviceName")):
        if source in options:
            query[target] = options[source]
    query.update({k: proto[k] for k in ("flow", "encryption") if k in proto})
    return f"vless://{identity['uuid']}@{host}:{identity['server_port']}?{urlencode(query)}#{quote(name)}"
