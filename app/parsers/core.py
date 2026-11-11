"""Pure format adapters. No I/O, execution, provider fetching, or runtime claims."""

import base64
import binascii
import copy
import ipaddress
import json
import math
import re
from urllib.parse import parse_qsl, unquote, urlsplit
from uuid import UUID

import yaml

from app.domain import (
    PASSWORD_PROTOCOLS,
    PROTOCOLS,
    AssetError,
    InputFormat,
    NormalizedNode,
    ParseIssue,
    ParseReport,
)

PARSER_VERSION = "protocols-v4"
MISSING = object()
MAX_BYTES = 10_485_760
# Item counts are not limited on their own: MAX_BYTES bounds every document, and a
# 10 MiB list holds at most ~100k share links. This only stops pathological inputs.
MAX_ITEMS = 200_000


def _take(data, *keys, default=MISSING):
    values = [data.pop(k) for k in keys if k in data]
    if values and any(v != values[0] for v in values[1:]):
        raise AssetError("CONFLICTING_FIELDS")
    return values[0] if values else default


def _text(value, *, required=False):
    if value is MISSING:
        if required:
            raise AssetError("MISSING_FIELD")
        return value
    if not isinstance(value, str) or any(ord(c) < 32 for c in value):
        raise AssetError("INVALID_FIELD")
    if required and not value:
        raise AssetError("MISSING_FIELD")
    return value


def _integer(value):
    if isinstance(value, bool) or not (
        isinstance(value, int) or isinstance(value, str) and value.isascii() and value.isdigit()
    ):
        raise AssetError("INVALID_INTEGER")
    try:
        return int(value)
    except ValueError:
        raise AssetError("INVALID_INTEGER") from None


def _boolean(value):
    if value is MISSING:
        return value
    if value is True or value == "true" or value == "1":
        return True
    if value is False or value == "false" or value == "0":
        return False
    raise AssetError("INVALID_BOOLEAN")


def _list(value):
    if value is MISSING:
        return value
    if isinstance(value, str):
        return value.split(",") if value else []
    if isinstance(value, list) and all(isinstance(v, str) for v in value):
        return value
    raise AssetError("INVALID_FIELD")


def _host(value):
    value = _text(value, required=True)
    if any(c in value for c in "/@%?#[]") or any(c.isspace() for c in value):
        raise AssetError("INVALID_HOST")
    try:
        return ipaddress.ip_address(value).compressed
    except ValueError:
        try:
            result = value.rstrip(".").encode("idna").decode("ascii").lower()
            if len(result) > 253 or not all(
                re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", p) for p in result.split(".")
            ):
                raise ValueError
            return result
        except (ValueError, UnicodeError):
            raise AssetError("INVALID_HOST") from None


def _json_value(value, depth=0):
    if depth > 64:
        raise AssetError("STRUCTURE_TOO_DEEP")
    if isinstance(value, dict):
        if not all(isinstance(k, str) for k in value):
            raise AssetError("INVALID_FIELD")
        for v in value.values():
            _json_value(v, depth + 1)
    elif isinstance(value, list):
        for v in value:
            _json_value(v, depth + 1)
    elif value is not None and not isinstance(value, (str, int, float, bool)):
        raise AssetError("INVALID_FIELD")
    elif isinstance(value, float) and not math.isfinite(value):
        raise AssetError("INVALID_FIELD")


def _clean(data):
    return {k: v for k, v in data.items() if v is not MISSING}


def _headers(data):
    if not isinstance(data, dict):
        raise AssetError("INVALID_FIELD")
    result = {}
    for key, value in data.items():
        folded = key.lower()
        if folded in result:
            raise AssetError("DUPLICATE_FIELD")
        result[folded] = value
    return result


