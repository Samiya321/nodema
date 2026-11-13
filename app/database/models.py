from datetime import date, datetime
from decimal import Decimal
from uuid import UUID, uuid4

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    metadata = sa.MetaData(
        naming_convention={
            "ix": "ix_%(table_name)s_%(column_0_name)s",
            "uq": "uq_%(table_name)s_%(column_0_name)s",
            "ck": "ck_%(table_name)s_%(constraint_name)s",
            "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
            "pk": "pk_%(table_name)s",
        }
    )


short_id_sequence = sa.Sequence("node_short_id_seq", metadata=Base.metadata)


class Source(Base):
    __tablename__ = "sources"
    __table_args__ = (
        sa.CheckConstraint(
            "type IN ('SUBSCRIPTION_URL','SINGLE_URI','UPLOADED_FILE','RAW_TEXT')", name="type"
        ),
        sa.CheckConstraint(
            "format_hint IN ('AUTO','URI','BASE64','CLASH','SINGBOX')", name="format"
        ),
        sa.CheckConstraint("sync_interval_seconds > 0", name="sync_interval"),
        sa.CheckConstraint(
            "(type = 'SUBSCRIPTION_URL' AND url_data IS NOT NULL) OR "
            "(type <> 'SUBSCRIPTION_URL' AND url_data IS NULL "
            "AND payload_data IS NOT NULL)",
            name="input",
        ),
        sa.CheckConstraint(
            "last_sync_status IN ('NEVER','SUCCESS','PARTIAL','FAILED')", name="status"
        ),
        sa.CheckConstraint("kind IN ('AUTO','AIRPORT','SELF_HOSTED')", name="kind"),
        sa.CheckConstraint(
            "detected_kind IN ('UNKNOWN','AIRPORT','SELF_HOSTED','SUBSTORE')", name="detected_kind"
        ),
        sa.Index("idx_sources_parent", "parent_source_id"),
        sa.Index("idx_sources_provider", "provider_id"),
        sa.Index(
            "uq_sources_origin",
            "parent_source_id",
            "origin_key",
            unique=True,
            postgresql_where=sa.text("parent_source_id IS NOT NULL AND deleted_at IS NULL"),
        ),
    )
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    name: Mapped[str] = mapped_column(sa.Text)
    type: Mapped[str] = mapped_column(sa.Text)
    format_hint: Mapped[str] = mapped_column(sa.Text, server_default="AUTO")
    url_data: Mapped[bytes | None] = mapped_column(sa.LargeBinary)
    payload_data: Mapped[bytes | None] = mapped_column(sa.LargeBinary)
    enabled: Mapped[bool] = mapped_column(server_default=sa.true())
    sync_interval_seconds: Mapped[int] = mapped_column(server_default="86400")
    content_hash: Mapped[str | None] = mapped_column(sa.Text)
    applied_hash: Mapped[str | None] = mapped_column(sa.Text)
    parser_version: Mapped[str | None] = mapped_column(sa.Text)
    last_checked_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    sync_requested_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    last_synced_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    last_sync_status: Mapped[str] = mapped_column(sa.Text, server_default="NEVER")
    last_error_code: Mapped[str | None] = mapped_column(sa.Text)
    last_parse_summary: Mapped[dict] = mapped_column(JSONB, server_default=sa.text("'{}'::jsonb"))
    revision: Mapped[int] = mapped_column(sa.BigInteger, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    # AUTO follows detection; users can force AIRPORT/SELF_HOSTED.
    kind: Mapped[str] = mapped_column(sa.Text, server_default="AUTO")
    detected_kind: Mapped[str] = mapped_column(sa.Text, server_default="UNKNOWN")
    parent_source_id: Mapped[UUID | None] = mapped_column(
        sa.ForeignKey("sources.id", ondelete="RESTRICT")
    )
    origin_key: Mapped[str | None] = mapped_column(sa.Text)
    origin_label: Mapped[str | None] = mapped_column(sa.Text)
    user_agent: Mapped[str | None] = mapped_column(sa.Text)
    provider_id: Mapped[UUID | None] = mapped_column(
        sa.ForeignKey("providers.id", ondelete="SET NULL")
    )
    traffic_upload: Mapped[int | None] = mapped_column(sa.BigInteger)
    traffic_download: Mapped[int | None] = mapped_column(sa.BigInteger)
    traffic_total: Mapped[int | None] = mapped_column(sa.BigInteger)
    expires_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    userinfo_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    profile_title: Mapped[str | None] = mapped_column(sa.Text)
    profile_url: Mapped[str | None] = mapped_column(sa.Text)
    last_success_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))


class Provider(Base):
    """An airport; several subscription links can belong to one provider."""

    __tablename__ = "providers"
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    name: Mapped[str] = mapped_column(sa.Text)
    match_key: Mapped[str | None] = mapped_column(sa.Text, unique=True)
    website: Mapped[str | None] = mapped_column(sa.Text)
    created_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now()
    )


