import copy
import errno
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from datetime import UTC, datetime, timedelta

import dns.exception
import dns.resolver
import pytest

from app.checker.health import HealthChecker
from app.checker.precheck import EndpointCache


class Resolver:
    calls = 0

    def resolve_name(self, *args, **kwargs):
        self.calls += 1

        class Answers:
            def addresses(self):
                return ["198.51.100.1", "2001:db8::1"]

        return Answers()


def test_shared_single_flight_dns_tcp_ttl_and_scope(monitor_settings):
    clock = [0]
    resolver, sockets = Resolver(), []

    def connect(address, **kwargs):
        sockets.append(address)
        return nullcontext()

    cache = EndpointCache(
        monitor_settings, resolver=resolver, connector=connect, clock=lambda: clock[0]
    )
    with ThreadPoolExecutor(8) as executor:
        answers = list(
            executor.map(lambda _: cache.resolve("synthetic.example", "runner1"), range(32))
        )
        probes = list(
            executor.map(
                lambda _: cache.tcp("synthetic.example", 443, answers[0]["ips"], "runner1"),
                range(32),
            )
        )
    assert resolver.calls == len(sockets) == 1
    assert sum(a["cached"] for a in answers) == sum(p["cached"] for p in probes) == 31
    assert len({p["check_id"] for p in probes}) == 1
    cache.resolve("synthetic.example", "runner2")
    assert resolver.calls == 2
    clock[0] = 61
    cache.resolve("synthetic.example", "runner1")
    cache.tcp("synthetic.example", 443, answers[0]["ips"], "runner1")
    assert resolver.calls == 3 and len(sockets) == 2


@pytest.mark.parametrize(
    "error,status", [(dns.resolver.NXDOMAIN, "FAILED"), (dns.exception.Timeout, "ERROR")]
)
def test_negative_dns_is_bounded_and_environment_errors_are_not_cached(
    monitor_settings, error, status
):
    class Broken(Resolver):
        def resolve_name(self, *args, **kwargs):
            self.calls += 1
            raise error

    clock, resolver = [0], Broken()
    cache = EndpointCache(monitor_settings, resolver=resolver, clock=lambda: clock[0])
    assert cache.resolve("synthetic.example", "runner")["status"] == status
    cache.resolve("synthetic.example", "runner")
    assert resolver.calls == (1 if status == "FAILED" else 2)
    clock[0] = 16
    cache.resolve("synthetic.example", "runner")
    assert resolver.calls == (2 if status == "FAILED" else 3)


def test_multiple_addresses_require_exhaustive_failure_and_ipv6_success_counts(monitor_settings):
    calls = []

    def connect(address, **kwargs):
        calls.append(address)
        if ":" in address[0]:
            return nullcontext()
        raise ConnectionRefusedError

    cache = EndpointCache(monitor_settings, connector=connect)
    ips = ["198.51.100.1", "2001:db8::1"]
    assert cache.tcp("fixture", 443, ips, "runner")["status"] == "SUCCESS"
    assert len(calls) == 2

    def refuse(*args, **kwargs):
        raise ConnectionRefusedError

    cache = EndpointCache(monitor_settings, connector=refuse)
    failed = cache.tcp("fixture", 443, ips, "runner")
    assert failed["confirmed"] and len(failed["addresses"]) == 4
    assert (
        cache.tcp("many", 443, [f"198.51.100.{i}" for i in range(1, 34)], "runner")["confirmed"]
        is False
    )


def test_network_environment_failure_does_not_justify_gating(monitor_settings):
    def no_network(*args, **kwargs):
        raise OSError(errno.ENETUNREACH, "synthetic")

    assert not EndpointCache(monitor_settings, connector=no_network).tcp(
        "fixture", 443, ["2001:db8::1"], "runner"
    )["confirmed"]


class Runtime:
    port = 12345
    starts = 0

    def preflight(self):
        pass

    def start(self, proxy):
        self.starts += 1

    def set_hosts(self, hosts):
        self.hosts = hosts

    def reset(self):
        pass

    def close(self):
        pass


class Echo:
    url = "https://echo.example/"

    def request(self, port=None):
        return {"ip": "8.8.8.8", "country": "US", "asn": 64512}


class Geo:
    metadata = {}

    def lookup(self, ip):
        return {"country": "US", "asn": 64512, "city": None}

    def close(self):
        pass


def checker(settings, *, refused=False):
    def connect(*args, **kwargs):
        if refused:
            raise ConnectionRefusedError
        return nullcontext()

    runtime = Runtime()
    result = HealthChecker(
        settings,
        runtime=runtime,
        echo=Echo(),
        geoip=Geo(),
        cache=EndpointCache(settings, resolver=Resolver(), connector=connect),
    )
    result.preflight()
    return result


def test_gating_sample_and_force_full_preserve_only_https_as_up(monitor_settings, fixture_bytes):
    from app.parsers import parse_document

    identity = parse_document(fixture_bytes("sample_vless.txt")).nodes[0].identity
    settings = monitor_settings.model_copy(
        update={"precheck_gate_enabled": True, "precheck_sample_rate": 0}
    )
    health = checker(settings, refused=True)
    gated = health.check(identity, "N1")
    assert gated.status == "UNKNOWN" and gated.measurement_kind == "PREFLIGHT"
    assert health.runtime.starts == 0
    for key in ("precheck_sample_rate", "check_force_full"):
        settings = settings.model_copy(update={key: 1 if key.endswith("rate") else True})
        health = checker(settings, refused=True)
        sampled = health.check(identity, "N1")
        assert sampled.status == "UP" and sampled.measurement_kind == "FULL"
        assert health.metrics["full_samples"] == health.runtime.starts == 1


