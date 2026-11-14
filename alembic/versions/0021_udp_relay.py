"""UDP check results (Wi-Fi Calling) and relay entries counted as airports."""

from pathlib import Path

import sqlalchemy as sa

from alembic import op

revision = "0021_udp_relay"
down_revision = "0020_shared_credentials"
branch_labels = depends_on = None


def _run(suffix):
    sql = Path(__file__).with_name("0021_udp_relay" + suffix).read_text()
    op.execute(sa.text(sql.replace(":", r"\:")))


def upgrade():
    _run(".sql")


def downgrade():
    _run(".down.sql")
