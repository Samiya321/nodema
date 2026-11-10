"""Exercise the driver boundary without opening an external database connection."""

from types import SimpleNamespace

import certifi
import pytest
import sqlalchemy as sa

from app.database.session import make_engine


@pytest.mark.parametrize(
    "configured,host_bundle", [("system", True), ("system", False), ("/custom/root.pem", True)]
)
def test_verified_tls_reaches_driver_with_correct_trust_bundle(
    tmp_path, monkeypatch, configured, host_bundle
):
    host_ca = tmp_path / "host-trust.pem"
    host_ca.write_text("synthetic-trust-bundle")
    monkeypatch.setattr(
        "app.database.session.ssl.get_default_verify_paths",
        lambda: SimpleNamespace(cafile=str(host_ca) if host_bundle else None),
    )
    engine = make_engine(
        "postgresql+psycopg://test:synthetic-password@database.example/nodes"
        f"?sslmode=verify-full&sslrootcert={configured}"
    )
    seen = {}

    class StopBeforeNetwork(Exception):
        pass

    def capture(dialect, record, args, params):
        seen.update(params)
        raise StopBeforeNetwork

    sa.event.listen(engine, "do_connect", capture)
    try:
        with pytest.raises(StopBeforeNetwork):
            engine.connect()
        assert seen["sslmode"] == "verify-full"
        expected_ca = str(host_ca) if host_bundle else certifi.where()
        assert seen["sslrootcert"] == (expected_ca if configured == "system" else configured)
        assert seen["password"] == "synthetic-password"
        assert "synthetic-password" not in str(engine.url)
    finally:
        engine.dispose()
