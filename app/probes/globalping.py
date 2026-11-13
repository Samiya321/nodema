"""Minimal Globalping API client (https://globalping.io, public measurement network).

Measurement data is public by measurement ID, so only entry IPs (never hostnames,
credentials or node names) are sent. One registered token is used when configured,
otherwise the anonymous per-IP limit; the two are never combined (Globalping terms,
section 5). Response bodies and targets never reach logs.
"""

import json
import re
import statistics
import time
import urllib.error
import urllib.request
from dataclasses import dataclass

USER_AGENT = "probe-client/1"
CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f​-‏ -‮⁦-⁩]")
MEASUREMENT_ID = re.compile(r"^[A-Za-z0-9]{1,64}$")


class RateLimited(Exception):
    """The hourly limit is used up; stop creating measurements this run."""


class ApiError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def text(value: object, limit: int = 100) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = " ".join(CONTROL.sub(" ", value).split())[:limit]
    return cleaned or None


def integer(value: object) -> int | None:
    return value if type(value) is int and 0 <= value <= 4294967295 else None


def number(value: object) -> float | None:
    if type(value) in (int, float) and 0 <= value < 600000:
        return float(value)
    return None


@dataclass(frozen=True)
class Probe:
    country: str | None
    city: str | None
    asn: int | None
    network: str | None
    tags: tuple[str, ...]

    @property
    def key(self) -> str:
        return f"{self.asn or 0}|{self.city or ''}|{self.network or ''}"


@dataclass(frozen=True)
class PingOutcome:
    probe: Probe
    sent: int
    received: int
    rtt_min: float | None
    rtt_avg: float | None
    rtt_max: float | None
    jitter: float | None


@dataclass(frozen=True)
class TraceOutcome:
    probe: Probe
    hop_asns: tuple[int, ...]
    reached: bool


def parse_probe(value: object) -> Probe:
    data = value if isinstance(value, dict) else {}
    tags = data.get("tags") if isinstance(data.get("tags"), list) else []
    country = text(data.get("country"), 2)
    return Probe(
        country=country.upper() if country and country.isalpha() else None,
        city=text(data.get("city")),
        asn=integer(data.get("asn")),
        network=text(data.get("network"), 200),
        tags=tuple(t for t in (text(x, 60) for x in tags[:20]) if t),
    )


def parse_ping(result: object, packets: int) -> PingOutcome | None:
    """A finished test; failed/offline probes are not a measurement of the target."""
    if not isinstance(result, dict):
        return None
    probe, body = parse_probe(result.get("probe")), result.get("result")
    if not isinstance(body, dict) or body.get("status") != "finished":
        return None
    stats = body.get("stats") if isinstance(body.get("stats"), dict) else {}
    total = integer(stats.get("total")) or packets
    received = integer(stats.get("rcv"))
    if received is None:
        return None
    total = max(1, min(total, 16))
    received = min(received, total)
    timings = body.get("timings") if isinstance(body.get("timings"), list) else []
    rtts = [
        r
        for r in (number(t.get("rtt")) for t in timings[:16] if isinstance(t, dict))
        if r is not None
    ]
    jitter = round(statistics.pstdev(rtts), 2) if len(rtts) >= 2 else None
    return PingOutcome(
        probe=probe,
        sent=total,
        received=received,
        rtt_min=number(stats.get("min")) if received else None,
        rtt_avg=number(stats.get("avg")) if received else None,
        rtt_max=number(stats.get("max")) if received else None,
        jitter=jitter if received else None,
    )


def parse_trace(result: object, target_ip: str) -> TraceOutcome | None:
    if not isinstance(result, dict):
        return None
    probe, body = parse_probe(result.get("probe")), result.get("result")
    if not isinstance(body, dict) or body.get("status") != "finished":
        return None
    hops = body.get("hops") if isinstance(body.get("hops"), list) else []
    sequence: list[int] = []
    reached = False
    for hop in hops[:64]:
        if not isinstance(hop, dict):
            continue
        reached = reached or hop.get("resolvedAddress") == target_ip
        for asn in hop.get("asn") if isinstance(hop.get("asn"), list) else []:
            value = integer(asn)
            if value and (not sequence or sequence[-1] != value) and len(sequence) < 32:
                sequence.append(value)
    return TraceOutcome(probe=probe, hop_asns=tuple(sequence), reached=reached)


class Client:
    def __init__(self, base_url: str, token: str = "", timeout: float = 20, opener=None):
        self.base = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout
        self.open = opener or urllib.request.urlopen
        self.remaining: int | None = None

    @property
    def authenticated(self) -> bool:
        return bool(self.token)

    def _request(self, method: str, path: str, body: dict | None = None):
        headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        request = urllib.request.Request(
            self.base + path, data=data, method=method, headers=headers
        )
        try:
            with self.open(request, timeout=self.timeout) as response:
                self._note(response.headers)
                return response.status, json.loads(response.read(4_000_000) or b"null")
        except urllib.error.HTTPError as error:
            self._note(error.headers)
            if error.code == 429:
                raise RateLimited() from None
            raise ApiError(f"HTTP_{error.code}") from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise ApiError("NETWORK") from None
        except ValueError:
            raise ApiError("INVALID_RESPONSE") from None

    def _note(self, headers) -> None:
        value = headers.get("X-RateLimit-Remaining") if headers else None
        if value is not None and str(value).isdigit():
            self.remaining = int(value)

    def limits(self) -> int | None:
        """Remaining tests this hour, if the API says."""
        _, data = self._request("GET", "/limits")
        try:
            create = data["rateLimit"]["measurements"]["create"]
            remaining = integer(create.get("remaining"))
        except (KeyError, TypeError, AttributeError):
            remaining = None
        if remaining is not None:
            self.remaining = remaining
        return remaining

    def probes(self) -> list[Probe]:
        _, data = self._request("GET", "/probes")
        if not isinstance(data, list):
            raise ApiError("INVALID_RESPONSE")
        return [
            parse_probe(item.get("location", {}) | {"tags": item.get("tags", [])})
            for item in data[:20000]
            if isinstance(item, dict)
        ]

    def create(self, body: dict) -> str:
        status, data = self._request("POST", "/measurements", body)
        identifier = data.get("id") if isinstance(data, dict) else None
        if (
            status not in (200, 201, 202)
            or not isinstance(identifier, str)
            or not MEASUREMENT_ID.match(identifier)
        ):
            raise ApiError("INVALID_RESPONSE")
        return identifier

    def wait(self, identifier: str, deadline_seconds: float = 60, sleep=time.sleep) -> list:
        """Poll no faster than every 500 ms (API guideline), until not in-progress."""
        started = time.monotonic()
        while True:
            _, data = self._request("GET", f"/measurements/{identifier}")
            if not isinstance(data, dict):
                raise ApiError("INVALID_RESPONSE")
            if data.get("status") != "in-progress":
                results = data.get("results")
                return results if isinstance(results, list) else []
            if time.monotonic() - started > deadline_seconds:
                raise ApiError("TIMEOUT")
            sleep(0.6)
