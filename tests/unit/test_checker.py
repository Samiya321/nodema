import copy
from contextlib import nullcontext

import pytest

from app.checker.health import HealthChecker
from app.conversion import to_mihomo, to_singbox, to_uri
from app.domain import AssetError
from app.parsers import parse_document, parse_vless


class Runtime:
    port = 23456

    def preflight(self):
        pass

    def start(self, proxy):
        self.proxy = proxy

    def close(self):
        pass


class Geo:
    metadata = {"city_build_epoch": None}

    def lookup(self, ip):
        return {"country": "US", "city": None, "asn": 64501}

    def close(self):
        pass


class Echo:
    url = "https://echo.example/"

    def request(self, port=None):
        return {"ip": "8.8.8.8", "country": "JP", "asn": 64501}


def test_proxy_success_determines_up_and_exit_not_tcp(monkeypatch, monitor_settings, fixture_bytes):
    import app.checker.health as module

    def no_tcp(*args, **kwargs):
        raise OSError

    monkeypatch.setattr(module.socket, "create_connection", no_tcp)
    runtime = Runtime()
    checker = HealthChecker(monitor_settings, runtime=runtime, echo=Echo(), geoip=Geo())
    identity = parse_document(fixture_bytes("sample_vless.txt")).nodes[0].identity
    identity["server_host"] = "198.51.100.1"
    result = checker.check(identity, "N000001")
    assert result.status == "UP" and result.tcp_status == "FAILED"
    assert result.exit_ip == "8.8.8.8" and result.exit_country == "JP"
    assert result.geoip_metadata["entry"][0]["ip"] == "198.51.100.1"
    assert result.geoip_metadata["exit"]["asn"] == 64501
    assert result.geoip_metadata["entry"][0]["queried_at"]
    assert "entry" not in Geo.metadata


def test_all_dns_addresses_keep_separate_geoip_evidence(
    monkeypatch, monitor_settings, fixture_bytes
):
    import app.checker.health as module

    monkeypatch.setattr(module.socket, "create_connection", lambda *a, **k: nullcontext())

    class Resolver:
        def resolve_name(self, *args, **kwargs):
            class Answers:
                def addresses(self):
                    return ["8.8.8.8", "1.1.1.1"]

            return Answers()

    class DistinctGeo(Geo):
        def lookup(self, ip):
            return {
                "country": "US" if ip == "8.8.8.8" else "AU",
                "city": "Synthetic",
                "asn": 64501 if ip == "8.8.8.8" else 64502,
                "organization": "Synthetic ASN",
            }

    checker = HealthChecker(
        monitor_settings, runtime=Runtime(), echo=Echo(), geoip=DistinctGeo(), resolver=Resolver()
    )
    identity = parse_document(fixture_bytes("sample_vless.txt")).nodes[0].identity
    result = checker.check(identity, "N000001")
    entries = result.geoip_metadata["entry"]
    assert [r["ip"] for r in entries] == ["8.8.8.8", "1.1.1.1"]
    assert [r["asn"] for r in entries] == [64501, 64502]
    assert all(r["organization"] == "Synthetic ASN" and r["queried_at"] for r in entries)


def test_tcp_success_proxy_failure_is_not_up(monkeypatch, monitor_settings, fixture_bytes):
    import app.checker.health as module

    monkeypatch.setattr(module.socket, "create_connection", lambda *a, **k: nullcontext())

    class BrokenProxy(Echo):
        def request(self, port=None):
            if port:
                raise AssetError("ECHO_REQUEST_FAILED")
            return super().request()

    identity = parse_document(fixture_bytes("sample_vless.txt")).nodes[0].identity
    identity["server_host"] = "198.51.100.1"
    result = HealthChecker(
        monitor_settings, runtime=Runtime(), echo=BrokenProxy(), geoip=Geo()
    ).check(identity, "N1")
    assert result.status == "UNKNOWN" and result.tcp_status == "SUCCESS"


def test_echo_failure_is_environment_error(monkeypatch, monitor_settings, fixture_bytes):
    import app.checker.health as module

    monkeypatch.setattr(module.socket, "create_connection", lambda *a, **k: nullcontext())

    class Broken(Echo):
        def request(self, port=None):
            raise AssetError("ECHO_REQUEST_FAILED")

    identity = parse_document(fixture_bytes("sample_vless.txt")).nodes[0].identity
    identity["server_host"] = "198.51.100.1"
    result = HealthChecker(monitor_settings, runtime=Runtime(), echo=Broken(), geoip=Geo()).check(
        identity, "N1"
    )
    assert result.status == "ENVIRONMENT_ERROR"