class Node(Base):
    __tablename__ = "nodes"
    __table_args__ = (
        sa.UniqueConstraint("fingerprint_version", "fingerprint"),
        sa.CheckConstraint("octet_length(fingerprint) = 32", name="fingerprint_length"),
        sa.CheckConstraint("fingerprint_version > 0", name="fingerprint_version"),
        sa.CheckConstraint("server_port BETWEEN 1 AND 65535", name="port"),
        sa.CheckConstraint(
            "protocol IN ('shadowsocks','trojan','anytls','hysteria2','vmess','vless')",
            name="protocol",
        ),
        sa.CheckConstraint("line_type = 'UNKNOWN'", name="line_type"),
        sa.Index("idx_nodes_enabled", "enabled"),
        sa.Index("idx_nodes_protocol", "protocol"),
        sa.Index("idx_nodes_endpoint", "server_host", "server_port"),
        sa.Index("idx_nodes_first_seen", "first_seen_at"),
        sa.CheckConstraint(
            "checked_days>=0 AND available_days>=0 AND available_days<=checked_days",
            name="lifetime_days",
        ),
    )
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    short_id: Mapped[str] = mapped_column(sa.Text, unique=True)
    fingerprint: Mapped[bytes] = mapped_column(sa.LargeBinary)
    fingerprint_version: Mapped[int] = mapped_column(server_default="1")
    protocol: Mapped[str] = mapped_column(sa.Text)
    server_host: Mapped[str] = mapped_column(sa.Text)
    server_port: Mapped[int]
    transport: Mapped[str | None] = mapped_column(sa.Text)
    security: Mapped[str | None] = mapped_column(sa.Text)
    config_data: Mapped[bytes] = mapped_column(sa.LargeBinary)
    line_type: Mapped[str] = mapped_column(sa.Text, server_default="UNKNOWN")
    enabled: Mapped[bool] = mapped_column(server_default=sa.true())
    checked_days: Mapped[int] = mapped_column(server_default="0")
    available_days: Mapped[int] = mapped_column(server_default="0")
    first_seen_at: Mapped[datetime] = mapped_column(sa.DateTime(timezone=True))
    last_seen_at: Mapped[datetime] = mapped_column(sa.DateTime(timezone=True))


class NodeSource(Base):
    __tablename__ = "node_sources"
    __table_args__ = (
        sa.Index("idx_node_sources_source", "source_id", "is_present", "last_seen_at"),
    )
    node_id: Mapped[UUID] = mapped_column(
        sa.ForeignKey("nodes.id", ondelete="RESTRICT"), primary_key=True
    )
    source_id: Mapped[UUID] = mapped_column(
        sa.ForeignKey("sources.id", ondelete="RESTRICT"), primary_key=True
    )
    aliases_data: Mapped[bytes] = mapped_column(sa.LargeBinary)
    is_present: Mapped[bool] = mapped_column(server_default=sa.true())
    first_seen_at: Mapped[datetime] = mapped_column(sa.DateTime(timezone=True))
    last_seen_at: Mapped[datetime] = mapped_column(sa.DateTime(timezone=True))


class ScanRun(Base):
    __tablename__ = "scan_runs"
    __table_args__ = (
        sa.CheckConstraint("kind IN ('DAILY','SUPPLEMENTAL','MANUAL')", name="kind"),
        sa.CheckConstraint("scope IN ('ALL','SELF_HOSTED','AIRPORT')", name="scope"),
        sa.Index(
            "uq_scan_runs_daily",
            "scan_date",
            unique=True,
            postgresql_where=sa.text("kind = 'DAILY'"),
        ),
        sa.Index("idx_scan_runs_day", "scan_date", "started_at"),
    )
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    scan_date: Mapped[date] = mapped_column(sa.Date)
    kind: Mapped[str] = mapped_column(sa.Text, server_default="DAILY")
    status: Mapped[str] = mapped_column(sa.Text, server_default="PENDING")
    node_count: Mapped[int]
    shard_count: Mapped[int]
    started_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now()
    )
    finished_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    error_summary: Mapped[dict] = mapped_column(JSONB, server_default=sa.text("'{}'::jsonb"))
    archived_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    archive_summary: Mapped[dict] = mapped_column(JSONB, server_default=sa.text("'{}'::jsonb"))
    scope: Mapped[str] = mapped_column(sa.Text, server_default="ALL")


class ScanShard(Base):
    __tablename__ = "scan_shards"
    scan_run_id: Mapped[UUID] = mapped_column(sa.ForeignKey("scan_runs.id"), primary_key=True)
    shard_no: Mapped[int] = mapped_column(primary_key=True)
    status: Mapped[str] = mapped_column(sa.Text, server_default="PENDING")
    planned_count: Mapped[int]
    completed_count: Mapped[int] = mapped_column(server_default="0")
    failed_count: Mapped[int] = mapped_column(server_default="0")
    lease_owner: Mapped[UUID | None]
    lease_until: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    started_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    last_heartbeat_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    error_summary: Mapped[dict] = mapped_column(JSONB, server_default=sa.text("'{}'::jsonb"))


