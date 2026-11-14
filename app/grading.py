"""Node quality grades: pure rules, no database or network access.

A grade answers "how good is this node when used from vantage V" (Chinese carriers
CN-CT/CN-CU/CN-CM, their worst case CN, or HK/SG). It is the worse of two measured
bands: access (TCP ping from Globalping probes to the entry) and stability (daily
availability from the Actions full checks). Nothing here infers a line type.
"""

import copy
import math
import re
import statistics
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime

from app.domain import AssetError

VANTAGES = ("CN-CT", "CN-CU", "CN-CM", "CN", "HK", "SG")
CARRIERS = ("CN-CT", "CN-CU", "CN-CM")
OVERSEAS = ("HK", "SG")
BANDS = ("S", "A", "B", "C")
GRADES = ("S", "A", "B", "C", "D", "PENDING")
VANTAGE_NAMES = {
    "CN-CT": "电信",
    "CN-CU": "联通",
    "CN-CM": "移动",
    "CN": "三网",
    "HK": "香港",
    "SG": "新加坡",
}
BAND_NAMES = {"S": "优", "A": "良", "B": "中", "C": "差"}

DEFAULT_GRADING = {
    "default_vantage": "CN",
    "bands": {
        "CN": {
            "S": {"rtt_ms": 80, "loss_pct": 1, "jitter_ms": 15, "peak_rise_pct": 30},
            "A": {"rtt_ms": 150, "loss_pct": 3},
            "B": {"rtt_ms": 250, "loss_pct": 8},
        },
        "OVERSEAS": {
            "S": {"rtt_ms": 30, "loss_pct": 0.5, "jitter_ms": 10},
            "A": {"rtt_ms": 80, "loss_pct": 2},
            "B": {"rtt_ms": 180, "loss_pct": 5},
        },
    },
    "stability_pct": {"S": 95, "A": 80, "B": 60},
    "min_checked_days": 3,
    "min_probes": 2,
    "s_requires_clean_exit": False,
    "probe_enabled": True,
    "peak_start": "19:30",
    "peak_end": "23:30",
    "coverage": "ALL",
}
_LIMIT_KEYS = {"rtt_ms": (1, 2000), "loss_pct": (0, 100), "jitter_ms": (0, 1000)}
_TIME = re.compile(r"^([01][0-9]|2[0-3]):[0-5][0-9]$")


def _number(value, low, high):
    return type(value) in (int, float) and math.isfinite(value) and low <= value <= high


def validate_grading(value) -> dict:
    """Whole-policy validation; omitted keys take defaults. Mirrors grading.ts."""
    if not isinstance(value, dict) or set(value) - DEFAULT_GRADING.keys():
        raise AssetError("INVALID_GRADING_POLICY")
    result = {**copy.deepcopy(DEFAULT_GRADING), **copy.deepcopy(value)}
    if result["default_vantage"] not in VANTAGES or result["coverage"] not in ("ALL", "EXPORTS"):
        raise AssetError("INVALID_GRADING_POLICY")
    for key in ("s_requires_clean_exit", "probe_enabled"):
        if type(result[key]) is not bool:
            raise AssetError("INVALID_GRADING_POLICY")
    for key, low, high in (("min_checked_days", 1, 7), ("min_probes", 1, 5)):
        if type(result[key]) is not int or not low <= result[key] <= high:
            raise AssetError("INVALID_GRADING_POLICY")
    if not all(
        isinstance(result[k], str) and _TIME.match(result[k]) for k in ("peak_start", "peak_end")
    ):
        raise AssetError("INVALID_GRADING_POLICY")
    if result["peak_start"] == result["peak_end"]:
        raise AssetError("INVALID_GRADING_POLICY")
    bands = result["bands"]
    if not isinstance(bands, dict) or set(bands) != {"CN", "OVERSEAS"}:
        raise AssetError("INVALID_GRADING_POLICY")
    for table in bands.values():
        if not isinstance(table, dict) or set(table) != {"S", "A", "B"}:
            raise AssetError("INVALID_GRADING_POLICY")
        previous = None
        for band in ("S", "A", "B"):
            limits = table[band]
            allowed = set(_LIMIT_KEYS) | ({"peak_rise_pct"} if band == "S" else set())
            if not isinstance(limits, dict) or not {"rtt_ms", "loss_pct"} <= set(limits) <= allowed:
                raise AssetError("INVALID_GRADING_POLICY")
            for key, number in limits.items():
                low, high = _LIMIT_KEYS.get(key, (0, 1000))
                if not _number(number, low, high):
                    raise AssetError("INVALID_GRADING_POLICY")
            if previous and any(limits[k] < previous[k] for k in ("rtt_ms", "loss_pct")):
                raise AssetError("INVALID_GRADING_POLICY")
            previous = limits
    stability = result["stability_pct"]
    if not isinstance(stability, dict) or set(stability) != {"S", "A", "B"}:
        raise AssetError("INVALID_GRADING_POLICY")
    if not all(_number(stability[k], 0, 100) for k in ("S", "A", "B")) or not (
        stability["S"] >= stability["A"] >= stability["B"]
    ):
        raise AssetError("INVALID_GRADING_POLICY")
    return result


