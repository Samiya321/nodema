"""Independent adapters for Loon, Surge and Quantumult X proxy declarations.

Format references and the upstream implementations consulted are listed in
docs/PARSER_REFERENCES.md. No upstream service or executable is run here.
"""

import re
from urllib.parse import urlsplit

from app.domain import AssetError, ParseIssue, ParseReport

PROTOCOL_NAMES = {
    "ss",
    "shadowsocks",
    "vmess",
    "vless",
    "trojan",
    "anytls",
    "hysteria2",
    "hy2",
    "socks5",
    "socks",
    "http",
    "https",
    "snell",
    "tuic",
    "tuic-v5",
    "ssr",
    "shadowsocksr",
}


def looks_like_proxy_list(text):
    for line in text.splitlines():
        if re.match(r"^\s*\[(?:Proxy|server_local)\]\s*$", line, re.I):
            return True
        try:
            left, right = _assignment(line)
        except AssetError:
            continue
        if left.strip().lower() in PROTOCOL_NAMES:
            return True
        if right.split(",", 1)[0].strip().lower() in PROTOCOL_NAMES:
            return True
    return False


def _tokens(text, delimiter=",", quote_after="="):
    result, buffer, quote = [], [], None
    quote_allowed = True
    index = 0
    while index < len(text):
        char = text[index]
        if quote:
            buffer.append(char)
            if char == "\\" and index + 1 < len(text):
                index += 1
                buffer.append(text[index])
            elif char == quote:
                quote = None
        elif char in ('"', "'") and quote_allowed:
            quote = char
            quote_allowed = False
            buffer.append(char)
        elif char == delimiter:
            result.append("".join(buffer).strip())
            buffer = []
            quote_allowed = True
        else:
            buffer.append(char)
            if not char.isspace():
                quote_allowed = char in quote_after
        index += 1
    if quote:
        raise AssetError("INVALID_PROXY_LINE")
    result.append("".join(buffer).strip())
    return result


def _value(value):
    value = value.strip()
    if value[:1] in ('"', "'"):
        if len(value) < 2 or value[-1] != value[0]:
            raise AssetError("INVALID_PROXY_LINE")
        quote = value[0]
        raw, result, index = value[1:-1], [], 0
        while index < len(raw):
            char = raw[index]
            if char == "\\" and index + 1 < len(raw) and raw[index + 1] in (quote, "\\"):
                index += 1
                char = raw[index]
            elif char == quote:
                raise AssetError("INVALID_PROXY_LINE")
            result.append(char)
            index += 1
        value = "".join(result)
    if any(ord(char) < 32 for char in value):
        raise AssetError("INVALID_FIELD")
    return value


def _assignment(text):
    """Split the declaration at an unquoted equals sign (names may contain '=')."""
    quote, escaped = None, False
    quote_start = len(text) - len(text.lstrip())
    for index, char in enumerate(text):
        if escaped:
            escaped = False
        elif quote and char == "\\":
            escaped = True
        elif quote and char == quote:
            quote = None
        elif not quote and char in ('"', "'") and index == quote_start:
            quote = char
        elif not quote and char == "=":
            return text[:index], text[index + 1 :]
    raise AssetError("INVALID_PROXY_LINE")


def _options(tokens, *, comma_password=False):
    result, previous = {}, None
    for token in tokens:
        name, sep, value = token.partition("=")
        if not sep:
            # QX allows an unquoted comma in a password. An actual option has '='.
            if comma_password and previous == "password":
                result[previous] += "," + token
                continue
            raise AssetError("INVALID_PROXY_LINE")
        name = name.strip().lower()
        if not name or name in result:
            raise AssetError("DUPLICATE_FIELD")
        # Surge exports may wrap the full header list in quotes while also
        # quoting each header value: ws-headers="Host:"ws.example"".
        # Remove only that list wrapper; parse individual quotes with headers.
        if name == "ws-headers":
            value = value.strip()
            if value[:1] in ('"', "'") and not value.split(":", 1)[0].endswith(value[0]):
                if len(value) < 2 or value[-1] != value[0]:
                    raise AssetError("INVALID_HEADERS")
                value = value[1:-1]
            result[name] = value
        else:
            result[name] = _value(value)
        previous = name
    return result


