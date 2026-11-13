"""Safe dashboard read models and persistent naming rules."""

import json
from datetime import datetime
from uuid import UUID

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import insert

from app.database.models import NamingRevision, NamingRule, NodeCurrentStatus, ScanRun, TestResult
from app.domain import AssetError
from app.naming import render_name
from app.scans import ScanService, now

FILTER_KEYS = {
    "id",
    "node_group",
    "provider_id",
    "asn_label",
    "exit_ip_type",
    "exit_ip_proxy",
    "q",
    "status",
    "protocol",
    "entry_country",
    "exit_country",
    "transport",
    "security",
    "server_host",
    "server_port",
    "entry_ip",
    "exit_ip",
    "exit_city",
    "entry_asn",
    "exit_asn",
    "asn",
    "source_id",
    "enabled",
    "eligible",
    "probe_key",
    "grade",
    "confidence",
    "line_type",
    "line_claim",
    "evidence_level",
    "tags",
    "operator",
    "min_success_rate",
    "max_timeout_rate",
    "max_http_ms",
    "max_http_p95_ms",
    "min_samples",
    "min_age_days",
    "min_checked_days",
    "min_available_days",
    "min_lifetime_availability",
    "last_checked_after",
    "last_success_after",
    # Grades (node_grades) for one vantage; see docs/NODE_GRADING_DESIGN.md.
    "vantage",
    "quality_grade",
    "min_quality_grade",
    "max_peak_rtt_ms",
    "max_peak_loss",
    "min_avail_7d",
    "route_asn",
    "cross_border",
    "unreachable",
    "best_per_server",
}
BOOLEAN_KEYS = (
    "enabled",
    "eligible",
    "exit_ip_proxy",
    "cross_border",
    "unreachable",
    "best_per_server",
)


def filters_from_params(params):
    if set(params) - FILTER_KEYS - {"offset", "limit", "sort"}:
        raise AssetError("INVALID_NODE_QUERY")
    result = {k: v for k, v in params.items() if k in FILTER_KEYS and v != ""}
    for key in BOOLEAN_KEYS:
        if key in result:
            if result[key] not in ("true", "false"):
                raise AssetError("INVALID_NODE_QUERY")
            result[key] = result[key] == "true"
    if "tags" in result:
        result["tags"] = [tag.strip() for tag in result["tags"].split(",") if tag.strip()]
    return result


