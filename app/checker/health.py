import copy
import hashlib
import ipaddress
import json
import socket
import time
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from urllib.parse import urlsplit

import httpcore

from app.checker.geoip import GeoIP
from app.checker.precheck import EndpointCache
from app.checker.runtime import Mihomo
from app.checker.udp import probe as udp_probe
from app.conversion import to_mihomo
from app.domain import AssetError
from app.ingestion.fetcher import DeadlineStream, SafeBackend, read_body, validate_url


@dataclass
class Observation:
    checked_at: datetime | None = None
    status: str = "UNKNOWN"
    parse_ok: bool = True
    dns_status: str = "NOT_RUN"
    entry_ips: list = field(default_factory=list)
    entry_country: str | None = None
    entry_asn: int | None = None
    tcp_status: str = "NOT_RUN"
    proxy_status: str = "NOT_RUN"
    http_status: str = "NOT_RUN"
    exit_ip: str | None = None
    exit_country: str | None = None
    exit_city: str | None = None
    exit_asn: int | None = None
    exit_asn_org: str | None = None
    dns_duration_ms: int | None = None
    tcp_duration_ms: int | None = None
    http_duration_ms: int | None = None
    error_code: str | None = None
    geoip_metadata: dict = field(default_factory=dict)
    echo_source: str | None = None
    check_duration_ms: int | None = None
    timeout_stages: list = field(default_factory=list)
    probe_key: str = "legacy"
    probe_metadata: dict = field(default_factory=dict)
    measurement_kind: str = "FULL"
    precheck_metadata: dict = field(default_factory=dict)
    udp_status: str = "NOT_RUN"
    udp_duration_ms: int | None = None
    udp_exit_ip: str | None = None

    def values(self):
        values = asdict(self)
        values.pop("checked_at")
        return values


ENVIRONMENT_VERDICT_TTL_SECONDS = 20
# Echo failures after which a second target is tried (not timeouts: a slow or
# blackholed node would only spend the fallback timeout as well).
FALLBACK_AFTER = frozenset({"ECHO_REQUEST_FAILED", "ECHO_HTTP_ERROR"})
FALLBACK_TIMEOUT = 6
FALLBACK_SOURCE = "fallback"
# Errors that prove the whole Runner is unusable; every other per-node error is retried.
GLOBAL_ENVIRONMENT_ERRORS = frozenset(
    {"ECHO_ENVIRONMENT_ERROR", "RUNNER_NETWORK_ERROR", "MIHOMO_UNAVAILABLE"}
)


def milliseconds(start):
    return max(0, round((time.monotonic() - start) * 1000))


