"""Bind trigger lookups to their restored schema without disabling SQL inlining."""

import sqlalchemy as sa

from alembic import op

revision = "0012_trigger_search_path"
down_revision = "0011_scan_archives"
branch_labels = depends_on = None


def configure(reset=False):
    connection = op.get_bind()
    schema = connection.scalar(sa.text("SELECT current_schema()"))
    quote = connection.dialect.identifier_preparer.quote
    names = connection.scalars(
        sa.text(
            "SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace "
            "WHERE n.nspname=:schema AND p.prorettype='pg_catalog.trigger'::regtype "
            "AND p.proname LIKE 'nodema_%'"
        ),
        {"schema": schema},
    ).all()
    for name in names:
        statement = f"ALTER FUNCTION {quote(schema)}.{quote(name)}() "
        statement += (
            "RESET search_path" if reset else f"SET search_path TO {quote(schema)}, pg_temp"
        )
        op.execute(sa.text(statement))


def upgrade():
    configure()


def downgrade():
    configure(reset=True)
