"""Stable display names: exit flag, entry->exit route, short ASN label, group number."""

import pytest
import sqlalchemy as sa

from app.catalog import Catalog
from app.checker.health import Observation
from app.domain import SourceType
from app.scans import ScanService

pytestmark = pytest.mark.integration


@pytest.mark.parametrize(
    "org,label",
    [
        ("WEBBING HONG KONG LIMITED", "Webbing"),
        ("Amazon.com, Inc.", "Amazon.com"),
        ("HGC Global Communications Limited", "HGC"),
        ("The Constant Company, LLC", "Constant"),
        ("Hong Kong Broadband Network Ltd.", "Hong"),
        ("", None),
    ],
)
def test_org_short(db_engine, org, label):
    with db_engine.connect() as conn:
        assert conn.scalar(sa.text("SELECT nodema_org_short(:o)"), {"o": org}) == label


def nodes(service, count):
    lines = [f"trojan://secret-{i}@host-{i}.example:443#n{i}".encode() for i in range(1, count + 1)]
    source = service.create_source(
        name="vps", source_type=SourceType.RAW_TEXT, payload=b"\n".join(lines)
    )
    service.sync_source(source["id"])


class Checker:
    exit = {}

    def preflight(self):
        pass

    def close(self):
        pass

    def check(self, identity, short_id):
        country, asn, org = self.exit.get(identity["server_host"], ("SG", 64512, "WEBBING HK LTD"))
        return Observation(
            status="UP",
            entry_country="HK",
            exit_country=country,
            exit_asn=asn,
            exit_asn_org=org,
            exit_ip="8.8.8.8",
            http_duration_ms=10,
        )


def scan(service, settings):
    scans = ScanService(service, settings, checker_factory=Checker)
    run = scans.create(manual=True)
    for shard in scans.get(run["id"])["shards"]:
        scans.run_shard(run["id"], shard["shard_no"])
    assert scans.finalize(run["id"])["status"] == "COMPLETED"


def names(service, settings):
    items = Catalog(service, settings).page({}, sort="short_id:asc", limit=100)["items"]
    return {n["server_host"].split(".")[0]: n["name"] for n in items}


def test_names_are_grouped_numbered_and_stable(service, monitor_settings):
    nodes(service, 3)
    scan(service, monitor_settings)
    first = names(service, monitor_settings)
    assert sorted(first.values()) == [
        "🇸🇬HK->SG|Webbing 01",
        "🇸🇬HK->SG|Webbing 02",
        "🇸🇬HK->SG|Webbing 03",
    ]
    # Node 2 moves to a same-country exit with a user-labelled ASN; others keep numbers.
    Checker.exit = {"host-2.example": ("HK", 4760, "HKT Limited")}
    with service.sessions.begin() as session:
        session.execute(sa.text("UPDATE asn_labels SET label='HKT-Home' WHERE asn=4760"))
    scan(service, monitor_settings)
    second = names(service, monitor_settings)
    assert second["host-2"] == "🇭🇰HK|HKT-Home 01"
    assert second["host-1"] == first["host-1"] and second["host-3"] == first["host-3"]
    Checker.exit = {}
    nodes(service, 4)  # adds host-4; existing nodes are deduplicated
    scan(service, monitor_settings)
    third = names(service, monitor_settings)
    assert third["host-1"] == first["host-1"] and third["host-3"] == first["host-3"]
    # host-2 moved back and host-4 is new: both join the group above existing numbers.
    assert {third["host-2"], third["host-4"]}.isdisjoint({third["host-1"], third["host-3"]})
    assert len(set(third.values())) == 4  # names stay unique for subscription clients