class EchoClient:
    def __init__(self, url, token="", timeout=10):
        if not url:
            raise AssetError("ECHO_CONFIGURATION_REQUIRED")
        self.url = validate_url(url)
        self.token, self.timeout = token, timeout
        self.metrics = {"echo_requests": 0, "echo_failures": 0, "echo_response_bytes": 0}

    def request(self, port=None):
        self.metrics["echo_requests"] += 1
        deadline = time.monotonic() + self.timeout
        headers = {"Accept": "application/json", "Accept-Encoding": "identity"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        # Direct calls validate target DNS too. Proxied calls use only the known local
        # proxy; the target is fixed configuration, never supplied by a web request.
        pool = (
            httpcore.HTTPProxy(
                proxy_url=f"http://127.0.0.1:{port}", network_backend=TimedLocalBackend(deadline)
            )
            if port
            else httpcore.ConnectionPool(network_backend=SafeBackend(deadline))
        )
        try:
            with (
                pool,
                pool.stream(
                    "GET",
                    self.url,
                    headers=headers,
                    extensions={
                        "timeout": {
                            "connect": self.timeout,
                            "read": self.timeout,
                            "write": self.timeout,
                            "pool": self.timeout,
                        }
                    },
                ) as response,
            ):
                if response.status != 200:
                    raise AssetError("ECHO_HTTP_ERROR")

                def measured_chunks():
                    for chunk in response.iter_stream():
                        self.metrics["echo_response_bytes"] += len(chunk)
                        yield chunk

                raw = read_body(measured_chunks(), b"", 4096)
            data = json.loads(raw)
            ip = ipaddress.ip_address(data["ip"])
            if not ip.is_global or ip.is_multicast:
                raise ValueError
            country, asn = data.get("country"), data.get("asn")
            if country is not None and (
                not isinstance(country, str) or len(country) != 2 or not country.isalpha()
            ):
                raise ValueError
            if asn is not None and (type(asn) is not int or not 0 <= asn <= 4294967295):
                raise ValueError
            org = data.get("org")
            if not isinstance(org, str) or not 0 < len(org) <= 200 or not org.isprintable():
                org = None
            return {
                "ip": str(ip),
                "country": country.upper() if country else None,
                "asn": asn,
                "org": org,
            }
        except AssetError:
            self.metrics["echo_failures"] += 1
            raise
        except (httpcore.TimeoutException, TimeoutError):
            self.metrics["echo_failures"] += 1
            raise AssetError("ECHO_TIMEOUT") from None
        except (
            ValueError,
            KeyError,
            TypeError,
            httpcore.NetworkError,
            httpcore.ProtocolError,
            OSError,
        ):
            self.metrics["echo_failures"] += 1
            raise AssetError("ECHO_REQUEST_FAILED") from None

    def reachable(self, port, url, timeout):
        """Fallback probe through the local proxy: does a non-Cloudflare URL answer?

        Some exits cannot reach the Echo Worker (Cloudflare blocks or challenges their
        IP). A 2xx/3xx from a second target proves the node works; only the landing
        details stay unknown.
        """
        self.metrics["fallback_requests"] = self.metrics.get("fallback_requests", 0) + 1
        deadline = time.monotonic() + timeout
        pool = httpcore.HTTPProxy(
            proxy_url=f"http://127.0.0.1:{port}", network_backend=TimedLocalBackend(deadline)
        )
        limits = {"connect": timeout, "read": timeout, "write": timeout, "pool": timeout}
        try:
            with pool:
                response = pool.request(
                    "GET",
                    url,
                    headers={"Accept-Encoding": "identity"},
                    extensions={"timeout": limits},
                )
            return 200 <= response.status < 400
        except (
            AssetError,
            httpcore.TimeoutException,
            httpcore.NetworkError,
            httpcore.ProtocolError,
            OSError,
            TimeoutError,
        ):
            return False


class TimedLocalBackend(httpcore.SyncBackend):
    def __init__(self, deadline):
        self.deadline = deadline

    def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        if host != "127.0.0.1":
            raise AssetError("UNSAFE_PROXY_TARGET")
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise AssetError("ECHO_REQUEST_FAILED")
        stream = super().connect_tcp(
            host, port, min(timeout or remaining, remaining), local_address, socket_options
        )
        return DeadlineStream(stream, self.deadline)


class HealthChecker:
    def __init__(self, settings, *, runtime=None, echo=None, geoip=None, resolver=None, cache=None):
        self.settings = settings
        self.runtime = runtime or Mihomo(
            settings.mihomo_binary,
            reuse=settings.mihomo_reuse,
            max_nodes=settings.mihomo_max_nodes_per_process,
        )
        self.echo = echo or EchoClient(
            settings.echo_url, settings.echo_token.get_secret_value(), settings.http_timeout_seconds
        )
        self.geoip = geoip or GeoIP(settings.geoip_city_path, settings.geoip_asn_path)
        self.cache = cache or EndpointCache(
            settings, resolver=resolver, connector=socket.create_connection
        )
        self.resolver = self.cache.resolver
        self.probe_key, self.probe_metadata = "legacy", {}
        self.udp_targets = None  # None: the public STUN/DNS targets in app.checker.udp
        self.context = {}
        self.metrics = {
            key: 0 for key in ("full_checks", "full_samples", "preflight_skips", "cooldown_skips")
        }

    def set_context(self, **context):
        self.context = context

    def _probe_identity(self, data):
        geo = self.geoip.lookup(data["ip"])
        country = data.get("country") or geo.get("country")
        asn = data.get("asn") if data.get("asn") is not None else geo.get("asn")
        family = ipaddress.ip_address(data["ip"]).version
        target = urlsplit(self.echo.url)
        target_key = hashlib.sha256(
            (target.scheme + "://" + target.netloc + target.path).encode()
        ).hexdigest()[:16]
        if country and asn is not None:
            location = f"located:{self.settings.runner_probe_id}:{country}:{asn}"
        else:
            location = "unlocated:" + hashlib.sha256(data["ip"].encode()).hexdigest()[:16]
        self.probe_key = f"{location}:{family}:{target_key}:https-v1"
        self.probe_metadata = {
            "country": country,
            "asn": asn,
            "ip_family": family,
            "echo_source": target.hostname,
            "profile": "https-v1",
            "probe_id": self.settings.runner_probe_id,
        }

    def _sample(self, short_id):
        seed = (
            f"{self.probe_key}:{short_id}:{self.context.get('round_id', datetime.now(UTC).date())}"
        )
        return (
            self.settings.check_force_full
            or int.from_bytes(hashlib.sha256(seed.encode()).digest()[:8], "big") / 2**64
            < self.settings.precheck_sample_rate
        )

    def preflight(self):
        self.runtime.preflight()
        try:
            self._probe_identity(self.echo.request())
        except AssetError:
            raise AssetError("ECHO_ENVIRONMENT_ERROR") from None

    def adopt_preflight(self, other):
        """Share another worker's preflight (same Runner, binary and Echo) instead of
        repeating it: at high concurrency serial preflights dominated short shards."""
        self.probe_key = other.probe_key
        self.probe_metadata = copy.deepcopy(other.probe_metadata)

    def environment_ok(self):
        """Direct Echo canary, shared by all workers for a short TTL.

        A node-specific DNS/proxy failure must only become an environment failure when
        the Runner itself can no longer reach the fixed Echo endpoint.
        """

        def probe():
            try:
                self.echo.request()
                return True
            except AssetError:
                return False

        verdict = getattr(self.cache, "verdict", None)
        if verdict is None:
            return probe()
        return verdict("echo-direct", probe, ENVIRONMENT_VERDICT_TTL_SECONDS)

    def _works_without_echo(self, error, port):
        """After an Echo failure, a second (non-Cloudflare) target decides UP vs failure."""
        url = self.settings.fallback_probe_url
        reachable = getattr(self.echo, "reachable", None)
        if not url or reachable is None or error.code not in FALLBACK_AFTER:
            return False
        return reachable(port, url, min(self.settings.http_timeout_seconds, FALLBACK_TIMEOUT))

    def _start_runtime(self, proxy):
        """A crashed per-worker runtime is restarted once before reporting an error."""
        try:
            self.runtime.start(proxy)
        except AssetError as error:
            if not error.code.startswith("MIHOMO_"):
                raise
            self.runtime.close()
            self.runtime.start(proxy)

    def check(self, identity, short_id):
        started = time.monotonic()
        result = self._check(identity, short_id)
        result.check_duration_ms = milliseconds(started)
        result.checked_at = datetime.now(UTC)
        return result

    def _check(self, identity, short_id):
        result, ready = self.prepare(identity, short_id)
        return result if ready is None else self.probe(result, ready)

    def prepare(self, identity, short_id):
        """Everything before the proxy itself: conversion, DNS, TCP pre-check, cooldown.

        Returns (result, None) when the node is decided without a proxy, or
        (result, ready) where ready holds the mihomo proxy and the pinned entry IPs.
        """
        result = Observation(
            geoip_metadata=dict(self.geoip.metadata),
            echo_source=urlsplit(self.echo.url).hostname,
            probe_key=self.probe_key,
            probe_metadata=copy.deepcopy(self.probe_metadata),
        )
        try:
            proxy = to_mihomo(identity, short_id)
        except AssetError:
            result.status, result.error_code = "UNSUPPORTED", "RUNTIME_UNSUPPORTED"
            return result, None
        resolution = self.cache.resolve(identity["server_host"], self.probe_key)
        result.dns_status, result.dns_duration_ms = resolution["status"], resolution["duration_ms"]
        result.precheck_metadata["dns"] = {
            k: resolution.get(k) for k in ("cached", "checked_at", "ttl", "literal")
        }
        if resolution["status"] != "SUCCESS":
            result.error_code = resolution["error_code"]
            result.measurement_kind = "PREFLIGHT"
            if resolution["status"] == "FAILED":
                self.metrics["preflight_skips"] += 1
            if resolution["status"] == "ERROR":
                if result.error_code == "DNS_TIMEOUT":
                    result.timeout_stages.append("DNS")
                # One slow/broken authoritative server is a node problem (retried, then
                # DOWN); only a failing Runner canary turns it into an environment error.
                if not self.environment_ok():
                    result.status = "ENVIRONMENT_ERROR"
                    result.error_code = "RUNNER_NETWORK_ERROR"
                elif result.error_code == "DNS_ENVIRONMENT_ERROR":
                    result.error_code = "ENTRY_DNS_ERROR"
            return result, None
        ips = resolution["ips"]
        result.entry_ips = list(ips)
        result.geoip_metadata["entry"] = [
            {"ip": ip, **self.geoip.lookup(ip), "queried_at": datetime.now(UTC).isoformat()}
            for ip in ips
        ]
        geo = result.geoip_metadata["entry"][0]
        result.entry_country, result.entry_asn = geo["country"], geo["asn"]
        sampled = self._sample(short_id)
        if self.cache.ipv6_route_unavailable(ips, identity["server_port"], self.probe_key):
            result.tcp_status = (
                "NOT_APPLICABLE" if identity["protocol"] == "hysteria2" else "NOT_RUN"
            )
            result.measurement_kind, result.error_code = "SKIPPED", "ENTRY_NETWORK_UNAVAILABLE"
            result.precheck_metadata["decision"] = "ENTRY_NETWORK_UNAVAILABLE"
            self.metrics["preflight_skips"] += 1
            return result, None
        if identity["protocol"] == "hysteria2":
            result.tcp_status = "NOT_APPLICABLE"
        else:
            tcp = self.cache.tcp(
                identity["server_host"], identity["server_port"], ips, self.probe_key
            )
            result.precheck_metadata["tcp"] = tcp
            result.tcp_status, result.tcp_duration_ms = tcp["status"], tcp["duration_ms"]
            if tcp["timeout"]:
                result.timeout_stages.append("TCP")
            if tcp.get("environment_only"):
                # E.g. GitHub Runner has no IPv6 route: this is not proof of a bad node.
                result.measurement_kind, result.error_code = "SKIPPED", "ENTRY_NETWORK_UNAVAILABLE"
                result.precheck_metadata["decision"] = "ENTRY_NETWORK_UNAVAILABLE"
                self.metrics["preflight_skips"] += 1
                return result, None
            if (
                self.settings.precheck_gate_enabled
                and tcp["status"] == "FAILED"
                and tcp["confirmed"]
            ):
                if not sampled:
                    result.measurement_kind, result.error_code = (
                        "PREFLIGHT",
                        "ENTRY_TCP_UNREACHABLE",
                    )
                    result.precheck_metadata["decision"] = "CONFIRMED_UNREACHABLE"
                    self.metrics["preflight_skips"] += 1
                    return result, None
                result.precheck_metadata["sampled_full"] = True
                self.metrics["full_samples"] += 1
        next_check = self.context.get("next_full_check_at")
        if (
            self.settings.failure_cooldown_enabled
            and self.context.get("probe_key") == self.probe_key
            and next_check
            and next_check > datetime.now(UTC)
        ):
            if not sampled:
                result.measurement_kind, result.error_code = "SKIPPED", "NODE_COOLDOWN"
                result.precheck_metadata.update(
                    decision="COOLDOWN", next_full_check_at=next_check.isoformat()
                )
                self.metrics["cooldown_skips"] += 1
                return result, None
            if not result.precheck_metadata.get("sampled_full"):
                result.precheck_metadata["sampled_full"] = True
                self.metrics["full_samples"] += 1
        self.metrics["full_checks"] += 1
        hosts = {identity["server_host"]: ips} if not resolution["literal"] else {}
        # The checker relays UDP unless the node itself declares TCP only.
        udp = proxy.get("udp") is not False
        if udp:
            proxy["udp"] = True
        return result, {"proxy": proxy, "hosts": hosts, "udp": udp}

    def _udp(self, result, ready, port):
        """UDP through the node, after HTTPS has proved it works (Wi-Fi Calling)."""
        if not self.settings.udp_check_enabled:
            return
        if not ready.get("udp", True):
            result.udp_status = "NOT_SUPPORTED"
            return
        options = {"targets": self.udp_targets} if self.udp_targets else {}
        checked = udp_probe(port, timeout=self.settings.udp_timeout_seconds, **options)
        result.udp_status, result.udp_duration_ms = checked.status, checked.duration_ms
        result.udp_exit_ip = checked.exit_ip
        result.precheck_metadata["udp"] = checked.attempts

    def probe(self, result, ready, listener=None):
        """The proxy request itself. listener=(port, alive) uses a shared batch runtime
        (app.checker.runtime.ListenerPool) instead of this worker's own mihomo."""
        proxy = ready["proxy"]
        if listener is None and hasattr(self.runtime, "set_hosts"):
            self.runtime.set_hosts(ready["hosts"])
        # Only a successful proxy HTTPS response can establish UP.
        try:
            if listener is None:
                self._start_runtime(proxy)
            port = self.runtime.port if listener is None else listener[0]
            started = time.monotonic()
            try:
                data = self.echo.request(port)
            except AssetError as error:
                if listener is not None and not listener[1]():
                    raise AssetError("MIHOMO_BATCH_CRASHED") from None
                if not self._works_without_echo(error, port):
                    raise
                # The node works; its exit just cannot reach Echo. No landing details.
                result.http_duration_ms = milliseconds(started)
                result.proxy_status = result.http_status = "SUCCESS"
                result.echo_source = FALLBACK_SOURCE
                result.precheck_metadata["echo_unreachable"] = error.code
                result.status = (
                    "DEGRADED" if result.http_duration_ms > self.settings.degraded_http_ms else "UP"
                )
                self._udp(result, ready, port)
                return result
            result.http_duration_ms = milliseconds(started)
            result.proxy_status = result.http_status = "SUCCESS"
            result.exit_ip = data["ip"]
            geo = self.geoip.lookup(data["ip"])
            result.geoip_metadata["exit"] = {
                "ip": data["ip"],
                **geo,
                "queried_at": datetime.now(UTC).isoformat(),
            }
            result.exit_country = data.get("country") or geo["country"]
            result.exit_asn = data.get("asn") if data.get("asn") is not None else geo["asn"]
            # Prefer the GeoLite organization only when it describes the same ASN.
            same_asn = geo.get("asn") == result.exit_asn
            result.exit_asn_org = data.get("org") or (geo.get("organization") if same_asn else None)
            result.exit_city = geo["city"]
            result.status = (
                "DEGRADED" if result.http_duration_ms > self.settings.degraded_http_ms else "UP"
            )
            self._udp(result, ready, port)
        except AssetError as error:
            result.error_code = error.code
            if error.code == "ECHO_TIMEOUT":
                result.timeout_stages.append("HTTPS")
            if error.code == "RUNTIME_CONFIG_REJECTED":
                result.status = "UNSUPPORTED"
            elif error.code.startswith("MIHOMO_"):
                result.status = "ENVIRONMENT_ERROR"
            else:
                result.proxy_status = result.http_status = "FAILED"
                # A broken Echo cannot turn a batch into DOWN. The direct canary is
                # shared and cached briefly, so dead nodes don't each pay an extra request.
                if not self.environment_ok():
                    result.status, result.error_code = "ENVIRONMENT_ERROR", "ECHO_ENVIRONMENT_ERROR"
        finally:
            if listener is None:
                try:
                    getattr(self.runtime, "reset", self.runtime.close)()
                except AssetError as error:
                    result.status, result.error_code = "ENVIRONMENT_ERROR", error.code
        return result

    def close(self):
        self.runtime.close()
        self.geoip.close()