def _normalize(
    *,
    protocol,
    host,
    port,
    credential,
    name,
    transport=MISSING,
    security=MISSING,
    tls=None,
    transport_options=None,
    protocol_options=None,
    extras=None,
    dialect="",
):
    port = _integer(port)
    if not 1 <= port <= 65535:
        raise AssetError("INVALID_PORT")
    credential_key = "password" if protocol in PASSWORD_PROTOCOLS else "uuid"
    if credential_key == "uuid":
        try:
            credential = str(UUID(_text(credential, required=True)))
        except (ValueError, AttributeError):
            raise AssetError("INVALID_UUID") from None
    else:
        credential = _text(credential, required=True)
    identity = _clean(
        {
            "protocol": protocol,
            "server_host": _host(host),
            "server_port": port,
            credential_key: credential,
            "transport": _text(transport),
            "security": _text(security),
            "tls": _clean(tls or {}),
            "transport_options": _clean(transport_options or {}),
            "protocol_options": _clean(protocol_options or {}),
        }
    )
    if extras:
        identity["extensions"] = {dialect: extras}
    _json_value(identity)
    return NormalizedNode(identity, "" if name is MISSING else _text(name))


def _decode64(value):
    try:
        raw = value.encode("ascii") if isinstance(value, str) else value
        raw = b"".join(raw.split())
        if len(raw) % 4 == 1:
            raise ValueError
        return base64.b64decode(raw + b"=" * (-len(raw) % 4), altchars=b"-_", validate=True)
    except (ValueError, binascii.Error, UnicodeError):
        raise AssetError("INVALID_BASE64") from None


def _strict_json(payload):
    def pairs(items):
        result = {}
        for k, v in items:
            if k in result:
                raise AssetError("DUPLICATE_FIELD")
            result[k] = v
        return result

    try:
        value = json.loads(
            payload,
            object_pairs_hook=pairs,
            parse_constant=lambda _: (_ for _ in ()).throw(ValueError()),
        )
        _json_value(value)
        return value
    except (ValueError, UnicodeError, RecursionError):
        raise AssetError("INVALID_JSON") from None


def parse_vless(uri: str) -> NormalizedNode:
    try:
        if len(uri.encode()) > MAX_BYTES or re.search(r"%(?![0-9A-Fa-f]{2})", uri):
            raise AssetError("INVALID_URI")
        u = urlsplit(uri)
        if u.scheme != "vless" or u.password is not None or u.path not in ("", "/"):
            raise AssetError("INVALID_URI")
        query = {}
        for k, v in parse_qsl(u.query, keep_blank_values=True, errors="strict"):
            if k in query:
                raise AssetError("DUPLICATE_FIELD")
            query[k] = v
        tls = {
            "sni": _text(_take(query, "sni", "serverName")),
            "alpn": _list(_take(query, "alpn")),
            "client_fingerprint": _text(_take(query, "fp")),
            "insecure": _boolean(_take(query, "allowInsecure")),
        }
        reality = _clean(
            {
                "public_key": _text(_take(query, "pbk")),
                "short_id": _text(_take(query, "sid")),
                "spider_x": _text(_take(query, "spx")),
            }
        )
        if reality:
            tls["reality"] = reality
        transport = _take(query, "type")
        security = _take(query, "security")
        transport_options = {
            "host": _text(_take(query, "host")),
            "path": _text(_take(query, "path")),
            "service_name": _text(_take(query, "serviceName")),
        }
        proto = {
            "flow": _text(_take(query, "flow")),
            "encryption": _text(_take(query, "encryption")),
        }
        return _normalize(
            protocol="vless",
            host=u.hostname,
            port=u.port,
            credential=unquote(u.username or ""),
            name=unquote(u.fragment, errors="strict"),
            transport=transport,
            security=security,
            tls=tls,
            transport_options=transport_options,
            protocol_options=proto,
            extras=query,
            dialect="vless_uri",
        )
    except (ValueError, UnicodeError, TypeError):
        raise AssetError("INVALID_URI") from None


