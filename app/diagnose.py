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
