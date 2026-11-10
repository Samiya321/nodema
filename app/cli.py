"""A thin local CLI. Credentials are accepted through files/stdin, never URL arguments."""

import base64
import functools
import json
import os
import re
import secrets
import sys
import tempfile
from datetime import date
from pathlib import Path
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

import typer
from pydantic import ValidationError
from sqlalchemy.exc import OperationalError
from sqlalchemy.exc import TimeoutError as PoolTimeout

from app.catalog import Catalog
from app.config import Settings
from app.database.session import make_engine, session_factory
from app.domain import AssetError, InputFormat, SourceType
from app.exports import ExportService
from app.ingestion.fetcher import Fetcher
from app.ingestion.service import AssetService, source_due
from app.scans import ScanService, now
from app.security.crypto import Cipher
from app.security.logging import configure_logging

app = typer.Typer(pretty_exceptions_enable=False, no_args_is_help=True)
source_app = typer.Typer(no_args_is_help=True)
node_app = typer.Typer(no_args_is_help=True)
keys_app = typer.Typer(no_args_is_help=True)
naming_app = typer.Typer(no_args_is_help=True)
scan_app = typer.Typer(no_args_is_help=True)
export_app = typer.Typer(no_args_is_help=True)
usage_app = typer.Typer(no_args_is_help=True)
quality_app = typer.Typer(no_args_is_help=True)
app.add_typer(source_app, name="source")
app.add_typer(node_app, name="node")
app.add_typer(keys_app, name="keys")
app.add_typer(naming_app, name="naming")
app.add_typer(scan_app, name="scan")
app.add_typer(export_app, name="export")
app.add_typer(usage_app, name="usage")
app.add_typer(quality_app, name="quality")


def output(value):
    typer.echo(json.dumps(value, default=str, ensure_ascii=False, indent=2))


