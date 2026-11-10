import hashlib
import hmac
import json
from datetime import UTC, datetime
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import insert

from app.database.models import Node, NodeSource, Source, short_id_sequence
from app.domain import AssetError, InputFormat, NormalizedNode, SourceType
from app.ingestion.fetcher import Fetcher, validate_url
from app.ingestion.subscriptions import SubscriptionResolver
from app.naming import DEFAULT_TEMPLATE, render_name
from app.parsers import PARSER_VERSION, parse_document
from app.security.crypto import FINGERPRINT_VERSION, canonical_json, fingerprint


def utcnow():
    return datetime.now(UTC)


def source_due(last_checked, interval, at, timezone="Asia/Shanghai"):
    if last_checked is None:
        return True
    if interval % 86400 == 0:
        zone = ZoneInfo(timezone)
        days = (at.astimezone(zone).date() - last_checked.astimezone(zone).date()).days
        return days >= interval // 86400
    return (at - last_checked).total_seconds() >= interval


class AssetService:
    def __init__(
        self,
        sessions,
        fingerprint_key: bytes,
        *,
        fetcher=None,
        max_bytes=10_485_760,
        max_items=10_000,
        sync_interval=86400,
        name_template=DEFAULT_TEMPLATE,
        substore_max_fetches=256,
        substore_max_depth=3,
        substore_timeout=120,
        substore_max_items=50000,
    ):
        self.sessions, self.fingerprint_key = sessions, fingerprint_key
        self.fetcher = fetcher or Fetcher(max_bytes=max_bytes, allow_http=True)
        self.max_bytes, self.max_items, self.sync_interval = max_bytes, max_items, sync_interval
        render_name("N000001", "vless", None, None, name_template)
        self.name_template = name_template
        self.substore_limits = dict(
            max_fetches=substore_max_fetches,
            max_depth=substore_max_depth,
            timeout=substore_timeout,
            max_total_items=substore_max_items,
        )

    @staticmethod
    def _source_dto(source):
        return {
            k: getattr(source, k)
            for k in (
                "id",
                "name",
                "type",
                "format_hint",
                "enabled",
                "sync_interval_seconds",
                "content_hash",
                "applied_hash",
                "parser_version",
                "last_checked_at",
                "sync_requested_at",
                "last_synced_at",
                "last_sync_status",
                "last_error_code",
                "last_parse_summary",
                "revision",
                "deleted_at",
            )
        }

    @staticmethod
    def _source(session, source_id, *, lock=False):
        query = sa.select(Source).where(Source.id == source_id, Source.deleted_at.is_(None))
        if lock:
            query = query.with_for_update()
        source = session.scalar(query)
        if source is None:
            raise AssetError("SOURCE_NOT_FOUND")
        return source

    @staticmethod
    def _label(name):
        if (
            not isinstance(name, str)
            or not 1 <= len(name) <= 80
            or "://" in name
            or any(ord(c) < 32 for c in name)
        ):
            raise AssetError("INVALID_SOURCE_LABEL")
        return name

    def _input(self, source_id, source_type, payload):
        if not isinstance(payload, bytes) or not payload.strip():
            raise AssetError("EMPTY_INPUT")
        if len(payload) > self.max_bytes:
            raise AssetError("INPUT_TOO_LARGE")
        if source_type == SourceType.SUBSCRIPTION_URL:
            try:
                url = validate_url(payload.decode("utf-8").strip(), allow_http=True)
            except UnicodeError:
                raise AssetError("UNSAFE_SUBSCRIPTION_URL") from None
            return {
                "url_data": bytes(url.encode()),
                "payload_data": None,
            }
        return {
            "url_data": None,
            "payload_data": bytes(payload),
        }

    def create_source(
        self, *, name: str, source_type: SourceType, payload: bytes, format_hint=InputFormat.AUTO
    ):
        try:
            source_type, format_hint = SourceType(source_type), InputFormat(format_hint)
        except ValueError:
            raise AssetError("INVALID_SOURCE_TYPE_OR_FORMAT") from None
        source_id = uuid4()
        values = self._input(source_id, source_type, payload)
        with self.sessions.begin() as session:
            self._verify_keys(session)
            source = Source(
                id=source_id,
                name=self._label(name),
                type=source_type.value,
                format_hint=format_hint.value,
                sync_interval_seconds=self.sync_interval,
                sync_requested_at=utcnow(),
                **values,
            )
            session.add(source)
            session.flush()
            return self._source_dto(source)

    def list_sources(self, *, include_deleted=False):
        with self.sessions() as session:
            query = sa.select(Source).order_by(Source.created_at, Source.id)
            if not include_deleted:
                query = query.where(Source.deleted_at.is_(None))
            return [self._source_dto(s) for s in session.scalars(query)]

    def create_sources_bulk(self, urls, *, name_prefix="批量订阅"):
        from app.ingestion.bulk import bulk_result, prepare_links

        items = prepare_links(urls, name_prefix)
        candidates = {item["url"].encode() for item in items if "url" in item}
        if not candidates:
            return bulk_result(items)
        with self.sessions.begin() as session:
            # Serialize concurrent bulk imports in this schema, including empty catalogs.
            session.execute(
                sa.text(
                    "SELECT pg_advisory_xact_lock(hashtextextended("
                    "current_schema() || ':nodema:source-bulk', 0))"
                )
            )
            self._verify_keys(session)
            existing = {
                bytes(source.url_data): source
                for source in session.scalars(
                    sa.select(Source)
                    .where(
                        Source.deleted_at.is_(None),
                        Source.type == SourceType.SUBSCRIPTION_URL.value,
                        Source.url_data.in_(candidates),
                    )
                    .order_by(Source.created_at.desc(), Source.id.desc())
                )
            }
            for item in items:
                if "url" not in item:
                    continue
                value = item["url"].encode()
                source = existing.get(value)
                if source is not None:
                    item["status"] = "DUPLICATE"
                else:
                    source = Source(
                        id=uuid4(),
                        name=item["name"],
                        type=SourceType.SUBSCRIPTION_URL.value,
                        format_hint=InputFormat.AUTO.value,
                        url_data=value,
                        sync_interval_seconds=self.sync_interval,
                        sync_requested_at=utcnow(),
                    )
                    session.add(source)
                    existing[value] = source
                    item["status"] = "CREATED"
                item.update(id=str(source.id), name=source.name)
            session.flush()
        return bulk_result(items)

    def get_source(self, source_id: UUID):
        with self.sessions() as session:
            value = self._source_dto(self._source(session, source_id))
            counts = (
                session.execute(
                    sa.select(
                        sa.func.count().label("linked_nodes"),
                        sa.func.count()
                        .filter(NodeSource.is_present.is_(True))
                        .label("present_nodes"),
                        sa.func.count()
                        .filter(NodeSource.is_present.is_(True), Node.enabled.is_(True))
                        .label("enabled_nodes"),
                    )
                    .select_from(NodeSource)
                    .join(Node)
                    .where(NodeSource.source_id == source_id)
                )
                .mappings()
                .one()
            )
            return {**value, **dict(counts)}

    def update_source(
        self,
        source_id: UUID,
        *,
        name=None,
        enabled=None,
        payload=None,
        format_hint=None,
        sync_interval_seconds=None,
    ):
        with self.sessions.begin() as session:
            source = self._source(session, source_id, lock=True)
            if name is not None:
                source.name = self._label(name)
            if enabled is not None:
                if not isinstance(enabled, bool):
                    raise AssetError("INVALID_BOOLEAN")
                source.enabled = enabled
            if sync_interval_seconds is not None:
                if type(sync_interval_seconds) is not int or sync_interval_seconds <= 0:
                    raise AssetError("INVALID_SYNC_INTERVAL")
                source.sync_interval_seconds = sync_interval_seconds
            if format_hint is not None:
                try:
                    source.format_hint = InputFormat(format_hint).value
                except ValueError:
                    raise AssetError("INVALID_FORMAT") from None
            if payload is not None:
                self._verify_keys(session)
                for k, v in self._input(source.id, source.type, payload).items():
                    setattr(source, k, v)
                source.content_hash = None
            if payload is not None or format_hint is not None:
                source.applied_hash = source.parser_version = None
                source.last_sync_status = "NEVER"
                source.last_error_code = None
                source.last_parse_summary = {}
            if payload is not None or format_hint is not None or enabled is True:
                source.sync_requested_at = utcnow()
            source.revision += 1
            source.updated_at = utcnow()
            session.flush()
            return self._source_dto(source)

    def delete_source(self, source_id: UUID):
        with self.sessions.begin() as session:
            source = self._source(session, source_id, lock=True)
            source.enabled = False
            source.deleted_at = source.updated_at = utcnow()
            source.revision += 1

    def request_sync(self, source_id: UUID):
        with self.sessions.begin() as session:
            source = self._source(session, source_id, lock=True)
            if not source.enabled:
                raise AssetError("SOURCE_DISABLED")
            source.sync_requested_at = source.updated_at = utcnow()
            source.revision += 1

    def _verify_keys(self, session):
        # Verify the deduplication key against the existing canonical identity.
        node = session.scalar(sa.select(Node).order_by(Node.id).limit(1))
        if node is not None:
            if node.fingerprint_version != FINGERPRINT_VERSION:
                raise AssetError("FINGERPRINT_MIGRATION_REQUIRED")
            identity = json.loads(bytes(node.config_data))
            actual = fingerprint(NormalizedNode(identity), self.fingerprint_key)
            if not hmac.compare_digest(actual, node.fingerprint):
                raise AssetError("FINGERPRINT_KEY_MISMATCH")

    def sync_source(self, source_id: UUID, *, force=False):
        from app.usage import Usage

        event_id, started = uuid4(), utcnow()
        if hasattr(self.fetcher, "reset_metrics"):
            self.fetcher.reset_metrics()
        outcome = "FAILED"
        try:
            result = self._sync_source(source_id, force=force)
            outcome = result["status"]
            return result
        except AssetError as error:
            if error.code == "SOURCE_CHANGED_RETRY":
                outcome = "CONFLICT"
            raise
        finally:
            metrics = getattr(self.fetcher, "metrics", {})
            Usage(self.sessions).best_effort(
                event_id,
                "SOURCE",
                outcome=outcome,
                started_at=started,
                entity_id=source_id,
                **{k: metrics.get(k, 0) for k in ("source_requests", "source_response_bytes")},
            )

    def _sync_source(self, source_id: UUID, *, force=False):
        with self.sessions() as session:
            source = self._source(session, source_id)
            if not source.enabled:
                raise AssetError("SOURCE_DISABLED")
            self._verify_keys(session)
            revision, source_type, hint = source.revision, source.type, source.format_hint
            old_hash, old_parser = source.applied_hash, source.parser_version
            stored_data = (
                source.url_data
                if source_type == SourceType.SUBSCRIPTION_URL
                else source.payload_data
            )
        payload, report, error, digest = None, None, None, None
        try:
            purpose = "url" if source_type == SourceType.SUBSCRIPTION_URL else "payload"
            raw = bytes(stored_data)
            if purpose == "url":
                resolved = SubscriptionResolver(
                    self.fetcher,
                    max_bytes=self.max_bytes,
                    max_items=self.max_items,
                    **self.substore_limits,
                ).resolve(raw.decode(), InputFormat(hint))
                payload, report = resolved.snapshot, resolved.report
            else:
                payload = raw
            if report is None and len(payload) > self.max_bytes:
                raise AssetError("INPUT_TOO_LARGE")
            digest = hashlib.sha256(payload).hexdigest()
            unchanged = not force and digest == old_hash and old_parser == PARSER_VERSION
            if not unchanged:
                report = report or parse_document(
                    payload, InputFormat(hint), max_bytes=self.max_bytes, max_items=self.max_items
                )
                if source_type == SourceType.SINGLE_URI and (
                    len(report.nodes) != 1 or report.issues
                ):
                    raise AssetError("SINGLE_URI_REQUIRES_ONE_NODE")
        except AssetError as exc:
            error = exc.code
            unchanged = False
        now = utcnow()
        with self.sessions.begin() as session:
            source = self._source(session, source_id, lock=True)
            if source.revision != revision:
                raise AssetError("SOURCE_CHANGED_RETRY")
            source.last_checked_at = source.updated_at = now
            source.sync_requested_at = None
            source.revision += 1
            if payload is not None and digest is not None:
                source.content_hash = digest
                # Latest fetched snapshot, including failed/partial input, is stored as plaintext.
                source.payload_data = bytes(payload)
            if error:
                source.last_sync_status, source.last_error_code = "FAILED", error
                source.last_parse_summary = {"issue_count": 1, "issues": [{"code": error}]}
                return {"source_id": source_id, "status": "FAILED", "error_code": error}
            if unchanged:
                present_ids = sa.select(NodeSource.node_id).where(
                    NodeSource.source_id == source_id, NodeSource.is_present.is_(True)
                )
                session.execute(
                    sa.update(Node)
                    .where(Node.id.in_(present_ids))
                    .values(last_seen_at=sa.func.greatest(Node.last_seen_at, now))
                )
                session.execute(
                    sa.update(NodeSource)
                    .where(NodeSource.source_id == source_id, NodeSource.is_present.is_(True))
                    .values(last_seen_at=now)
                )
                source.last_sync_status, source.last_error_code = "SUCCESS", None
                source.last_parse_summary = {
                    **(report.summary() if report else {}),
                    "issue_count": 0,
                    "issues": [],
                    "parsed": False,
                }
                return {"source_id": source_id, "status": "UNCHANGED", "parsed": False}
            return self._apply(session, source, report, digest, now)

    def _apply(self, session, source, report, digest, now):
        grouped = {}
        for parsed in report.nodes:
            fp = fingerprint(parsed, self.fingerprint_key)
            if fp not in grouped:
                grouped[fp] = (parsed, set())
            grouped[fp][1].add(parsed.original_name)
        observed, created = [], 0
        ordered = sorted(grouped)  # deterministic lock order across concurrent sources
        for offset in range(0, len(ordered), 250):
            batch = ordered[offset : offset + 250]
            numbers = session.scalars(
                sa.select(short_id_sequence.next_value()).select_from(
                    sa.func.generate_series(1, len(batch))
                )
            ).all()
            candidates = []
            for fp, number in zip(batch, numbers, strict=True):
                identity = grouped[fp][0].identity
                candidate = uuid4()
                candidates.append(
                    dict(
                        id=candidate,
                        short_id=f"N{number:06d}",
                        fingerprint=fp,
                        fingerprint_version=FINGERPRINT_VERSION,
                        protocol=identity["protocol"],
                        server_host=identity["server_host"],
                        server_port=identity["server_port"],
                        transport=identity.get("transport"),
                        security=identity.get("security"),
                        config_data=bytes(canonical_json(identity)),
                        first_seen_at=now,
                        last_seen_at=now,
                    )
                )
            rows = session.execute(
                insert(Node)
                .values(candidates)
                .on_conflict_do_update(
                    index_elements=[Node.fingerprint_version, Node.fingerprint],
                    set_={"last_seen_at": sa.func.greatest(Node.last_seen_at, now)},
                )
                .returning(Node.id, Node.fingerprint)
            ).all()
            resolved = {fp: node_id for node_id, fp in rows}
            created += sum(value["id"] == resolved[value["fingerprint"]] for value in candidates)
            observed.extend(resolved.values())
            old_links = {}
            if not report.complete:
                old_links = {
                    link.node_id: link
                    for link in session.scalars(
                        sa.select(NodeSource).where(
                            NodeSource.source_id == source.id,
                            NodeSource.node_id.in_(resolved.values()),
                        )
                    )
                }
            links = []
            for fp in batch:
                node_id, aliases = resolved[fp], grouped[fp][1]
                if node_id in old_links:
                    aliases |= set(json.loads(bytes(old_links[node_id].aliases_data)))
                links.append(
                    dict(
                        node_id=node_id,
                        source_id=source.id,
                        aliases_data=bytes(canonical_json(sorted(aliases))),
                        is_present=True,
                        first_seen_at=now,
                        last_seen_at=now,
                    )
                )
            statement = insert(NodeSource).values(links)
            session.execute(
                statement.on_conflict_do_update(
                    index_elements=[NodeSource.node_id, NodeSource.source_id],
                    set_={
                        key: statement.excluded[key]
                        for key in ("aliases_data", "is_present", "last_seen_at")
                    },
                )
            )
        if report.complete:
            session.execute(
                sa.update(NodeSource)
                .where(NodeSource.source_id == source.id, NodeSource.node_id.not_in(observed))
                .values(is_present=False)
            )
            source.applied_hash, source.parser_version = digest, PARSER_VERSION
            source.last_synced_at = now
        source.last_sync_status = "SUCCESS" if report.complete else "PARTIAL"
        source.last_error_code = None if report.complete else "PARTIAL_PARSE"
        source.last_parse_summary = report.summary()
        return {
            "source_id": source.id,
            "status": source.last_sync_status,
            "parsed": True,
            "unique_nodes": len(observed),
            "created_nodes": created,
            "reused_nodes": len(observed) - created,
            **report.summary(),
        }

    def list_nodes(self, *, node_id: UUID | None = None):
        with self.sessions() as session:
            effective = sa.exists(
                sa.select(NodeSource.node_id)
                .join(Source)
                .where(
                    NodeSource.node_id == Node.id,
                    NodeSource.is_present.is_(True),
                    Source.enabled.is_(True),
                    Source.deleted_at.is_(None),
                )
            )
            count = (
                sa.select(sa.func.count())
                .select_from(NodeSource)
                .where(NodeSource.node_id == Node.id)
                .scalar_subquery()
            )
            present = (
                sa.select(sa.func.count())
                .select_from(NodeSource)
                .join(Source)
                .where(
                    NodeSource.node_id == Node.id,
                    NodeSource.is_present.is_(True),
                    Source.deleted_at.is_(None),
                )
                .scalar_subquery()
            )
            query = sa.select(Node, effective.label("has_source"), count, present).order_by(
                Node.short_id
            )
            if node_id is not None:
                query = query.where(Node.id == node_id)
            rows = session.execute(query)
            return [
                {
                    "id": n.id,
                    "short_id": n.short_id,
                    "name": render_name(
                        n.short_id, n.protocol, n.transport, n.security, self.name_template
                    ),
                    "protocol": n.protocol,
                    "server_host": n.server_host,
                    "server_port": n.server_port,
                    "transport": n.transport,
                    "security": n.security,
                    "enabled": n.enabled,
                    "eligible": n.enabled and active,
                    "line_type": n.line_type,
                    "first_seen_at": n.first_seen_at,
                    "last_seen_at": n.last_seen_at,
                    "source_count": source_count,
                    "present_source_count": present_count,
                }
                for n, active, source_count, present_count in rows
            ]

    def get_node(self, node_id: UUID):
        for node in self.list_nodes(node_id=node_id):
            if node["id"] == node_id:
                with self.sessions() as session:
                    node["sources"] = [
                        {
                            "source_id": x.source_id,
                            "is_present": x.is_present,
                            "first_seen_at": x.first_seen_at,
                            "last_seen_at": x.last_seen_at,
                            "name": source.name,
                            "enabled": source.enabled,
                            "deleted": source.deleted_at is not None,
                        }
                        for x, source in session.execute(
                            sa.select(NodeSource, Source)
                            .join(Source)
                            .where(NodeSource.node_id == node_id)
                        )
                    ]
                return node
        raise AssetError("NODE_NOT_FOUND")

    def set_node_enabled(self, node_id: UUID, enabled: bool):
        if not isinstance(enabled, bool):
            raise AssetError("INVALID_BOOLEAN")
        with self.sessions.begin() as session:
            result = session.execute(
                sa.update(Node).where(Node.id == node_id).values(enabled=enabled)
            )
            if not result.rowcount:
                raise AssetError("NODE_NOT_FOUND")

    def protected_aliases(self, node_id: UUID):
        self.get_node(node_id)
        with self.sessions() as session:
            rows = session.execute(
                sa.select(NodeSource, Source.name).join(Source).where(NodeSource.node_id == node_id)
            ).all()
            return [
                {
                    "source_name": name,
                    "is_present": link.is_present,
                    "aliases": json.loads(bytes(link.aliases_data)),
                }
                for link, name in rows
            ]

    def preview_names(self, template=None):
        template = self.name_template if template is None else template
        return [
            {
                "id": n["id"],
                "name": render_name(
                    n["short_id"], n["protocol"], n["transport"], n["security"], template
                ),
            }
            for n in self.list_nodes()
        ]
