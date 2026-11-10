import sqlalchemy as sa
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker

from app.domain import AssetError


def make_engine(url: str):
    try:
        parsed = make_url(url)
        if parsed.drivername != "postgresql+psycopg":
            raise ValueError
        return sa.create_engine(
            parsed,
            echo=False,
            hide_parameters=True,
            pool_size=2,
            max_overflow=0,
            pool_pre_ping=True,
            connect_args={"connect_timeout": 10},
        )
    except (ValueError, sa.exc.ArgumentError):
        raise AssetError("INVALID_DATABASE_URL") from None


def session_factory(engine):
    return sessionmaker(engine, expire_on_commit=False)
