"""Plain database payloads and durable lifetime availability counters."""

import base64
import os
from pathlib import Path

import sqlalchemy as sa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from alembic import op

revision = "0009_plaintext_lifetime"
down_revision = "0008_export_projection"
branch_labels = depends_on = None

FIELDS = {
    "sources": (("id",), (("url", "sources:{id}:url"), ("payload", "sources:{id}:payload"))),
    "nodes": (("id",), (("config", "nodes:{id}:config"),)),
    "node_sources": (
        ("node_id", "source_id"),
        (("aliases", "node_sources:{node_id}:{source_id}:aliases"),),
    ),
    "node_annotations": (("node_id",), (("reference", "node_annotations:{node_id}:reference"),)),
    "export_artifacts": (("id",), (("payload", "exports:{id}:payload"),)),
}


def transform(encrypt=False):
    """Locked, bounded conversion; a missing/wrong old key rolls back the migration."""
    bind = op.get_bind()
    bind.execute(sa.text("LOCK TABLE " + ",".join(FIELDS) + " IN ACCESS EXCLUSIVE MODE"))
    aes = None
    for table, (keys, fields) in FIELDS.items():
        columns = [field + ("_data" if encrypt else "_encrypted") for field, _ in fields]
        offset = 0
        while True:
            records = (
                bind.execute(
                    sa.text(
                        f"SELECT {','.join(keys + tuple(columns))} FROM {table} "
                        f"ORDER BY {','.join(keys)} LIMIT 250 OFFSET :offset"
                    ),
                    {"offset": offset},
                )
                .mappings()
                .all()
            )
            if not records:
                break
            for record in records:
                values = {key: record[key] for key in keys}
                for column, (_, context) in zip(columns, fields, strict=True):
                    if record[column] is None:
                        continue
                    try:
                        if aes is None:
                            key = base64.b64decode(
                                os.environ.get("ENCRYPTION_KEY_B64", ""), validate=True
                            )
                            if len(key) != 32:
                                raise ValueError
                            aes = AESGCM(key)
                        raw = bytes(record[column])
                        purpose = context.format(**record).encode("ascii")
                        if encrypt:
                            kid = os.environ.get("ENCRYPTION_KEY_ID", "local-v1").encode("ascii")
                            if not 1 <= len(kid) <= 32:
                                raise ValueError
                            header = b"NMA1" + bytes([len(kid)]) + kid
                            nonce = os.urandom(12)
                            result = (
                                header + nonce + aes.encrypt(nonce, raw, header + b"\0" + purpose)
                            )
                        else:
                            if len(raw) < 34 or raw[:4] != b"NMA1" or not 1 <= raw[4] <= 32:
                                raise ValueError
                            end = 5 + raw[4]
                            result = aes.decrypt(
                                raw[end : end + 12], raw[end + 12 :], raw[:end] + b"\0" + purpose
                            )
                        values[column] = result
                    except Exception:
                        raise RuntimeError("LEGACY_DATA_KEY_REQUIRED_OR_INVALID") from None
                changed = [column for column in columns if column in values]
                if changed:
                    bind.execute(
                        sa.text(
                            f"UPDATE {table} SET "
                            + ",".join(f"{c}=:{c}" for c in changed)
                            + " WHERE "
                            + " AND ".join(f"{k}=:{k}" for k in keys)
                        ),
                        values,
                    )
            offset += len(records)


def rename(encrypt=False):
    for table, (_, fields) in FIELDS.items():
        for field, _ in fields:
            old, new = field + "_encrypted", field + "_data"
            op.alter_column(table, new if encrypt else old, new_column_name=old if encrypt else new)


def execute(sql):
    op.execute(sa.text(sql.replace(":", r"\:")))


def upgrade():
    transform()
    rename()
    execute(Path(__file__).with_suffix(".sql").read_text())


def downgrade():
    transform(encrypt=True)
    execute("DROP FUNCTION nodema_node_page(jsonb,text,integer,integer,integer,text,text)")
    execute("DROP FUNCTION nodema_catalog(integer,text,text)")
    execute(
        "DROP TRIGGER node_daily_lifetime ON node_daily_stats; "
        "DROP FUNCTION nodema_track_lifetime(); DROP VIEW nodema_catalog_base"
    )
    rename(encrypt=True)
    old = Path(__file__).with_name("0006_quality_queries.sql").read_text()
    execute(
        old[
            old.index("CREATE VIEW nodema_catalog_base AS") : old.index(
                "CREATE FUNCTION nodema_display_name"
            )
        ]
    )
    execute(
        old[
            old.index("CREATE FUNCTION nodema_catalog(fresh") : old.index(
                "CREATE FUNCTION nodema_node_page("
            )
        ]
    )
    execute(Path(__file__).with_name("0008_export_projection.sql").read_text())
    op.drop_index("idx_nodes_first_seen", table_name="nodes")
    op.drop_constraint(op.f("ck_nodes_lifetime_days"), "nodes", type_="check")
    op.drop_column("nodes", "available_days")
    op.drop_column("nodes", "checked_days")
