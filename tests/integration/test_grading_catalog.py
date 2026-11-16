from datetime import UTC, datetime, timedelta

import pytest
import sqlalchemy as sa

from app.database.models import (
    EntryProbeRejection,
    EntryProbeResult,
    EntryProbeRun,
    EntryRouteTrace,
    NodeGrade,
)
from app.domain import AssetError
from app.exports import ExportService
from app.probes import planner, refresh, runner
from app.probes.policy import GradingPolicyService
from tests.integration.test_quality_catalog import seed

pytestmark = pytest.mark.integration
PREFIX = "198.51.100"


@pytest.fixture(autouse=True)
def documentation_addresses(monkeypatch):
    monkeypatch.setattr(planner, "ALLOW_NON_GLOBAL", True)


def target(service):
    with service.sessions() as session:
        return session.execute(sa.text("SELECT server_port FROM nodes LIMIT 1")).scalar()


def measure(service, port, *, rtt, received=16, vantages=("CN-CT", "CN-CU", "CN-CM"), peak=True):
    rows = []
    for vantage in vantages:
        for probe in (1, 2):
            rows.append(
                {
                    "target": f"198.51.100.1:{port}",
                    "prefix": PREFIX,
                    "purpose": "QUALITY",
                    "vantage": vantage,
                    "protocol": "TCP",
                    "peak": peak,
                    "measured_at": datetime.now(UTC) - timedelta(hours=probe),
                    "probe_asn": 64600 + probe,
                    "probe_city": f"City{probe}",
                    "sent": 16,
                    "received": received,
                    "rtt_avg": rtt if received else None,
                    "jitter": 2 if received else None,
                    "measurement_id": f"m{probe}",
                }
            )
    with service.sessions.begin() as session:
        session.execute(sa.insert(EntryProbeResult), rows)


