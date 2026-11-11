"""Loss-aware password protocol conversions. Unknown options never disappear."""

import base64
import copy
from urllib.parse import quote, urlencode

from app.domain import AssetError

SS_CIPHERS = {
    "aes-128-gcm",
    "aes-192-gcm",
    "aes-256-gcm",
    "chacha20-ietf-poly1305",
    "xchacha20-ietf-poly1305",
    "2022-blake3-aes-128-gcm",
    "2022-blake3-aes-256-gcm",
    "2022-blake3-chacha20-poly1305",
    "none",
    # Legacy stream ciphers: still supported by mihomo and sing-box, common in old
    # subscriptions. Weak, but the node owner chose them; the client must match.
    "aes-128-cfb",
    "aes-192-cfb",
    "aes-256-cfb",
    "aes-128-ctr",
    "aes-192-ctr",
    "aes-256-ctr",
    "rc4-md5",
    "chacha20-ietf",
    "xchacha20",
}


def reject():
    raise AssetError("RUNTIME_UNSUPPORTED")


def keys(value, allowed):
    if not isinstance(value, dict) or set(value) - set(allowed):
        reject()


def plugin_string(plugin):
    keys(plugin, ("name", "options"))
    parts = [plugin["name"]]

    def escape(value):
        return "".join("\\" + c if c in "\\;=:" else c for c in str(value))

    for key, value in sorted(plugin["options"].items()):
        if value is False or not isinstance(value, (str, bool)):
            reject()
        parts.append(escape(key) + ("" if value is True else "=" + escape(value)))
    return ";".join(parts)


def _plugin(plugin):
    keys(plugin, ("name", "options"))
    name, options = plugin.get("name"), plugin.get("options", {})
    if name == "obfs-local":
        keys(options, ("obfs", "obfs-host"))
        if options.get("obfs") not in ("http", "tls"):
            reject()
        return "obfs", {{"obfs": "mode", "obfs-host": "host"}[k]: v for k, v in options.items()}
    if name == "v2ray-plugin":
        keys(options, ("tls", "host", "path", "mux"))
        if any(type(options[k]) is not bool for k in ("tls", "mux") if k in options):
            reject()
        return name, {"mode": "websocket", **copy.deepcopy(options)}
    reject()


def _tls(tls, security):
    keys(tls, ("sni", "alpn", "client_fingerprint", "insecure", "reality"))
    output = {}
    for source, target in (
        ("sni", "sni"),
        ("alpn", "alpn"),
        ("client_fingerprint", "client-fingerprint"),
        ("insecure", "skip-cert-verify"),
    ):
        if source in tls:
            output[target] = tls[source]
    if "reality" in tls:
        reality = tls["reality"]
        keys(reality, ("public_key", "short_id"))
        if security != "reality" or not reality.get("public_key"):
            reject()
        output["reality-opts"] = {k.replace("_", "-"): v for k, v in reality.items()}
    elif security == "reality":
        reject()
    return output


def _transport(options, transport):
    keys(options, ("host", "path", "service_name", "headers", "header_type"))
    if options.get("header_type") not in (None, "", "none"):
        reject()
    if transport == "ws":
        if "service_name" in options:
            reject()
        headers = copy.deepcopy(options.get("headers", {}))
        if "host" in options:
            headers["Host"] = options["host"]
        return {
            "ws-opts": {
                **({"path": options["path"]} if "path" in options else {}),
                **({"headers": headers} if headers else {}),
            }
        }
    if transport == "grpc":
        if set(options) - {"service_name", "header_type"}:
            reject()
        return {
            "grpc-opts": {"grpc-service-name": options["service_name"]}
            if "service_name" in options
            else {}
        }
    if set(options) - {"header_type"}:
        reject()
    return {}


