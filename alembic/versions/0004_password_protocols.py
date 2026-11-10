"""Add Shadowsocks, Trojan, AnyTLS and Hysteria2 without changing existing assets."""

import sqlalchemy as sa

from alembic import op

revision = "0004_password_protocols"
down_revision = "0003_import_pipeline"
branch_labels = None
depends_on = None


def upgrade():
    op.drop_constraint(op.f("ck_nodes_protocol"), "nodes", type_="check")
    op.create_check_constraint(
        op.f("ck_nodes_protocol"),
        "nodes",
        "protocol IN ('shadowsocks','trojan','anytls','hysteria2','vmess','vless')",
    )


def downgrade():
    if op.get_bind().scalar(
        sa.text("SELECT count(*) FROM nodes WHERE protocol NOT IN ('vmess','vless')")
    ):
        raise RuntimeError("PASSWORD_PROTOCOL_ASSETS_PREVENT_DOWNGRADE")
    op.drop_constraint(op.f("ck_nodes_protocol"), "nodes", type_="check")
    op.create_check_constraint(op.f("ck_nodes_protocol"), "nodes", "protocol IN ('vless','vmess')")
