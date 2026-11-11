"""Stable display names: exit flag, entry->exit route, short ASN label, group number."""

import pytest
import sqlalchemy as sa

from app.catalog import Catalog
from app.checker.health import Observation
from app.domain import AssetError, SourceType
from app.scans import ScanService

pytestmark = pytest.mark.integration


@pytest.mark.parametrize(
    "org,label",
    [
        ("WEBBING HONG KONG LIMITED", "Webbing"),
        ("Amazon.com, Inc.", "Amazon.com"),
        ("HGC Global Communications Limited", "HGC"),
        ("The Constant Company, LLC", "Constant"),
        ("Hong Kong Broadband Network Ltd.", None),  # only generic words -> AS<number>
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


def test_missing_geoip_never_renumbers_and_same_country_shares_a_group(service, monitor_settings):
    nodes(service, 2)
    scan(service, monitor_settings)
    before = names(service, monitor_settings)

    class NoGeo(Checker):
        def check(self, identity, short_id):
            result = super().check(identity, short_id)
            result.entry_country = result.exit_asn_org = None  # GeoIP/Echo field missing today
            return result

    scans = ScanService(service, monitor_settings, checker_factory=NoGeo)
    run = scans.create(manual=True)
    scans.run_shard(run["id"], 0)
    scans.finalize(run["id"])
    assert names(service, monitor_settings) == before
    # Entry unknown and entry == exit both render "SG": they must not collide.
    with service.sessions.begin() as session:
        session.execute(
            sa.text(
                "UPDATE node_current_status SET entry_country=CASE WHEN entry_country IS NOT NULL "
                "THEN NULL END, last_exit_country='SG'"
            )
        )
        session.execute(
            sa.text(
                "UPDATE node_current_status SET entry_country='SG' WHERE node_id="
                "(SELECT node_id FROM node_current_status ORDER BY node_id LIMIT 1)"
            )
        )
        session.execute(sa.text("SELECT nodema_assign_names()"))
    final = names(service, monitor_settings)
    assert len(set(final.values())) == 2
    assert all(name.startswith("🇸🇬SG|Webbing ") for name in final.values())


def test_requests_survive_and_each_scope_gets_one_run(service, monitor_settings):
    nodes(service, 2)
    scans = ScanService(service, monitor_settings, checker_factory=Checker)
    scans.request("SELF_HOSTED")
    scans.request("AIRPORT")
    scans.request("SELF_HOSTED")
    runs = scans.consume_requests()
    assert sorted(r["scope"] for r in runs) == ["AIRPORT", "SELF_HOSTED"]
    assert all(r["kind"] == "MANUAL" for r in runs)
    assert scans.consume_requests() == []
    scans.request("AIRPORT")
    scans.request("ALL")
    assert [r["scope"] for r in scans.consume_requests()] == ["ALL"]


def test_export_names_are_unique_even_without_sequence():
    from app.export_render import Renderer

    renderer = Renderer("json")
    for short_id in ("N1", "N2"):
        renderer.append({"name": "🇸🇬SG|Webbing", "short_id": short_id})
    import json

    assert [n["name"] for n in json.loads(renderer.finish())] == [
        "🇸🇬SG|Webbing",
        "🇸🇬SG|Webbing N2",
    ]


def test_sequence_numbers_above_99_are_not_truncated(db_engine):
    with db_engine.connect() as conn:
        render = (
            "SELECT nodema_render_name('{ASN} {SEQ}','N1','vless',NULL,NULL,'HK','SG','X',:seq)"
        )
        assert [conn.scalar(sa.text(render), {"seq": s}) for s in (7, 42, 108, 1234)] == [
            "X 07",
            "X 42",
            "X 108",
            "X 1234",
        ]


def test_numbers_follow_exit_country_and_asn_not_entry(service, monitor_settings):
    nodes(service, 3)

    class Mixed(Checker):
        def check(self, identity, short_id):
            result = super().check(identity, short_id)
            # host-1 enters via SG (same as exit); others via HK.
            result.entry_country = "SG" if identity["server_host"] == "host-1.example" else "HK"
            return result

    scans = ScanService(service, monitor_settings, checker_factory=Mixed)
    run = scans.create(manual=True)
    scans.run_shard(run["id"], 0)
    scans.finalize(run["id"])
    result = names(service, monitor_settings)
    numbers = sorted(name.rsplit(" ", 1)[1] for name in result.values())
    assert numbers == ["01", "02", "03"]  # one sequence for SG + Webbing
    assert result["host-1"].startswith("🇸🇬SG|Webbing ")
    assert result["host-2"].startswith("🇸🇬HK->SG|Webbing ")


def test_untested_nodes_are_not_numbered(service, monitor_settings):
    nodes(service, 2)
    items = Catalog(service, monitor_settings).page({}, limit=10)["items"]
    assert sorted(n["name"] for n in items) == sorted(f"🏳?|Unknown {n['short_id']}" for n in items)
    with service.sessions() as session:
        assert session.scalar(sa.text("SELECT count(*) FROM node_names")) == 0


def test_selected_nodes_get_their_own_run(service, monitor_settings):
    nodes(service, 3)
    scans = ScanService(service, monitor_settings, checker_factory=Checker)
    chosen = [n["id"] for n in Catalog(service, monitor_settings).page({}, limit=10)["items"]][:2]
    scans.request(node_ids=chosen)
    scans.request(node_ids=chosen[:1])
    runs = scans.consume_requests()
    assert len(runs) == 1 and runs[0]["node_count"] == 2 and runs[0]["kind"] == "MANUAL"
    with pytest.raises(AssetError, match="INVALID_SELECTION"):
        scans.request(node_ids=[])
