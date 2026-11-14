import io
import json
import random
import urllib.error
from datetime import UTC, datetime, timedelta

import pytest

from app.domain import AssetError
from app.grading import (
    DEFAULT_GRADING,
    Access,
    NodeFacts,
    Sample,
    access_band,
    access_stats,
    combine_cn,
    grade_node,
    is_peak,
    minutes,
    stability_band,
    validate_grading,
)
from app.probes import globalping, planner

POLICY = validate_grading({})
NOW = datetime(2026, 11, 13, 13, 0, tzinfo=UTC)  # 21:00 Beijing


def samples(rtts, *, target="198.51.100.1:443", peak=True, received=16, probes=2, jitter=2.0):
    return [
        Sample(target, 16, received, rtt if received else None, jitter, peak, f"p{i % probes}", NOW)
        for i, rtt in enumerate(rtts)
    ]


def test_policy_defaults_and_validation():
    assert validate_grading({}) == DEFAULT_GRADING
    assert validate_grading({"default_vantage": "CN-CT"})["default_vantage"] == "CN-CT"
    for bad in (
        {"unknown": 1},
        {"default_vantage": "US"},
        {"min_probes": 0},
        {"peak_start": "25:00"},
        {"peak_start": "20:00", "peak_end": "20:00"},
        {"stability_pct": {"S": 50, "A": 80, "B": 60}},
        {"probe_enabled": "yes"},
        {"bands": {"CN": DEFAULT_GRADING["bands"]["CN"]}},
    ):
        with pytest.raises(AssetError, match="INVALID_GRADING_POLICY"):
            validate_grading(bad)
    bands = json.loads(json.dumps(DEFAULT_GRADING["bands"]))
    bands["CN"]["A"]["rtt_ms"] = 60  # looser band cannot be stricter than S
    with pytest.raises(AssetError):
        validate_grading({"bands": bands})


def test_peak_window_wraps_midnight():
    assert is_peak(minutes("21:00"), POLICY) and not is_peak(minutes("12:00"), POLICY)
    late = {**POLICY, "peak_start": "22:00", "peak_end": "01:00"}
    assert is_peak(minutes("00:30"), late) and is_peak(minutes("23:00"), late)
    assert not is_peak(minutes("01:00"), late)


def test_access_bands_from_peak_samples():
    good = access_stats(samples([40, 42, 44, 41]), None, True, POLICY)
    assert good.sufficient and good.rtt == 41.5 and good.loss == 0 and good.probes == 2
    assert access_band(good, "CN-CT", POLICY) == "S"
    jittery = access_stats(samples([40, 42], jitter=30), None, True, POLICY)
    assert access_band(jittery, "CN-CT", POLICY) == "A"
    risen = access_stats(samples([70, 72]) + samples([30, 31], peak=False), None, True, POLICY)
    assert risen.idle_rtt == 30.5 and access_band(risen, "CN-CU", POLICY) == "A"
    slow = access_stats(samples([260, 280]), None, True, POLICY)
    assert access_band(slow, "CN-CM", POLICY) == "C"
    one_probe = access_stats(samples([40, 41], probes=1), None, True, POLICY)
    assert not one_probe.sufficient and access_band(one_probe, "CN-CT", POLICY) is None
    idle_only = access_stats(samples([40, 41], peak=False), None, True, POLICY)
    assert idle_only.samples == 0 and access_band(idle_only, "CN-CT", POLICY) is None
    # HK/SG use every sample, with stricter overseas bands.
    assert (
        access_band(access_stats(samples([20, 22], peak=False), None, False, POLICY), "HK", POLICY)
        == "S"
    )
    assert access_band(access_stats(samples([90, 95]), None, False, POLICY), "SG", POLICY) == "B"


def test_dead_target_is_excluded_and_marks_only_its_nodes():
    dead = samples([0, 0], target="198.51.100.9:443", received=0)
    alive = samples([50, 52])
    shared = access_stats(dead + alive, "198.51.100.1:443", True, POLICY)
    assert not shared.unreachable and shared.loss == 0 and shared.rtt == 51
    own = access_stats(dead + alive, "198.51.100.9:443", True, POLICY)
    assert own.unreachable