def test_grades_are_computed_filtered_sorted_and_explained(
    service, monitor_settings, fixture_bytes
):
    _, catalog, _ = seed(service, monitor_settings, fixture_bytes)
    port = target(service)
    # Two days of checks only: not enough history yet.
    with service.sessions.begin() as session:
        session.execute(
            sa.text(
                "DELETE FROM node_daily_stats"
                " WHERE stat_date=(SELECT min(stat_date) FROM node_daily_stats)"
            )
        )
    first = refresh.refresh(service.sessions, monitor_settings)
    assert first["nodes"] == 2 and first["rows"] == 14 and first["grades"] == {"PENDING": 2}
    with service.sessions.begin() as session:
        session.execute(
            sa.text(
                "INSERT INTO node_daily_stats SELECT node_id,stat_date-2,scheduled_count,"
                "successful_count,failed_count,availability_ratio,avg_http_duration_ms"
                " FROM node_daily_stats"
                " WHERE stat_date=(SELECT max(stat_date) FROM node_daily_stats)"
            )
        )
    measure(service, port, rtt=40)
    measure(service, port, rtt=20, vantages=("HK", "SG", "GB"), peak=False)
    with service.sessions.begin() as session:
        session.add(
            EntryRouteTrace(
                prefix=PREFIX, vantage="CN-CT", hop_asns=[4134, 4809, 64510], reached=True
            )
        )
    result = refresh.refresh(service.sessions, monitor_settings)
    assert result["changed"] and result["grades"] == {"S": 2}
    with service.sessions() as session:
        grade = session.get(NodeGrade, (catalog.nodes()["items"][0]["id"], "CN-CT"))
        assert grade.grade == "S" and grade.peak_rtt_ms == 40 and grade.loss == 0
        assert grade.route_asns == [4134, 4809, 64510] and grade.server_best_grade == "S"
        assert any("电信晚高峰" in r for r in grade.reasons)

    page = catalog.page({"vantage": "CN-CT", "min_quality_grade": "A"}, sort="quality_grade:asc")
    assert page["total"] == 2 and page["vantage"] == "CN-CT"
    node = page["items"][0]
    assert node["quality_grade"] == "S" and node["peak_rtt_ms"] == 40 and node["avail_7d"] == 3
    assert node["route_asns"] == [4134, 4809, 64510] and node["grade_reasons"]
    assert catalog.page({"vantage": "CN-CT", "route_asn": "4809"})["total"] == 2
    assert catalog.page({"vantage": "CN-CU", "route_asn": "4809"})["total"] == 0
    assert catalog.page({"max_peak_rtt_ms": "30"})["total"] == 0
    assert catalog.page({"vantage": "HK", "quality_grade": "S"})["total"] == 2
    assert catalog.page({"vantage": "GB", "quality_grade": "S"})["total"] == 2
    assert catalog.page({"best_per_server": True})["total"] == 1
    assert catalog.page({"cross_border": True})["total"] == 2
    assert catalog.page({"unreachable": True})["total"] == 0
    for bad in ({"vantage": "US"}, {"min_quality_grade": "PENDING"}, {"max_peak_loss": "2"}):
        with pytest.raises(AssetError, match="INVALID_NODE_QUERY"):
            catalog.page(bad)
    with service.sessions() as session:
        compact = session.scalar(
            sa.text(
                "SELECT nodema_node_page(CAST(:f AS jsonb),'peak_rtt_ms:asc,avail_7d:desc',"
                "0,10,36,'{SHORT_ID}','compact')"
            ),
            {"f": '{"vantage":"CN"}'},
        )
        fields = compact["fields"]
        assert fields[-12:] == [
            "quality_grade",
            "quality_score",
            "peak_rtt_ms",
            "peak_loss",
            "avail_7d",
            "checked_7d",
            "server_best_grade",
            "unreachable",
            "icmp_only",
            "udp",
            "udp_ms",
            "access_band",
        ]
        assert compact["items"][0][fields.index("quality_grade")] == "S"
        access = session.scalar(sa.text("SELECT nodema_node_access(:id)"), {"id": node["id"]})
        assert access["prefix"] == PREFIX and set(access["grades"]) == {
            "CN-CT",
            "CN-CU",
            "CN-CM",
            "CN",
            "HK",
            "SG",
            "GB",
        }
        assert (
            access["traces"]["CN-CT"]["hop_asns"] == [4134, 4809, 64510]
            and len(access["measurements"]) == 12
        )
        status = session.scalar(sa.text("SELECT nodema_probe_status('CN')"))
        assert (
            status["grades"] == {"S": 2}
            and status["prefixes_peak"] == 1
            and status["prefixes_overseas"] == 1
        )

    # A subscription filtering by grade is rebuilt when grades change.
    exports = ExportService(service, monitor_settings)
    profile = exports.create(
        "uri", {"vantage": "CN", "min_quality_grade": "A", "sort": "quality_grade:asc"}
    )
    exports.build_pending()
    assert exports.get(profile["id"])["node_count"] == 2
    assert exports.get(profile["id"])["status"] == "READY"
    measure(service, port, rtt=0, received=0)  # half the samples lost: poor (C)
    assert refresh.refresh(service.sessions, monitor_settings)["grades"] == {"C": 2}
    with service.sessions.begin() as session:
        session.execute(
            sa.text("DELETE FROM entry_probe_results WHERE received>0 AND vantage LIKE 'CN-%'")
        )
    changed = refresh.refresh(service.sessions, monitor_settings)  # every probe fails now
    assert changed["grades"] == {"D": 2}
    assert catalog.page({"unreachable": True, "vantage": "CN-CM"})["total"] == 2
    exports.build_pending()
    assert exports.get(profile["id"])["node_count"] == 0  # rebuilt after the change


def test_grading_policy_versions_and_validation(service):
    policies = GradingPolicyService(service.sessions)
    original = policies.get()
    assert original["version"] == 1 and original["policy"]["default_vantage"] == "CN"
    updated = policies.set({"default_vantage": "CN-CT"}, expected_version=1)
    assert updated["version"] == 2 and updated["policy"]["default_vantage"] == "CN-CT"
    with pytest.raises(AssetError, match="GRADING_POLICY_CONFLICT"):
        policies.set({}, expected_version=1)
    with pytest.raises(AssetError, match="INVALID_GRADING_POLICY"):
        policies.set({"min_probes": 9})