def to_mihomo(d, name):
    protocol, p = d["protocol"], d.get("protocol_options", {})
    transport = d.get("transport", "quic" if protocol == "hysteria2" else "tcp")
    security = d.get("security", "none" if protocol == "shadowsocks" else "tls")
    if not isinstance(d.get("password"), str) or not d["password"]:
        reject()
    out = {
        "name": name,
        "type": "ss" if protocol == "shadowsocks" else protocol,
        "server": d["server_host"],
        "port": d["server_port"],
        "password": d["password"],
    }
    if p.get("allowed_network") not in (None, "tcp"):
        reject()
    if p.get("allowed_network") == "tcp":
        out["udp"] = False
    if protocol == "shadowsocks":
        keys(p, ("cipher", "plugin", "allowed_network"))
        tls = d.get("tls", {})
        if (
            transport != "tcp"
            or security != "none"
            or d.get("transport_options")
            or tls
            and tls != {"insecure": False}
        ):
            reject()
        if tls:
            out["skip-cert-verify"] = False
        if p.get("cipher") not in SS_CIPHERS:
            reject()
        out["cipher"] = p["cipher"]
        if "plugin" in p:
            out["plugin"], out["plugin-opts"] = _plugin(p["plugin"])
    else:
        if security not in (("tls", "reality") if protocol == "trojan" else ("tls",)):
            reject()
        out.update(_tls(d.get("tls", {}), security))
        if protocol == "trojan":
            keys(p, ("allowed_network",))
            if transport not in ("tcp", "ws", "grpc"):
                reject()
            out["network"] = transport
            out.update(_transport(d.get("transport_options", {}), transport))
        elif protocol == "anytls":
            keys(
                p,
                (
                    "idle_check_seconds",
                    "idle_timeout_seconds",
                    "min_idle_session",
                    "client_metadata",
                    "allowed_network",
                ),
            )
            if transport != "tcp" or d.get("transport_options"):
                reject()
            for source, target in (
                ("idle_check_seconds", "idle-session-check-interval"),
                ("idle_timeout_seconds", "idle-session-timeout"),
                ("min_idle_session", "min-idle-session"),
                ("client_metadata", "client-metadata"),
            ):
                if source in p:
                    if source != "client_metadata" and (
                        type(p[source]) is not int or not 0 <= p[source] <= 86400
                    ):
                        reject()
                    out[target] = p[source]
        elif protocol == "hysteria2":
            keys(
                p,
                ("server_ports", "hop_seconds", "up_mbps", "down_mbps", "obfs", "allowed_network"),
            )
            if (
                transport != "quic"
                or d.get("transport_options")
                or "client_fingerprint" in d.get("tls", {})
            ):
                reject()
            if "server_ports" in p:
                out["ports"] = ",".join(p["server_ports"])
            for source, target in (
                ("hop_seconds", "hop-interval"),
                ("up_mbps", "up"),
                ("down_mbps", "down"),
            ):
                if source in p:
                    out[target] = p[source]
            if "obfs" in p:
                obfs = p["obfs"]
                keys(obfs, ("type", "password"))
                if (
                    obfs.get("type") != "salamander"
                    or not isinstance(obfs.get("password"), str)
                    or not obfs["password"]
                ):
                    reject()
                out["obfs"], out["obfs-password"] = obfs["type"], obfs["password"]
        else:
            reject()
    for dialect, extra in d.get("extensions", {}).items():
        if dialect != "clash":
            reject()
        keys(
            extra, ("udp", "tfo", "mptcp", "ip-version", "fingerprint", "name-cert-verify", "smux")
        )
        out.update(copy.deepcopy(extra))
    return out


