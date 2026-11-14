"""Nodes that share one credential across servers count as airport nodes (0020)."""

import pytest
import sqlalchemy as sa

from app.catalog import Catalog
from app.domain import SourceType, credential_key

pytestmark = pytest.mark.integration
SHARED = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
FEW = "11111111-2222-4333-8444-555555555555"
ONE_HOST = "99999999-8888-4777-8666-555555555555"


def vless(uuid, host, port, name):
    return f"vless://{uuid}@{host}:{port}?type=tcp&security=none#{name}"


def lines():
    out = [vless(SHARED.upper(), f"198.51.100.{i % 2 + 1}", 443 + i, f"s{i}") for i in range(5)]
    out += [vless(FEW, f"198.51.100.{i + 10}", 443, f"f{i}") for i in range(4)]
    out += [vless(ONE_HOST, "198.51.100.30", 1000 + i, f"o{i}") for i in range(6)]
    out.append("trojan://Synthetic-Pass-1@198.51.100.40:443?security=tls&sni=t.example#t0")
    return "\n".join(out).encode()


def test_shared_credentials_make_airport_nodes(service, monitor_settings):
    source = service.create_source(
        name="synthetic", source_type=SourceType.RAW_TEXT, payload=lines()
    )
    service.sync_source(source["id"])
    with service.sessions() as session:
        rows = session.execute(
            sa.text(
                "SELECT n.credential_key, sc.node_group, sc.credential_shared,"
                # The migration's backfill expression must agree with the Python helper.
                " md5(CASE WHEN n.protocol IN ('vless','vmess') THEN 'uuid:'"
                "||lower(convert_from(n.config_data,'UTF8')::jsonb->>'uuid')"
                " ELSE 'pw:'||(convert_from(n.config_data,'UTF8')::jsonb->>'password') END) sql_key"
                " FROM nodes n JOIN nodema_node_scope sc ON sc.node_id=n.id"
            )
        ).all()
    assert len(rows) == 16 and all(r.credential_key == r.sql_key for r in rows)
    groups = {}
    for row in rows:
        groups.setdefault(row.credential_key, set()).add((row.node_group, row.credential_shared))
    assert groups[credential_key({"protocol": "vless", "uuid": SHARED})] == {("AIRPORT", True)}
    assert groups[credential_key({"protocol": "vmess", "uuid": FEW})] == {("SELF_HOSTED", False)}
    assert groups[credential_key({"protocol": "vless", "uuid": ONE_HOST})] == {
        ("SELF_HOSTED", False)
    }  # one server's own ports
    assert groups[credential_key({"protocol": "trojan", "password": "Synthetic-Pass-1"})] == {
        ("SELF_HOSTED", False)
    }
    catalog = Catalog(service, monitor_settings)
    assert catalog.page({"node_group": "AIRPORT"})["total"] == 5
    assert catalog.page({"node_group": "SELF_HOSTED"})["total"] == 11
    assert credential_key({"protocol": "trojan"}) is None
