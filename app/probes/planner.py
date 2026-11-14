"""Which entry measurements to buy with this hour's Globalping budget (pure logic).

Units (see docs/NODE_GRADING_DESIGN.md 4.4):
- route quality is shared by a /24 ("prefix"); one representative ip:port per prefix
  is pinged from each Chinese carrier (peak and idle), HK and SG;
- national reachability is per ip:port, one mainland probe each, off-peak;
- the outbound route (mtr hop ASNs) per prefix and carrier, about monthly;
- Cloudflare entries all hit the anycast edge: one shared "cf" prefix, measured from
  the Chinese carriers only (HK/SG probes reach a CF data centre in their own city,
  about 1 ms, which says nothing about the node);
- nodes that land on Cloudflare (exit ASN 13335) are not measured or graded at all.
"""

import ipaddress
import random
import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from app.grading import CARRIERS

CLOUDFLARE_ASN = 13335
CF_PREFIX = "cf"
# Landing networks the owner does not want measured or graded (WARP/CF egress).
EXCLUDED_EXIT_ASNS = frozenset({CLOUDFLARE_ASN})
# HK/SG users sit on home broadband; datacentre probes next to the server read ~1 ms.
OVERSEAS_LOCATIONS = (
    {"country": "HK", "tags": ["eyeball-network"], "limit": 1},
    {"country": "SG", "tags": ["eyeball-network"], "limit": 1},
)
OVERSEAS_FALLBACK = ({"country": "HK", "limit": 1}, {"country": "SG", "limit": 1})
REACH_EVERY = timedelta(days=2)
IDLE_EVERY = timedelta(days=3)
OVERSEAS_EVERY = timedelta(days=2)
TRACE_EVERY = timedelta(days=30)
PING_PACKETS = 16
REACH_PACKETS = 4

CARRIER_ASNS = {
    "CN-CT": {
        4134,
        4809,
        4811,
        4812,
        4813,
        4816,
        23724,
        58466,
        134420,
        136188,
        136190,
        140292,
        140330,
    },
    "CN-CU": {4837, 4808, 9929, 10099, 17621, 17622, 17623, 17816, 133118, 135061, 137539},
    "CN-CM": {
        9808,
        24400,
        24444,
        24445,
        24547,
        38019,
        56040,
        56041,
        56042,
        56044,
        56045,
        56046,
        56047,
        56048,
        132525,
        134810,
    },
}
CARRIER_NAMES = {
    "CN-CT": re.compile(r"telecom|chinanet", re.I),
    "CN-CU": re.compile(r"unicom|china169|cnc ", re.I),
    "CN-CM": re.compile(r"china mobile|cmnet|mobile communications", re.I),
}


def carrier_of(asn: int | None, network: str | None) -> str | None:
    for carrier, numbers in CARRIER_ASNS.items():
        if asn in numbers:
            return carrier
    for carrier, pattern in CARRIER_NAMES.items():
        if network and pattern.search(network):
            return carrier
    return None


def vantage_of(country: str | None, asn: int | None, network: str | None) -> str | None:
    if country == "CN":
        return carrier_of(asn, network)
    return country if country in ("HK", "SG") else None


# Private/reserved addresses are never sent to the public probe network. Tests that
# use documentation ranges (198.51.100.0/24 ...) switch this on.
ALLOW_NON_GLOBAL = False


def ipv4(values: Iterable) -> str | None:
    for value in values or []:
        try:
            address = ipaddress.ip_address(value) if isinstance(value, str) else None
        except ValueError:
            continue
        if address and address.version == 4 and (address.is_global or ALLOW_NON_GLOBAL):
            return value
    return None


def prefix_of(ip: str, entry_asn: int | None) -> str:
    return CF_PREFIX if entry_asn == CLOUDFLARE_ASN else ip.rsplit(".", 1)[0]


@dataclass(frozen=True)
class EntryNode:
    node_id: object
    protocol: str
    ip: str | None
    port: int
    entry_asn: int | None

    @property
    def target(self) -> str | None:
        return f"{self.ip}:{self.port}" if self.ip else None

    @property
    def prefix(self) -> str | None:
        return prefix_of(self.ip, self.entry_asn) if self.ip else None


@dataclass
class Prefix:
    key: str
    tcp: dict[str, int] = field(default_factory=dict)  # target -> node count
    icmp: set[str] = field(default_factory=set)  # bare IPs of UDP-only (Hysteria2) entries


def group(nodes: Iterable[EntryNode]) -> dict[str, Prefix]:
    prefixes: dict[str, Prefix] = {}
    for node in nodes:
        if not node.ip:
            continue
        item = prefixes.setdefault(node.prefix, Prefix(node.prefix))
        if node.protocol == "hysteria2":
            item.icmp.add(node.ip)
        else:
            item.tcp[node.target] = item.tcp.get(node.target, 0) + 1
    return prefixes


@dataclass(frozen=True)
class History:
    """What the last 7 days already hold, one value per prefix (aggregated in SQL so the
    hourly run reads a few hundred KB, not raw samples). "Oldest" values are None when
    any carrier (or HK/SG) has no sample yet."""

    peak_probes: dict = field(default_factory=dict)  # prefix -> min distinct peak probes
    last_peak: dict = field(default_factory=dict)  # prefix -> oldest carrier peak sample
    last_idle: dict = field(default_factory=dict)  # prefix -> oldest carrier idle sample
    last_overseas: dict = field(default_factory=dict)  # prefix -> oldest of HK/SG
    idle_poor: frozenset = frozenset()  # prefixes already worse than band B off-peak
    last_reach: dict = field(default_factory=dict)  # target -> datetime
    dead: frozenset = frozenset()  # targets whose every sample failed
    last_trace: dict = field(default_factory=dict)  # prefix -> oldest carrier trace