def to_singbox(d, name):
    to_mihomo(d, name)
    if d.get("extensions") or d["protocol"] == "shadowsocks" and d.get("tls"):
        reject()
    protocol, p = d["protocol"], d.get("protocol_options", {})
    out = {
        "type": protocol,
        "tag": name,
        "server": d["server_host"],
        "server_port": d["server_port"],
        "password": d["password"],
    }
    if protocol == "shadowsocks":
        out["method"] = p["cipher"]
        if "plugin" in p:
            plugin = plugin_string(p["plugin"])
            out["plugin"], _, out["plugin_opts"] = plugin.partition(";")
    else:
        t = d.get("tls", {})
        tls = {"enabled": True}
        for source, target in (("sni", "server_name"), ("alpn", "alpn"), ("insecure", "insecure")):
            if source in t:
                tls[target] = t[source]
        if "client_fingerprint" in t:
            tls["utls"] = {"enabled": True, "fingerprint": t["client_fingerprint"]}
        if "reality" in t:
            tls["reality"] = {"enabled": True, **t["reality"]}
        out["tls"] = tls
        if protocol == "trojan" and d.get("transport", "tcp") != "tcp":
            options = d.get("transport_options", {})
            transport = {"type": d["transport"]}
            for key in ("path", "service_name"):
                if key in options:
                    transport[key] = options[key]
            headers = copy.deepcopy(options.get("headers", {}))
            if "host" in options:
                headers["Host"] = options["host"]
            if headers:
                transport["headers"] = headers
            out["transport"] = transport
        elif protocol == "anytls":
            for source, target in (
                ("idle_check_seconds", "idle_session_check_interval"),
                ("idle_timeout_seconds", "idle_session_timeout"),
                ("min_idle_session", "min_idle_session"),
                ("client_metadata", "client_metadata"),
            ):
                if source in p:
                    out[target] = f"{p[source]}s" if source.endswith("seconds") else p[source]
        elif protocol == "hysteria2":
            for key in ("up_mbps", "down_mbps", "obfs"):
                if key in p:
                    out[key] = copy.deepcopy(p[key])
            if "server_ports" in p:
                out.pop("server_port")
                out["server_ports"] = [v.replace("-", ":") for v in p["server_ports"]]
            if "hop_seconds" in p:
                out["hop_interval"] = f"{p['hop_seconds']}s"
    if "allowed_network" in p:
        # AnyTLS has no outbound network option in the supported schema.
        if protocol == "anytls":
            reject()
        out["network"] = p["allowed_network"]
    return out


def to_uri(d, name):
    to_mihomo(d, name)
    if d.get("extensions") or d["protocol"] == "shadowsocks" and d.get("tls"):
        reject()
    protocol, p, t = d["protocol"], d.get("protocol_options", {}), d.get("tls", {})
    host = f"[{d['server_host']}]" if ":" in d["server_host"] else d["server_host"]
    authority = f"{host}:{d['server_port']}"
    query = {}
    password = quote(d["password"], safe="")
    if protocol == "shadowsocks":
        keys(p, ("cipher", "plugin"))
        if p["cipher"].startswith("2022-"):
            userinfo = quote(p["cipher"], safe="") + ":" + password
        else:
            userinfo = (
                base64.urlsafe_b64encode((p["cipher"] + ":" + d["password"]).encode())
                .decode()
                .rstrip("=")
            )
        if "plugin" in p:
            query["plugin"] = plugin_string(p["plugin"])
        scheme, password = "ss", userinfo
    else:
        for source, target in (("sni", "sni"), ("client_fingerprint", "fp")):
            if source in t:
                query[target] = t[source]
        if "alpn" in t:
            query["alpn"] = ",".join(t["alpn"])
        if "insecure" in t:
            query["insecure"] = "1" if t["insecure"] else "0"
        scheme = protocol
        if protocol == "trojan":
            keys(p, ())
            query.update(type=d.get("transport", "tcp"), security=d.get("security", "tls"))
            for source, target in (
                ("host", "host"),
                ("path", "path"),
                ("service_name", "serviceName"),
            ):
                if source in d.get("transport_options", {}):
                    query[target] = d["transport_options"][source]
            if d.get("transport_options", {}).get("headers"):
                reject()
            if "reality" in t:
                for source, target in (("public_key", "pbk"), ("short_id", "sid")):
                    if source in t["reality"]:
                        query[target] = t["reality"][source]
        elif protocol == "anytls":
            keys(p, ())  # Session tuning is not part of the official AnyTLS URI.
        elif protocol == "hysteria2":
            keys(p, ("server_ports", "obfs"))
            if "server_ports" in p:
                authority = host + ":" + ",".join(p["server_ports"])
            if "obfs" in p:
                query.update(obfs=p["obfs"]["type"], **{"obfs-password": p["obfs"]["password"]})
    return (
        f"{scheme}://{password}@{authority}/"
        + ("?" + urlencode(query) if query else "")
        + "#"
        + quote(name, safe="")
    )
