"""Landing-IP details (netblock org, ISP, region) from ip-api.com.

Runs in Actions after test results are published. The free tier is HTTP only and
allows 15 batch requests per minute, so only new or month-old landing IPs are sent.
A failure never fails a scan: the round is skipped and retried next time. Only
counts are reported; IPs and response bodies never reach logs.
"""

import ipaddress
import json
import re
import urllib.error
import urllib.request
from dataclasses import dataclass

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import insert

from app.database.models import IpInfo
from app.scans import now

FIELDS = "status,countryCode,regionName,city,isp,org,as,query"
BATCH_SIZE = 100
MAX_TEXT = 200
CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f​-‏ -‮⁦-⁩]")
AS_TEXT = re.compile(r"^AS(\d{1,10})(?:\s+(.*))?$")


def clean(value: object, limit: int = MAX_TEXT) -> str | None:
    """Untrusted provider text: drop control/bidi characters, collapse spaces, cap length."""
    if not isinstance(value, str):
        return None
    text = " ".join(CONTROL.sub(" ", value).split())[:limit]
    return text or None


def parse_as(value: object) -> tuple[int | None, str | None]:
    """'AS3258 xTom Japan Corporation' -> (3258, 'xTom Japan Corporation')."""
    match = AS_TEXT.match(clean(value) or "")
    if not match:
        return None, None
    number = int(match.group(1))
    return (number if number <= 4294967295 else None), clean(match.group(2))


def parse_entry(item: object, requested: set[str]) -> dict | None:
    if not isinstance(item, dict) or item.get("query") not in requested:
        return None
    if item.get("status") != "success":
        return {"ip": item["query"], "status": "FAILED"}
    as_number, as_org = parse_as(item.get("as"))
    country = clean(item.get("countryCode"), 2)
    return {
        "ip": item["query"],
        "status": "SUCCESS",
        "country_code": country if country and country.isalpha() else None,
        "region": clean(item.get("regionName")),
        "city": clean(item.get("city")),
        "isp": clean(item.get("isp")),
        "org": clean(item.get("org")),
        "as_number": as_number,
        "as_org": as_org,
    }


@dataclass(frozen=True)
class BatchReply:
    items: list
    remaining: int | None


class IpApiClient:
    def __init__(self, url: str, timeout: float):
        self.url, self.timeout = url, timeout

    def lookup(self, ips: list[str]) -> BatchReply:
        request = urllib.request.Request(
            f"{self.url}?fields={FIELDS}",
            data=json.dumps(ips).encode(),
            headers={"Content-Type": "application/json", "User-Agent": "nodema"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=self.timeout) as response:  # noqa: S310
            body = response.read(2_000_000)
            remaining = response.headers.get("X-Rl")
        data = json.loads(body)
        if not isinstance(data, list):
            raise ValueError("unexpected response")
        return BatchReply(data, int(remaining) if remaining and remaining.isdigit() else None)


def public_ip(value: str) -> bool:
    try:
        return ipaddress.ip_address(value).is_global
    except ValueError:
        return False


def pending_ips(session, refresh_days: int, limit: int) -> list[str]:
    """Landing IPs with no details yet, month-old details, or a failure older than a day."""
    rows = session.scalars(
        sa.text("""
        SELECT DISTINCT c.last_exit_ip FROM node_current_status c
        LEFT JOIN ip_info i ON i.ip=c.last_exit_ip
        WHERE c.last_exit_ip IS NOT NULL AND length(c.last_exit_ip)<=64 AND (i.ip IS NULL
          OR (i.status='SUCCESS' AND i.queried_at < now()-make_interval(days=>:days))
          OR (i.status<>'SUCCESS' AND i.queried_at < now()-interval '1 day'))
        ORDER BY 1 LIMIT :limit
    """),
        {"days": refresh_days, "limit": limit},
    ).all()
    return [ip for ip in rows if public_ip(ip)]


def refresh(sessions, settings, client: IpApiClient | None = None) -> dict:
    """Fetch details for pending landing IPs, then renumber names. Returns counts only."""
    summary = {"pending": 0, "saved": 0, "failed_lookups": 0, "names_changed": 0, "skipped": None}
    if not settings.ipinfo_enabled:
        return {**summary, "skipped": "DISABLED"}
    client = client or IpApiClient(settings.ipinfo_url, settings.ipinfo_timeout_seconds)
    with sessions() as session:
        ips = pending_ips(session, settings.ipinfo_refresh_days, settings.ipinfo_max_ips)
    summary["pending"] = len(ips)
    rows = []
    for start in range(0, len(ips), BATCH_SIZE):
        chunk = ips[start : start + BATCH_SIZE]
        try:
            reply = client.lookup(chunk)
        except (OSError, ValueError, urllib.error.URLError):
            # Includes HTTP 429 and timeouts: keep what we have, retry next run.
            summary["skipped"] = "LOOKUP_FAILED"
            break
        requested = set(chunk)
        parsed = [row for row in (parse_entry(i, requested) for i in reply.items) if row]
        rows.extend(parsed)
        summary["failed_lookups"] += sum(r["status"] == "FAILED" for r in parsed)
        if reply.remaining == 0:
            summary["skipped"] = "RATE_LIMITED"
            break
    with sessions.begin() as session:
        if rows:
            stamp = now()
            for row in rows:
                values = {**row, "queried_at": stamp}
                update = {k: v for k, v in values.items() if k != "ip"}
                if row["status"] == "FAILED":
                    # A transient failure never erases details found earlier.
                    update = {"queried_at": stamp}
                session.execute(
                    insert(IpInfo)
                    .values(values)
                    .on_conflict_do_update(index_elements=[IpInfo.ip], set_=update)
                )
            summary["saved"] = len(rows)
        summary["names_changed"] = session.scalar(sa.text("SELECT nodema_assign_names()"))
    return summary