def test_conversion_preserves_reality_and_rejects_unmapped(fixture_bytes):
    identity = parse_document(fixture_bytes("sample_vless.txt")).nodes[0].identity
    proxy = to_mihomo(identity, "N1")
    assert proxy["ws-opts"]["headers"]["Host"] == "ws.example"
    assert to_singbox(identity, "N1")["transport"]["type"] == "ws"
    assert parse_vless(to_uri(identity, "N1")).identity["uuid"] == identity["uuid"]
    changed = copy.deepcopy(identity)
    changed["extensions"] = {"vless_uri": {"future-secret": "synthetic"}}
    with pytest.raises(AssetError, match="RUNTIME_UNSUPPORTED"):
        to_mihomo(changed, "N1")


def test_hysteria2_skips_tcp_and_requires_proxy_success(
    monkeypatch, monitor_settings, fixture_bytes
):
    import app.checker.health as module

    def unexpected_tcp(*args, **kwargs):
        pytest.fail("QUIC must not perform a TCP diagnostic")

    monkeypatch.setattr(module.socket, "create_connection", unexpected_tcp)
    identity = next(
        n.identity
        for n in parse_document(fixture_bytes("protocols_all.txt")).nodes
        if n.identity["protocol"] == "hysteria2"
    )
    identity["server_host"] = "198.51.100.1"
    result = HealthChecker(monitor_settings, runtime=Runtime(), echo=Echo(), geoip=Geo()).check(
        identity, "N1"
    )
    assert result.status == "UP" and result.tcp_status == "NOT_APPLICABLE"
    assert result.tcp_duration_ms is None and result.http_status == "SUCCESS"


class TimeoutResolver:
    def resolve_name(self, *args, **kwargs):
        import dns.exception

        raise dns.exception.Timeout


def dns_identity(fixture_bytes):
    identity = parse_document(fixture_bytes("sample_vless.txt")).nodes[0].identity
    identity["server_host"] = "slow-dns.example"
    return identity


def test_node_dns_timeout_with_healthy_runner_is_node_failure(monitor_settings, fixture_bytes):
    checker = HealthChecker(
        monitor_settings, runtime=Runtime(), echo=Echo(), geoip=Geo(), resolver=TimeoutResolver()
    )
    result = checker.check(dns_identity(fixture_bytes), "N1")
    assert result.status == "UNKNOWN" and result.error_code == "DNS_TIMEOUT"
    assert result.timeout_stages == ["DNS"]


def test_node_dns_timeout_with_broken_runner_is_environment(monitor_settings, fixture_bytes):
    class Broken(Echo):
        calls = 0

        def request(self, port=None):
            Broken.calls += 1
            raise AssetError("ECHO_REQUEST_FAILED")

    checker = HealthChecker(
        monitor_settings, runtime=Runtime(), echo=Broken(), geoip=Geo(), resolver=TimeoutResolver()
    )
    first = checker.check(dns_identity(fixture_bytes), "N1")
    second = checker.check(dns_identity(fixture_bytes), "N2")
    assert first.status == second.status == "ENVIRONMENT_ERROR"
    assert first.error_code == "RUNNER_NETWORK_ERROR"
    assert Broken.calls == 1  # the canary verdict is shared for a short TTL


def test_crashed_runtime_is_restarted_once(monkeypatch, monitor_settings, fixture_bytes):
    import app.checker.health as module

    monkeypatch.setattr(module.socket, "create_connection", lambda *a, **k: nullcontext())

    class Flaky(Runtime):
        starts = closes = 0

        def start(self, proxy):
            Flaky.starts += 1
            if Flaky.starts == 1:
                raise AssetError("MIHOMO_START_FAILED")

        def close(self):
            Flaky.closes += 1

    identity = parse_document(fixture_bytes("sample_vless.txt")).nodes[0].identity
    identity["server_host"] = "198.51.100.1"
    result = HealthChecker(monitor_settings, runtime=Flaky(), echo=Echo(), geoip=Geo()).check(
        identity, "N1"
    )
    assert result.status == "UP" and Flaky.starts == 2 and Flaky.closes >= 1
