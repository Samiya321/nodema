import logging


def configure_logging() -> None:
    # Third-party errors may contain URLs, SQL details, or invalid input. Only the
    # CLI's explicit DTOs/error codes are emitted; raw exception chains stay private.
    for name in ("sqlalchemy", "httpcore", "httpx", "alembic", "psycopg"):
        logger = logging.getLogger(name)
        logger.handlers = [logging.NullHandler()]
        logger.propagate = False
        logger.setLevel(logging.CRITICAL)