def _flag(value):
    if not isinstance(value, str) or value.lower() not in {"true", "false", "1", "0"}:
        raise AssetError("INVALID_BOOLEAN")
    return value.lower() in {"true", "1"}


def _one(options, *names, default=None):
    values = [options.pop(name) for name in names if name in options]
    if values and any(v != values[0] for v in values[1:]):
        raise AssetError("CONFLICTING_FIELDS")
    return values[0] if values else default


def _line(text):
    from app.parsers.core import _clash_item

    tokens = _tokens(text)
    tag, first = _assignment(tokens.pop(0))
    tag, first = _value(tag), first.strip()
    qx = tag.lower() in PROTOCOL_NAMES and first.split(",", 1)[0].lower() not in PROTOCOL_NAMES
    if qx:
        protocol, dialect = tag.lower(), "quantumult_x"
        try:
            address = urlsplit("https://" + first)
            host, port = address.hostname, address.port
            if (
                address.username
                or address.password
                or address.path
                or address.query
                or address.fragment
            ):
                raise ValueError
        except ValueError:
            raise AssetError("INVALID_PROXY_LINE") from None
        options = _options(tokens, comma_password=True)
        tag = options.pop("tag", "Imported node")
        positional = []
    else:
        protocol = first.lower()
        if protocol in {"direct", "reject", "reject-tinygif"}:
            return None
        if len(tokens) < 2:
            raise AssetError("INVALID_PROXY_LINE")
        host, port = (_value(tokens.pop(0)), _value(tokens.pop(0)))
        positional = []
        while tokens and ("=" not in tokens[0] or tokens[0].startswith(('"', "'"))):
            positional.append(_value(tokens.pop(0)))
        options = _options(tokens)
        dialect = "loon" if positional else "surge"
    protocol = {"shadowsocks": "ss", "hy2": "hysteria2"}.get(protocol, protocol)
    if protocol not in {"ss", "vmess", "vless", "trojan", "anytls", "hysteria2"}:
        raise AssetError("UNSUPPORTED_PROTOCOL")
    if any(key in options for key in ("underlying-proxy", "dialer-proxy", "detour")):
        raise AssetError("UNSUPPORTED_DEPENDENCY")
    data = {"name": tag, "type": protocol, "server": host, "port": port}
    if protocol in {"vmess", "vless"}:
        if dialect == "loon":
            expected = 2 if protocol == "vmess" else 1
            if len(positional) != expected:
                raise AssetError("INVALID_PROXY_LINE")
            data["uuid"] = positional[-1]
            if protocol == "vmess":
                data["cipher"] = positional[0]
        else:
            data["uuid"] = _one(options, "username", "password", "uuid")
        if protocol == "vmess":
            cipher = _one(options, "encrypt-method", "method")
            if cipher is not None and "cipher" in data and cipher != data["cipher"]:
                raise AssetError("CONFLICTING_FIELDS")
            data.setdefault("cipher", cipher or ("none" if qx else "aes-128-gcm"))
            data["cipher"] = {"chacha20-ietf-poly1305": "chacha20-poly1305"}.get(
                data["cipher"], data["cipher"]
            )
            aid = _one(options, "alterid", "alter-id")
            aead = _one(options, "vmess-aead", "aead")
            if aid is not None and aead is not None and (int(aid) == 0) != _flag(aead):
                raise AssetError("CONFLICTING_FIELDS")
            # Surge defaults to the legacy handshake; Loon/QX default to AEAD.
            enabled = _flag(aead) if aead is not None else dialect != "surge"
            data["alterId"] = aid if aid is not None else (0 if enabled else 1)
        else:
            flow = _one(options, "flow", "vless-flow")
            if flow is not None:
                data["flow"] = flow
    else:
        if dialect == "loon":
            expected = 2 if protocol == "ss" else 1
            if len(positional) != expected:
                raise AssetError("INVALID_PROXY_LINE")
            data["password"] = positional[-1]
            if protocol == "ss":
                data["cipher"] = positional[0]
        else:
            data["password"] = _one(options, "password")
            if protocol == "ss":
                data["cipher"] = _one(options, "encrypt-method", "method")
    transport = options.pop("transport", "tcp")
    if "ws" in options:
        ws = _flag(options.pop("ws"))
        if transport not in {"tcp", "ws"} or transport == "ws" and not ws:
            raise AssetError("CONFLICTING_FIELDS")
        transport = "ws" if ws else "tcp"
    obfs = options.pop("obfs", None)
    tls = _one(options, "tls", "over-tls")
    if obfs in {"ws", "wss", "over-tls"}:
        transport = "ws" if obfs != "over-tls" else "tcp"
        if obfs != "ws":
            if tls is not None and not _flag(tls):
                raise AssetError("CONFLICTING_FIELDS")
            tls = "true"
    elif obfs is not None:
        options["obfs"] = obfs
    data["network"] = "quic" if protocol == "hysteria2" else transport
    data["tls"] = _flag(tls) if tls is not None else protocol in {"trojan", "anytls", "hysteria2"}
    sni = _one(options, "sni", "tls-name", "tls-host")
    if sni is not None:
        data["sni"] = sni
    alpn = options.pop("alpn", None)
    if alpn is not None:
        data["alpn"] = [value.strip() for value in alpn.split(",")]
    insecure, verify = options.pop("skip-cert-verify", None), options.pop("tls-verification", None)
    if insecure is not None and verify is not None and _flag(insecure) == _flag(verify):
        raise AssetError("CONFLICTING_FIELDS")
    if insecure is not None or verify is not None:
        data["skip-cert-verify"] = _flag(insecure) if insecure is not None else not _flag(verify)
    path = _one(options, "ws-path", "path", "obfs-uri")
    host_header = _one(options, "host", "obfs-host")
    raw_headers = options.pop("ws-headers", None)
    if transport == "ws":
        headers = {}
        if raw_headers is not None:
            for pair in _tokens(raw_headers, "|", quote_after="=:"):
                key, sep, value = pair.partition(":")
                key = _value(key)
                if not sep or key.lower() in {k.lower() for k in headers}:
                    raise AssetError("INVALID_HEADERS")
                headers[key] = _value(value)
        if host_header is not None:
            if any(k.lower() == "host" and v != host_header for k, v in headers.items()):
                raise AssetError("CONFLICTING_FIELDS")
            headers["Host"] = host_header
        data["ws-opts"] = {
            **({"path": path} if path is not None else {}),
            **({"headers": headers} if headers else {}),
        }
    elif raw_headers is not None:
        options["ws-headers"] = raw_headers
    public_key = _one(options, "public-key", "reality-base64-pubkey")
    short_id = _one(options, "short-id", "reality-hex-shortid")
    if public_key is not None or short_id is not None:
        data["reality-opts"] = {
            **({"public-key": public_key} if public_key is not None else {}),
            **({"short-id": short_id} if short_id is not None else {}),
        }
    for aliases, target in ((("udp", "udp-relay"), "udp"), (("tfo", "fast-open"), "tfo")):
        value = _one(options, *aliases)
        if value is not None:
            data[target] = _flag(value)
    if protocol == "anytls":
        for key in ("idle-session-check-interval", "idle-session-timeout", "min-idle-session"):
            if key in options:
                data[key] = options.pop(key)
    if protocol == "hysteria2":
        for source, target in (
            ("server-ports", "ports"),
            ("hop-interval", "hop-interval"),
            ("download-bandwidth", "down"),
        ):
            if source in options:
                data[target] = options.pop(source)
        if "salamander-password" in options:
            data["obfs"], data["obfs-password"] = "salamander", options.pop("salamander-password")
    node = _clash_item(data)
    if options:
        node.identity.setdefault("extensions", {})[dialect] = options
    return node


def parse_proxy_list(text, *, max_items=10000):
    report, section = ParseReport(), None
    has_sections = bool(re.search(r"(?m)^\s*\[[^]\r\n]+\]\s*$", text))
    count = 0
    for ordinal, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith(("#", ";", "//")):
            continue
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1].strip().lower()
            continue
        if has_sections and section not in {"proxy", "server_local"}:
            continue
        count += 1
        if count > max_items:
            raise AssetError("TOO_MANY_ITEMS")
        try:
            node = _line(line)
            if node is None:
                report.ignored_count += 1
            else:
                report.nodes.append(node)
        except AssetError as error:
            report.issues.append(ParseIssue(error.code, ordinal))
        except (ValueError, TypeError, IndexError):
            report.issues.append(ParseIssue("INVALID_PROXY_LINE", ordinal))
    if not count:
        raise AssetError("EMPTY_INPUT")
    return report