class FakeClient:
    authenticated = True

    def __init__(self):
        self.remaining, self.requests = 300, []

    def limits(self):
        return self.remaining

    def probes(self):
        from app.probes.globalping import Probe

        return [
            Probe("CN", "Shanghai", 4134, "Chinanet", ("eyeball-network",)),
            Probe("CN", "Beijing", 4837, "China Unicom", ("eyeball-network",)),
            Probe("CN", "Guangzhou", 9808, "China Mobile", ("eyeball-network",)),
            Probe("HK", "Hong Kong", 4760, "HKT", ()),
        ]

    def create(self, body):
        self.requests.append(body)
        return f"id{len(self.requests)}"

    def wait(self, identifier):
        body = self.requests[int(identifier[2:]) - 1]
        results = []
        for location in body["locations"]:
            country = location["country"]
            asn = location.get("asn", 4760 if country == "HK" else 64700)
            probe = {
                "country": country,
                "city": "X",
                "asn": asn,
                "network": "Chinanet" if asn == 4134 else "Net",
                "tags": [],
            }
            if body["type"] == "mtr":
                results.append(
                    {
                        "probe": probe,
                        "result": {
                            "status": "finished",
                            "hops": [
                                {"asn": [asn]},
                                {"asn": [64510], "resolvedAddress": body["target"]},
                            ],
                        },
                    }
                )
            else:
                stats = {"min": 30, "avg": 31, "max": 33, "total": 16, "rcv": 16}
                results.append(
                    {
                        "probe": probe,
                        "result": {
                            "status": "finished",
                            "stats": stats,
                            "timings": [{"rtt": 30}, {"rtt": 32}],
                        },
                    }
                )
        # The public API can return up to location.limit different probes.
        expanded = []
        for result, location in zip(results, body["locations"], strict=True):
            for i in range(location.get("limit", 1)):
                expanded.append({**result, "probe": {**result["probe"], "city": f"X{i}"}})
        return expanded


def test_probe_round_plans_measures_and_records_counts(service, monitor_settings, fixture_bytes):
    seed(service, monitor_settings, fixture_bytes)
    client = FakeClient()
    off_peak = datetime(2026, 11, 13, 4, 0, tzinfo=UTC)  # 12:00 Beijing
    summary = runner.run(service.sessions, monitor_settings, client=client, clock=lambda: off_peak)
    assert (
        summary["status"] == "OK"
        and not summary["peak"]
        and summary["measurements"] == len(client.requests)
    )
    kinds = {
        (r["type"], tuple(sorted(loc["country"] for loc in r["locations"])))
        for r in client.requests
    }
    assert (
        ("mtr", ("CN", "CN", "CN")) in kinds
        and ("ping", ("HK",)) in kinds
        and ("ping", ("SG",)) in kinds
        and ("ping", ("CN",)) in kinds
    )
    assert all(r["target"] == "198.51.100.1" for r in client.requests)  # IPs only, never hostnames
    with service.sessions() as session:
        stored = session.scalars(sa.select(EntryProbeResult)).all()
        assert {r.vantage for r in stored} >= {"CN-CT", "CN-CU", "CN-CM", "HK", "CN"}
        assert session.scalar(sa.select(sa.func.count()).select_from(EntryRouteTrace)) == 3
        run = session.scalars(sa.select(EntryProbeRun)).one()
        assert run.tests == summary["tests"] and run.authenticated and run.probes["CN-CT"] == 1
    again = runner.run(
        service.sessions, monitor_settings, client=FakeClient(), clock=lambda: off_peak
    )
    assert again["planned"] == 0  # everything is fresh
    peak = datetime(2026, 11, 13, 13, 0, tzinfo=UTC)
    evening = FakeClient()
    assert runner.run(service.sessions, monitor_settings, client=evening, clock=lambda: peak)[
        "peak"
    ]
    assert evening.requests and all(len(r["locations"]) == 3 for r in evening.requests)
    assert runner.cleanup(service.sessions, days=14) == 0
    GradingPolicyService(service.sessions).set({"probe_enabled": False})
    assert (
        runner.run(service.sessions, monitor_settings, client=FakeClient())["status"] == "DISABLED"
    )


def test_cloudflare_landings_are_neither_measured_nor_graded(
    service, monitor_settings, fixture_bytes
):
    _, catalog, _ = seed(service, monitor_settings, fixture_bytes)
    excluded, kept = sorted(n["id"] for n in catalog.nodes()["items"])
    with service.sessions.begin() as session:
        session.execute(
            sa.text("UPDATE node_current_status SET last_exit_asn=13335 WHERE node_id=:id"),
            {"id": excluded},
        )
    result = refresh.refresh(service.sessions, monitor_settings)
    assert result["nodes"] == 1 and result["rows"] == 7
    with service.sessions() as session:
        graded = set(session.scalars(sa.select(NodeGrade.node_id).distinct()))
        assert graded == {kept}
        entries = runner.load_nodes(session, monitor_settings.freshness_hours, "ALL")
        assert len(entries) == 1  # the landing on Cloudflare is not probed
    by_id = {n["id"]: n for n in catalog.page({"vantage": "CN"})["items"]}
    assert by_id[excluded]["quality_grade"] is None  # "not graded", never PENDING
    assert by_id[kept]["quality_grade"] == "B"  # three checked days, entry not measured
    assert catalog.page({"min_quality_grade": "C"})["total"] == 1


