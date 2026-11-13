"""Authenticated single-admin API; long-running detection remains a CLI/Actions job."""

import hmac
from typing import Annotated
from uuid import UUID

import sqlalchemy as sa
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field, SecretStr

from app.catalog import Catalog, filters_from_params
from app.config import Settings
from app.database.session import make_engine, session_factory
from app.dispatch import dispatch_export_build, dispatch_scan, dispatch_source_sync
from app.domain import AssetError, InputFormat, SourceType
from app.exports import ExportService
from app.grading import VANTAGES
from app.ingestion.fetcher import Fetcher
from app.ingestion.service import AssetService
from app.scans import ScanService
from app.security.logging import configure_logging


class SourceCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)
    name: str = Field(min_length=1, max_length=80)
    type: SourceType
    payload: SecretStr
    format_hint: InputFormat = InputFormat.AUTO
    kind: str = "AUTO"
    user_agent: str | None = Field(default=None, max_length=512)


class SourceUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)
    name: str | None = Field(default=None, min_length=1, max_length=80)
    enabled: bool | None = None
    payload: SecretStr | None = None
    format_hint: InputFormat | None = None
    sync_interval_seconds: int | None = Field(default=None, gt=0)
    kind: str | None = None
    user_agent: str | None = Field(default=None, max_length=512)


class SourceBulkCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)
    urls: SecretStr
    name_prefix: str = "批量订阅"


class EnableUpdate(BaseModel):
    enabled: bool


class TemplateUpdate(BaseModel):
    template: str = Field(max_length=200)


class ExportCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = "Subscription"
    format: str
    filters: dict = Field(default_factory=dict)
    expires_in_hours: int | None = None


class ScanCreate(BaseModel):
    scope: str = "SELF_HOSTED"