def test_grades_take_the_worse_band_and_explain_it():
    access = access_stats(samples([40, 42]), "198.51.100.1:443", True, POLICY)
    facts = NodeFacts("vless", "198.51.100.1:443", 7, 7)
    best = grade_node(facts, "CN-CT", access, False, POLICY)
    assert best.grade == "S" and best.access_band == "S" and best.stability_band == "S"
    assert any("电信晚高峰 RTT 41 ms" in r for r in best.reasons)
    shaky = grade_node(NodeFacts("vless", "198.51.100.1:443", 5, 7), "CN-CT", access, False, POLICY)
    assert shaky.grade == "B" and shaky.stability_band == "B"
    assert (
        grade_node(NodeFacts("vless", "x", 2, 2), "CN-CT", access, False, POLICY).grade == "PENDING"
    )
    assert grade_node(facts, "CN-CT", Access(), False, POLICY).grade == "B"  # unmeasured: capped
    assert grade_node(NodeFacts("vless", None, 7, 7), "HK", Access(), False, POLICY).grade == "B"
    cdn = grade_node(
        NodeFacts("vless", "104.16.0.1:443", 7, 7, cdn_entry=True), "SG", Access(), False, POLICY
    )
    assert cdn.grade == "B" and cdn.access_band is None
    assert any("Cloudflare CDN" in r for r in cdn.reasons)
    assert (
        grade_node(
            NodeFacts("hysteria2", "198.51.100.1", 7, 7), "CN-CT", access, False, POLICY
        ).grade
        == "A"
    )
    blocked = grade_node(facts, "CN-CU", access, True, POLICY)
    assert blocked.grade == "D" and blocked.unreachable
    assert grade_node(facts, "HK", access, True, POLICY).grade == "A"  # mainland check only
    clean = {**POLICY, "s_requires_clean_exit": True}
    flagged = NodeFacts("vless", "198.51.100.1:443", 7, 7, exit_ip_proxy=True)
    assert grade_node(flagged, "CN-CT", access, False, clean).grade == "A"
    assert stability_band(6, 7, POLICY) == "A" and stability_band(4, 7, POLICY) == "C"


def test_three_carrier_grade_is_the_worst_carrier():
    facts = NodeFacts("vless", "198.51.100.1:443", 7, 7)
    fast = access_stats(samples([40, 42]), None, True, POLICY)
    slow = access_stats(samples([200, 210]), None, True, POLICY)
    result = combine_cn(
        {
            "CN-CT": grade_node(facts, "CN-CT", fast, False, POLICY),
            "CN-CU": grade_node(facts, "CN-CU", slow, False, POLICY),
            "CN-CM": grade_node(facts, "CN-CM", fast, False, POLICY),
        }
    )
    assert result.grade == "B" and result.access.rtt == 205
    blocked = {c: grade_node(facts, c, fast, True, POLICY) for c in ("CN-CT", "CN-CU", "CN-CM")}
    assert combine_cn(blocked).grade == "D" and combine_cn(blocked).unreachable


def nodes():
    return [
        planner.EntryNode(1, "vless", "198.51.100.1", 443, 64500),
        planner.EntryNode(2, "trojan", "198.51.100.1", 443, 64500),
        planner.EntryNode(3, "vmess", "198.51.100.7", 8443, 64500),
        planner.EntryNode(4, "hysteria2", "203.0.113.5", 443, 64501),
        planner.EntryNode(5, "vless", "104.16.0.1", 443, 13335),
        planner.EntryNode(6, "vless", "104.17.0.1", 443, 13335),
        planner.EntryNode(7, "vless", None, 443, None),
    ]


CARRIERS = {"CN-CT": [4134], "CN-CU": [4837], "CN-CM": [9808]}


def test_prefixes_group_routes_cloudflare_and_udp_entries():
    groups = planner.group(nodes())
    assert set(groups) == {"198.51.100", "203.0.113", "cf"}
    assert groups["198.51.100"].tcp == {"198.51.100.1:443": 2, "198.51.100.7:8443": 1}
    assert planner.representative(groups["198.51.100"], frozenset(), 0) == (
        "198.51.100.1:443",
        "TCP",
    )
    assert (
        planner.representative(groups["198.51.100"], frozenset({"198.51.100.1:443"}), 0)[0]
        == "198.51.100.7:8443"
    )
    assert planner.representative(groups["203.0.113"], frozenset(), 0) == ("203.0.113.5", "ICMP")
    picks = {planner.representative(groups["cf"], frozenset(), r)[0] for r in range(4)}
    assert len(picks) == 2  # the anycast class rotates its representative
    assert planner.ipv4(["2001:db8::1", "10.0.0.1"]) is None


