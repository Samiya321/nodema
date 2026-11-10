from datetime import UTC, datetime, timedelta

import pytest
import sqlalchemy as sa

from app.catalog import Catalog
from app.checker.health import Observation
from app.database.models import Node, NodeAnnotation, NodeCurrentStatus, RunnerNodeSummary
from app.domain import AssetError, SourceType
from app.exports import ExportService
from app.quality import QualityService
from app.scans import ScanService

pytestmark = pytest.mark.integration
PROBE = "synthetic:JP:64500:4:echo-v1"


def seed(service, settings, fixture_bytes, days=3):
    raw = fixture_bytes("sample_vless.txt")
    source = service.create_source(
        name="synthetic",
        source_type=SourceType.RAW_TEXT,
        payload=raw + raw.replace(b"000001", b"000002"),
    )
    service.sync_source(source["id"])

    class Checker:
        def preflight(self):
            pass

        def close(self):
            pass

        def check(self, identity, short_id):
            return Observation(
                status="UP",
                entry_country="SG",
                entry_asn=64510,
                entry_ips=["198.51.100.1"],
                exit_country="JP",
                exit_asn=64520,
                exit_ip="203.0.113.1",
                http_duration_ms=10 if identity["uuid"].endswith("1") else 50,
                probe_key=PROBE,
                probe_metadata={"country": "JP", "asn": 64500},
            )

    scans = ScanService(service, settings, checker_factory=Checker)
    for day in range(days):
        run = scans.create(datetime.now(UTC).date() - timedelta(days=day))
        for shard in scans.get(run["id"])["shards"]:
            scans.run_shard(run["id"], shard["shard_no"])
        scans.finalize(run["id"])
    return source["id"], Catalog(service, settings), QualityService(service)


def test_reference_rules_are_explainable_and_never_infer_line_type(
    service, monitor_settings, fixture_bytes
):
    _, catalog, quality = seed(service, monitor_settings, fixture_bytes)
    nodes = catalog.nodes()["items"]
    assert {n["grade"] for n in nodes} == {"P2"}
    assert all(n["sample_count"] == 3 and n["success_rate"] == 1 for n in nodes)
    assert all(n["mainland_reachability"] == "UNKNOWN" for n in nodes)
    from uuid import uuid4

    with pytest.raises(AssetError, match="NODE_NOT_FOUND"):
        quality.reveal_reference(uuid4())
    original = quality.policy()
    policy = quality.set_policy(
        {"preferred_entry_countries": ["SG"]}, expected_version=original["version"]
    )
    assert policy["version"] == original["version"] + 1 and len(policy["history"]) == 2
    assert catalog.nodes()["items"][0]["grade"] == "P1"
    assert catalog.nodes()["items"][0]["confidence"] == "LOW"
    with pytest.raises(AssetError, match="QUALITY_POLICY_CONFLICT"):
        quality.set_policy({}, expected_version=original["version"])
    quality.set_policy({})
    node_id = nodes[0]["id"]
    quality.annotate(
        node_id, {"line_claim": "IPLC", "evidence_level": "DECLARED", "tags": ["personal"]}
    )
    node = catalog.node(node_id)
    assert node["grade"] == "P2" and node["line_type"] == "UNKNOWN"
    assert "UNVERIFIED_SOURCE_CLAIM" in node["reasons"]
    reference = "https://reference.example/private?token=synthetic-evidence-secret"
    quality.annotate(
        node_id, {"reference": reference, "evidence_level": "DOCUMENTED", "operators": ["CT"]}
    )
    assert catalog.node(node_id)["grade"] == "P2"
    scoped = catalog.nodes(operator="CT", tags=["personal"])["items"][0]
    assert scoped["grade"] == "P1" and scoped["confidence"] == "MEDIUM"
    assert scoped["rule_version"] == quality.policy()["version"]
    assert reference not in str(scoped) + str(quality.annotation(node_id))
    assert quality.reveal_reference(node_id)["reference"] == reference
    with service.sessions() as session:
        row = session.get(NodeAnnotation, node_id)
        assert b"synthetic-evidence-secret" in row.reference_data
        assert session.get(Node, node_id).line_type == "UNKNOWN"
    with service.sessions.begin() as session:
        session.get(NodeAnnotation, node_id).evidence_updated_at = datetime.now(UTC) - timedelta(
            days=100
        )
    assert catalog.nodes(id=str(node_id), operator="CT")["items"][0]["grade"] == "P2"