def minutes(text: str) -> int:
    hours, mins = text.split(":")
    return int(hours) * 60 + int(mins)


def is_peak(beijing_minute: int, policy: dict) -> bool:
    """Peak window in Beijing time; it may wrap past midnight."""
    start, end = minutes(policy["peak_start"]), minutes(policy["peak_end"])
    if start < end:
        return start <= beijing_minute < end
    return beijing_minute >= start or beijing_minute < end


@dataclass(frozen=True)
class Sample:
    target: str
    sent: int
    received: int
    rtt_avg: float | None
    jitter: float | None
    peak: bool
    probe: str
    measured_at: datetime | None = None


@dataclass(frozen=True)
class Access:
    rtt: float | None = None
    idle_rtt: float | None = None
    loss: float | None = None
    jitter: float | None = None
    samples: int = 0
    probes: int = 0
    sufficient: bool = False
    unreachable: bool = False
    last_measured_at: datetime | None = None


def _median(values: Iterable[float | None]) -> float | None:
    clean = [v for v in values if v is not None]
    return round(statistics.median(clean), 1) if clean else None


def _all_failed(samples: list[Sample], policy: dict) -> bool:
    probes = {s.probe for s in samples}
    return (
        len(samples) >= 2
        and len(probes) >= min(2, policy["min_probes"])
        and all(s.received == 0 for s in samples)
    )


def access_stats(
    samples: list[Sample], own_target: str | None, carrier: bool, policy: dict
) -> Access:
    """Window statistics for one vantage. Samples are the entry prefix's (same /24
    route); a target whose every sample failed is excluded from the prefix figures
    and only marks its own nodes unreachable."""
    by_target: dict[str, list[Sample]] = {}
    for sample in samples:
        by_target.setdefault(sample.target, []).append(sample)
    dead = {t for t, group in by_target.items() if _all_failed(group, policy)}
    unreachable = own_target in dead
    usable = [s for s in samples if s.target not in dead]
    last = max((s.measured_at for s in samples if s.measured_at), default=None)
    chosen = [s for s in usable if s.peak] if carrier else usable
    idle = [s for s in usable if not s.peak] if carrier else []
    probes = len({s.probe for s in chosen})
    sent = sum(s.sent for s in chosen)
    return Access(
        rtt=_median(s.rtt_avg for s in chosen if s.received),
        idle_rtt=_median(s.rtt_avg for s in idle if s.received),
        loss=round(1 - sum(s.received for s in chosen) / sent, 4) if sent else None,
        jitter=_median(s.jitter for s in chosen if s.received),
        samples=len(chosen),
        probes=probes,
        sufficient=probes >= policy["min_probes"] and any(s.received for s in chosen),
        unreachable=unreachable,
        last_measured_at=last,
    )


def access_band(access: Access, vantage: str, policy: dict) -> str | None:
    if not access.sufficient or access.rtt is None or access.loss is None:
        return None
    table = policy["bands"]["CN" if vantage.startswith("CN") else "OVERSEAS"]
    for band in ("S", "A", "B"):
        limits = table[band]
        if access.rtt > limits["rtt_ms"] or access.loss * 100 > limits["loss_pct"]:
            continue
        if (
            "jitter_ms" in limits
            and access.jitter is not None
            and access.jitter > limits["jitter_ms"]
        ):
            continue
        rise = limits.get("peak_rise_pct")
        if rise is not None and access.idle_rtt and access.rtt > access.idle_rtt * (1 + rise / 100):
            continue
        return band
    return "C"


def stability_band(available: int, checked: int, policy: dict) -> str | None:
    if checked < policy["min_checked_days"]:
        return None
    ratio = available / checked * 100
    for band in ("S", "A", "B"):
        if ratio >= policy["stability_pct"][band]:
            return band
    return "C"


def worse(*bands: str) -> str:
    return max(bands, key=BANDS.index)


def score(access: Access, available: int, checked: int) -> float:
    """0-100, only for ordering nodes inside one grade."""
    rtt = 1 - min(access.rtt, 400) / 400 if access.rtt is not None else 0.4
    loss = 1 - min(access.loss * 100, 20) / 20 if access.loss is not None else 0.5
    avail = available / checked if checked else 0
    return round(100 * (0.5 * rtt + 0.3 * loss + 0.2 * avail), 1)