def test_peak_plan_buys_only_carrier_samples_within_budget():
    groups = planner.group(nodes())
    tasks = planner.plan(
        groups, planner.History(), CARRIERS, now=NOW, peak=True, budget=7, min_probes=2
    )
    assert [t.kind for t in tasks] == ["QUALITY_CN", "QUALITY_CN"] and sum(
        t.cost for t in tasks
    ) == 6
    request = tasks[0].request()
    assert request["type"] == "ping" and request["measurementOptions"]["packets"] == 16
    assert {loc["asn"] for loc in request["locations"]} == {4134, 4837, 9808}
    assert all(loc["tags"] == ["eyeball-network"] for loc in request["locations"])
    poor = planner.History(idle_poor=frozenset({"198.51.100", "203.0.113", "cf"}))
    assert planner.plan(groups, poor, CARRIERS, now=NOW, peak=True, budget=99, min_probes=2) == []


def test_off_peak_plan_covers_reach_overseas_idle_and_routes():
    groups = planner.group(nodes())
    tasks = planner.plan(
        groups, planner.History(), CARRIERS, now=NOW, peak=False, budget=999, min_probes=2
    )
    kinds = {t.kind for t in tasks}
    assert kinds == {"QUALITY_CN", "QUALITY_OVERSEAS", "REACH", "TRACE"}
    reach = [t for t in tasks if t.kind == "REACH"]
    assert {t.target for t in reach} == {"198.51.100.1:443", "198.51.100.7:8443"}  # not CF/UDP
    trace = next(t for t in tasks if t.kind == "TRACE").request()
    assert trace["type"] == "mtr" and trace["measurementOptions"]["protocol"] == "TCP"
    icmp = next(t for t in tasks if t.prefix == "203.0.113" and t.kind == "QUALITY_OVERSEAS")
    assert icmp.request()["measurementOptions"] == {"packets": 16, "protocol": "ICMP"}
    # HK/SG: home-broadband probes; the Cloudflare edge is never measured from there.
    overseas = [t for t in tasks if t.kind == "QUALITY_OVERSEAS"]
    assert overseas and all(t.prefix != planner.CF_PREFIX for t in overseas)
    assert all(
        loc["tags"] == ["eyeball-network"] for t in overseas for loc in t.request()["locations"]
    )
    assert any(t.prefix == planner.CF_PREFIX and t.kind == "QUALITY_CN" for t in tasks)
    # HK fresh, SG missing: only SG is bought again, one location per measurement.
    half = planner.History(last_overseas={(p, "HK"): NOW for p in groups})
    again = planner.plan(groups, half, CARRIERS, now=NOW, peak=False, budget=999, min_probes=2)
    regions = {loc["country"] for t in again if t.kind == "QUALITY_OVERSEAS" for loc in t.locations}
    assert regions == {"SG"} and all(t.cost == 1 for t in again if t.kind == "QUALITY_OVERSEAS")
    recent = planner.History(
        last_reach={t.target: NOW for t in reach},
        last_overseas={(p, r): NOW for p in groups for r in planner.OVERSEAS},
        last_idle={p: NOW for p in groups},
        last_trace={p: NOW - timedelta(days=1) for p in groups},
    )
    assert (
        planner.plan(groups, recent, CARRIERS, now=NOW, peak=False, budget=999, min_probes=2) == []
    )
    small = planner.plan(
        groups,
        planner.History(),
        CARRIERS,
        now=NOW,
        peak=False,
        budget=4,
        min_probes=2,
        rng=random.Random(1),
    )
    assert sum(t.cost for t in small) <= 4


def test_carrier_classification():
    assert planner.carrier_of(4134, None) == "CN-CT"
    assert planner.carrier_of(64999, "China Unicom Shanghai network") == "CN-CU"
    assert planner.carrier_of(56048, "China Mobile Communicaitons") == "CN-CM"
    assert planner.carrier_of(37963, "Hangzhou Alibaba Advertising") is None
    assert planner.vantage_of("HK", 1, None) == "HK" and planner.vantage_of("JP", 1, None) is None


RESULT = {
    "probe": {
        "country": "CN",
        "city": "Shanghai",
        "asn": 4134,
        "network": "Chinanet",
        "tags": ["eyeball-network"],
    },
    "result": {
        "status": "finished",
        "stats": {"min": 30, "avg": 32.5, "max": 35, "total": 4, "rcv": 4, "drop": 0, "loss": 0},
        "timings": [{"rtt": 30}, {"rtt": 32}, {"rtt": 33}, {"rtt": 35}],
    },
}