@dataclass(frozen=True)
class Task:
    kind: str  # QUALITY_CN, QUALITY_OVERSEAS, REACH, TRACE
    prefix: str
    target: str  # "ip:port" or bare ip for ICMP
    protocol: str  # TCP / ICMP
    locations: tuple
    cost: int
    peak: bool

    @property
    def ip(self) -> str:
        return self.target.rsplit(":", 1)[0] if self.protocol == "TCP" else self.target

    @property
    def port(self) -> int | None:
        return int(self.target.rsplit(":", 1)[1]) if self.protocol == "TCP" else None

    def request(self) -> dict:
        if self.kind == "TRACE":
            options = {"protocol": "TCP", "port": self.port, "packets": 3}
            kind = "mtr"
        else:
            packets = REACH_PACKETS if self.kind == "REACH" else PING_PACKETS
            options = {"packets": packets, "protocol": self.protocol}
            if self.protocol == "TCP":
                options["port"] = self.port
            kind = "ping"
        return {
            "type": kind,
            "target": self.ip,
            "locations": [dict(item) for item in self.locations],
            "measurementOptions": options,
        }


def representative(prefix: Prefix, dead: frozenset, rotate: int) -> tuple[str, str] | None:
    alive = sorted((t for t in prefix.tcp if t not in dead), key=lambda t: (-prefix.tcp[t], t))
    if alive:
        if prefix.key == CF_PREFIX:  # anycast: spread over the shared class
            return alive[rotate % len(alive)], "TCP"
        return alive[0], "TCP"
    if prefix.icmp:
        return sorted(prefix.icmp)[0], "ICMP"
    return None


def carrier_locations(
    carriers: dict[str, list[int]], chosen: Iterable[str], rng: random.Random
) -> tuple:
    """One home-broadband probe per carrier, on a randomly picked carrier ASN that has
    online probes (spreads samples over distinct probes)."""
    locations = []
    for carrier in chosen:
        asns = carriers.get(carrier) or []
        if asns:
            locations.append(
                (
                    ("country", "CN"),
                    ("asn", rng.choice(asns)),
                    ("tags", ("eyeball-network",)),
                    ("limit", 1),
                )
            )
    return tuple(locations)


def _thaw(locations: tuple) -> tuple:
    return tuple({k: list(v) if isinstance(v, tuple) else v for k, v in item} for item in locations)


def _age(last: datetime | None, now: datetime) -> float:
    return (now - last).total_seconds() if last else float("inf")


def plan(
    prefixes: dict[str, Prefix],
    history: History,
    carriers: dict[str, list[int]],
    *,
    now: datetime,
    peak: bool,
    budget: int,
    min_probes: int,
    rng: random.Random | None = None,
) -> list[Task]:
    """Tasks in priority order whose total cost fits the budget."""
    rng = rng or random.Random(now.timestamp())
    rotate = int(now.timestamp() // 3600)
    candidates: list[tuple[tuple, Task]] = []
    for key, prefix in prefixes.items():
        chosen = representative(prefix, history.dead, rotate)
        if chosen is None:
            continue
        target, protocol = chosen
        if peak:
            if key in history.idle_poor:
                continue  # already poor off-peak; the evening only gets worse
            need = [c for c in CARRIERS if carriers.get(c)]
            if not need:
                continue
            probes = history.peak_probes.get(key, 0)
            oldest = _age(history.last_peak.get(key), now)
            locations = carrier_locations(carriers, need, rng)
            task = Task("QUALITY_CN", key, target, protocol, _thaw(locations), len(locations), True)
            candidates.append(((probes >= min_probes, probes, -oldest), task))
            continue
        need = [c for c in CARRIERS if carriers.get(c)]
        idle_age = _age(history.last_idle.get(key), now)
        if need and idle_age >= IDLE_EVERY.total_seconds():
            locations = carrier_locations(carriers, need, rng)
            task = Task(
                "QUALITY_CN", key, target, protocol, _thaw(locations), len(locations), False
            )
            candidates.append(
                ((idle_age != float("inf"), -idle_age / IDLE_EVERY.total_seconds()), task)
            )
        overseas_age = _age(history.last_overseas.get(key), now)
        if key != CF_PREFIX and overseas_age >= OVERSEAS_EVERY.total_seconds():
            locations = tuple(dict(item) for item in OVERSEAS_LOCATIONS)
            task = Task("QUALITY_OVERSEAS", key, target, protocol, locations, 2, False)
            candidates.append(
                (
                    (overseas_age != float("inf"), -overseas_age / OVERSEAS_EVERY.total_seconds()),
                    task,
                )
            )
        if protocol == "TCP" and key != CF_PREFIX:
            trace_age = _age(history.last_trace.get(key), now)
            if need and trace_age >= TRACE_EVERY.total_seconds():
                locations = carrier_locations(carriers, need, rng)
                task = Task("TRACE", key, target, "TCP", _thaw(locations), len(locations), False)
                candidates.append(
                    ((trace_age != float("inf"), -trace_age / TRACE_EVERY.total_seconds()), task)
                )
            for each in prefix.tcp:
                reach_age = _age(history.last_reach.get(each), now)
                if reach_age >= REACH_EVERY.total_seconds():
                    task = Task(
                        "REACH", key, each, "TCP", ({"country": "CN", "limit": 1},), 1, False
                    )
                    candidates.append(
                        (
                            (reach_age != float("inf"), -reach_age / REACH_EVERY.total_seconds()),
                            task,
                        )
                    )
    candidates.sort(key=lambda item: item[0])
    tasks, spent = [], 0
    for _, task in candidates:
        if task.cost and spent + task.cost <= budget:
            tasks.append(task)
            spent += task.cost
    return tasks