class ScanItem(Base):
    __tablename__ = "scan_items"
    __table_args__ = (
        sa.ForeignKeyConstraint(
            ["scan_run_id", "shard_no"], ["scan_shards.scan_run_id", "scan_shards.shard_no"]
        ),
        sa.Index("idx_scan_items_shard", "scan_run_id", "shard_no", "status"),
    )
    scan_run_id: Mapped[UUID] = mapped_column(sa.ForeignKey("scan_runs.id"), primary_key=True)
    node_id: Mapped[UUID] = mapped_column(sa.ForeignKey("nodes.id"), primary_key=True)
    shard_no: Mapped[int]
    status: Mapped[str] = mapped_column(sa.Text, server_default="PENDING")
    attempts: Mapped[int] = mapped_column(server_default="0")
    last_error_code: Mapped[str | None] = mapped_column(sa.Text)
    updated_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now()
    )


class TestResult(Base):
    __tablename__ = "test_results"
    __table_args__ = (
        sa.UniqueConstraint("scan_run_id", "node_id", "attempt_no"),
        sa.ForeignKeyConstraint(
            ["scan_run_id", "node_id"], ["scan_items.scan_run_id", "scan_items.node_id"]
        ),
        sa.Index("idx_test_results_node_time", "node_id", sa.text("checked_at DESC")),
    )
    id: Mapped[int] = mapped_column(sa.BigInteger, sa.Identity(), primary_key=True)
    scan_run_id: Mapped[UUID]
    node_id: Mapped[UUID] = mapped_column(sa.ForeignKey("nodes.id"))
    attempt_no: Mapped[int]
    checked_at: Mapped[datetime] = mapped_column(sa.DateTime(timezone=True))
    check_duration_ms: Mapped[int | None]
    timeout_stages: Mapped[list] = mapped_column(JSONB, server_default=sa.text("'[]'::jsonb"))
    parse_ok: Mapped[bool]
    dns_status: Mapped[str] = mapped_column(sa.Text)
    entry_ips: Mapped[list] = mapped_column(JSONB)
    entry_country: Mapped[str | None] = mapped_column(sa.Text)
    entry_asn: Mapped[int | None] = mapped_column(sa.BigInteger)
    tcp_status: Mapped[str] = mapped_column(sa.Text)
    proxy_status: Mapped[str] = mapped_column(sa.Text)
    http_status: Mapped[str] = mapped_column(sa.Text)
    exit_ip: Mapped[str | None] = mapped_column(sa.Text)
    exit_country: Mapped[str | None] = mapped_column(sa.Text)
    exit_city: Mapped[str | None] = mapped_column(sa.Text)
    exit_asn: Mapped[int | None] = mapped_column(sa.BigInteger)
    dns_duration_ms: Mapped[int | None]
    tcp_duration_ms: Mapped[int | None]
    http_duration_ms: Mapped[int | None]
    status: Mapped[str] = mapped_column(sa.Text)
    error_code: Mapped[str | None] = mapped_column(sa.Text)
    geoip_metadata: Mapped[dict] = mapped_column(JSONB)
    echo_source: Mapped[str | None] = mapped_column(sa.Text)
    probe_key: Mapped[str] = mapped_column(sa.Text, server_default="legacy")
    probe_metadata: Mapped[dict] = mapped_column(JSONB, server_default=sa.text("'{}'::jsonb"))
    measurement_kind: Mapped[str] = mapped_column(sa.Text, server_default="FULL")
    precheck_metadata: Mapped[dict] = mapped_column(JSONB, server_default=sa.text("'{}'::jsonb"))
    exit_asn_org: Mapped[str | None] = mapped_column(sa.Text)


class NodeCurrentStatus(Base):
    __tablename__ = "node_current_status"
    __table_args__ = (
        sa.Index("idx_current_entry", "entry_country", "entry_asn"),
        sa.Index("idx_current_exit", "last_exit_country", "last_exit_asn"),
        sa.Index("idx_current_checked", sa.text("last_checked_at DESC")),
    )
    node_id: Mapped[UUID] = mapped_column(sa.ForeignKey("nodes.id"), primary_key=True)
    status: Mapped[str] = mapped_column(sa.Text)
    last_checked_at: Mapped[datetime] = mapped_column(sa.DateTime(timezone=True))
    last_success_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    last_error_code: Mapped[str | None] = mapped_column(sa.Text)
    consecutive_failures: Mapped[int] = mapped_column(server_default="0")
    last_result_id: Mapped[int | None] = mapped_column(
        sa.ForeignKey("test_results.id", ondelete="SET NULL")
    )
    last_exit_ip: Mapped[str | None] = mapped_column(sa.Text)
    last_exit_country: Mapped[str | None] = mapped_column(sa.Text)
    last_exit_asn: Mapped[int | None] = mapped_column(sa.BigInteger)
    last_http_duration_ms: Mapped[int | None]
    entry_country: Mapped[str | None] = mapped_column(sa.Text)
    entry_asn: Mapped[int | None] = mapped_column(sa.BigInteger)
    probe_key: Mapped[str] = mapped_column(sa.Text, server_default="legacy")
    next_full_check_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    measurement_kind: Mapped[str] = mapped_column(sa.Text, server_default="FULL")
    last_exit_asn_org: Mapped[str | None] = mapped_column(sa.Text)


