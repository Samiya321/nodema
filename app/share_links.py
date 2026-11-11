"""Per-node share URIs for QR codes, computed once with the export converters.

The URI is stored without a display name; the Worker adds the current name when
the dashboard asks for it, so renumbering never makes stored links stale.
"""

import json

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import insert

from app.conversion import to_uri
from app.database.models import NodeShareLink
from app.domain import AssetError

BATCH = 2000


def share_uri(identity: dict) -> tuple[str | None, str | None]:
    """(uri, None) or (None, error_code) when the URI format cannot express the node."""
    try:
        uri = to_uri(identity, "")
    except AssetError as error:
        return None, error.code[:64]
    except (KeyError, TypeError, ValueError):
        return None, "SHARE_UNSUPPORTED"
    if len(uri) > 8192:
        return None, "SHARE_TOO_LONG"
    return uri, None


def fill_missing(sessions) -> dict:
    """Create share links for nodes that have none yet. Returns counts only."""
    created = unsupported = 0
    while True:
        with sessions.begin() as session:
            rows = session.execute(
                sa.text(
                    "SELECT n.id,n.config_data FROM nodes n "
                    "LEFT JOIN node_share_links l ON l.node_id=n.id "
                    "WHERE l.node_id IS NULL ORDER BY n.id LIMIT :limit"
                ),
                {"limit": BATCH},
            ).all()
            if not rows:
                break
            values = []
            for node_id, config in rows:
                uri, error = share_uri(json.loads(bytes(config)))
                values.append({"node_id": node_id, "uri": uri, "error_code": error})
                unsupported += error is not None
            session.execute(insert(NodeShareLink).values(values).on_conflict_do_nothing())
            created += len(values)
        if len(rows) < BATCH:
            break
    return {"created": created, "unsupported": unsupported}
