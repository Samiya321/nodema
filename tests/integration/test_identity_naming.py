"""Source conflicts must not turn into invented routes or mixed exit identities."""

from datetime import UTC, datetime, timedelta

import pytest
import sqlalchemy as sa

from alembic import command
from app.catalog import Catalog
from app.database.models import NodeCurrentStatus
from app.database.models import TestResult as ResultRow
from app.naming import render_name
from app.scans import ScanService
from tests.integration.test_naming_scope import Checker, nodes, scan

pytestmark = pytest.mark.integration


def publish(service, settings, factory):
    scans = ScanService(service, settings, checker_factory=factory)
    run = scans.create(manual=True)
    for shard in scans.get(run["id"])["shards"]:
        scans.run_shard(run["id"], shard["shard_no"])
    assert scans.finalize(run["id"])["status"] == "COMPLETED"


class SameIP(Checker):
    def check(self, identity, short_id):
        r = super().check(identity, short_id)
        r.entry_ips = [r.exit_ip]
        r.entry_country = "GB"
        r.exit_country = "NL"
        r.exit_asn = 141995
        r.exit_asn_org = "Private Customer"
        r.geoip_metadata = {"exit": {"country": "GB", "asn": 64500}}
        return r


def test_conflicts_are_preserved_but_not_rendered_as_routes(service, monitor_settings):
    nodes(service, 1)
    publish(service, monitor_settings, SameIP)
    catalog = Catalog(service, monitor_settings)
    n = catalog.page({})["items"][0]
    assert n["name"] == "🇳🇱NL|Contabo 01"
    assert n["entry_country"] == "NL"
    assert n["identity"]["raw_entry_country"] == "GB"
    assert n["identity_flags"] & 7 == 7
    assert catalog.page({"cross_border": True})["total"] == 0
    assert catalog.page({"entry_country": "NL"})["total"] == 1
    assert n["exit_observed_at"] == n["last_checked_at"]
    assert (
        render_name(
            "N1",
            "trojan",
            None,
            None,
            entry_country="GB",
            exit_country="NL",
            entry_ips=["2001:db8::1"],
            exit_ip="2001:0db8::1",
            asn_label="Contabo",
            seq=1,
        )
        == n["name"]
    )
    with service.sessions() as s:
        report = s.scalar(
            sa.text(
                "SELECT nodema_node_page('{}','short_id:asc',0,10,36,"
                "'{FLAG}{ROUTE}|{OPERATOR} {SEQ}{VARIANT}','report')"
            )
        )
        compact = s.scalar(
            sa.text(
                "SELECT nodema_node_page('{}','short_id:asc',0,10,36,"
                "'{FLAG}{ROUTE}|{OPERATOR} {SEQ}{VARIANT}','compact')"
            )
        )
    assert report["items"][0]["name"] == n["name"]
    row = dict(zip(compact["fields"], compact["items"][0], strict=True))
    assert (row["name"], row["identity_flags"]) == (n["name"], n["identity_flags"])


@pytest.mark.parametrize("org", ["Private Customer", "PRIVATE", "Unknown", "Not disclosed"])
def test_placeholder_and_verified_aliases(db_engine, org):
    with db_engine.begin() as c:
        assert c.scalar(sa.text("SELECT nodema_org_short(:o)"), {"o": org}) is None
        assert c.scalar(sa.text("SELECT nodema_asn_label(64500,:o)"), {"o": org}) == "AS64500"
        assert c.scalar(sa.text("SELECT nodema_asn_label(40676,:o)"), {"o": org}) == "Psychz"
        c.execute(sa.text("UPDATE asn_labels SET label='Custom',origin='USER' WHERE asn=40676"))
        assert c.scalar(sa.text("SELECT nodema_asn_label(40676,:o)"), {"o": org}) == "Custom"


