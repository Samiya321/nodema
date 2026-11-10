"""Password protocols and SIP002/AnyTLS/Hysteria2 share adapters. No network I/O."""

import re
from urllib.parse import parse_qsl, quote, unquote, urlsplit

from app.domain import AssetError
from app.parsers.core import (
    MAX_BYTES,
    MISSING,
    _boolean,
    _clean,
    _decode64,
    _integer,
    _normalize,
    _take,
    _text,
)


def seconds(value):
    if value is MISSING:
        return MISSING
    if isinstance(value, str):
        match = re.fullmatch(r"(\d+(?:\.\d+)?)(ms|s|m|h)?", value)
        if not match:
            raise AssetError("INVALID_DURATION")
        value = float(match[1]) * {None: 1, "ms": 0.001, "s": 1, "m": 60, "h": 3600}[match[2]]
    if type(value) not in (int, float) or not 0 < value <= 86400:
        raise AssetError("INVALID_DURATION")
    return int(value) if int(value) == value else value


def bandwidth(value):
    if value is MISSING:
        return MISSING
    if isinstance(value, str):
        match = re.fullmatch(r"(\d+(?:\.\d+)?)\s*(bps|kbps|mbps|gbps)?", value, re.I)
        if not match:
            raise AssetError("INVALID_BANDWIDTH")
        value = (
            float(match[1])
            * {None: 1, "bps": 0.000001, "kbps": 0.001, "mbps": 1, "gbps": 1000}[
                match[2].lower() if match[2] else None
            ]
        )
    if type(value) not in (int, float) or not 0 <= value <= 1_000_000:
        raise AssetError("INVALID_BANDWIDTH")
    return int(value) if int(value) == value else value


def ports(value):
    if value is MISSING:
        return MISSING
    values = value.split(",") if isinstance(value, str) else value
    if not isinstance(values, list) or not 1 <= len(values) <= 64:
        raise AssetError("INVALID_PORT_RANGE")
    result = []
    for part in values:
        match = re.fullmatch(r"(\d+)(?:[:-](\d+))?", str(part).strip())
        if not match:
            raise AssetError("INVALID_PORT_RANGE")
        low, high = int(match[1]), int(match[2] or match[1])
        if not 1 <= low <= high <= 65535:
            raise AssetError("INVALID_PORT_RANGE")
        result.append(str(low) if low == high else f"{low}-{high}")
    return result


def plugin_parts(value):
    """Parse SIP003 escaped separators without shell/plugin execution."""
    if not isinstance(value, str) or len(value) > 16384:
        raise AssetError("INVALID_PLUGIN")
    parts, current, escaped = [], [], False
    for c in value:
        if escaped:
            current.append(c)
            escaped = False
        elif c == "\\":
            escaped = True
        elif c == ";":
            parts.append("".join(current))
            current = []
        else:
            current.append(c)
    if escaped:
        raise AssetError("INVALID_PLUGIN")
    parts.append("".join(current))
    name = parts.pop(0)
    name = {"simple-obfs": "obfs-local", "obfs": "obfs-local"}.get(name, name)
    options = {}
    for part in parts:
        key, sep, value = part.partition("=")
        if not key or key in options:
            raise AssetError("INVALID_PLUGIN")
        options[key] = value if sep else True
    return {"name": name, "options": options}


def clash_plugin(name, options):
    name = _text(name, required=True)
    if options is MISSING:
        options = {}
    if not isinstance(options, dict):
        raise AssetError("INVALID_PLUGIN")
    options = dict(options)
    if name in ("obfs", "obfs-local", "simple-obfs"):
        options = {{"mode": "obfs", "host": "obfs-host"}.get(k, k): v for k, v in options.items()}
        name = "obfs-local"
    elif name == "v2ray-plugin" and options.get("mode") == "websocket":
        options.pop("mode")  # SIP003 v2ray-plugin defaults to WebSocket.
    return {"name": name, "options": options}


