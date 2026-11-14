"""UDP results (Wi-Fi Calling) reach the node list; relay entries count as airports (0021)."""

from datetime import UTC, datetime, timedelta

import pytest
import sqlalchemy as sa

from app.catalog import Catalog
from app.checker.health import Observation
from app.domain import SourceType
from app.scans import ScanService

pytestmark = pytest.mark.integration
RELAY = "77777777-6666-4555-8444-333333333333"


def vless(uuid, host, port, name):
    return f"vless://{uuid}@{host}:{port}?type=tcp&security=none#{name}"


def scan(service, settings, observe, day=0):
    class Checker:
        def preflight(self):
            pass

        def close(self):
            pass

        def check(self, identity, short_id):
            return observe(identity)

    scans = ScanService(service, settings, checker_factory=Checker)
    run = scans.create(datetime.now(UTC).date() - timedelta(days=day))
    for shard in scans.get(run["id"])["shards"]:
        scans.run_shard(run["id"], shard["shard_no"])
    scans.finalize(run["id"])


def up(identity, **extra):
    return Observation(
        status="UP",
        entry_country="SG",
        entry_asn=64510,
        entry_ips=["198.51.100.1"],
        exit_country=extra.pop("exit_country", "JP"),
        exit_asn=64520,
        exit_ip="203.0.113.1",
        http_duration_ms=20,
        probe_key="synthetic",
        **extra,
    )


def test_udp_results_are_published_filtered_and_remembered(service, monitor_settings):
    payload = "\n".join(
        vless(f"00000000-0000-4000-8000-00000000000{i}", f"198.51.100.{i + 1}", 443, f"n{i}")
        for i in range(3)
    )
    source = service.create_source(
        name="udp", source_type=SourceType.RAW_TEXT, payload=payload.encode()
    )
    service.sync_source(source["id"])

    def first(identity):
        last = identity["uuid"][-1]
        if last == "0":
            return up(identity, udp_status="SUCCESS", udp_duration_ms=80, udp_exit_ip="203.0.113.9")
        if last == "1":
            return up(identity, udp_status="FAILED", udp_duration_ms=9000)
        return Observation(status="DOWN", probe_key="synthetic", error_code="ECHO_TIMEOUT")

    scan(service, monitor_settings, first, day=1)
    catalog = Catalog(service, monitor_settings)
    assert catalog.page({"udp": True})["total"] == 1
    assert catalog.page({"udp": False})["total"] == 2  # failed UDP and a DOWN node
    with service.sessions() as session:
        page = session.scalar(
            sa.text(
                "SELECT nodema_node_page(CAST('{}' AS jsonb),'short_id:asc',0,10,36,"
                "'{SHORT_ID}','compact')"
            )
        )
        rows = {
            r.udp_status: r
            for r in session.execute(
                sa.text(
                    "SELECT udp_status, udp_exit_ip, udp_success_at, udp_checked_at"
                    " FROM node_current_status"
                )
            )
        }
    udp = [row[page["fields"].index("udp")] for row in page["items"]]
    assert sorted(udp, key=str) == sorted(["SUCCESS", "FAILED", None], key=str)
    assert rows["SUCCESS"].udp_exit_ip == "203.0.113.9" and rows["SUCCESS"].udp_success_at
    assert rows["FAILED"].udp_success_at is None and rows["NOT_RUN"].udp_checked_at

    # The next day UDP fails everywhere: the last success is kept, the state is current.
    scan(service, monitor_settings, lambda d: up(d, udp_status="FAILED"), day=0)
    assert catalog.page({"udp": True})["total"] == 0
    with service.sessions() as session:
        kept = session.scalar(
            sa.text("SELECT count(*) FROM node_current_status WHERE udp_success_at IS NOT NULL")
        )
    assert kept == 1


def test_one_relay_entry_landing_in_many_countries_is_an_airport(service, monitor_settings):
    payload = "\n".join(vless(RELAY, "198.51.100.60", 2000 + i, f"r{i}") for i in range(5))
    source = service.create_source(
        name="relay", source_type=SourceType.RAW_TEXT, payload=payload.encode()
    )
    service.sync_source(source["id"])
    catalog = Catalog(service, monitor_settings)
    assert catalog.page({"node_group": "AIRPORT"})["total"] == 0  # one server's own ports
    countries = ["JP", "US", "SG", "JP", "US"]

    def relay(identity):
        port = identity["server_port"]
        return up(identity, exit_country=countries[port - 2000])

    scan(service, monitor_settings, relay)
    assert catalog.page({"node_group": "AIRPORT"})["total"] == 5