def test_catalog_filters_sort_nulls_and_stable_pagination_apply_to_exports(
    service, monitor_settings, fixture_bytes, monkeypatch
):
    source, catalog, quality = seed(service, monitor_settings, fixture_bytes)
    monkeypatch.setattr(service, "list_nodes", lambda: pytest.fail("catalog fetched every node"))
    filtered = catalog.nodes(
        status="UP",
        source_id=str(source),
        entry_country="SG",
        exit_asn=64520,
        entry_ip="198.51.100.1",
        min_success_rate=0.9,
        sort="http_p95_ms:desc,short_id:asc",
    )
    assert filtered["total"] == 2
    assert [n["http_p95_ms"] for n in filtered["items"]] == [50, 10]
    assert len(catalog.nodes(offset=1, limit=1)["items"]) == 1
    assert catalog.nodes(entry_asn=64520)["total"] == 0  # Entry and exit are independent.
    assert catalog.nodes(asn=64520)["total"] == 2
    exports = ExportService(service, monitor_settings)
    artifact = exports.create(
        "json", {"sort": "http_p95_ms:asc", "limit": 1, "source_id": str(source)}, build=True
    )
    assert artifact["node_count"] == 1
    data, _, _ = exports.download(artifact["id"], artifact["token"])
    assert b'"http_duration_ms": 10' in data
    assert catalog.overview()["total"] == 2
    for kwargs in (
        {"sort": "short_id;DROP TABLE nodes:asc"},
        {"sort": "unknown:desc"},
        {"entry_asn": "secret"},
        {"mystery": "private"},
    ):
        with pytest.raises(AssetError):
            catalog.nodes(**kwargs)
    assert catalog.nodes()["total"] == 2


def test_insufficient_stale_missing_and_poor_history_are_distinct(
    service, monitor_settings, fixture_bytes
):
    _, catalog, quality = seed(service, monitor_settings, fixture_bytes, days=1)
    node_id = catalog.nodes()["items"][0]["id"]
    assert catalog.node(node_id)["grade"] == "U"
    quality.set_policy({"min_samples": 1})
    with service.sessions.begin() as session:
        summary = session.get(RunnerNodeSummary, (node_id, PROBE))
        summary.success_rate = 0.5
    assert catalog.node(node_id)["grade"] == "P3"
    with service.sessions.begin() as session:
        session.get(RunnerNodeSummary, (node_id, PROBE)).success_rate = 1
        session.get(NodeCurrentStatus, node_id).entry_asn = None
    assert "MISSING_METADATA" in catalog.node(node_id)["reasons"]
    with service.sessions.begin() as session:
        session.get(NodeCurrentStatus, node_id).last_checked_at = datetime.now(UTC) - timedelta(
            days=3
        )
    assert catalog.node(node_id)["status"] == "STALE"
    assert "NOT_CURRENTLY_AVAILABLE" in catalog.node(node_id)["reasons"]


def test_catalog_projection_allows_postgres_to_push_down_index_filters(
    service, monitor_settings, fixture_bytes
):
    seed(service, monitor_settings, fixture_bytes, days=1)
    with service.sessions() as session:
        session.execute(sa.text("SET LOCAL enable_seqscan=off"))
        plan = session.scalar(
            sa.text("""EXPLAIN (FORMAT JSON)
            SELECT id FROM nodema_catalog(36,'{SHORT_ID}','GENERAL')
            WHERE protocol='vless' ORDER BY short_id LIMIT 10""")
        )[0]["Plan"]

    def flatten(node):
        return [node] + [child for p in node.get("Plans", []) for child in flatten(p)]

    nodes = flatten(plan)
    assert not any(n["Node Type"] == "Function Scan" for n in nodes)
    assert any(
        n.get("Index Name") == "idx_nodes_protocol" and "protocol" in n.get("Index Cond", "")
        for n in nodes
    )


def test_database_names_escape_braces_and_query_rejects_invalid_ranges(
    service, monitor_settings, fixture_bytes
):
    _, catalog, _ = seed(service, monitor_settings, fixture_bytes, days=1)
    catalog.set_template("{{{SHORT_ID}}} {PROTOCOL}")
    row = catalog.nodes(limit=1)["items"][0]
    assert row["name"] == "{" + row["short_id"] + "} VLESS"
    assert catalog.nodes(offset=999)["items"] == []
    assert catalog.nodes(q="no-synthetic-match")["total"] == 0
    for filters in (
        [],
        {"entry_asn": None},
        {"min_success_rate": 1.1},
        {"max_timeout_rate": 2},
        {"server_port": 65536},
        {"min_samples": 1.5},
        {"tags": [123]},
        {"entry_ip": {}},
        {"last_checked_after": "2026-11-09"},
    ):
        with pytest.raises(AssetError):
            catalog.page(filters)