class ScanRequest(Base):
    """A requested test scope; consumed by the next Actions run even if GitHub
    replaced the dispatch that carried it."""

    __tablename__ = "scan_requests"
    __table_args__ = (
        sa.Index(
            "idx_scan_requests_pending",
            "requested_at",
            postgresql_where=sa.text("consumed_at IS NULL"),
        ),
    )
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    scope: Mapped[str] = mapped_column(sa.Text)
    requested_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now()
    )
    consumed_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    scan_run_id: Mapped[UUID | None] = mapped_column(sa.ForeignKey("scan_runs.id"))
    node_ids: Mapped[list[UUID] | None] = mapped_column(sa.ARRAY(sa.Uuid))


class AppSettings(Base):
    __tablename__ = "app_settings"
    id: Mapped[int] = mapped_column(primary_key=True)
    daily_scan_enabled: Mapped[bool] = mapped_column(server_default=sa.true())
    daily_scan_scope: Mapped[str] = mapped_column(sa.Text, server_default="SELF_HOSTED")
    updated_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now()
    )


class AsnLabel(Base):
    __tablename__ = "asn_labels"
    asn: Mapped[int] = mapped_column(sa.BigInteger, primary_key=True, autoincrement=False)
    label: Mapped[str] = mapped_column(sa.Text)
    origin: Mapped[str] = mapped_column(sa.Text, server_default="USER")
    updated_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now()
    )


class NodeName(Base):
    """Per-node name parts copied from its landing server; maintained in SQL."""

    __tablename__ = "node_names"
    __table_args__ = (sa.Index("idx_node_names_server", "server_key"),)
    node_id: Mapped[UUID] = mapped_column(
        sa.ForeignKey("nodes.id", ondelete="CASCADE"), primary_key=True
    )
    entry_country: Mapped[str | None] = mapped_column(sa.Text)
    exit_country: Mapped[str | None] = mapped_column(sa.Text)
    asn_label: Mapped[str | None] = mapped_column(sa.Text)
    seq: Mapped[int]
    assigned_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now()
    )
    server_key: Mapped[str | None] = mapped_column(sa.Text)
    org_label: Mapped[str | None] = mapped_column(sa.Text)
    variant: Mapped[str | None] = mapped_column(sa.Text)


class NameServer(Base):
    """One stable number per landing server inside a country + operator group."""

    __tablename__ = "name_servers"
    __table_args__ = (
        sa.Index(
            "uq_name_servers_group",
            sa.text("coalesce(exit_country, '')"),
            sa.text("coalesce(org_label, '')"),
            sa.text("coalesce(asn_label, '')"),
            "seq",
            unique=True,
        ),
    )
    server_key: Mapped[str] = mapped_column(sa.Text, primary_key=True)
    exit_country: Mapped[str | None] = mapped_column(sa.Text)
    org_label: Mapped[str | None] = mapped_column(sa.Text)
    asn_label: Mapped[str | None] = mapped_column(sa.Text)
    seq: Mapped[int]
    assigned_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now()
    )


class IpInfo(Base):
    """Landing-IP details from ip-api, cached by Actions."""

    __tablename__ = "ip_info"
    ip: Mapped[str] = mapped_column(sa.Text, primary_key=True)
    status: Mapped[str] = mapped_column(sa.Text)
    country_code: Mapped[str | None] = mapped_column(sa.Text)
    region: Mapped[str | None] = mapped_column(sa.Text)
    city: Mapped[str | None] = mapped_column(sa.Text)
    isp: Mapped[str | None] = mapped_column(sa.Text)
    org: Mapped[str | None] = mapped_column(sa.Text)
    as_number: Mapped[int | None] = mapped_column(sa.BigInteger)
    as_org: Mapped[str | None] = mapped_column(sa.Text)
    queried_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now()
    )
    is_mobile: Mapped[bool | None]
    is_proxy: Mapped[bool | None]
    is_hosting: Mapped[bool | None]


class NodeShareLink(Base):
    """Share URI without a name (or why none exists), computed once per node."""

    __tablename__ = "node_share_links"
    node_id: Mapped[UUID] = mapped_column(
        sa.ForeignKey("nodes.id", ondelete="CASCADE"), primary_key=True
    )
    uri: Mapped[str | None] = mapped_column(sa.Text)
    error_code: Mapped[str | None] = mapped_column(sa.Text)
    omitted: Mapped[str | None] = mapped_column(sa.Text)
    created_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now()
    )