def create_app(settings=None, *, assets=None):
    configure_logging()
    settings = settings or Settings()
    admin_token = settings.admin_password.get_secret_value()
    if len(admin_token) < 24:
        raise AssetError("ADMIN_TOKEN_REQUIRED")
    if assets is None:
        key = settings.fingerprint_key()
        assets = AssetService(
            session_factory(make_engine(settings.database_url.get_secret_value())),
            key,
            max_bytes=settings.source_max_bytes,
            max_items=settings.source_max_items,
            sync_interval=settings.source_sync_interval_seconds,
            name_template=settings.name_template,
            substore_max_fetches=settings.source_substore_max_fetches,
            substore_max_depth=settings.source_substore_max_depth,
            substore_timeout=settings.source_substore_timeout_seconds,
            substore_max_items=settings.source_substore_max_items,
            fetcher=Fetcher(
                max_bytes=settings.source_max_bytes,
                timeout=settings.source_total_timeout_seconds,
                max_redirects=settings.source_max_redirects,
                allow_http=True,
            ),
        )
    catalog, exports, scans = (
        Catalog(assets, settings),
        ExportService(assets, settings),
        ScanService(assets, settings),
    )
    app = FastAPI(title="Nodema", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.assets, app.state.settings = assets, settings
    bearer = HTTPBearer(auto_error=False)

    def authenticate(credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)]):
        actual = (
            credentials.credentials
            if credentials and credentials.scheme.lower() == "bearer"
            else ""
        )
        if not hmac.compare_digest(actual.encode(), admin_token.encode()):
            raise HTTPException(401, detail="AUTHENTICATION_REQUIRED")

    auth = [Depends(authenticate)]

    @app.middleware("http")
    async def protect(request: Request, call_next):
        # Bound the actual stream, not just an untrusted Content-Length header.
        if request.method in ("POST", "PUT", "PATCH"):
            size = 0
            try:
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > settings.source_max_bytes + 65536:
                        return JSONResponse({"error_code": "INPUT_TOO_LARGE"}, status_code=413)
                    # Body is needed by the downstream parser; accumulate only within the cap.
                    request._body = getattr(request, "_body", b"") + chunk
            except Exception:
                return JSONResponse({"error_code": "INVALID_REQUEST"}, status_code=400)
        try:
            response = await call_next(request)
        except Exception:
            response = JSONResponse({"error_code": "OPERATION_FAILED"}, status_code=500)
        response.headers.update(
            {
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "Referrer-Policy": "no-referrer",
                "X-Frame-Options": "DENY",
                "Content-Security-Policy": "default-src 'self'; script-src 'self'; "
                "style-src 'self'; img-src 'self' data:; connect-src 'self'; "
                "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
            }
        )
        return response

    from app.quality import QualityService

    quality = QualityService(assets)

    @app.get("/api/quality-policy", dependencies=auth)
    def quality_policy():
        return quality.policy()

    @app.put("/api/quality-policy", dependencies=auth)
    def update_quality_policy(body: dict):
        if set(body) - {"policy", "expected_version"} or "policy" not in body:
            raise AssetError("INVALID_QUALITY_POLICY")
        return quality.set_policy(body["policy"], body.get("expected_version"))

    from app.probes.policy import GradingPolicyService
    from app.probes.policy import load_policy as load_grading

    grading = GradingPolicyService(assets.sessions)

    @app.get("/api/grading-policy", dependencies=auth)
    def grading_policy():
        return grading.get()

    @app.put("/api/grading-policy", dependencies=auth)
    def update_grading_policy(body: dict):
        if not isinstance(body.get("policy"), dict):
            raise AssetError("INVALID_GRADING_POLICY")
        return grading.set(body["policy"], body.get("expected_version"))

    @app.get("/api/probe-status", dependencies=auth)
    def probe_status(vantage: str = ""):
        with assets.sessions() as session:
            chosen = vantage or load_grading(session)["default_vantage"]
            if chosen not in VANTAGES:
                raise AssetError("INVALID_NODE_QUERY")
            return session.scalar(sa.text("SELECT nodema_probe_status(:v)"), {"v": chosen})

    @app.get("/api/nodes/{node_id}/access", dependencies=auth)
    def node_access(node_id: UUID):
        with assets.sessions() as session:
            result = session.scalar(sa.text("SELECT nodema_node_access(:id)"), {"id": node_id})
        if result is None:
            raise AssetError("NODE_NOT_FOUND")
        return result

    @app.get("/api/nodes/{node_id}/annotations", dependencies=auth)
    def annotations(node_id: UUID):
        return quality.annotation(node_id)

    @app.patch("/api/nodes/{node_id}/annotations", dependencies=auth)
    def annotate(node_id: UUID, body: dict):
        return quality.annotate(node_id, body)

    @app.get("/api/nodes/{node_id}/evidence", dependencies=auth)
    def evidence(node_id: UUID):
        return quality.reveal_reference(node_id)

    @app.exception_handler(AssetError)
    async def asset_error(request, error):
        status = (
            503
            if error.code == "EXPORT_PENDING"
            else 410
            if error.code in ("SCAN_ARCHIVED", "SCAN_DATE_ARCHIVED")
            else 409
            if error.code
            in (
                "QUALITY_POLICY_CONFLICT",
                "GRADING_POLICY_CONFLICT",
                "EXPORT_TOKEN_LEGACY",
                "EXPORT_REVISION_CONFLICT",
            )
            else 404
            if error.code.endswith("NOT_FOUND") or error.code == "EXPORT_NOT_AVAILABLE"
            else 400
        )
        return JSONResponse(
            {"error_code": error.code},
            status_code=status,
            headers={"Retry-After": "60"} if status == 503 else None,
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, error):
        return JSONResponse({"error_code": "INVALID_REQUEST"}, status_code=422)

    @app.get("/api/health")
    def health():
        return {"status": "ok"}

    @app.get("/api/overview", dependencies=auth)
    def overview():
        return catalog.overview()

    @app.get("/api/usage", dependencies=auth)
    def usage_summary(days: int = 30):
        from app.usage import Usage

        return Usage(assets.sessions).summary(days)

    @app.get("/api/readiness", dependencies=auth)
    def deployment_readiness():
        from app.readiness import readiness

        return readiness(assets, settings)

    @app.get("/api/sources", dependencies=auth)
    def sources():
        return assets.list_sources()

    @app.post("/api/sources", dependencies=auth, status_code=201)
    def add_source(body: SourceCreate):
        return assets.create_source(
            name=body.name,
            source_type=body.type,
            payload=body.payload.get_secret_value().encode(),
            format_hint=body.format_hint,
            kind=body.kind,
            user_agent=body.user_agent,
        )

    @app.post("/api/sources/bulk", dependencies=auth)
    def add_sources_bulk(body: SourceBulkCreate):
        result = assets.create_sources_bulk(
            body.urls.get_secret_value(), name_prefix=body.name_prefix
        )
        # Imports never start Actions; the user syncs/tests explicitly.
        result["pipeline"] = {
            "dispatched": False,
            "reason": "MANUAL_SYNC" if result["created"] else "NO_NEW_SOURCES",
        }
        return result

    @app.post("/api/pipeline/sync", dependencies=auth, status_code=202)
    def pipeline_sync():
        return dispatch_source_sync(settings)

    @app.get("/api/sources/{source_id}", dependencies=auth)
    def source(source_id: UUID):
        return assets.get_source(source_id)

    @app.patch("/api/sources/{source_id}", dependencies=auth)
    def update_source(source_id: UUID, body: SourceUpdate):
        values = body.model_dump(exclude_unset=True)
        if body.payload is not None:
            values["payload"] = body.payload.get_secret_value().encode()
        return assets.update_source(source_id, **values)

    @app.delete("/api/sources/{source_id}", dependencies=auth)
    def delete_source(source_id: UUID):
        assets.delete_source(source_id)
        return {"status": "DELETED"}

    @app.post("/api/sources/{source_id}/sync", dependencies=auth)
    def sync_source(source_id: UUID):
        # Bounded single-source import; scans never run in a request/background task.
        return assets.sync_source(source_id)

    @app.get("/api/nodes", dependencies=auth)
    def nodes(request: Request, offset: int = 0, limit: int = 100, sort: str = "short_id:asc"):
        if offset < 0 or not 1 <= limit <= 500:
            raise HTTPException(422, "INVALID_PAGINATION")
        return catalog.page(
            filters_from_params(request.query_params), sort=sort, offset=offset, limit=limit
        )

    @app.get("/api/nodes/{node_id}", dependencies=auth)
    def node(node_id: UUID, vantage: str = ""):
        return catalog.node(node_id, vantage=vantage or None)

    @app.patch("/api/nodes/{node_id}", dependencies=auth)
    def update_node(node_id: UUID, body: EnableUpdate):
        assets.set_node_enabled(node_id, body.enabled)
        return {"status": "UPDATED"}

    @app.get("/api/nodes/{node_id}/aliases", dependencies=auth)
    def aliases(node_id: UUID):
        return assets.protected_aliases(node_id)

    @app.get("/api/scans", dependencies=auth)
    def list_scans():
        return scans.list()

    @app.post("/api/scans", dependencies=auth)
    def create_scan(body: ScanCreate | None = None):
        # Queue an immutable manual snapshot; execution is explicitly handled by CLI/Actions.
        run = scans.create(scope=(body or ScanCreate()).scope, manual=True)
        return {**run, **dispatch_scan(settings, run["id"])}

    @app.post("/api/scans/{run_id}/retry", dependencies=auth)
    def retry_scan(run_id: UUID):
        run = scans.get(run_id)
        if run.get("archived_at") is not None:
            raise AssetError("SCAN_ARCHIVED")
        if run["status"] == "COMPLETED":
            return {"dispatched": False, "reason": "ALREADY_COMPLETED"}
        return dispatch_scan(settings, run_id)

    @app.get("/api/scans/{run_id}", dependencies=auth)
    def get_scan(run_id: UUID):
        return scans.get(run_id)

    @app.get("/api/naming-rules", dependencies=auth)
    def naming():
        return catalog.naming()

    @app.put("/api/naming-rules", dependencies=auth)
    def naming_update(body: TemplateUpdate):
        return catalog.set_template(body.template)

    @app.post("/api/naming-rules/preview", dependencies=auth)
    def naming_preview(body: TemplateUpdate):
        return catalog.preview(body.template)

    @app.get("/api/exports", dependencies=auth)
    def list_exports():
        return exports.list()

    @app.post("/api/exports", dependencies=auth, status_code=202)
    def create_export(body: ExportCreate):
        return {
            **exports.create(
                body.format, body.filters, name=body.name, expires_in_hours=body.expires_in_hours
            ),
            "pipeline": dispatch_export_build(settings),
        }

    @app.get("/api/exports/{export_id}", dependencies=auth)
    def get_export(export_id: UUID):
        return exports.get(export_id)

    @app.patch("/api/exports/{export_id}", dependencies=auth, status_code=202)
    def update_export(export_id: UUID, body: dict):
        return {**exports.update(export_id, body), "pipeline": dispatch_export_build(settings)}

    @app.post("/api/exports/{export_id}/retry", dependencies=auth, status_code=202)
    def retry_export(export_id: UUID):
        return {**exports.retry(export_id), "pipeline": dispatch_export_build(settings)}

    @app.get("/api/exports/{export_id}/link", dependencies=auth)
    def export_link(export_id: UUID):
        return exports.link(export_id)

    @app.post("/api/exports/{export_id}/token", dependencies=auth)
    def rotate_export_token(export_id: UUID):
        return exports.link(export_id, rotate=True)

    @app.get("/api/exports/{export_id}/versions", dependencies=auth)
    def export_versions(export_id: UUID):
        return exports.versions(export_id)

    @app.delete("/api/exports/{export_id}", dependencies=auth)
    def revoke_export(export_id: UUID):
        exports.revoke(export_id)
        return {"status": "REVOKED"}

    @app.get("/subscriptions/{export_id}")
    def subscription(export_id: UUID, request: Request, token: str = ""):
        payload, mime, suffix = exports.download(export_id, token)
        import hashlib

        etag = '"' + hashlib.sha256(payload).hexdigest() + '"'
        if any(
            item.strip().removeprefix("W/") in (etag, "*")
            for item in request.headers.get("if-none-match", "").split(",")
        ):
            return Response(status_code=304, headers={"ETag": etag})
        return Response(
            payload,
            media_type=mime,
            headers={"Content-Disposition": f'attachment; filename="nodes.{suffix}"', "ETag": etag},
        )

    @app.get("/")
    def index():
        # The dashboard needs the Worker API (airports, Sub-Store, pipeline routes).
        return Response(
            "Nodema local API. The dashboard runs on Cloudflare Pages + Worker; "
            "for local UI work use `npm run dev` in cloudflare/api-worker and web/dashboard.",
            media_type="text/plain",
        )

    return app