def parse_vmess(uri: str) -> NormalizedNode:
    if not uri.startswith("vmess://") or len(uri.encode()) > MAX_BYTES:
        raise AssetError("INVALID_URI")
    data = _strict_json(_decode64(uri[8:]))
    if not isinstance(data, dict):
        raise AssetError("INVALID_STRUCTURE")
    data = copy.deepcopy(data)
    version = _take(data, "v")
    if version is not MISSING and str(version) not in ("2",):
        raise AssetError("UNSUPPORTED_SHARE_VERSION")
    name = _take(data, "ps")
    host, port, credential = (_take(data, k) for k in ("add", "port", "id"))
    transport, security = _take(data, "net"), _take(data, "tls")
    if security == "":
        security = "none"
    aid = _take(data, "aid")
    proto = {
        "alter_id": _integer(aid) if aid is not MISSING else MISSING,
        "cipher": _text(_take(data, "scy")),
    }
    tls = {
        "sni": _text(_take(data, "sni")),
        "alpn": _list(_take(data, "alpn")),
        "client_fingerprint": _text(_take(data, "fp")),
        "insecure": _boolean(_take(data, "allowInsecure")),
    }
    options = {
        "host": _text(_take(data, "host")),
        "path": _text(_take(data, "path")),
        "header_type": _text(_take(data, "type")),
    }
    return _normalize(
        protocol="vmess",
        host=host,
        port=port,
        credential=credential,
        name=name,
        transport=transport,
        security=security,
        tls=tls,
        protocol_options=proto,
        transport_options=options,
        extras=data,
        dialect="vmess_uri",
    )


class StrictLoader(yaml.SafeLoader):
    yaml_implicit_resolvers = copy.deepcopy(yaml.SafeLoader.yaml_implicit_resolvers)


# YAML 1.2 booleans; names such as ON and dates remain strings.
for _key, _resolvers in StrictLoader.yaml_implicit_resolvers.items():
    StrictLoader.yaml_implicit_resolvers[_key] = [
        (tag, regex)
        for tag, regex in _resolvers
        if tag not in ("tag:yaml.org,2002:bool", "tag:yaml.org,2002:timestamp")
    ]
StrictLoader.add_implicit_resolver(
    "tag:yaml.org,2002:bool", re.compile(r"^(?:true|false|True|False|TRUE|FALSE)$"), list("tTfF")
)


MERGE_TAG = "tag:yaml.org,2002:merge"


def _mapping(loader, node):
    """Mapping with YAML merge keys (`<<: *base` or `<<: [*a, *b]`), common in Clash
    files. Merged keys are defaults: explicit keys override them; an explicit key
    repeated in the same mapping is still an error."""
    merged, result = {}, {}
    for key, val in node.value:
        if key.tag == MERGE_TAG:
            sources = val.value if isinstance(val, yaml.SequenceNode) else [val]
            for source in sources:
                base = loader.construct_object(source, deep=True)
                if not isinstance(base, dict):
                    raise AssetError("INVALID_YAML_MERGE")
                for k, v in base.items():
                    merged.setdefault(k, v)  # earlier sources win, as in YAML 1.1
            continue
        k = loader.construct_object(key)
        if not isinstance(k, str) or k in result:
            raise AssetError("DUPLICATE_OR_INVALID_FIELD")
        result[k] = loader.construct_object(val)
    return {**merged, **result}


StrictLoader.add_constructor("tag:yaml.org,2002:map", _mapping)


# Anchors and aliases are allowed (Clash files use them for shared options), but the
# fully expanded document is measured from the event stream before anything is built:
# nested aliases ("billion laughs") would otherwise multiply on traversal.
MAX_YAML_EXPANDED_NODES = 2_000_000
MAX_YAML_ALIASES = 100_000


def _check_yaml_events(payload):
    depth, aliases = 0, 0
    sizes = {}  # anchor -> expanded node count of what it names
    stack = [[None, 0]]  # open collections: [anchor, expanded size so far]

    def add(size):
        stack[-1][1] += size
        if sum(entry[1] for entry in stack) > MAX_YAML_EXPANDED_NODES:
            raise AssetError("YAML_TOO_LARGE")

    for event in yaml.parse(payload, Loader=StrictLoader):
        if isinstance(event, yaml.AliasEvent):
            aliases += 1
            if aliases > MAX_YAML_ALIASES:
                raise AssetError("YAML_TOO_LARGE")
            if event.anchor not in sizes:
                # Unknown, or an ancestor still open: a recursive structure.
                raise AssetError("YAML_RECURSIVE_ALIAS")
            add(sizes[event.anchor])
        elif isinstance(event, yaml.ScalarEvent):
            if event.anchor is not None:
                sizes[event.anchor] = 1
            add(1)
        elif isinstance(event, (yaml.MappingStartEvent, yaml.SequenceStartEvent)):
            depth += 1
            if depth > 64:
                raise AssetError("STRUCTURE_TOO_DEEP")
            stack.append([event.anchor, 1])
        elif isinstance(event, (yaml.MappingEndEvent, yaml.SequenceEndEvent)):
            depth -= 1
            anchor, size = stack.pop()
            if anchor is not None:
                sizes[anchor] = size
            add(size)