def clash_options(data, protocol):
    options = {}
    if protocol == "shadowsocks":
        options["cipher"] = _text(_take(data, "cipher"), required=True)
        plugin = _take(data, "plugin")
        if plugin is not MISSING:
            options["plugin"] = clash_plugin(plugin, _take(data, "plugin-opts"))
    elif protocol == "anytls":
        for source, target in (
            ("idle-session-check-interval", "idle_check_seconds"),
            ("idle-session-timeout", "idle_timeout_seconds"),
        ):
            options[target] = seconds(_take(data, source))
        minimum = _take(data, "min-idle-session")
        if minimum is not MISSING:
            options["min_idle_session"] = _integer(minimum)
        options["client_metadata"] = _text(_take(data, "client-metadata"))
    elif protocol == "hysteria2":
        options.update(
            server_ports=ports(_take(data, "ports")),
            hop_seconds=seconds(_take(data, "hop-interval")),
            up_mbps=bandwidth(_take(data, "up")),
            down_mbps=bandwidth(_take(data, "down")),
        )
        obfs = _take(data, "obfs")
        if obfs is not MISSING:
            options["obfs"] = _clean(
                {
                    "type": _text(obfs),
                    "password": _text(_take(data, "obfs-password"), required=True),
                }
            )
    return _clean(options)


def singbox_options(data, protocol):
    options = {}
    if protocol == "shadowsocks":
        options["cipher"] = _text(_take(data, "method"), required=True)
        plugin = _take(data, "plugin")
        if plugin is not MISSING and plugin != "":
            arguments = _take(data, "plugin_opts", default="")
            options["plugin"] = plugin_parts(plugin + (";" + arguments if arguments else ""))
    elif protocol == "anytls":
        for source, target in (
            ("idle_session_check_interval", "idle_check_seconds"),
            ("idle_session_timeout", "idle_timeout_seconds"),
        ):
            options[target] = seconds(_take(data, source))
        minimum = _take(data, "min_idle_session")
        if minimum is not MISSING:
            options["min_idle_session"] = _integer(minimum)
        options["client_metadata"] = _text(_take(data, "client_metadata"))
    elif protocol == "hysteria2":
        options.update(
            server_ports=ports(_take(data, "server_ports")),
            hop_seconds=seconds(_take(data, "hop_interval")),
            up_mbps=bandwidth(_take(data, "up_mbps")),
            down_mbps=bandwidth(_take(data, "down_mbps")),
        )
        obfs = _take(data, "obfs")
        if obfs is not MISSING:
            if not isinstance(obfs, dict):
                raise AssetError("INVALID_FIELD")
            options["obfs"] = obfs
    return _clean(options)


def _uri(uri):
    if (
        len(uri.encode()) > MAX_BYTES
        or re.search(r"%(?![0-9a-fA-F]{2})", uri)
        or any(c.isspace() for c in uri)
    ):
        raise AssetError("INVALID_URI")
    u = urlsplit(uri)
    query = {}
    for key, value in parse_qsl(u.query, keep_blank_values=True, errors="strict"):
        if key in query:
            raise AssetError("DUPLICATE_FIELD")
        query[key] = value
    return u, query


def parse_shadowsocks(uri):
    try:
        u, query = _uri(uri)
        if u.scheme != "ss":
            raise AssetError("INVALID_URI")
        # Legacy full-authority Base64, plus modern SIP002 userinfo.
        if "@" not in u.netloc:
            if u.query:
                raise AssetError("INVALID_URI")
            authority = _decode64(u.netloc + u.path.rstrip("/")).decode("utf8")
            userinfo, separator, address = authority.rpartition("@")
            method, colon, password = userinfo.partition(":")
            if not separator or not colon:
                raise AssetError("INVALID_URI")
            u = urlsplit(
                "ss://"
                + quote(method, safe="")
                + ":"
                + quote(password, safe="")
                + "@"
                + address
                + ("#" + u.fragment if u.fragment else "")
            )
        if u.path not in ("", "/") or "@" not in u.netloc:
            raise AssetError("INVALID_URI")
        auth = u.netloc.rsplit("@", 1)[0]
        if ":" in auth:
            method, password = (unquote(v, errors="strict") for v in auth.split(":", 1))
        else:
            method, password = (
                _decode64(unquote(auth, errors="strict")).decode("utf8").split(":", 1)
            )
        options = {"cipher": _text(method, required=True)}
        plugin = _take(query, "plugin")
        if plugin is not MISSING:
            options["plugin"] = plugin_parts(plugin)
        return _normalize(
            protocol="shadowsocks",
            host=u.hostname,
            port=u.port,
            credential=password,
            name=unquote(u.fragment, errors="strict"),
            transport="tcp",
            security="none",
            protocol_options=options,
            extras=query,
            dialect="ss_uri",
        )
    except (ValueError, TypeError, UnicodeError):
        raise AssetError("INVALID_URI") from None