def safe_command(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        configure_logging()
        try:
            return fn(*args, **kwargs)
        except AssetError as error:
            output({"error_code": error.code})
            raise typer.Exit(1) from None
        except ValidationError:
            output({"error_code": "INVALID_SETTINGS"})
            raise typer.Exit(1) from None
        except (OperationalError, PoolTimeout):
            output({"error_code": "DATABASE_UNAVAILABLE"})
            raise typer.Exit(1) from None
        except (typer.Exit, KeyboardInterrupt):
            raise
        except Exception:
            output({"error_code": "OPERATION_FAILED"})
            raise typer.Exit(1) from None

    return wrapper


def service():
    settings = Settings()
    hmac_key = settings.fingerprint_key()
    return AssetService(
        session_factory(make_engine(settings.database_url.get_secret_value())),
        hmac_key,
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


def identifier(value: str):
    try:
        return UUID(value)
    except ValueError:
        raise AssetError("INVALID_ID") from None


def read_input(path: str) -> bytes:
    # Bound reads even for stdin and special files.
    limit = min(Settings().source_max_bytes, 10_485_760)
    try:
        if path == "-":
            data = sys.stdin.buffer.read(limit + 1)
        else:
            with Path(path).open("rb") as stream:
                data = stream.read(limit + 1)
    except OSError:
        raise AssetError("INPUT_READ_FAILED") from None
    if len(data) > limit:
        raise AssetError("INPUT_TOO_LARGE")
    return data


@keys_app.command("init")
@safe_command
def keys_init(env_file: str = ".env", admin_only: bool = False):
    path = Path(env_file)
    if path.is_symlink():
        raise AssetError("ENV_SYMLINK_FORBIDDEN")
    content = path.read_text() if path.exists() else "ENCRYPTION_KEY_ID=local-v1\n"
    lines = content.splitlines()
    keys = (
        ("ADMIN_PASSWORD",)
        if admin_only
        else ("ENCRYPTION_KEY_B64", "FINGERPRINT_KEY_B64", "ADMIN_PASSWORD")
    )
    for key in keys:
        positions = [i for i, line in enumerate(lines) if line.strip().startswith(key + "=")]
        if len(positions) > 1 or positions and lines[positions[0]].split("=", 1)[1].strip():
            raise AssetError("KEY_ALREADY_EXISTS")
        assignment = f"{key}={base64.b64encode(secrets.token_bytes(32)).decode()}"
        if positions:
            lines[positions[0]] = assignment
        else:
            lines.append(assignment)
    fd, temporary = tempfile.mkstemp(prefix=".nodema-keys-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write("\n".join(lines) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    output({"status": "KEYS_INITIALIZED"})


@source_app.command("create")
@safe_command
def source_create(
    name: str = typer.Option(...),
    type_: SourceType = typer.Option(..., "--type", case_sensitive=False),
    input_file: str = typer.Option(...),
    format_hint: InputFormat = InputFormat.AUTO,
):
    output(
        service().create_source(
            name=name, source_type=type_, payload=read_input(input_file), format_hint=format_hint
        )
    )


@source_app.command("list")
@safe_command
def source_list(include_deleted: bool = False):
    output(service().list_sources(include_deleted=include_deleted))


@source_app.command("import-links")
@safe_command
def source_import_links(input_file: str = typer.Option(...), name_prefix: str = "批量订阅"):
    """Save one subscription/Sub-Store URL per line without fetching in the CLI request."""
    from app.dispatch import dispatch_source_sync

    try:
        urls = read_input(input_file).decode("utf-8-sig")
    except UnicodeError:
        raise AssetError("INVALID_TEXT_ENCODING") from None
    result = service().create_sources_bulk(urls, name_prefix=name_prefix)
    result["pipeline"] = (
        dispatch_source_sync(Settings())
        if result["created"]
        else {"dispatched": False, "reason": "NO_NEW_SOURCES"}
    )
    output(result)


@source_app.command("show")
@safe_command
def source_show(source_id: str):
    output(service().get_source(identifier(source_id)))


@source_app.command("update")
@safe_command
def source_update(
    source_id: str,
    name: str | None = None,
    enabled: bool | None = None,
    input_file: str | None = None,
    format_hint: InputFormat | None = None,
    sync_interval_seconds: int | None = None,
):
    output(
        service().update_source(
            identifier(source_id),
            name=name,
            enabled=enabled,
            format_hint=format_hint,
            payload=read_input(input_file) if input_file is not None else None,
            sync_interval_seconds=sync_interval_seconds,
        )
    )


@source_app.command("delete")
@safe_command
def source_delete(source_id: str):
    service().delete_source(identifier(source_id))
    output({"status": "DELETED"})


@source_app.command("sync")
@safe_command
def source_sync(source_id: str, force: bool = False):
    result = service().sync_source(identifier(source_id), force=force)
    output(result)
    if result["status"] in ("PARTIAL", "FAILED"):
        raise typer.Exit(2)


@source_app.command("sync-all")
@safe_command
def source_sync_all(due_only: bool = False):
    assets = service()
    results = []
    for source in assets.list_sources():
        if not source["enabled"]:
            continue
        if (
            due_only
            and not source_due(
                source["last_checked_at"],
                source["sync_interval_seconds"],
                now(),
                Settings().scan_timezone,
            )
            and source["sync_requested_at"] is None
            and source["last_sync_status"] != "NEVER"
        ):
            continue
        try:
            results.append(assets.sync_source(source["id"]))
        except AssetError as error:
            results.append(
                {"source_id": source["id"], "status": "FAILED", "error_code": error.code}
            )
    output(results)
    if any(result["status"] in ("FAILED", "PARTIAL") for result in results):
        raise typer.Exit(2)


@node_app.command("list")
@safe_command
def node_list(
    filters_file: str | None = None,
    sort: str = "short_id:asc",
    offset: int = 0,
    limit: int = 100,
    with_total: bool = False,
):
    filters = json.loads(read_input(filters_file)) if filters_file else {}
    result = Catalog(service(), Settings()).page(filters, sort=sort, offset=offset, limit=limit)
    output(result if with_total else result["items"])


@quality_app.command("show")
@safe_command
def quality_show():
    from app.quality import QualityService

    output(QualityService(service()).policy())


@quality_app.command("apply")
@safe_command
def quality_apply(input_file: str = typer.Option(...), expected_version: int | None = None):
    from app.quality import QualityService

    output(
        QualityService(service()).set_policy(json.loads(read_input(input_file)), expected_version)
    )


@quality_app.command("annotate")
@safe_command
def quality_annotate(node_id: str, input_file: str = typer.Option(...)):
    from app.quality import QualityService

    output(
        QualityService(service()).annotate(identifier(node_id), json.loads(read_input(input_file)))
    )


@node_app.command("show")
@safe_command
def node_show(node_id: str):
    output(Catalog(service(), Settings()).node(identifier(node_id)))


@node_app.command("enable")
@safe_command
def node_enable(node_id: str):
    service().set_node_enabled(identifier(node_id), True)
    output({"status": "ENABLED"})


@node_app.command("disable")
@safe_command
def node_disable(node_id: str):
    service().set_node_enabled(identifier(node_id), False)
    output({"status": "DISABLED"})


@naming_app.command("preview")
@safe_command
def naming_preview(template_file: str | None = None):
    current = service()
    catalog = Catalog(current, Settings())
    template = read_input(template_file).decode().strip() if template_file else catalog.template()
    output(catalog.preview(template))


@naming_app.command("apply")
@safe_command
def naming_apply(template_file: str = typer.Option(...)):
    output(Catalog(service(), Settings()).set_template(read_input(template_file).decode().strip()))


@scan_app.command("prepare")
@safe_command
def scan_prepare(run_id: str | None = None, scan_date: str | None = None):
    scans = ScanService(service(), Settings())
    if run_id:
        plan = scans.plan(identifier(run_id))
    else:
        try:
            day = date.fromisoformat(scan_date) if scan_date else None
        except ValueError:
            raise AssetError("INVALID_SCAN_DATE") from None
        plan = scans.plan(scan_date=day)
    result = {k: v for k, v in plan.items() if k not in ("runs", "workers")}
    result["run_ids"] = [r["id"] for r in plan["runs"]]
    detail = scans.get(result["id"])
    shards = [s["shard_no"] for s in detail["shards"] if s["status"] != "COMPLETED"]
    result["shards"] = shards
    output(result)
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as stream:
            stream.write(f"run_id={result['id']}\nshards={json.dumps(shards)}\n")
            stream.write(f"has_work={'true' if shards else 'false'}\n")
            workers = [{"tasks_json": json.dumps(tasks)} for tasks in plan["workers"]]
            stream.write(f"workers={json.dumps(workers)}\n")
            stream.write(f"run_ids={json.dumps([str(r['id']) for r in plan['runs']])}\n")
            stream.write(f"has_tasks={'true' if plan['workers'] else 'false'}\n")


def json_list(value):
    try:
        result = json.loads(value)
        if not isinstance(result, list) or len(result) > 10000:
            raise ValueError
        return result
    except (ValueError, TypeError):
        raise AssetError("INVALID_SCAN_PLAN") from None


@scan_app.command("worker-batch")
@safe_command
def scan_worker_batch(tasks_json: str = typer.Option(...)):
    scans = ScanService(service(), Settings())
    tasks = json_list(tasks_json)
    parsed = []
    for task in tasks:
        if not isinstance(task, dict) or type(task.get("shard")) is not int or task["shard"] < 0:
            raise AssetError("INVALID_SCAN_PLAN")
        parsed.append((identifier(str(task.get("run_id"))), task["shard"]))
    results, failed = [], False
    for run_id, shard in parsed:
        try:
            result = scans.run_shard(run_id, shard)
        except AssetError as error:
            result, failed = {"error_code": error.code}, True
        results.append({"run_id": run_id, "shard": shard, **result})
    output(results)
    if failed:
        raise typer.Exit(2)


@scan_app.command("finalize-batch")
@safe_command
def scan_finalize_batch(run_ids_json: str = typer.Option(...)):
    scans = ScanService(service(), Settings())
    ids = [identifier(str(value)) for value in json_list(run_ids_json)]
    results = []
    for run_id in ids:
        try:
            results.append(scans.finalize(run_id))
        except AssetError as error:
            results.append({"id": run_id, "status": "FAILED", "error_code": error.code})
    output(results)
    if any(r["status"] != "COMPLETED" for r in results):
        raise typer.Exit(2)


@scan_app.command("worker")
@safe_command
def scan_worker(run_id: str = typer.Option(...), shard: int = typer.Option(..., min=0)):
    output(ScanService(service(), Settings()).run_shard(identifier(run_id), shard))


@scan_app.command("finalize")
@safe_command
def scan_finalize(run_id: str = typer.Option(...)):
    result = ScanService(service(), Settings()).finalize(identifier(run_id))
    output(result)
    if result["status"] != "COMPLETED":
        raise typer.Exit(2)


@scan_app.command("list")
@safe_command
def scan_list():
    output(ScanService(service(), Settings()).list())


@scan_app.command("show")
@safe_command
def scan_show(run_id: str):
    output(ScanService(service(), Settings()).get(identifier(run_id)))


@scan_app.command("run-local")
@safe_command
def scan_local():
    scans = ScanService(service(), Settings())
    plan = scans.plan()
    for run in plan["runs"]:
        for shard in run["shards"]:
            if shard["status"] != "COMPLETED":
                scans.run_shard(run["id"], shard["shard_no"])
        scans.finalize(run["id"])
    output(scans.get(plan["id"]))


@app.command("cleanup")
@safe_command
def cleanup():
    assets, settings = service(), Settings()
    from app.usage import Usage

    output(
        {
            **ScanService(assets, settings).cleanup(),
            "deleted_exports": ExportService(assets, settings).cleanup(),
            "deleted_usage": Usage(assets.sessions).cleanup(settings.stats_retention_days),
        }
    )


@usage_app.command("show")
@safe_command
def usage_show(days: int = 30):
    from app.usage import Usage

    output(Usage(service().sessions).summary(days))


@usage_app.command("sample")
@safe_command
def usage_sample():
    from app.usage import Usage

    output(Usage(service().sessions).database_sample())


@usage_app.command("collect-actions")
@safe_command
def usage_actions(
    run_id: int = typer.Option(..., min=1),
    attempt: int = typer.Option(..., min=1),
    trusted_branch: str | None = None,
):
    from app.actions_usage import collect_actions

    settings = Settings()
    output(
        collect_actions(
            service().sessions,
            settings.github_repository,
            os.environ.get("GITHUB_TOKEN", ""),
            run_id,
            attempt,
            trusted_branch=trusted_branch or settings.github_workflow_ref,
        )
    )


@usage_app.command("record-job")
@safe_command
def usage_record_job(sample_file: str = typer.Option(...), outcome: str = "success"):
    from app.job_network import finish
    from app.usage import Usage

    states = {"success": "COMPLETED", "failure": "FAILED", "cancelled": "FAILED"}
    if outcome not in states:
        raise AssetError("INVALID_JOB_OUTCOME")
    key = os.environ.get("USAGE_JOB_KEY") or os.environ.get("GITHUB_JOB", "local")
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", key):
        raise AssetError("INVALID_JOB_KEY")
    run_id, attempt = os.environ.get("GITHUB_RUN_ID", ""), os.environ.get("GITHUB_RUN_ATTEMPT", "")
    if run_id and (not run_id.isdigit() or not attempt.isdigit()):
        raise AssetError("INVALID_ACTIONS_RUN")
    event_id = (
        uuid5(NAMESPACE_URL, f"nodema-job:{Settings().github_repository}:{run_id}:{attempt}:{key}")
        if run_id
        else uuid4()
    )
    values = finish(sample_file)
    recorded = Usage(service().sessions).best_effort(
        event_id, "JOB", outcome=states[outcome], **values
    )
    output({"recorded": recorded, "network_available": bool(values["network_samples"])})


@app.command("doctor")
@safe_command
def doctor(network: bool = False):
    from app.readiness import readiness

    result = readiness(service(), Settings(), network=network)
    output(result)
    if not result["ready"]:
        raise typer.Exit(2)


@export_app.command("create")
@safe_command
def export_create(
    format: str = "mihomo",
    exit_country: str | None = None,
    protocol: str | None = None,
    filters_file: str | None = None,
    sort: str = "short_id:asc",
    limit: int = 100000,
    name: str = "Subscription",
    expires_in_hours: int | None = None,
    build_now: bool = False,
):
    filters = json.loads(read_input(filters_file)) if filters_file else {}
    if not isinstance(filters, dict):
        raise AssetError("INVALID_EXPORT_FILTER")
    filters.update(
        {k: v for k, v in {"exit_country": exit_country, "protocol": protocol}.items() if v}
    )
    filters.update(sort=sort, limit=limit)
    output(
        ExportService(service(), Settings()).create(
            format, filters, name=name, expires_in_hours=expires_in_hours, build=build_now
        )
    )


@export_app.command("budgets")
@safe_command
def export_budgets(
    max_profiles: int | None = None,
    max_payload_bytes: int | None = None,
    max_members: int | None = None,
    version_limit: int | None = None,
):
    values = {
        k: v
        for k, v in {
            "max_profiles": max_profiles,
            "max_payload_bytes": max_payload_bytes,
            "max_members": max_members,
            "version_limit": version_limit,
        }.items()
        if v is not None
    }
    output(ExportService(service(), Settings()).budgets(values or None))


@export_app.command("build-pending")
@safe_command
def export_build_pending():
    output(ExportService(service(), Settings()).build_pending())


@export_app.command("retry")
@safe_command
def export_retry(export_id: str):
    output(ExportService(service(), Settings()).retry(identifier(export_id)))


@export_app.command("list")
@safe_command
def export_list():
    output(ExportService(service(), Settings()).list())


@export_app.command("revoke")
@safe_command
def export_revoke(export_id: str):
    ExportService(service(), Settings()).revoke(identifier(export_id))
    output({"status": "REVOKED"})


@app.command("serve")
@safe_command
def serve(host: str = "127.0.0.1", port: int = 8000):
    import uvicorn

    from app.api import create_app

    uvicorn.run(create_app(), host=host, port=port, access_log=False, log_level="warning")


@app.command("backup")
@safe_command
def backup(output_file: str = typer.Option(...), docker_client: bool = False):
    from app.backup import backup_database

    settings = Settings()
    aes, _ = settings.keys()
    output(
        backup_database(
            settings.database_url.get_secret_value(),
            Cipher(aes, settings.encryption_key_id),
            output_file,
            docker_client=docker_client,
        )
    )


@app.command("restore")
@safe_command
def restore(
    input_file: str = typer.Option(...), confirm_restore: bool = False, docker_client: bool = False
):
    from app.backup import restore_database

    settings = Settings()
    aes, _ = settings.keys()
    output(
        restore_database(
            settings.database_url.get_secret_value(),
            Cipher(aes, settings.encryption_key_id),
            input_file,
            confirmed=confirm_restore,
            docker_client=docker_client,
        )
    )


@app.command("geoip-update")
@safe_command
def geoip_update(directory: str = "private/geoip"):
    from app.geoip_update import download_databases

    output(download_databases(Settings(), directory))


@app.command("geoip-pack")
@safe_command
def geoip_pack(output_file: str = typer.Option(...), directory: str = "private/geoip"):
    from app.geoip_update import download_databases, download_provider, pack_databases

    settings = Settings()
    ready = False
    result = {"provider": download_provider(settings)}
    if result["provider"] != "disabled":
        try:
            aes, _ = settings.keys()
            result["databases"] = download_databases(settings, directory)
            pack_databases(directory, output_file, Cipher(aes, settings.encryption_key_id))
            ready = True
        except AssetError as error:
            # GeoIP enrichment is optional: an upstream outage must not stop health checks.
            result["error_code"] = error.code
    output(
        {
            **result,
            "status": "PACKED"
            if ready
            else "UNAVAILABLE"
            if "error_code" in result
            else "DISABLED",
            "geoip_ready": ready,
        }
    )
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as stream:
            stream.write(f"geoip_ready={'true' if ready else 'false'}\n")


@app.command("geoip-install")
@safe_command
def geoip_install(input_file: str = typer.Option(...), directory: str = "private/geoip"):
    from app.geoip_update import install_databases

    settings = Settings()
    aes, _ = settings.keys()
    output(install_databases(input_file, directory, Cipher(aes, settings.encryption_key_id)))


def main():
    configure_logging()
    app()


if __name__ == "__main__":
    main()