def _yaml(payload):
    try:
        _check_yaml_events(payload)
        value = yaml.load(payload, Loader=StrictLoader)
        _json_value(value)
        return value
    except (yaml.YAMLError, UnicodeError, RecursionError, TypeError):
        raise AssetError("INVALID_YAML") from None


def _clash_item(item):
    d = copy.deepcopy(item)
    protocol = _take(d, "type")
    if not isinstance(protocol, str):
        raise AssetError("UNSUPPORTED_PROTOCOL")
    protocol = {"ss": "shadowsocks", "hy2": "hysteria2"}.get(protocol, protocol)
    if protocol not in PROTOCOLS:
        raise AssetError("UNSUPPORTED_PROTOCOL")
    if "dialer-proxy" in d:
        raise AssetError("UNSUPPORTED_DEPENDENCY")
    name = _take(d, "name")
    host, port = (_take(d, k) for k in ("server", "port"))
    credential = _take(d, "password" if protocol in PASSWORD_PROTOCOLS else "uuid")
    default_transport = (
        "quic" if protocol == "hysteria2" else "tcp" if protocol in PASSWORD_PROTOCOLS else MISSING
    )
    transport = _take(d, "network", default=default_transport)
    default_tls = protocol != "shadowsocks" if protocol in PASSWORD_PROTOCOLS else MISSING
    tls_enabled = _boolean(_take(d, "tls", default=default_tls))
    reality = _take(d, "reality-opts")
    security = ("tls" if tls_enabled else "none") if tls_enabled is not MISSING else MISSING
    tls = {
        "sni": _text(_take(d, "servername", "sni")),
        "alpn": _list(_take(d, "alpn")),
        "client_fingerprint": _text(_take(d, "client-fingerprint")),
        "insecure": _boolean(_take(d, "skip-cert-verify")),
    }
    if reality is not MISSING:
        if not isinstance(reality, dict):
            raise AssetError("INVALID_FIELD")
        if tls_enabled is not True:
            raise AssetError("REALITY_REQUIRES_TLS")
        security = "reality"
        reality = copy.deepcopy(reality)
        tls["reality"] = _clean(
            {
                "public_key": _text(_take(reality, "public-key")),
                "short_id": _text(_take(reality, "short-id")),
            }
        )
        if reality:
            d["reality-opts"] = reality
    options = {}
    ws = _take(d, "ws-opts")
    if ws is not MISSING:
        if not isinstance(ws, dict):
            raise AssetError("INVALID_FIELD")
        ws = copy.deepcopy(ws)
        options["path"] = _text(_take(ws, "path"))
        headers = _take(ws, "headers")
        if headers is not MISSING:
            headers = _headers(headers)
            options["host"] = _text(_take(headers, "host"))
            if headers:
                options["headers"] = headers
        if ws:
            d["ws-opts"] = ws
    grpc = _take(d, "grpc-opts")
    if grpc is not MISSING:
        if not isinstance(grpc, dict):
            raise AssetError("INVALID_FIELD")
        grpc = copy.deepcopy(grpc)
        options["service_name"] = _text(_take(grpc, "grpc-service-name"))
        if grpc:
            d["grpc-opts"] = grpc
    proto = {"flow": _text(_take(d, "flow")), "encryption": _text(_take(d, "encryption"))}
    if protocol == "vmess":
        aid = _take(d, "alterId")
        proto.update(
            {
                "alter_id": _integer(aid) if aid is not MISSING else MISSING,
                "cipher": _text(_take(d, "cipher")),
            }
        )
    if protocol in PASSWORD_PROTOCOLS:
        from app.parsers.passwords import clash_options

        # flow/encryption do not belong to these protocols: preserve rather than discard.
        if _clean(proto):
            d["unsupported_protocol_options"] = _clean(proto)
        proto = clash_options(d, protocol)
        if "server_ports" in proto:
            port = int(proto["server_ports"][0].split("-")[0])
    return _normalize(
        protocol=protocol,
        host=host,
        port=port,
        credential=credential,
        name=name,
        transport=transport,
        security=security,
        tls=tls,
        transport_options=options,
        protocol_options=proto,
        extras=d,
        dialect="clash",
    )