def test_ipapi_as_organization_requires_matching_asn(service, monitor_settings):
    nodes(service, 1)
    scan(service, monitor_settings)
    with service.sessions.begin() as s:
        s.execute(sa.text("UPDATE node_current_status SET last_exit_asn_org=NULL"))
        s.execute(
            sa.text(
                "INSERT INTO ip_info(ip,status,as_number,as_org)"
                " VALUES ('192.0.2.1','SUCCESS',64513,'Other Network')"
            )
        )
        s.execute(sa.text("SELECT nodema_assign_names()"))
    catalog = Catalog(service, monitor_settings)
    n = catalog.page({})["items"][0]
    assert n["asn_label"] == "AS64512"
    assert n["identity_flags"] & 4
    with service.sessions.begin() as s:
        s.execute(sa.text("UPDATE ip_info SET as_number=64512,as_org='Webbing Ltd'"))
        s.execute(sa.text("SELECT nodema_assign_names()"))
    assert catalog.page({})["items"][0]["asn_label"] == "Webbing"


def test_fallback_keeps_observation_time_and_new_ip_does_not_inherit_identity(
    service,
    monitor_settings,
):
    nodes(service, 1)
    scan(service, monitor_settings)
    catalog = Catalog(service, monitor_settings)
    before = catalog.page({})["items"][0]

    class Fallback(Checker):
        def check(self, identity, short_id):
            r = super().check(identity, short_id)
            r.exit_ip = r.exit_country = r.exit_asn = r.exit_asn_org = None
            r.echo_source = "fallback"
            return r

    publish(service, monitor_settings, Fallback)
    old = catalog.page({})["items"][0]
    assert old["exit_observed_at"] == before["exit_observed_at"]
    assert old["last_success_at"] > old["exit_observed_at"]
    assert old["identity_flags"] & 8
    assert old["name"] == before["name"]

    class NewIP(Checker):
        def check(self, identity, short_id):
            r = super().check(identity, short_id)
            r.exit_ip = "198.51.100.1"
            r.exit_country = r.exit_asn = r.exit_asn_org = None
            return r

    publish(service, monitor_settings, NewIP)
    fresh = catalog.page({})["items"][0]
    assert fresh["exit_ip"] == "198.51.100.1"
    assert fresh["exit_country"] is None and fresh["exit_asn"] is None
    assert fresh["exit_asn_org"] is None
    assert fresh["exit_observed_at"] == fresh["last_checked_at"]
    assert not fresh["identity_flags"] & 8


def test_asn_change_drops_previous_organization_even_on_same_ip(service, monitor_settings):
    nodes(service, 1)
    scan(service, monitor_settings)

    class ChangedASN(Checker):
        def check(self, identity, short_id):
            r = super().check(identity, short_id)
            r.exit_asn, r.exit_asn_org = 64513, None
            return r

    publish(service, monitor_settings, ChangedASN)
    n = Catalog(service, monitor_settings).page({})["items"][0]
    assert n["exit_asn_org"] is None
    assert n["asn_label"] == "AS64513"


def test_migration_backfills_actual_exit_not_latest_fallback(
    service,
    monitor_settings,
    db_engine,
    migration_config,
):
    nodes(service, 2)
    scan(service, monitor_settings)
    then = datetime.now(UTC) - timedelta(days=3)
    with service.sessions.begin() as s:
        rows = list(s.scalars(sa.select(NodeCurrentStatus).order_by(NodeCurrentStatus.node_id)))
        observed = s.get(ResultRow, rows[0].last_result_id)
        observed.checked_at = then
        rows[0].last_checked_at = then + timedelta(days=2)
        # Missing retained detail cannot be backfilled using last_success_at.
        s.get(ResultRow, rows[1].last_result_id).exit_ip = None
    with db_engine.begin() as c:
        migration_config.attributes["connection"] = c
        command.downgrade(migration_config, "0022_uk_probes")
        command.upgrade(migration_config, "head")
    with service.sessions() as s:
        rows = list(s.scalars(sa.select(NodeCurrentStatus).order_by(NodeCurrentStatus.node_id)))
        assert rows[0].exit_observed_at == then
        assert rows[1].exit_observed_at is None
