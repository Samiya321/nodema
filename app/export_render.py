"""One bounded Python renderer, used by Actions and local export verification."""

import csv
import io
import json
from datetime import datetime, timedelta
from uuid import UUID

import sqlalchemy as sa
import yaml

from app.conversion import to_mihomo, to_singbox, to_uri
from app.database.models import CatalogState, NamingRule
from app.domain import AssetError

MAX_EXPORT_BYTES = 10_485_760
FORMATS = {
    "mihomo": ("text/yaml", "yaml"),
    "singbox": ("application/json", "json"),
    "uri": ("text/plain", "txt"),
    "json": ("application/json", "json"),
    "csv": ("text/csv", "csv"),
}
CSV_FIELDS = [
    "first_seen_at",
    "age_days",
    "checked_days",
    "available_days",
    "lifetime_availability",
    "short_id",
    "name",
    "protocol",
    "server_host",
    "server_port",
    "status",
    "entry_country",
    "exit_country",
    "exit_asn",
    "http_duration_ms",
    "entry_asn",
    "grade",
    "confidence",
    "operator",
    "sample_count",
    "success_rate",
    "http_p50_ms",
    "http_p95_ms",
    "probe_key",
    "line_claim",
    "rule_version",
    "mainland_reachability",
    "timeout_rate",
    "evidence_level",
    "evidence_age_days",
    "evidence_updated_at",
]
REPORT_FIELDS = set(CSV_FIELDS) | {
    "transport",
    "security",
    "exit_ip",
    "last_checked_at",
    "reasons",
    "tags",
}


def validate(session, format, filters):
    if format not in FORMATS:
        raise AssetError("INVALID_EXPORT_FORMAT")
    if not isinstance(filters, dict):
        raise AssetError("INVALID_EXPORT_FILTER")
    try:
        return session.scalar(
            sa.text("SELECT nodema_validate_export(:format,CAST(:filters AS jsonb))"),
            {"format": format, "filters": json.dumps(filters, allow_nan=False, default=str)},
        )
    except (sa.exc.DBAPIError, ValueError, TypeError):
        raise AssetError("INVALID_EXPORT_FILTER") from None


class Renderer:
    def __init__(self, format):
        if format not in FORMATS:
            raise AssetError("INVALID_EXPORT_FORMAT")
        self.format, self.body, self.count = format, bytearray(), 0
        if format in ("json", "singbox"):
            self.push("[" if format == "json" else '{"outbounds":[')
        elif format == "csv":
            self.push(b"\xef\xbb\xbf")
            self.push(self.csv_row(dict(zip(CSV_FIELDS, CSV_FIELDS, strict=True))))

    def push(self, data):
        raw = data.encode() if isinstance(data, str) else data
        if len(self.body) + len(raw) > MAX_EXPORT_BYTES:
            raise AssetError("EXPORT_TOO_LARGE")
        self.body.extend(raw)

    @staticmethod
    def csv_row(node):
        stream = io.StringIO()
        writer = csv.writer(stream)
        values = [node.get(field) for field in CSV_FIELDS]
        writer.writerow(
            [
                "'" + value
                if isinstance(value, str) and value.startswith(("=", "+", "-", "@", "\t", "\r"))
                else value
                for value in values
            ]
        )
        return stream.getvalue()

    def append(self, node, identity=None):
        if self.format == "json":
            self.push(
                ("," if self.count else "")
                + json.dumps(
                    {k: v for k, v in node.items() if k in REPORT_FIELDS},
                    ensure_ascii=False,
                    default=str,
                )
            )
        elif self.format == "csv":
            self.push(self.csv_row(node))
        else:
            proxy = {"mihomo": to_mihomo, "singbox": to_singbox, "uri": to_uri}[self.format](
                identity, node["name"]
            )
            if self.format == "mihomo":
                if not self.count:
                    self.push("proxies:\n")
                self.push(yaml.safe_dump([proxy], allow_unicode=True, sort_keys=False))
            elif self.format == "singbox":
                self.push(("," if self.count else "") + json.dumps(proxy, ensure_ascii=False))
            else:
                self.push(proxy + "\n")
        self.count += 1

    def finish(self):
        if self.format in ("json", "singbox"):
            self.push("]" if self.format == "json" else "]}")
        elif self.format == "mihomo" and not self.count:
            self.push("proxies: []\n")
        return bytes(self.body)


def render_snapshot(assets, settings, format, filters, at, heartbeat=None):
    with assets.sessions() as session:
        session.connection(execution_options={"isolation_level": "REPEATABLE READ"})
        session.execute(sa.text("SET TRANSACTION READ ONLY"))
        filters = validate(session, format, filters or {})
        ordering, limit = filters.pop("sort"), filters.pop("limit")
        epoch = session.scalar(sa.select(CatalogState.revision).where(CatalogState.id == 1))
        template = (
            session.scalar(sa.select(NamingRule.template).where(NamingRule.id == 1))
            or settings.name_template
        )
        cutoff = at - timedelta(hours=settings.freshness_hours)
        if filters.get("last_success_after"):
            cutoff = max(cutoff, datetime.fromisoformat(filters["last_success_after"]))
        filters.update(status="UP", eligible=True, last_success_after=cutoff.isoformat())
        writer, members, deadline = (
            Renderer(format),
            [],
            at + timedelta(hours=settings.freshness_hours),
        )
        offset = 0
        while offset < limit:
            if heartbeat:
                heartbeat()
            page = session.scalar(
                sa.text(
                    "SELECT nodema_node_page(CAST(:filters AS jsonb),:sort,:offset,:limit,"
                    ":fresh,:tpl,:projection)"
                ),
                dict(
                    filters=json.dumps(filters),
                    sort=ordering,
                    offset=offset,
                    limit=min(1000, limit - offset),
                    fresh=settings.freshness_hours,
                    tpl=template,
                    projection="report" if format in ("json", "csv") else "identity",
                ),
            )
            items = page["items"]
            if not items:
                break
            for item in items:
                members.append(item["id"])
                success = datetime.fromisoformat(item["last_success_at"])
                deadline = min(deadline, success + timedelta(hours=settings.freshness_hours))
            if format in ("json", "csv"):
                for item in items:
                    writer.append(item)
            else:
                lengths = dict(
                    session.execute(
                        sa.text(
                            "SELECT id,octet_length(config_data) FROM nodes "
                            "WHERE id=ANY(CAST(:ids AS uuid[]))"
                        ),
                        {"ids": [i["id"] for i in items]},
                    ).all()
                )
                start = 0
                while start < len(items):
                    end, size = start, 0
                    while end < len(items):
                        length = lengths[UUID(items[end]["id"])]
                        if length > MAX_EXPORT_BYTES:
                            raise AssetError("EXPORT_TOO_LARGE")
                        if end > start and size + length > 1_048_576:
                            break
                        size += length
                        end += 1
                    chunk = items[start:end]
                    stored = dict(
                        session.execute(
                            sa.text(
                                "SELECT id,config_data FROM nodes "
                                "WHERE id=ANY(CAST(:ids AS uuid[]))"
                            ),
                            {"ids": [i["id"] for i in chunk]},
                        ).all()
                    )
                    for item in chunk:
                        try:
                            identity = json.loads(bytes(stored[UUID(item["id"])]))
                        except (ValueError, TypeError, KeyError):
                            raise AssetError("STORED_DATA_INVALID") from None
                        writer.append(item, identity)
                    start = end
            offset += len(items)
            if offset >= page["total"]:
                break
        return {
            "payload": writer.finish(),
            "node_count": writer.count,
            "members": members,
            "catalog_revision": epoch,
            "valid_until": deadline,
        }