def _singbox_item(item):
    d = copy.deepcopy(item)
    protocol = _take(d, "type")
    if protocol in ("direct", "block", "dns", "selector", "urltest"):
        return None
    if protocol not in PROTOCOLS:
        raise AssetError("UNSUPPORTED_PROTOCOL")
    if "detour" in d:
        raise AssetError("UNSUPPORTED_DEPENDENCY")
    name = _take(d, "tag")
    host, port = (_take(d, k) for k in ("server", "server_port"))
    credential = _take(d, "password" if protocol in PASSWORD_PROTOCOLS else "uuid")
    tls_data = _take(d, "tls")
    security, tls = MISSING, {}
    if tls_data is not MISSING:
        if not isinstance(tls_data, dict):
            raise AssetError("INVALID_FIELD")
        tls_data = copy.deepcopy(tls_data)
        enabled = _boolean(_take(tls_data, "enabled"))
        security = ("tls" if enabled else "none") if enabled is not MISSING else MISSING
        tls = {
            "sni": _text(_take(tls_data, "server_name")),
            "alpn": _list(_take(tls_data, "alpn")),
            "insecure": _boolean(_take(tls_data, "insecure")),
        }
        utls = _take(tls_data, "utls")
        if utls is not MISSING:
            if not isinstance(utls, dict):
                raise AssetError("INVALID_FIELD")
            utls = copy.deepcopy(utls)
            utls_enabled = _boolean(_take(utls, "enabled"))
            if utls_enabled is True:
                client_fingerprint = _text(_take(utls, "fingerprint"))
                if client_fingerprint is MISSING:
                    tls["utls_enabled"] = True
                else:
                    tls["client_fingerprint"] = client_fingerprint
            elif utls_enabled is not MISSING:
                utls["enabled"] = utls_enabled
            if utls:
                tls_data["utls"] = utls
        reality = _take(tls_data, "reality")
        if reality is not MISSING:
            if not isinstance(reality, dict):
                raise AssetError("INVALID_FIELD")
            reality = copy.deepcopy(reality)
            reality_enabled = _take(reality, "enabled")
            if reality_enabled is True:
                if enabled is not True:
                    raise AssetError("REALITY_REQUIRES_TLS")
                security = "reality"
                tls["reality"] = reality
            else:
                tls_data["reality"] = _clean({"enabled": reality_enabled, **reality})
        if tls_data:
            d["tls"] = tls_data
    transport_data = _take(d, "transport")
    transport, options = MISSING, {}
    if transport_data is not MISSING:
        if not isinstance(transport_data, dict):
            raise AssetError("INVALID_FIELD")
        transport_data = copy.deepcopy(transport_data)
        transport = _take(transport_data, "type")
        options = {
            "path": _text(_take(transport_data, "path")),
            "service_name": _text(_take(transport_data, "service_name")),
        }
        headers = _take(transport_data, "headers")
        if headers is not MISSING:
            headers = _headers(headers)
            host_header = _take(headers, "host")
            if isinstance(host_header, list) and len(host_header) == 1:
                host_header = host_header[0]
            options["host"] = _text(host_header)
            if headers:
                options["headers"] = headers
        if transport_data:
            d["transport"] = transport_data
    proto = {"flow": _text(_take(d, "flow"))}
    if protocol == "vmess":
        aid = _take(d, "alter_id")
        proto.update(
            {
                "alter_id": _integer(aid) if aid is not MISSING else MISSING,
                "cipher": _text(_take(d, "security")),
            }
        )
    # sing-box network is allowed payload networks, NOT V2Ray transport.
    network = _take(d, "network")
    if network is not MISSING:
        proto["allowed_network"] = _text(network)
    if protocol in PASSWORD_PROTOCOLS:
        from app.parsers.passwords import singbox_options

        known = singbox_options(d, protocol)
        if "flow" in proto and proto["flow"] is not MISSING:
            d["unsupported_flow"] = proto["flow"]
        if "allowed_network" in proto:
            known["allowed_network"] = proto["allowed_network"]
        proto = known
        if transport is MISSING:
            transport = "quic" if protocol == "hysteria2" else "tcp"
        if security is MISSING:
            # Unlike share URIs/Mihomo's implicit TLS protocols, sing-box's
            # TLS enabled flag defaults to false. Never silently enable TLS.
            security = "none"
        if "server_ports" in proto:
            port = int(proto["server_ports"][0].split("-")[0])
    return _normalize(
        protocol=protocol,
        host=host,
        port=port,
        credential=credential,
        name=name,
        transport=transport,
        security=security,
        tls=tls,
        transport_options=options,
        protocol_options=proto,
        extras=d,
        dialect="singbox",
    )