class NodeAnnotation(Base):
    __tablename__ = "node_annotations"
    __table_args__ = (
        sa.Index("idx_annotations_tags", "tags", postgresql_using="gin"),
        sa.CheckConstraint("line_claim IN ('UNKNOWN','IPLC','IEPL','CN2','OTHER')", name="claim"),
        sa.CheckConstraint("evidence_level IN ('NONE','DECLARED','DOCUMENTED')", name="evidence"),
        sa.CheckConstraint("manual_priority IN ('NONE','P1','P2','P3')", name="priority"),
    )
    node_id: Mapped[UUID] = mapped_column(sa.ForeignKey("nodes.id"), primary_key=True)
    tags: Mapped[list] = mapped_column(JSONB, server_default=sa.text("'[]'::jsonb"))
    line_claim: Mapped[str] = mapped_column(sa.Text, server_default="UNKNOWN")
    evidence_level: Mapped[str] = mapped_column(sa.Text, server_default="NONE")
    manual_priority: Mapped[str] = mapped_column(sa.Text, server_default="NONE")
    operators: Mapped[list] = mapped_column(JSONB, server_default=sa.text("'[\"GENERAL\"]'::jsonb"))
    reference_data: Mapped[bytes | None] = mapped_column(sa.LargeBinary)
    evidence_updated_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now()
    )


class QualityPolicy(Base):
    __tablename__ = "quality_policies"
    __table_args__ = (sa.CheckConstraint("id = 1 AND version > 0", name="singleton"),)
    id: Mapped[int] = mapped_column(sa.Integer, primary_key=True)
    version: Mapped[int] = mapped_column(sa.Integer, server_default="1")
    policy: Mapped[dict] = mapped_column(JSONB)
    updated_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now()
    )


class QualityPolicyRevision(Base):
    __tablename__ = "quality_policy_revisions"
    version: Mapped[int] = mapped_column(sa.Integer, primary_key=True)
    policy: Mapped[dict] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now()
    )


class RunnerNodeSummary(Base):
    __tablename__ = "runner_node_summaries"
    node_id: Mapped[UUID] = mapped_column(sa.ForeignKey("nodes.id"), primary_key=True)
    probe_key: Mapped[str] = mapped_column(sa.Text, primary_key=True)
    sample_count: Mapped[int] = mapped_column(sa.Integer)
    success_rate: Mapped[float | None] = mapped_column(sa.Float)
    timeout_rate: Mapped[float | None] = mapped_column(sa.Float)
    http_p50_ms: Mapped[float | None] = mapped_column(sa.Float)
    http_p95_ms: Mapped[float | None] = mapped_column(sa.Float)
    window_start: Mapped[datetime] = mapped_column(sa.DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now()
    )


class NodeDailyStats(Base):
    __tablename__ = "node_daily_stats"
    node_id: Mapped[UUID] = mapped_column(sa.ForeignKey("nodes.id"), primary_key=True)
    stat_date: Mapped[date] = mapped_column(sa.Date, primary_key=True)
    scheduled_count: Mapped[int]
    successful_count: Mapped[int]
    failed_count: Mapped[int]
    availability_ratio: Mapped[Decimal | None] = mapped_column(sa.Numeric(8, 6))
    avg_http_duration_ms: Mapped[int | None]


class NamingRule(Base):
    __tablename__ = "naming_rules"
    __table_args__ = (sa.CheckConstraint("id = 1", name="singleton"),)
    id: Mapped[int] = mapped_column(primary_key=True, default=1)
    template: Mapped[str] = mapped_column(sa.Text)
    updated_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now()
    )


class NamingRevision(Base):
    __tablename__ = "naming_revisions"
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    template: Mapped[str] = mapped_column(sa.Text)
    created_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now()
    )


class CatalogState(Base):
    __tablename__ = "catalog_state"
    __table_args__ = (sa.CheckConstraint("id=1", name="singleton"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    revision: Mapped[int] = mapped_column(sa.BigInteger, server_default="1")
    changed_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now()
    )
    closed_before: Mapped[date | None] = mapped_column(sa.Date)
    max_profiles: Mapped[int] = mapped_column(server_default="20")
    max_payload_bytes: Mapped[int] = mapped_column(sa.BigInteger, server_default="67108864")
    max_members: Mapped[int] = mapped_column(server_default="100000")
    version_limit: Mapped[int] = mapped_column(server_default="20")


class ExportArtifact(Base):
    __tablename__ = "export_artifacts"
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    name: Mapped[str] = mapped_column(sa.Text, server_default="Subscription")
    format: Mapped[str] = mapped_column(sa.Text)
    filter_spec: Mapped[dict] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now()
    )
    expires_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    token_hash: Mapped[bytes] = mapped_column(sa.LargeBinary)
    token_value: Mapped[str | None] = mapped_column(sa.Text)
    payload_data: Mapped[bytes] = mapped_column(
        sa.LargeBinary, server_default=sa.text("'\\x'::bytea")
    )
    node_count: Mapped[int] = mapped_column(server_default="0")
    status: Mapped[str] = mapped_column(sa.Text, server_default="PENDING")
    request_revision: Mapped[int] = mapped_column(sa.BigInteger, server_default="1")
    published_revision: Mapped[int] = mapped_column(sa.BigInteger, server_default="0")
    current_version: Mapped[int] = mapped_column(server_default="0")
    catalog_revision: Mapped[int] = mapped_column(sa.BigInteger, server_default="0")
    invalidated: Mapped[bool] = mapped_column(server_default=sa.true())
    requested_at: Mapped[datetime | None] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now()
    )
    built_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    valid_until: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    error_code: Mapped[str | None] = mapped_column(sa.Text)
    failed_catalog_revision: Mapped[int | None] = mapped_column(sa.BigInteger)
    lease_owner: Mapped[UUID | None]
    lease_until: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    payload_bytes: Mapped[int] = mapped_column(server_default="0")
    payload_hash: Mapped[str | None] = mapped_column(sa.Text)


