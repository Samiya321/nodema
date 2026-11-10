import os

import sqlalchemy as sa
from dotenv import load_dotenv

from alembic import context
from app.database.models import Base
from app.database.session import make_engine
from app.domain import AssetError
from app.security.logging import configure_logging

configure_logging()
config = context.config
target_metadata = Base.metadata


def run(connection):
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        compare_type=True,
        compare_server_default=True,
    )
    with context.begin_transaction():
        connection.execute(
            sa.text(
                "SELECT pg_advisory_xact_lock(hashtextextended(current_schema()||:lock_suffix,0))"
            ),
            {"lock_suffix": ":nodema-migrations"},
        )
        context.run_migrations()


if context.is_offline_mode():
    context.configure(
        url="postgresql+psycopg://",
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()
elif config.attributes.get("connection") is not None:
    run(config.attributes["connection"])
else:
    load_dotenv(".env")
    url = os.environ.get("MIGRATION_DATABASE_URL") or os.environ.get("DATABASE_URL")
    if not url:
        raise AssetError("DATABASE_URL_REQUIRED")
    engine = make_engine(url)
    try:
        with engine.connect() as connection:
            run(connection)
    except Exception:
        raise AssetError("DATABASE_MIGRATION_FAILED") from None
    finally:
        engine.dispose()