def _items_report(items, adapter, max_items):
    if not isinstance(items, list):
        raise AssetError("INVALID_STRUCTURE")
    if len(items) > max_items:
        raise AssetError("TOO_MANY_ITEMS")
    report = ParseReport()
    for ordinal, item in enumerate(items, 1):
        try:
            if not isinstance(item, dict):
                raise AssetError("INVALID_STRUCTURE")
            node = adapter(item)
            if node is None:
                report.ignored_count += 1
            else:
                report.nodes.append(node)
        except AssetError as e:
            report.issues.append(ParseIssue(e.code, ordinal))
    return report


def parse_clash_yaml(payload: bytes, *, max_items=MAX_ITEMS) -> ParseReport:
    if len(payload) > MAX_BYTES:
        raise AssetError("INPUT_TOO_LARGE")
    root = _yaml(payload)
    if not isinstance(root, dict) or "proxies" not in root:
        raise AssetError("INVALID_STRUCTURE")
    return _items_report(root["proxies"], _clash_item, max_items)


def parse_singbox_json(payload: bytes, *, max_items=MAX_ITEMS) -> ParseReport:
    if len(payload) > MAX_BYTES:
        raise AssetError("INPUT_TOO_LARGE")
    root = _strict_json(payload)
    if not isinstance(root, dict) or "outbounds" not in root:
        raise AssetError("INVALID_STRUCTURE")
    return _items_report(root["outbounds"], _singbox_item, max_items)


def parse_document(
    payload: bytes, format_hint=InputFormat.AUTO, *, max_bytes=MAX_BYTES, max_items=MAX_ITEMS
) -> ParseReport:
    if len(payload) > min(max_bytes, MAX_BYTES):
        raise AssetError("INPUT_TOO_LARGE")
    try:
        text = payload.decode("utf-8-sig").strip()
    except UnicodeError:
        raise AssetError("INVALID_ENCODING") from None
    if not text:
        raise AssetError("EMPTY_INPUT")
    if format_hint == InputFormat.SINGBOX or (
        format_hint == InputFormat.AUTO and text.startswith("{")
    ):
        return parse_singbox_json(text.encode(), max_items=max_items)
    if format_hint == InputFormat.CLASH or (
        format_hint == InputFormat.AUTO and re.search(r"(?m)^proxies\s*:", text)
    ):
        return parse_clash_yaml(text.encode(), max_items=max_items)
    if format_hint in (InputFormat.AUTO, InputFormat.URI):
        from app.parsers.proxy_lists import looks_like_proxy_list, parse_proxy_list

        if looks_like_proxy_list(text):
            return parse_proxy_list(text, max_items=max_items)
    if format_hint == InputFormat.BASE64 or (format_hint == InputFormat.AUTO and "://" not in text):
        # Only one subscription envelope; never recursive auto-decoding.
        return parse_document(
            _decode64(text), InputFormat.URI, max_bytes=max_bytes, max_items=max_items
        )
    lines = [
        line.strip()
        for line in text.splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    if not lines:
        raise AssetError("EMPTY_INPUT")
    if len(lines) > max_items:
        raise AssetError("TOO_MANY_ITEMS")
    report = ParseReport()
    for ordinal, line in enumerate(lines, 1):
        try:
            if line.startswith("vless://"):
                node = parse_vless(line)
            elif line.startswith("vmess://"):
                node = parse_vmess(line)
            else:
                from app.parsers.passwords import parse_password_uri

                node = parse_password_uri(line)
            report.nodes.append(node)
        except AssetError as e:
            report.issues.append(ParseIssue(e.code, ordinal))
    return report