def test_reference_grade_decision_table(db_engine):
    import copy
    import json

    from app.quality import DEFAULT_POLICY

    base = {
        "eligible": True,
        "status": "UP",
        "sample_count": 3,
        "probe_key": PROBE,
        "success_rate": 1,
        "entry_country": "SG",
        "entry_asn": 64510,
        "exit_country": "JP",
        "exit_asn": 64520,
        "protocol": "vless",
        "has_evidence": False,
        "evidence_level": "NONE",
        "evidence_updated_at": None,
        "operators": ["GENERAL"],
        "manual_priority": "NONE",
    }
    cases = [
        ({}, {}, "GENERAL", "P2", "LOW", "RUNNER_AVAILABLE"),
        ({"eligible": False}, {}, "GENERAL", "U", "UNKNOWN", "NOT_CURRENTLY_AVAILABLE"),
        ({"status": "DEGRADED"}, {}, "GENERAL", "U", "UNKNOWN", "NOT_CURRENTLY_AVAILABLE"),
        ({"sample_count": 2}, {}, "GENERAL", "U", "UNKNOWN", "INSUFFICIENT_SAMPLES"),
        ({"probe_key": "legacy"}, {}, "GENERAL", "U", "UNKNOWN", "RUNNER_SCOPE_UNKNOWN"),
        (
            {"probe_key": "unlocated:synthetic"},
            {},
            "GENERAL",
            "U",
            "UNKNOWN",
            "RUNNER_SCOPE_UNKNOWN",
        ),
        (
            {"success_rate": 0.5, "manual_priority": "P1"},
            {},
            "GENERAL",
            "P3",
            "LOW",
            "RUNNER_HISTORY_UNSTABLE",
        ),
        ({"entry_asn": None}, {}, "GENERAL", "U", "UNKNOWN", "MISSING_METADATA"),
        ({"manual_priority": "P3"}, {}, "GENERAL", "P3", "LOW", "MANUAL_PREFERENCE"),
        (
            {"evidence_level": "DECLARED", "line_claim": "IPLC"},
            {},
            "GENERAL",
            "P2",
            "LOW",
            "UNVERIFIED_SOURCE_CLAIM",
        ),
        (
            {
                "has_evidence": True,
                "evidence_level": "DOCUMENTED",
                "evidence_updated_at": datetime.now(UTC).isoformat(),
            },
            {},
            "GENERAL",
            "P1",
            "MEDIUM",
            "DOCUMENTED_REFERENCE",
        ),
        ({}, {"preferred_protocols": ["vless"]}, "GENERAL", "P1", "LOW", "PREFERRED_PROTOCOL"),
        ({}, {"preferred_exit_asns": [64520]}, "GENERAL", "P1", "LOW", "PREFERRED_EXIT_ASN"),
        (
            {},
            {
                "preferred_entry_countries": ["SG"],
                "operator_preferences": {"CT": {"preferred_entry_countries": ["HK"]}},
            },
            "CT",
            "P2",
            "LOW",
            "RUNNER_AVAILABLE",
        ),
    ]
    with db_engine.connect() as conn:
        for changed, preferences, operator, grade, confidence, reason in cases:
            policy = {**copy.deepcopy(DEFAULT_POLICY), **preferences}
            result = conn.scalar(
                sa.text(
                    "SELECT nodema_grade(CAST(:node AS jsonb),CAST(:policy AS jsonb),7,:operator)"
                ),
                {
                    "node": json.dumps({**base, **changed}),
                    "policy": json.dumps(policy),
                    "operator": operator,
                },
            )
            assert (result["grade"], result["confidence"]) == (grade, confidence)
            assert reason in result["reasons"] and "NO_MAINLAND_MEASUREMENT" in result["reasons"]
            assert result["rule_version"] == 7 and result["mainland_reachability"] == "UNKNOWN"


def test_export_projection_omits_large_observation_details_and_evidence(
    service, monitor_settings, fixture_bytes
):
    import json

    from app.database.models import TestResult as Result

    _, catalog, _ = seed(service, monitor_settings, fixture_bytes, days=1)
    node = catalog.nodes(limit=1)["items"][0]
    with service.sessions.begin() as session:
        current = session.get(NodeCurrentStatus, node["id"])
        session.get(Result, current.last_result_id).precheck_metadata = {
            "diagnostic": "x" * 1_000_000
        }
    with service.sessions() as session:
        params = {"filters": json.dumps({"id": str(node["id"])}), "template": catalog.template()}
        result = session.scalar(
            sa.text(
                "SELECT nodema_node_page(CAST(:filters AS jsonb),"
                "'short_id:asc',0,1,36,:template,'identity')"
            ),
            params,
        )
        assert set(result["items"][0]) == {"id", "short_id", "name", "last_success_at"}
        assert len(json.dumps(result)) < 500
        report = session.scalar(
            sa.text(
                "SELECT nodema_node_page(CAST(:filters AS jsonb),"
                "'short_id:asc',0,1,36,:template,'report')"
            ),
            params,
        )
        assert report["items"][0]["grade"] == "U"
        assert "precheck_metadata" not in report["items"][0]
        assert len(json.dumps(report)) < 2000
    assert len(json.dumps(catalog.nodes(id=str(node["id"])), default=str)) > 1_000_000