def parse_password_uri(uri):
    if uri.startswith("ss://"):
        return parse_shadowsocks(uri)
    try:
        u, query = _uri(uri)
        protocol = "hysteria2" if u.scheme == "hy2" else u.scheme
        if protocol not in ("trojan", "anytls", "hysteria2"):
            raise AssetError("UNSUPPORTED_PROTOCOL")
        if u.path not in ("", "/"):
            raise AssetError("INVALID_URI")
        if "@" not in u.netloc:
            raise AssetError("MISSING_FIELD")
        auth, authority = u.netloc.rsplit("@", 1)
        # Hysteria userpass uses the complete userinfo as its password.
        if protocol != "hysteria2" and ":" in auth:
            raise AssetError("INVALID_URI")
        password = unquote(auth, errors="strict")
        host_part, sep, port_part = authority.rpartition(":")
        ranges = MISSING
        if (
            protocol == "hysteria2"
            and sep
            and not authority.endswith("]")
            and any(c in port_part for c in ",-")
        ):
            ranges = ports(port_part)
            u = urlsplit(f"{u.scheme}://{host_part}:{ranges[0].split('-')[0]}")
        else:
            # This also validates IPv6 brackets and the ordinary numeric port.
            _ = u.port
        tls = {
            "sni": _text(_take(query, "sni", "peer", "serverName")),
            "alpn": _take(query, "alpn"),
            "insecure": _boolean(_take(query, "insecure", "allowInsecure")),
            "client_fingerprint": _text(_take(query, "fp")),
        }
        if tls["alpn"] is not MISSING:
            tls["alpn"] = tls["alpn"].split(",") if tls["alpn"] else []
        security = _take(query, "security", default="tls")
        reality = _clean(
            {"public_key": _text(_take(query, "pbk")), "short_id": _text(_take(query, "sid"))}
        )
        if reality:
            tls["reality"] = reality
        options = {"server_ports": ranges}
        transport = _take(query, "type", default="quic" if protocol == "hysteria2" else "tcp")
        transport_options = {
            "host": _text(_take(query, "host")),
            "path": _text(_take(query, "path")),
            "service_name": _text(_take(query, "serviceName")),
        }
        if protocol == "hysteria2":
            multi = _take(query, "mport")
            if multi is not MISSING:
                if ranges is not MISSING:
                    raise AssetError("CONFLICTING_FIELDS")
                options["server_ports"] = ranges = ports(multi)
            obfs = _take(query, "obfs")
            if obfs is not MISSING:
                options["obfs"] = {
                    "type": _text(obfs),
                    "password": _text(_take(query, "obfs-password"), required=True),
                }
        name = unquote(urlsplit(uri).fragment, errors="strict")
        port = (
            int(ranges[0].split("-")[0])
            if ranges is not MISSING
            else (u.port if u.port is not None else 443)
        )
        return _normalize(
            protocol=protocol,
            host=u.hostname,
            port=port,
            credential=password,
            name=name,
            transport=transport,
            security=security,
            tls=tls,
            transport_options=transport_options,
            protocol_options=_clean(options),
            extras=query,
            dialect=protocol + "_uri",
        )
    except (ValueError, TypeError, UnicodeError):
        raise AssetError("INVALID_URI") from None