@dataclass(frozen=True)
class NodeFacts:
    protocol: str
    target: str | None  # entry "ip:port" (IPv4) or None
    available_days: int
    checked_days: int
    exit_ip_proxy: bool | None = None
    cdn_entry: bool = False  # entry on Cloudflare's anycast edge


@dataclass(frozen=True)
class Grade:
    grade: str
    score: float | None
    access_band: str | None
    stability_band: str | None
    access: Access
    unreachable: bool = False
    reasons: list[str] = field(default_factory=list)


def _fmt_access(access: Access, vantage: str) -> str:
    rtt = f"{access.rtt:g} ms" if access.rtt is not None else "—"
    loss = f"{access.loss * 100:.1f}%" if access.loss is not None else "—"
    when = "晚高峰" if vantage in CARRIERS else "中位"
    return f"{VANTAGE_NAMES[vantage]}{when} RTT {rtt}，丢包 {loss}"


def grade_node(
    facts: NodeFacts, vantage: str, access: Access, reach_failed: bool, policy: dict
) -> Grade:
    """Grade for a carrier, HK or SG. `reach_failed`: the national reachability check
    (any mainland probe) failed for this exact ip:port (only used for CN vantages)."""
    reasons: list[str] = []
    stable = stability_band(facts.available_days, facts.checked_days, policy)
    unreachable = access.unreachable or (reach_failed and vantage.startswith("CN"))
    if unreachable:
        reasons.append(
            f"{VANTAGE_NAMES[vantage]}探针对入口的 TCP 握手全部失败（美国 Runner 检测可用）"
        )
        return Grade("D", 0.0, "C", stable, access, True, reasons)
    band = access_band(access, vantage, policy)
    if facts.target is None:
        reasons.append("入口没有 IPv4 地址（仅 IPv6 或未解析），接入未测，最高 B")
    elif facts.cdn_entry and vantage in OVERSEAS:
        reasons.append(
            f"入口是 Cloudflare CDN：{VANTAGE_NAMES[vantage]}探针只能连到本地 CF 机房"
            "（约 1 ms），测不到节点本身，接入未测，最高 B"
        )
    elif band is None:
        reasons.append(
            f"{VANTAGE_NAMES[vantage]}接入样本不足（{access.probes} 个探针，"
            f"需要 {policy['min_probes']} 个），最高 B"
        )
    else:
        reasons.append(f"{_fmt_access(access, vantage)} → {BAND_NAMES[band]}")
    if facts.protocol == "hysteria2" and band == "S":
        band = "A"
        reasons.append("Hysteria2 走 UDP，延迟按同网段 TCP 测得，最高 A")
    if stable is None:
        reasons.append(
            f"7 天内只检测了 {facts.checked_days} 天，至少需要 {policy['min_checked_days']} 天"
        )
        return Grade(
            "PENDING",
            score(access, facts.available_days, facts.checked_days),
            band,
            None,
            access,
            False,
            reasons,
        )
    reasons.append(
        f"7 天可用 {facts.available_days}/{facts.checked_days} 天 → {BAND_NAMES[stable]}"
    )
    grade = worse(band or "B", stable)
    if grade == "S" and policy["s_requires_clean_exit"] and facts.exit_ip_proxy:
        grade = "A"
        reasons.append("落地 IP 有 ip-api 代理标记，按规则不给 S")
    return Grade(
        grade,
        score(access, facts.available_days, facts.checked_days),
        band,
        stable,
        access,
        False,
        reasons,
    )


def combine_cn(carriers: dict[str, Grade]) -> Grade:
    """Three-carrier grade: the worst carrier decides; one missing carrier caps at B."""
    grades = [carriers[c] for c in CARRIERS if c in carriers]
    if not grades:
        raise ValueError("no carrier grades")
    if all(g.unreachable for g in grades):
        return Grade(
            "D",
            0.0,
            "C",
            grades[0].stability_band,
            grades[0].access,
            True,
            ["三网探针对入口的 TCP 握手全部失败（美国 Runner 检测可用）"],
        )
    ranked = sorted(grades, key=lambda g: GRADES.index(g.grade))
    worst = ranked[-1]
    reasons = [f"{VANTAGE_NAMES[c]} {carriers[c].grade}" for c in CARRIERS if c in carriers]
    reasons.append("三网取最差的一家")
    worst_access = max(
        (g.access for g in grades if g.access.rtt is not None),
        key=lambda a: a.rtt,
        default=worst.access,
    )
    return Grade(
        worst.grade,
        min(g.score or 0 for g in grades),
        worst.access_band,
        worst.stability_band,
        worst_access,
        worst.unreachable,
        reasons,
    )


def best_grade(grades: Iterable[str]) -> str | None:
    present = [g for g in grades if g in GRADES]
    return min(present, key=GRADES.index) if present else None
