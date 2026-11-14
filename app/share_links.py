"""Per-node share URIs for QR codes, computed once with the export converters.

The URI is stored without a display name; the Worker adds the current name when
the dashboard asks for it, so renumbering never makes stored links stale.

Subscriptions stay lossless, but a QR code is for trying a node on a phone: when
the strict converter refuses, settings a share link cannot carry are left out and
recorded in ``omitted`` so the dashboard can say exactly what to set by hand.
"""

import copy
import json

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import insert

from app.conversion import to_uri
from app.database.models import NodeShareLink
from app.domain import AssetError

BATCH = 2000
BANDWIDTH = ("up_mbps", "down_mbps", "hop_seconds")
# AnyTLS session-pool tuning: client-side only, absent from share links.
SESSION_TUNING = ("idle_check_seconds", "idle_timeout_seconds", "min_idle_session")


def relaxed(identity: dict) -> tuple[dict, list[str]]:
    """Copy without settings URIs cannot express, plus the codes of what was removed."""
    node, omitted = copy.deepcopy(identity), []
    if node.pop("extensions", None):
        omitted.append("CLIENT_OPTIONS")  # e.g. Clash "udp", "ecn"
    options = node.get("protocol_options", {})
    if node["protocol"] == "hysteria2" and any(k in options for k in BANDWIDTH):
        for key in BANDWIDTH:
            options.pop(key, None)
        omitted.append("BANDWIDTH")
    transport = node.get("transport_options", {})
    headers = transport.pop("headers", None) or {}
    # Sub-Store/Clash add a User-Agent to WebSocket nodes; a share link has no field
    # for headers. A Host header still has one: keep it as the transport host.
    extra = {k: v for k, v in headers.items() if k.lower() != "host"}
    host = next((v for k, v in headers.items() if k.lower() == "host"), None)
    if host and "host" not in transport:
        transport["host"] = host
    if extra:
        omitted.append("HEADERS")
    if node["protocol"] == "anytls" and any(k in options for k in SESSION_TUNING):
        for key in SESSION_TUNING:
            options.pop(key, None)
        omitted.append("SESSION_OPTIONS")
    if node.get("security") in (None, "none") and node["protocol"] == "shadowsocks":
        node.pop("tls", None)  # certificate settings mean nothing without TLS
    tls = node.get("tls", {})
    if node["protocol"] == "vmess" and "insecure" in tls:
        # The VMess share format has no agreed field for skipping certificate checks.
        if tls.pop("insecure"):
            omitted.append("SKIP_CERT_VERIFY")
    return node, omitted


def _convert(identity: dict) -> tuple[str | None, str | None]:
    try:
        uri = to_uri(identity, "")
    except AssetError as error:
        return None, error.code[:64]
    except (KeyError, TypeError, ValueError):
        return None, "SHARE_UNSUPPORTED"
    if len(uri) > 8192:
        return None, "SHARE_TOO_LONG"
    return uri, None


def share_uri(identity: dict) -> tuple[str | None, str | None, list[str]]:
    """(uri, None, omitted) or (None, error_code, [])."""
    uri, error = _convert(identity)
    if uri:
        return uri, None, []
    node, omitted = relaxed(identity)
    if node == identity:
        return None, error, []
    uri, relaxed_error = _convert(node)
    return (uri, None, omitted) if uri else (None, relaxed_error, [])


def fill_missing(sessions) -> dict:
    """Create share links for nodes without one, and retry nodes whose earlier attempt
    failed (converters gain support over time). Returns counts only."""
    created = unsupported = partial = 0
    after = None
    while True:
        with sessions.begin() as session:
            rows = session.execute(
                sa.text(
                    "SELECT n.id,n.config_data FROM nodes n "
                    "LEFT JOIN node_share_links l ON l.node_id=n.id "
                    "WHERE (l.node_id IS NULL OR l.error_code IS NOT NULL) "
                    "AND (CAST(:after AS uuid) IS NULL OR n.id > CAST(:after AS uuid)) "
                    "ORDER BY n.id LIMIT :limit"
                ),
                {"limit": BATCH, "after": after},
            ).all()
            if not rows:
                break
            after = str(rows[-1][0])
            values = []
            for node_id, config in rows:
                uri, error, omitted = share_uri(json.loads(bytes(config)))
                values.append(
                    {
                        "node_id": node_id,
                        "uri": uri,
                        "error_code": error,
                        "omitted": ",".join(omitted) or None,
                    }
                )
                unsupported += error is not None
                partial += bool(omitted)
            statement = insert(NodeShareLink).values(values)
            session.execute(
                statement.on_conflict_do_update(
                    index_elements=[NodeShareLink.node_id],
                    set_={
                        "uri": statement.excluded.uri,
                        "error_code": statement.excluded.error_code,
                        "omitted": statement.excluded.omitted,
                    },
                    # Links that already exist are never rewritten.
                    where=NodeShareLink.error_code.is_not(None),
                )
            )
            created += len(values)
        if len(rows) < BATCH:
            break
    return {"created": created, "unsupported": unsupported, "partial": partial}