def test_cooldown_is_probe_specific_and_sampled_recovery_is_full(monitor_settings, fixture_bytes):
    from app.parsers import parse_document

    identity = parse_document(fixture_bytes("sample_vless.txt")).nodes[0].identity
    settings = monitor_settings.model_copy(
        update={"failure_cooldown_enabled": True, "precheck_sample_rate": 0}
    )
    health = checker(settings)
    context = {
        "next_full_check_at": datetime.now(UTC) + timedelta(hours=1),
        "probe_key": health.probe_key,
    }
    health.set_context(**context)
    result = health.check(identity, "N1")
    assert result.status == "UNKNOWN" and result.measurement_kind == "SKIPPED"
    assert health.runtime.starts == 0
    health.set_context(**{**context, "probe_key": "different-runner"})
    assert health.check(identity, "N1").status == "UP"
    health.set_context(**context)
    health.settings = settings.model_copy(update={"precheck_sample_rate": 1})
    assert health.check(identity, "N1").status == "UP"
    assert health.metrics["full_samples"] == 1
    assert health.runtime.hosts[identity["server_host"]] == ["198.51.100.1", "2001:db8::1"]


def test_quic_never_gated_by_tcp(monitor_settings, fixture_bytes):
    from app.parsers import parse_document

    identity = copy.deepcopy(
        next(
            n.identity
            for n in parse_document(fixture_bytes("protocols_all.txt")).nodes
            if n.identity["protocol"] == "hysteria2"
        )
    )
    settings = monitor_settings.model_copy(
        update={"precheck_gate_enabled": True, "precheck_sample_rate": 0}
    )
    health = checker(settings, refused=True)
    result = health.check(identity, "N1")
    assert result.status == "UP" and result.tcp_status == "NOT_APPLICABLE"
    assert health.cache.metrics["tcp_probes"] == 0


@pytest.mark.parametrize("kind", ["NXDOMAIN", "NODATA"])
def test_dns_negative_ttl_respects_authoritative_soa(monitor_settings, kind):
    import dns.message
    import dns.rrset

    response = dns.message.make_response(dns.message.make_query("synthetic.example", "A"))
    response.authority.append(
        dns.rrset.from_text(
            "example", 30, "IN", "SOA", "ns.example. hostmaster.example. 1 60 60 60 5"
        )
    )
    error = (
        dns.resolver.NXDOMAIN(
            qnames=[dns.name.from_text("synthetic.example")],
            responses={dns.name.from_text("synthetic.example"): response},
        )
        if kind == "NXDOMAIN"
        else dns.resolver.NoAnswer(response=response)
    )
    assert EndpointCache(monitor_settings)._negative_ttl(error) == 5


def test_runner_without_ipv6_route_skips_instead_of_publishing_a_node_failure(
    monitor_settings, fixture_bytes
):
    from app.parsers import parse_document

    identity = parse_document(fixture_bytes("sample_vless.txt")).nodes[0].identity
    identity["server_host"] = "2001:db8::1"

    def unavailable(*args, **kwargs):
        raise OSError(errno.ENETUNREACH, "synthetic no IPv6 route")

    cache = EndpointCache(monitor_settings, connector=unavailable)
    health = HealthChecker(
        monitor_settings, runtime=Runtime(), echo=Echo(), geoip=Geo(), cache=cache
    )
    health.preflight()
    result = health.check(identity, "N1")
    assert result.status == "UNKNOWN" and result.measurement_kind == "SKIPPED"
    assert result.error_code == "ENTRY_NETWORK_UNAVAILABLE"
    assert health.runtime.starts == 0
    assert result.precheck_metadata["decision"] == "ENTRY_NETWORK_UNAVAILABLE"


def test_quic_ipv6_route_failure_is_local_and_does_not_send_a_datagram(
    monitor_settings, fixture_bytes, monkeypatch
):
    import app.checker.precheck as module
    from app.parsers import parse_document

    class NoRoute:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def connect(self, *args):
            raise OSError(errno.ENETUNREACH, "synthetic route unavailable")

        def send(self, *args):
            pytest.fail("route lookup must not send a datagram")

    monkeypatch.setattr(module.socket, "socket", lambda *args: NoRoute())
    identity = copy.deepcopy(
        next(
            n.identity
            for n in parse_document(fixture_bytes("protocols_all.txt")).nodes
            if n.identity["protocol"] == "hysteria2"
        )
    )
    identity["server_host"] = "2001:db8::1"
    health = checker(monitor_settings)
    result = health.check(identity, "N1")
    assert result.status == "UNKNOWN" and result.measurement_kind == "SKIPPED"
    assert result.tcp_status == "NOT_APPLICABLE" and health.runtime.starts == 0
    assert result.error_code == "ENTRY_NETWORK_UNAVAILABLE"