def test_parse_ping_and_trace_results():
    ping = globalping.parse_ping(RESULT, 4)
    assert (ping.sent, ping.received, ping.rtt_avg, ping.probe.asn) == (4, 4, 32.5, 4134)
    assert ping.jitter == 1.8
    lost = {
        "probe": RESULT["probe"],
        "result": {"status": "finished", "stats": {"total": 4, "rcv": 0}, "timings": []},
    }
    assert (
        globalping.parse_ping(lost, 4).received == 0
        and globalping.parse_ping(lost, 4).rtt_avg is None
    )
    assert globalping.parse_ping({"probe": {}, "result": {"status": "failed"}}, 4) is None
    trace = {
        "probe": RESULT["probe"],
        "result": {
            "status": "finished",
            "hops": [
                {"asn": [], "resolvedAddress": "10.0.0.1"},
                {"asn": [4134]},
                {"asn": [4134]},
                {"asn": [4809], "resolvedAddress": "x"},
                {"asn": [64500], "resolvedAddress": "198.51.100.1"},
            ],
        },
    }
    outcome = globalping.parse_trace(trace, "198.51.100.1")
    assert outcome.hop_asns == (4134, 4809, 64500) and outcome.reached


class FakeResponse(io.BytesIO):
    def __init__(self, body, status=200, headers=None):
        super().__init__(json.dumps(body).encode())
        self.status, self.headers = status, headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def test_client_creates_polls_and_stops_on_rate_limit():
    calls = []

    def opener(request, timeout):
        calls.append((request.get_method(), request.full_url, request.get_header("Authorization")))
        if request.get_method() == "POST":
            return FakeResponse({"id": "abc123"}, 202, {"X-RateLimit-Remaining": "41"})
        if len([c for c in calls if c[0] == "GET"]) == 1:
            return FakeResponse({"status": "in-progress"})
        return FakeResponse({"status": "finished", "results": [RESULT]})

    client = globalping.Client("https://api.example.test/v1", "token-1", opener=opener)
    identifier = client.create({"type": "ping"})
    assert identifier == "abc123" and client.remaining == 41
    assert client.wait(identifier, sleep=lambda s: None) == [RESULT]
    assert calls[0][2] == "Bearer token-1" and calls[-1][1].endswith("/measurements/abc123")

    def limited(request, timeout):
        raise urllib.error.HTTPError(request.full_url, 429, "limit", {}, None)

    with pytest.raises(globalping.RateLimited):
        globalping.Client("https://api.example.test/v1", opener=limited).create({})
    anonymous = globalping.Client("https://api.example.test/v1", opener=opener)
    anonymous.create({})
    assert calls[-1][2] is None and not anonymous.authenticated

    # A brand-new measurement may read as 404 for a moment; a lasting 404 still fails.
    lookups = []

    def late(request, timeout):
        lookups.append(1)
        if len(lookups) < 3:
            raise urllib.error.HTTPError(request.full_url, 404, "missing", {}, None)
        return FakeResponse({"status": "finished", "results": [RESULT]})

    slept = []
    late_client = globalping.Client("https://api.example.test/v1", opener=late)
    assert late_client.wait("abc123", sleep=slept.append) == [RESULT] and slept == [1.0, 1.0]

    def gone(request, timeout):
        raise urllib.error.HTTPError(request.full_url, 404, "missing", {}, None)

    clock = iter([0.0, 0.0, 11.0])
    original = globalping.time.monotonic
    globalping.time.monotonic = lambda: next(clock)
    try:
        with pytest.raises(globalping.ApiError, match="HTTP_404"):
            globalping.Client("https://api.example.test/v1", opener=gone).wait(
                "abc123", sleep=slept.append
            )
    finally:
        globalping.time.monotonic = original


def test_grade_recompute_is_due_after_the_evening_peak_or_twelve_hours():
    from app.probes.refresh import due

    evening_end = datetime(2026, 11, 13, 15, 30, tzinfo=UTC)  # 23:30 Beijing
    assert due(None, NOW, POLICY)
    assert not due(NOW - timedelta(hours=1), NOW, POLICY)  # 21:00, inside the window
    assert due(evening_end - timedelta(minutes=5), evening_end + timedelta(minutes=10), POLICY)
    assert not due(evening_end + timedelta(minutes=1), evening_end + timedelta(hours=3), POLICY)
    assert due(evening_end, evening_end + timedelta(hours=13), POLICY)
