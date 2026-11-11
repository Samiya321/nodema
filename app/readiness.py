"""Safe deployment checks; never report connection strings, keys or node payloads."""

import sqlalchemy as sa

from app.checker.health import HealthChecker
from app.domain import AssetError

SCHEMA_REVISION = "0016_servers_ipinfo_share"


def readiness(assets, settings, *, network=False, checker_factory=None):
    checks = {}
    try:
        settings.fingerprint_key()
        checks["keys"] = "OK"
    except AssetError as error:
        checks["keys"] = error.code
    try:
        with assets.sessions() as session:
            revision = session.scalar(sa.text("SELECT version_num FROM alembic_version"))
            checks["schema"] = "OK" if revision == SCHEMA_REVISION else "MIGRATION_REQUIRED"
            assets._verify_keys(session)
            checks["stored_keys"] = "OK"
    except AssetError as error:
        checks["stored_keys"] = error.code
    except Exception:
        checks["database"] = "DATABASE_OR_SCHEMA_UNAVAILABLE"
    if network:
        checker = None
        try:
            checker = (checker_factory or (lambda: HealthChecker(settings)))()
            checker.preflight()
            checks["runtime_and_echo"] = "OK"
        except AssetError as error:
            checks["runtime_and_echo"] = error.code
        except Exception:
            checks["runtime_and_echo"] = "CHECK_ENVIRONMENT_ERROR"
        finally:
            if checker:
                checker.close()
    return {"ready": all(value == "OK" for value in checks.values()), "checks": checks}