class ExportMember(Base):
    __tablename__ = "export_members"
    __table_args__ = (sa.Index("idx_export_members_node", "node_id", "export_id"),)
    export_id: Mapped[UUID] = mapped_column(
        sa.ForeignKey("export_artifacts.id", ondelete="CASCADE"), primary_key=True
    )
    node_id: Mapped[UUID] = mapped_column(sa.ForeignKey("nodes.id"), primary_key=True)


class ExportVersion(Base):
    __tablename__ = "export_versions"
    export_id: Mapped[UUID] = mapped_column(
        sa.ForeignKey("export_artifacts.id", ondelete="CASCADE"), primary_key=True
    )
    version_no: Mapped[int] = mapped_column(primary_key=True)
    request_revision: Mapped[int] = mapped_column(sa.BigInteger)
    catalog_revision: Mapped[int] = mapped_column(sa.BigInteger)
    created_at: Mapped[datetime] = mapped_column(sa.DateTime(timezone=True))
    valid_until: Mapped[datetime] = mapped_column(sa.DateTime(timezone=True))
    node_count: Mapped[int]
    payload_bytes: Mapped[int]
    payload_hash: Mapped[str] = mapped_column(sa.Text)
    format: Mapped[str] = mapped_column(sa.Text)
    filter_spec: Mapped[dict] = mapped_column(JSONB)


class UsageEvent(Base):
    """Credential-free, idempotent counter snapshots; one row per execution/request."""

    __tablename__ = "usage_events"
    __table_args__ = (
        sa.CheckConstraint(
            "full_checks >= 0 AND "
            "full_samples >= 0 AND "
            "preflight_skips >= 0 AND "
            "cooldown_skips >= 0 AND "
            "dns_requests >= 0 AND "
            "dns_cache_hits >= 0 AND "
            "tcp_probes >= 0 AND "
            "tcp_socket_attempts >= 0 AND "
            "tcp_cache_hits >= 0 AND "
            "runtime_starts >= 0 AND "
            "runtime_reloads >= 0",
            name="optimization_counters",
        ),
        sa.CheckConstraint("kind IN ('CHECK','SOURCE','SUBSCRIPTION','JOB')", name="kind"),
        sa.CheckConstraint(
            "outcome IN ('RUNNING','COMPLETED','SUCCESS','UNCHANGED','PARTIAL','FAILED',"
            "'ENVIRONMENT_ERROR','CONFLICT')",
            name="outcome",
        ),
        sa.CheckConstraint(
            "check_count >= 0 AND check_duration_ms >= 0 AND timeout_checks >= 0 AND "
            "echo_requests >= 0 AND echo_failures >= 0 AND echo_response_bytes >= 0 AND "
            "source_requests >= 0 AND source_response_bytes >= 0 AND "
            "subscription_downloads >= 0 AND subscription_bytes >= 0 AND "
            "network_samples >= 0 AND network_rx_bytes >= 0 AND network_tx_bytes >= 0",
            name="counters",
        ),
        sa.ForeignKeyConstraint(
            ["scan_run_id", "shard_no"], ["scan_shards.scan_run_id", "scan_shards.shard_no"]
        ),
        sa.Index("idx_usage_events_time", "started_at", "kind"),
    )
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    kind: Mapped[str] = mapped_column(sa.Text)
    entity_id: Mapped[UUID | None]
    scan_run_id: Mapped[UUID | None] = mapped_column(sa.ForeignKey("scan_runs.id"))
    shard_no: Mapped[int | None]
    started_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now()
    )
    finished_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    outcome: Mapped[str] = mapped_column(sa.Text, server_default="RUNNING")
    check_count: Mapped[int] = mapped_column(sa.BigInteger, server_default="0")
    check_duration_ms: Mapped[int] = mapped_column(sa.BigInteger, server_default="0")
    timeout_checks: Mapped[int] = mapped_column(sa.BigInteger, server_default="0")
    echo_requests: Mapped[int] = mapped_column(sa.BigInteger, server_default="0")
    echo_failures: Mapped[int] = mapped_column(sa.BigInteger, server_default="0")
    echo_response_bytes: Mapped[int] = mapped_column(sa.BigInteger, server_default="0")
    source_requests: Mapped[int] = mapped_column(sa.BigInteger, server_default="0")
    source_response_bytes: Mapped[int] = mapped_column(sa.BigInteger, server_default="0")
    subscription_downloads: Mapped[int] = mapped_column(sa.BigInteger, server_default="0")
    subscription_bytes: Mapped[int] = mapped_column(sa.BigInteger, server_default="0")
    network_samples: Mapped[int] = mapped_column(sa.BigInteger, server_default="0")
    network_rx_bytes: Mapped[int] = mapped_column(sa.BigInteger, server_default="0")
    network_tx_bytes: Mapped[int] = mapped_column(sa.BigInteger, server_default="0")
    full_checks: Mapped[int] = mapped_column(sa.BigInteger, server_default="0")
    full_samples: Mapped[int] = mapped_column(sa.BigInteger, server_default="0")
    preflight_skips: Mapped[int] = mapped_column(sa.BigInteger, server_default="0")
    cooldown_skips: Mapped[int] = mapped_column(sa.BigInteger, server_default="0")
    dns_requests: Mapped[int] = mapped_column(sa.BigInteger, server_default="0")
    dns_cache_hits: Mapped[int] = mapped_column(sa.BigInteger, server_default="0")
    tcp_probes: Mapped[int] = mapped_column(sa.BigInteger, server_default="0")
    tcp_socket_attempts: Mapped[int] = mapped_column(sa.BigInteger, server_default="0")
    tcp_cache_hits: Mapped[int] = mapped_column(sa.BigInteger, server_default="0")
    runtime_starts: Mapped[int] = mapped_column(sa.BigInteger, server_default="0")
    runtime_reloads: Mapped[int] = mapped_column(sa.BigInteger, server_default="0")


