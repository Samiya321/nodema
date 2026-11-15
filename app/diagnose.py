"""Why nodes cannot be tested: counts of conversion rejection reasons.

Read-only. Output holds protocol names, field names and counts only (never values),
so it is safe in public Actions logs.
"""

import json
from collections import Counter

import sqlalchemy as sa

from app.conversion import to_mihomo
from app.domain import AssetError, Unsupported

BATCH = 1000


def unsupported_reasons(sessions, *, limit: int = 30) -> dict:
    """Re-run the runtime conversion for every node whose current status is UNSUPPORTED."""
    reasons: Counter = Counter()
    total = 0
    query = sa.text(
        "SELECT n.protocol, n.config_data FROM nodes n"
        " JOIN node_current_status c ON c.node_id=n.id"
        " WHERE c.status='UNSUPPORTED' AND n.enabled"
    )
    with sessions() as session:
        for row in session.execute(query.execution_options(yield_per=BATCH)):
            total += 1
            reasons[(row.protocol, _reason(row.config_data))] += 1
    return {
        "nodes": total,
        "reasons": [
            {"protocol": protocol, "reason": reason, "nodes": count}
            for (protocol, reason), count in reasons.most_common(limit)
        ],
        "other_reasons": sum(reasons.values()) - sum(c for _, c in reasons.most_common(limit)),
    }


def _reason(config_data) -> str:
    try:
        to_mihomo(json.loads(bytes(config_data)), "diagnose")
    except Unsupported as error:
        return error.reason
    except AssetError as error:
        return "error:" + error.code
    except (KeyError, TypeError, ValueError):
        return "malformed"
    return "convertible_now"  # rejected earlier by an older converter; a retest fixes it


def _features(identity: dict) -> list[str]:
    """Which new conversion mappings a node relies on (labels only)."""
    from app.compat import compatible

    d = compatible(identity)
    tls, options = d.get("tls", {}), d.get("transport_options", {})
    found = []
    if identity.get("transport") == "raw":
        found.append("raw")
    if options.get("header_type") == "http":
        found.append("tcp_http_header")
    if "spider_x" in tls.get("reality", {}):
        found.append("reality_spider_x")
    return found or ["baseline"]


def mapping_outcomes(sessions, *, hours: int = 30) -> dict:
    """Recently checked nodes by new mapping: UP vs DOWN and the top DOWN error codes.
    A mapping that is systematically wrong shows as near 0% UP with its own errors."""
    stats: dict = {}
    query = sa.text(
        "SELECT n.config_data, c.status, c.last_error_code FROM nodes n"
        " JOIN node_current_status c ON c.node_id=n.id"
        " WHERE n.enabled AND c.status IN ('UP','DEGRADED','DOWN')"
        " AND c.last_checked_at > now() - make_interval(hours => :hours)"
    )
    with sessions() as session:
        for row in session.execute(query.execution_options(yield_per=BATCH), {"hours": hours}):
            try:
                features = _features(json.loads(bytes(row.config_data)))
            except (KeyError, TypeError, ValueError):
                continue
            for feature in features:
                entry = stats.setdefault(feature, {"up": 0, "down": 0, "errors": Counter()})
                if row.status == "DOWN":
                    entry["down"] += 1
                    entry["errors"][row.last_error_code or "none"] += 1
                else:
                    entry["up"] += 1
    return {
        feature: {
            "up": e["up"],
            "down": e["down"],
            "up_ratio": round(e["up"] / (e["up"] + e["down"]), 3),
            "down_errors": dict(e["errors"].most_common(5)),
        }
        for feature, e in sorted(stats.items())
    }


def unsupported_protocol_names(sessions) -> dict:
    """Protocol names the parser could not read, summed over sources' last parse."""
    query = sa.text(
        "SELECT p.key, sum(p.value::bigint) AS n FROM sources s,"
        " jsonb_each_text(coalesce(s.last_parse_summary->'unsupported_protocols','{}')) p"
        " WHERE s.deleted_at IS NULL GROUP BY p.key ORDER BY n DESC LIMIT 40"
    )
    with sessions() as session:
        return {row.key: int(row.n) for row in session.execute(query)}