class NoHomeProbes(FakeClient):
    """Globalping answers 422 when no home-broadband probe matches a location."""

    def create(self, body):
        if any("tags" in loc and loc["country"] in ("HK", "SG") for loc in body["locations"]):
            from app.probes.globalping import ApiError

            raise ApiError("HTTP_422")
        return super().create(body)


def test_overseas_measurement_falls_back_to_any_probe(service, monitor_settings, fixture_bytes):
    seed(service, monitor_settings, fixture_bytes)
    client = NoHomeProbes()
    off_peak = datetime(2026, 11, 13, 4, 0, tzinfo=UTC)
    summary = runner.run(service.sessions, monitor_settings, client=client, clock=lambda: off_peak)
    assert summary["status"] == "OK" and summary["failed"] == 0
    overseas = [
        r for r in client.requests if {loc["country"] for loc in r["locations"]} <= {"HK", "SG"}
    ]
    assert overseas and all("tags" not in loc for r in overseas for loc in r["locations"])
    assert all(len(r["locations"]) == 1 for r in overseas) and summary["failed_codes"] == {}


def test_service_rejection_is_remembered_without_marking_nodes_down(
    service, monitor_settings, fixture_bytes
):
    _, catalog, _ = seed(service, monitor_settings, fixture_bytes)
    before = catalog.page()["items"]

    class Rejected(FakeClient):
        def create(self, body):
            self.requests.append(body)
            raise AssetApiError("TARGET_NOT_ALLOWED")

    from app.probes.globalping import ApiError as AssetApiError

    client = Rejected()
    summary = runner.run(service.sessions, monitor_settings, client=client)
    assert summary["failed_codes"]["TARGET_NOT_ALLOWED"] > 0 and summary["stored"] == 0
    with service.sessions() as session:
        rejections = session.scalars(sa.select(EntryProbeRejection)).all()
        assert len(rejections) == 1
        assert rejections[0].retry_after > datetime.now(UTC) + timedelta(days=6)
    again = runner.run(service.sessions, monitor_settings, client=Rejected())
    assert again["planned"] == 0
    assert [(n["id"], n["status"]) for n in catalog.page()["items"]] == [
        (n["id"], n["status"]) for n in before
    ]


@pytest.mark.parametrize("exhausted", [False, True])
def test_probe_round_uses_configured_account_pool(
    service, monitor_settings, fixture_bytes, monkeypatch, exhausted
):
    from pydantic import SecretStr

    from app.probes import globalping

    seed(service, monitor_settings, fixture_bytes)
    clients = []

    class AccountClient(FakeClient):
        def __init__(self, base, token, timeout):
            super().__init__()
            self.token = token
            self.remaining = 500
            self.waited = []
            clients.append(self)

        def limits(self):
            if self.token == "bad":
                raise globalping.ApiError("HTTP_401")
            return self.remaining

        def create(self, body):
            if exhausted:
                raise globalping.RateLimited()
            self.remaining -= sum(loc.get("limit", 1) for loc in body["locations"])
            return self.token + super().create(body)

        def wait(self, identifier):
            assert identifier.startswith(self.token)
            self.waited.append(identifier)
            return super().wait(identifier.removeprefix(self.token))

    monkeypatch.setattr(globalping, "Client", AccountClient)
    settings = monitor_settings.model_copy(
        update={
            "globalping_tokens": SecretStr("one\ntwo,bad,one"),
            "globalping_token": SecretStr("legacy-ignored"),
            "probe_concurrency": 4,
        }
    )
    summary = runner.run(
        service.sessions, settings, clock=lambda: datetime(2026, 11, 13, 4, tzinfo=UTC)
    )
    assert summary["status"] == "OK" and summary["budget"] == 990
    assert summary["accounts"] == 3 and [c.token for c in clients] == ["one", "two", "bad"]
    if exhausted:
        assert summary["rate_limited"] > 0 and summary["accounts_rate_limited"] == 2
        assert summary["accounts_unavailable"] == 3
        assert summary["measurements"] == 0
    else:
        assert summary["accounts_unavailable"] == 1 and summary["rate_limited"] == 0
        assert all(c.requests and c.waited for c in clients[:2])
        assert summary["tests"] > 0 and summary["stored"] > 0
    with service.sessions() as session:
        row = session.scalars(sa.select(EntryProbeRun)).one()
        expected_remaining = 0 if exhausted else sum(c.remaining for c in clients[:2])
        assert row.remaining == expected_remaining
        assert row.authenticated and row.tests == summary["tests"]