class DatabaseSample(Base):
    __tablename__ = "database_samples"
    __table_args__ = (sa.Index("idx_database_samples_time", "taken_at"),)
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    taken_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now()
    )
    database_bytes: Mapped[int] = mapped_column(sa.BigInteger)
    table_bytes: Mapped[int] = mapped_column(sa.BigInteger)
    connections: Mapped[int]


class ActionRun(Base):
    __tablename__ = "action_runs"
    __table_args__ = (
        sa.CheckConstraint(
            "workflow IN ('daily-check','source-sync','backup','export-build')", name="workflow"
        ),
        sa.CheckConstraint(
            "attempt > 0 AND runner_ms >= 0 AND job_count >= 0 "
            "AND failed_jobs >= 0 AND unmeasured_jobs >= 0",
            name="counters",
        ),
        sa.Index("idx_action_runs_time", "started_at"),
    )
    run_id: Mapped[int] = mapped_column(sa.BigInteger, primary_key=True)
    attempt: Mapped[int] = mapped_column(primary_key=True)
    workflow: Mapped[str] = mapped_column(sa.Text)
    conclusion: Mapped[str] = mapped_column(sa.Text)
    started_at: Mapped[datetime] = mapped_column(sa.DateTime(timezone=True))
    finished_at: Mapped[datetime] = mapped_column(sa.DateTime(timezone=True))
    runner_ms: Mapped[int] = mapped_column(sa.BigInteger)
    job_count: Mapped[int]
    failed_jobs: Mapped[int]
    unmeasured_jobs: Mapped[int]


VANTAGES = ("CN-CT", "CN-CU", "CN-CM", "CN", "HK", "SG")


class EntryProbeResult(Base):
    """One Globalping test (one probe) against an entry ip:port or ip."""

    __tablename__ = "entry_probe_results"
    __table_args__ = (
        sa.Index(
            "idx_entry_probe_prefix",
            "prefix",
            "vantage",
            sa.text("measured_at DESC"),
            postgresql_where=sa.text("purpose = 'QUALITY'"),
        ),
        sa.Index(
            "idx_entry_probe_target",
            "target",
            sa.text("measured_at DESC"),
            postgresql_where=sa.text("purpose = 'REACH'"),
        ),
        sa.Index("idx_entry_probe_time", "measured_at"),
    )
    id: Mapped[int] = mapped_column(sa.BigInteger, sa.Identity(), primary_key=True)
    target: Mapped[str] = mapped_column(sa.Text)
    prefix: Mapped[str] = mapped_column(sa.Text)
    purpose: Mapped[str] = mapped_column(sa.Text)
    vantage: Mapped[str] = mapped_column(sa.Text)
    protocol: Mapped[str] = mapped_column(sa.Text)
    peak: Mapped[bool]
    measured_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now()
    )
    probe_asn: Mapped[int | None] = mapped_column(sa.BigInteger)
    probe_city: Mapped[str | None] = mapped_column(sa.Text)
    probe_network: Mapped[str | None] = mapped_column(sa.Text)
    sent: Mapped[int] = mapped_column(sa.SmallInteger)
    received: Mapped[int] = mapped_column(sa.SmallInteger)
    rtt_min: Mapped[float | None] = mapped_column(sa.REAL)
    rtt_avg: Mapped[float | None] = mapped_column(sa.REAL)
    rtt_max: Mapped[float | None] = mapped_column(sa.REAL)
    jitter: Mapped[float | None] = mapped_column(sa.REAL)
    measurement_id: Mapped[str | None] = mapped_column(sa.Text)