class Catalog:
    def __init__(self, assets, settings):
        self.assets, self.settings, self.sessions = assets, settings, assets.sessions

    def template(self):
        with self.sessions() as session:
            rule = session.get(NamingRule, 1)
            return rule.template if rule else self.settings.name_template

    def naming(self):
        with self.sessions() as session:
            return {
                "template": self.template(),
                "history": [
                    {"id": row.id, "template": row.template, "created_at": row.created_at}
                    for row in session.scalars(
                        sa.select(NamingRevision)
                        .order_by(NamingRevision.created_at.desc())
                        .limit(50)
                    )
                ],
            }

    def set_template(self, template):
        render_name("N000001", "vless", "tcp", "tls", template)
        with self.sessions.begin() as session:
            session.execute(
                insert(NamingRule)
                .values(id=1, template=template)
                .on_conflict_do_update(
                    index_elements=[NamingRule.id], set_={"template": template, "updated_at": now()}
                )
            )
            session.add(NamingRevision(template=template))
        return {"template": template}

    def preview(self, template):
        render_name("N000001", "vless", "tcp", "tls", template)
        # Rendered by SQL so the preview always matches subscriptions exactly.
        items = self.page({}, limit=20, template=template)["items"]
        return [{"id": node["id"], "name": node["name"]} for node in items]

    def nodes(
        self,
        *,
        query="",
        status=None,
        protocol=None,
        entry_country=None,
        exit_country=None,
        transport=None,
        security=None,
        asn=None,
        offset=0,
        limit=100,
        sort="short_id:asc",
        **extra,
    ):
        filters = {
            k: v
            for k, v in {
                "q": query or None,
                "status": status,
                "protocol": protocol,
                "entry_country": entry_country,
                "exit_country": exit_country,
                "transport": transport,
                "security": security,
                "asn": asn,
                **extra,
            }.items()
            if v is not None
        }
        return self.page(filters, sort=sort, offset=offset, limit=limit)

    def page(self, filters=None, *, sort="short_id:asc", offset=0, limit=100, template=None):
        if (
            type(offset) is not int
            or offset < 0
            or type(limit) is not int
            or not 1 <= limit <= 100000
        ):
            raise AssetError("INVALID_PAGINATION")
        if (filters is not None and not isinstance(filters, dict)) or set(
            filters or {}
        ) - FILTER_KEYS:
            raise AssetError("INVALID_NODE_QUERY")
        if not isinstance(sort, str):
            raise AssetError("INVALID_NODE_SORT")
        try:
            with self.sessions() as session:
                result = session.scalar(
                    sa.text(
                        "SELECT nodema_node_page(CAST(:filters AS jsonb),"
                        ":sort,:offset,:limit,:fresh,:tpl)"
                    ),
                    {
                        "filters": json.dumps(filters or {}, default=str, allow_nan=False),
                        "sort": sort,
                        "offset": offset,
                        "limit": limit,
                        "fresh": self.settings.freshness_hours,
                        "tpl": template or self.template(),
                    },
                )
        except (TypeError, ValueError):
            raise AssetError("INVALID_NODE_QUERY") from None
        except sa.exc.DBAPIError as error:
            message = getattr(getattr(error.orig, "diag", None), "message_primary", "")
            code = (
                message
                if message in ("INVALID_NODE_QUERY", "INVALID_NODE_SORT")
                else "INVALID_NODE_QUERY"
                if getattr(error.orig, "sqlstate", "").startswith("22")
                else "DATABASE_QUERY_FAILED"
            )
            raise AssetError(code) from None
        for node in result["items"]:
            node["id"] = UUID(node["id"])
            for key in (
                "first_seen_at",
                "last_seen_at",
                "last_checked_at",
                "last_success_at",
                "next_full_check_at",
                "evidence_updated_at",
                "metrics_updated_at",
                "evaluated_at",
                "route_measured_at",
                "access_measured_at",
                "grade_computed_at",
            ):
                if node.get(key):
                    node[key] = datetime.fromisoformat(node[key])
        return result

    def node(self, node_id, vantage=None):
        extra = {"vantage": vantage} if vantage else {}
        items = self.nodes(id=str(node_id), limit=1, **extra)["items"]
        node = items[0] if items else None
        if node is None:
            raise AssetError("NODE_NOT_FOUND")
        node["sources"] = self.assets.get_node(node_id)["sources"]
        with self.sessions() as session:
            current = session.get(NodeCurrentStatus, node_id)
            published = (
                session.get(TestResult, current.last_result_id)
                if current and current.last_result_id
                else None
            )
            node["published_observation"] = (
                {
                    column.name: getattr(published, column.name)
                    for column in TestResult.__table__.columns
                }
                if published
                else None
            )
            node["history"] = [
                {column.name: getattr(row, column.name) for column in TestResult.__table__.columns}
                for row in session.scalars(
                    sa.select(TestResult)
                    .where(TestResult.node_id == node_id)
                    .order_by(TestResult.checked_at.desc(), TestResult.id.desc())
                    .limit(100)
                )
            ]
        return node

    def overview(self):
        with self.sessions() as session:
            aggregate = session.scalar(
                sa.text("""
                WITH data AS (SELECT status,eligible,exit_country
                  FROM nodema_catalog(:fresh,:tpl,'GENERAL'))
                SELECT jsonb_build_object('total',(SELECT count(*) FROM data),
                  'eligible',(SELECT count(*) FROM data WHERE eligible),
                  'statuses',coalesce((SELECT jsonb_object_agg(status,n) FROM
                    (SELECT status,count(*) n FROM data GROUP BY status) s),'{}'),
                  'countries',coalesce((SELECT jsonb_object_agg(country,n) FROM
                    (SELECT coalesce(exit_country,'UNK') country,count(*) n
                      FROM data GROUP BY 1) s),'{}'))
            """),
                {"fresh": self.settings.freshness_hours, "tpl": self.template()},
            )
        runs = ScanService(self.assets, self.settings).list()
        latest = ScanService(self.assets, self.settings).get(runs[0]["id"]) if runs else None
        with self.sessions() as session:
            completed = session.scalar(
                sa.select(ScanRun)
                .where(ScanRun.kind == "DAILY", ScanRun.status == "COMPLETED")
                .order_by(ScanRun.finished_at.desc())
                .limit(1)
            )
            last_complete = ScanService._run_dto(completed) if completed else None
        return {
            **aggregate,
            "latest_scan": latest,
            "latest_completed_scan": last_complete,
        }
