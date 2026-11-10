"""Queued profiles; only Python jobs render, while delivery reads published bytes."""

import hashlib
import hmac
import secrets
from datetime import timedelta
from uuid import UUID, uuid4

import sqlalchemy as sa
from sqlalchemy.orm import defer

from app.database.models import CatalogState, ExportArtifact, ExportMember, ExportVersion
from app.domain import AssetError
from app.export_render import FORMATS, render_snapshot, validate
from app.scans import now


class ExportService:
    def __init__(self, assets, settings):
        self.assets, self.settings, self.sessions = assets, settings, assets.sessions

    def _metadata(self, session, export_id=None):
        return list(
            session.scalars(
                sa.text("SELECT nodema_export_metadata(CAST(:id AS uuid))"), {"id": export_id}
            )
        )

    def budgets(self, values=None):
        fields = {
            "max_profiles": 100,
            "max_payload_bytes": 1_073_741_824,
            "max_members": 1_000_000,
            "version_limit": 100,
        }
        if values is not None and (
            set(values) - fields.keys()
            or any(type(v) is not int or not 1 <= v <= fields[k] for k, v in values.items())
        ):
            raise AssetError("INVALID_EXPORT_BUDGET")
        with self.sessions.begin() as session:
            state = session.get(CatalogState, 1, with_for_update=values is not None)
            if values:
                session.execute(sa.text("SELECT nodema_export_lock()"))
                totals = session.execute(
                    sa.select(
                        sa.func.count(),
                        sa.func.coalesce(sa.func.sum(ExportArtifact.payload_bytes), 0),
                        sa.func.coalesce(sa.func.sum(ExportArtifact.node_count), 0),
                    ).select_from(ExportArtifact)
                ).one()
                for key, count in zip(
                    ("max_profiles", "max_payload_bytes", "max_members"), totals, strict=True
                ):
                    if key in values and values[key] < count:
                        raise AssetError("EXPORT_BUDGET_BELOW_USAGE")
                for key, value in values.items():
                    setattr(state, key, value)
            return {key: getattr(state, key) for key in fields}

    def list(self):
        with self.sessions() as session:
            return self._metadata(session)

    def get(self, export_id):
        with self.sessions() as session:
            rows = self._metadata(session, export_id)
            if not rows:
                raise AssetError("EXPORT_NOT_AVAILABLE")
            return rows[0]

    @staticmethod
    def _expiry(hours):
        if hours is None:
            return None
        if type(hours) is not int or not 1 <= hours <= 8760:
            raise AssetError("INVALID_EXPORT_EXPIRY")
        return now() + timedelta(hours=hours)

    def create(
        self, format, filters=None, *, name="Subscription", expires_in_hours=None, build=False
    ):
        if (
            not isinstance(name, str)
            or not 1 <= len(name.strip()) <= 80
            or any(ord(c) < 32 for c in name)
        ):
            raise AssetError("INVALID_EXPORT_NAME")
        expiration = self._expiry(expires_in_hours)
        export_id, token = uuid4(), secrets.token_urlsafe(32)
        with self.sessions.begin() as session:
            normalized = validate(session, format, filters or {})
            session.execute(sa.text("SELECT nodema_export_lock()"))
            session.execute(
                sa.delete(ExportArtifact).where(
                    sa.or_(
                        ExportArtifact.revoked_at.is_not(None), ExportArtifact.expires_at <= now()
                    )
                )
            )
            state = session.get(CatalogState, 1)
            if (
                session.scalar(sa.select(sa.func.count()).select_from(ExportArtifact))
                >= state.max_profiles
            ):
                raise AssetError("EXPORT_PROFILE_LIMIT")
            session.add(
                ExportArtifact(
                    id=export_id,
                    name=name.strip(),
                    format=format,
                    filter_spec=normalized,
                    expires_at=expiration,
                    token_hash=hashlib.sha256(token.encode()).digest(),
                    token_value=token,
                )
            )
        if build:
            self.build_pending(export_id)
        return {**self.get(export_id), "token": token}

    def update(self, export_id, values):
        if not isinstance(values, dict) or set(values) - {
            "name",
            "format",
            "filters",
            "expires_in_hours",
            "expected_revision",
        }:
            raise AssetError("INVALID_EXPORT_FILTER")
        with self.sessions.begin() as session:
            profile = session.get(
                ExportArtifact,
                export_id,
                with_for_update=True,
                options=[defer(ExportArtifact.payload_data, raiseload=True)],
            )
            if profile is None or profile.revoked_at:
                raise AssetError("EXPORT_NOT_AVAILABLE")
            if "expected_revision" in values and (
                type(values["expected_revision"]) is not int
                or values["expected_revision"] != profile.request_revision
            ):
                raise AssetError("EXPORT_REVISION_CONFLICT")
            if "name" in values:
                name = values["name"]
                if (
                    not isinstance(name, str)
                    or not 1 <= len(name.strip()) <= 80
                    or any(ord(c) < 32 for c in name)
                ):
                    raise AssetError("INVALID_EXPORT_NAME")
                profile.name = name.strip()
            if "filters" in values or "format" in values:
                fmt = values.get("format", profile.format)
                profile.filter_spec = validate(
                    session, fmt, values.get("filters", profile.filter_spec)
                )
                profile.format = fmt
            if "expires_in_hours" in values:
                profile.expires_at = self._expiry(values["expires_in_hours"])
        return self.get(export_id)

    def retry(self, export_id):
        with self.sessions.begin() as session:
            result = session.execute(
                sa.update(ExportArtifact)
                .where(
                    ExportArtifact.id == export_id,
                    ExportArtifact.revoked_at.is_(None),
                    sa.or_(ExportArtifact.expires_at.is_(None), ExportArtifact.expires_at > now()),
                    sa.or_(
                        ExportArtifact.status != "BUILDING",
                        ExportArtifact.lease_until.is_(None),
                        ExportArtifact.lease_until <= now(),
                    ),
                )
                .values(status="PENDING", requested_at=now(), error_code=None)
            )
            if not result.rowcount:
                existing = self._metadata(session, export_id)
                if not existing or existing[0]["status"] in ("REVOKED", "EXPIRED"):
                    raise AssetError("EXPORT_NOT_AVAILABLE")
        return self.get(export_id)

    def link(self, export_id, *, rotate=False):
        with self.sessions.begin() as session:
            profile = session.get(
                ExportArtifact,
                export_id,
                options=[defer(ExportArtifact.payload_data, raiseload=True)],
                with_for_update=rotate,
            )
            if profile is None or profile.revoked_at:
                raise AssetError("EXPORT_NOT_AVAILABLE")
            if rotate:
                profile.token_value = secrets.token_urlsafe(32)
                profile.token_hash = hashlib.sha256(profile.token_value.encode()).digest()
            if profile.token_value is None:
                raise AssetError("EXPORT_TOKEN_LEGACY")
            return {"id": profile.id, "token": profile.token_value}

    def versions(self, export_id):
        self.get(export_id)
        with self.sessions() as session:
            return [
                dict(row)
                for row in session.execute(
                    sa.select(ExportVersion.__table__)
                    .where(ExportVersion.export_id == export_id)
                    .order_by(ExportVersion.version_no.desc())
                    .limit(20)
                ).mappings()
            ]

    def _claim(self, export_id=None, excluded=()):
        at = now()
        with self.sessions.begin() as session:
            epoch = session.scalar(sa.select(CatalogState.revision).where(CatalogState.id == 1))
            query = (
                sa.select(ExportArtifact)
                .options(defer(ExportArtifact.payload_data, raiseload=True))
                .where(
                    ExportArtifact.revoked_at.is_(None),
                    sa.or_(ExportArtifact.expires_at.is_(None), ExportArtifact.expires_at > at),
                    sa.or_(
                        ExportArtifact.status != "BUILDING",
                        ExportArtifact.lease_until.is_(None),
                        ExportArtifact.lease_until <= at,
                    ),
                    sa.or_(
                        ExportArtifact.requested_at.is_not(None),
                        ExportArtifact.catalog_revision != epoch,
                        ExportArtifact.valid_until <= at,
                        ExportArtifact.current_version == 0,
                    ),
                    sa.or_(
                        ExportArtifact.status != "FAILED",
                        ExportArtifact.failed_catalog_revision != epoch,
                        ExportArtifact.requested_at.is_not(None),
                    ),
                )
            )
            if excluded:
                query = query.where(ExportArtifact.id.not_in(excluded))
            if export_id is not None:
                query = query.where(ExportArtifact.id == export_id)
            profile = session.scalar(
                query.order_by(ExportArtifact.created_at).with_for_update(skip_locked=True).limit(1)
            )
            if profile is None:
                return None
            owner = uuid4()
            profile.status, profile.lease_owner, profile.lease_until = (
                "BUILDING",
                owner,
                at + timedelta(seconds=300),
            )
            profile.error_code = None
            return dict(
                id=profile.id,
                owner=owner,
                revision=profile.request_revision,
                format=profile.format,
                filters=dict(profile.filter_spec),
            )

    def _heartbeat(self, job):
        with self.sessions.begin() as session:
            count = session.execute(
                sa.update(ExportArtifact)
                .where(
                    ExportArtifact.id == job["id"],
                    ExportArtifact.lease_owner == job["owner"],
                    ExportArtifact.request_revision == job["revision"],
                    ExportArtifact.revoked_at.is_(None),
                    sa.or_(ExportArtifact.expires_at.is_(None), ExportArtifact.expires_at > now()),
                )
                .values(lease_until=now() + timedelta(seconds=300))
            ).rowcount
            if not count:
                raise AssetError("EXPORT_BUILD_SUPERSEDED")

    def _publish(self, job, rendered):
        at = now()
        with self.sessions.begin() as session:
            # Match catalog-writer lock order; fence mutations made during the snapshot read.
            state = session.scalar(
                sa.select(CatalogState).where(CatalogState.id == 1).with_for_update(read=True)
            )
            session.execute(sa.text("SELECT nodema_export_lock()"))
            profile = session.get(
                ExportArtifact,
                job["id"],
                with_for_update=True,
                options=[defer(ExportArtifact.payload_data, raiseload=True)],
            )
            if (
                profile is None
                or profile.revoked_at
                or (profile.expires_at is not None and profile.expires_at <= at)
                or profile.lease_owner != job["owner"]
                or profile.request_revision != job["revision"]
            ):
                return "SUPERSEDED"
            if state.revision != rendered["catalog_revision"] or rendered["valid_until"] <= at:
                profile.status, profile.requested_at = "PENDING", at
                profile.lease_owner = profile.lease_until = None
                return "SUPERSEDED"
            totals = session.execute(
                sa.select(
                    sa.func.coalesce(sa.func.sum(ExportArtifact.payload_bytes), 0),
                    sa.func.coalesce(sa.func.sum(ExportArtifact.node_count), 0),
                ).where(ExportArtifact.id != profile.id)
            ).one()
            if (
                totals[0] + len(rendered["payload"]) > state.max_payload_bytes
                or totals[1] + rendered["node_count"] > state.max_members
            ):
                raise AssetError("EXPORT_STORAGE_LIMIT")
            profile.current_version += 1
            profile.payload_data = rendered["payload"]
            profile.payload_bytes, profile.node_count = (
                len(rendered["payload"]),
                rendered["node_count"],
            )
            profile.payload_hash = hashlib.sha256(rendered["payload"]).hexdigest()
            profile.published_revision, profile.catalog_revision = job["revision"], state.revision
            profile.status, profile.invalidated, profile.built_at, profile.valid_until = (
                "READY",
                False,
                at,
                rendered["valid_until"],
            )
            profile.requested_at = profile.lease_owner = profile.lease_until = (
                profile.error_code
            ) = None
            profile.failed_catalog_revision = None
            session.execute(sa.delete(ExportMember).where(ExportMember.export_id == profile.id))
            for offset in range(0, len(rendered["members"]), 500):
                session.execute(
                    sa.insert(ExportMember),
                    [
                        {"export_id": profile.id, "node_id": UUID(n)}
                        for n in rendered["members"][offset : offset + 500]
                    ],
                )
            session.add(
                ExportVersion(
                    export_id=profile.id,
                    version_no=profile.current_version,
                    request_revision=profile.published_revision,
                    catalog_revision=state.revision,
                    created_at=at,
                    valid_until=profile.valid_until,
                    node_count=profile.node_count,
                    payload_bytes=profile.payload_bytes,
                    payload_hash=profile.payload_hash,
                    format=profile.format,
                    filter_spec=profile.filter_spec,
                )
            )
            session.execute(
                sa.delete(ExportVersion).where(
                    ExportVersion.export_id == profile.id,
                    ExportVersion.version_no <= profile.current_version - state.version_limit,
                )
            )
            return "READY"

    def build_pending(self, export_id=None):
        self.cleanup()
        result, seen = {"ready": 0, "failed": 0, "superseded": 0}, set()
        while True:
            job = self._claim(export_id, seen)
            if job is None:
                break
            seen.add(job["id"])
            try:
                rendered = render_snapshot(
                    self.assets,
                    self.settings,
                    job["format"],
                    job["filters"],
                    now(),
                    lambda job=job: self._heartbeat(job),
                )
                outcome = self._publish(job, rendered)
                result["ready" if outcome == "READY" else "superseded"] += 1
            except Exception as error:
                code = error.code if isinstance(error, AssetError) else "EXPORT_BUILD_FAILED"
                with self.sessions.begin() as session:
                    epoch = session.scalar(
                        sa.select(CatalogState.revision).where(CatalogState.id == 1)
                    )
                    session.execute(
                        sa.update(ExportArtifact)
                        .where(
                            ExportArtifact.id == job["id"],
                            ExportArtifact.lease_owner == job["owner"],
                        )
                        .values(
                            status="FAILED",
                            requested_at=None,
                            lease_owner=None,
                            lease_until=None,
                            error_code=code,
                            failed_catalog_revision=epoch,
                        )
                    )
                result["failed"] += 1
            if export_id is not None:
                break
        return result

    def _render(self, format, filters=None):
        result = render_snapshot(self.assets, self.settings, format, filters, now())
        return result["payload"], result["node_count"]

    def download(self, export_id, token, *, etag=None):
        with self.sessions() as session:
            profile = session.execute(
                sa.select(
                    ExportArtifact.format,
                    ExportArtifact.token_hash,
                    ExportArtifact.expires_at,
                    ExportArtifact.revoked_at,
                ).where(ExportArtifact.id == export_id)
            ).one_or_none()
            if (
                profile is None
                or profile.revoked_at
                or (profile.expires_at and profile.expires_at <= now())
                or not hmac.compare_digest(
                    profile.token_hash, hashlib.sha256(token.encode()).digest()
                )
            ):
                raise AssetError("EXPORT_NOT_AVAILABLE")
            row = session.execute(
                sa.text(
                    "SELECT format,payload_data,payload_hash FROM export_artifacts e "
                    "WHERE id=:id AND token_hash=:hash AND payload_bytes BETWEEN 0 AND 10485760 "
                    "AND octet_length(payload_data)=payload_bytes AND nodema_export_serving(e)"
                ),
                {"id": export_id, "hash": profile.token_hash},
            ).one_or_none()
            if row is None:
                raise AssetError("EXPORT_PENDING")
            payload = bytes(row.payload_data)

        from app.usage import Usage

        Usage(self.sessions).best_effort(
            uuid4(),
            "SUBSCRIPTION",
            entity_id=export_id,
            outcome="COMPLETED",
            subscription_downloads=1,
            subscription_bytes=len(payload),
        )
        return payload, *FORMATS[row.format]

    def revoke(self, export_id):
        with self.sessions.begin() as session:
            if not session.execute(
                sa.update(ExportArtifact)
                .where(ExportArtifact.id == export_id)
                .values(revoked_at=now(), lease_owner=None, lease_until=None)
            ).rowcount:
                raise AssetError("EXPORT_NOT_AVAILABLE")

    def cleanup(self):
        with self.sessions.begin() as session:
            session.execute(sa.text("SELECT nodema_export_lock()"))
            return session.execute(
                sa.delete(ExportArtifact).where(
                    sa.or_(
                        ExportArtifact.expires_at < now(), ExportArtifact.revoked_at.is_not(None)
                    )
                )
            ).rowcount