class EntryRouteTrace(Base):
    """Latest outbound route (hop ASNs) from one Chinese carrier to an entry prefix."""

    __tablename__ = "entry_route_traces"
    prefix: Mapped[str] = mapped_column(sa.Text, primary_key=True)
    vantage: Mapped[str] = mapped_column(sa.Text, primary_key=True)
    measured_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now()
    )
    probe_asn: Mapped[int | None] = mapped_column(sa.BigInteger)
    probe_city: Mapped[str | None] = mapped_column(sa.Text)
    hop_asns: Mapped[list[int]] = mapped_column(
        sa.ARRAY(sa.BigInteger), server_default=sa.text("'{}'::bigint[]")
    )
    reached: Mapped[bool] = mapped_column(server_default=sa.false())
    measurement_id: Mapped[str | None] = mapped_column(sa.Text)


class EntryProbeRun(Base):
    __tablename__ = "entry_probe_runs"
    __table_args__ = (sa.Index("idx_entry_probe_runs_time", sa.text("started_at DESC")),)
    id: Mapped[UUID] = mapped_column(primary_key=True, server_default=sa.text("gen_random_uuid()"))
    started_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now()
    )
    finished_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    peak: Mapped[bool] = mapped_column(server_default=sa.false())
    authenticated: Mapped[bool] = mapped_column(server_default=sa.false())
    measurements: Mapped[int] = mapped_column(server_default="0")
    tests: Mapped[int] = mapped_column(server_default="0")
    stored: Mapped[int] = mapped_column(server_default="0")
    failed: Mapped[int] = mapped_column(server_default="0")
    rate_limited: Mapped[int] = mapped_column(server_default="0")
    remaining: Mapped[int | None]
    probes: Mapped[dict] = mapped_column(JSONB, server_default=sa.text("'{}'::jsonb"))
    error_code: Mapped[str | None] = mapped_column(sa.Text)


class NodeGrade(Base):
    """Grade of one currently available node seen from one vantage (Actions-computed)."""

    __tablename__ = "node_grades"
    __table_args__ = (sa.Index("idx_node_grades_vantage", "vantage", "grade"),)
    node_id: Mapped[UUID] = mapped_column(
        sa.ForeignKey("nodes.id", ondelete="CASCADE"), primary_key=True
    )
    vantage: Mapped[str] = mapped_column(sa.Text, primary_key=True)
    grade: Mapped[str] = mapped_column(sa.Text)
    score: Mapped[float | None] = mapped_column(sa.REAL)
    access_band: Mapped[str | None] = mapped_column(sa.Text)
    stability_band: Mapped[str | None] = mapped_column(sa.Text)
    peak_rtt_ms: Mapped[float | None] = mapped_column(sa.REAL)
    idle_rtt_ms: Mapped[float | None] = mapped_column(sa.REAL)
    loss: Mapped[float | None] = mapped_column(sa.REAL)
    jitter_ms: Mapped[float | None] = mapped_column(sa.REAL)
    samples: Mapped[int] = mapped_column(server_default="0")
    probes: Mapped[int] = mapped_column(server_default="0")
    avail_7d: Mapped[int] = mapped_column(server_default="0")
    checked_7d: Mapped[int] = mapped_column(server_default="0")
    unreachable: Mapped[bool] = mapped_column(server_default=sa.false())
    route_asns: Mapped[list[int] | None] = mapped_column(sa.ARRAY(sa.BigInteger))
    route_measured_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    server_best_grade: Mapped[str | None] = mapped_column(sa.Text)
    last_measured_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    reasons: Mapped[list] = mapped_column(JSONB, server_default=sa.text("'[]'::jsonb"))
    computed_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now()
    )


class GradingPolicy(Base):
    __tablename__ = "grading_policy"
    __table_args__ = (sa.CheckConstraint("id = 1", name="singleton"),)
    id: Mapped[int] = mapped_column(sa.Integer, primary_key=True, autoincrement=False)
    version: Mapped[int] = mapped_column(sa.Integer, server_default="1")
    policy: Mapped[dict] = mapped_column(JSONB)
    updated_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now()
    )


class GradingPolicyRevision(Base):
    __tablename__ = "grading_policy_revisions"
    version: Mapped[int] = mapped_column(sa.Integer, primary_key=True, autoincrement=False)
    policy: Mapped[dict] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(
        sa.DateTime(timezone=True), server_default=sa.func.now()
    )
