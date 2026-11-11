"""Real local VLESS/TLS checks in disposable schemas. Never contacts public proxy endpoints."""

import argparse
import base64
import json
import os
import secrets
import ssl
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from uuid import uuid4

import httpcore
import sqlalchemy as sa
import yaml
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from alembic.config import Config  # noqa: E402

from alembic import command  # noqa: E402
from app.checker.batch import ListenerPool  # noqa: E402
from app.checker.health import HealthChecker  # noqa: E402
from app.checker.precheck import EndpointCache  # noqa: E402
from app.checker.runtime import Mihomo, free_port  # noqa: E402
from app.config import Settings  # noqa: E402
from app.database.models import NodeCurrentStatus, NodeDailyStats, TestResult  # noqa: E402
from app.database.session import make_engine, session_factory  # noqa: E402
from app.domain import AssetError, SourceType  # noqa: E402
from app.exports import ExportService  # noqa: E402
from app.ingestion.fetcher import read_body  # noqa: E402
from app.ingestion.service import AssetService  # noqa: E402
from app.scans import ScanService  # noqa: E402
from app.usage import Usage  # noqa: E402
from scripts.smoke_protocols import Geo, certificate, private_file  # noqa: E402


@contextmanager
def fixture_server(binary, users):
    """All routing is literal loopback; Echo metadata is explicitly synthetic."""
    with tempfile.TemporaryDirectory(prefix="nodema-pipeline-fixture-") as temporary:
        directory = Path(temporary)
        cert, key = certificate(directory)
        nonce = secrets.token_urlsafe(24)

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path != "/" + nonce:
                    self.send_error(404)
                    return
                # Optional delay models a real exit's network round trip (loopback is ~1 ms).
                time.sleep(float(os.environ.get("BENCHMARK_ECHO_DELAY_MS", "0")) / 1000)
                raw = json.dumps(
                    {"nonce": nonce, "ip": "198.51.100.20", "country": "ZZ", "asn": 64512}
                ).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, *args):
                pass

        http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(cert, key)
        http.socket = tls.wrap_socket(http.socket, server_side=True)
        thread = threading.Thread(target=http.serve_forever, daemon=True)
        thread.start()
        client_tls = ssl.create_default_context(cafile=cert)
        url = f"https://127.0.0.1:{http.server_port}/{nonce}"

        class LocalEcho:
            def __init__(self):
                self.url = url
                self.metrics = {"echo_requests": 0, "echo_failures": 0, "echo_response_bytes": 0}

            def request(self, port=None):
                self.metrics["echo_requests"] += 1
                pool = (
                    httpcore.HTTPProxy(proxy_url=f"http://127.0.0.1:{port}", ssl_context=client_tls)
                    if port
                    else httpcore.ConnectionPool(ssl_context=client_tls)
                )
                try:
                    with (
                        pool,
                        pool.stream(
                            "GET",
                            url,
                            extensions={
                                "timeout": {"connect": 5, "read": 8, "write": 5, "pool": 5}
                            },
                        ) as response,
                    ):

                        def chunks():
                            for chunk in response.iter_stream():
                                self.metrics["echo_response_bytes"] += len(chunk)
                                yield chunk

                        data = json.loads(read_body(chunks(), b"", 4096))
                        if response.status != 200 or data.get("nonce") != nonce:
                            raise ValueError
                    return data
                except (httpcore.TimeoutException, TimeoutError):
                    self.metrics["echo_failures"] += 1
                    raise AssetError("ECHO_TIMEOUT") from None
                except Exception:
                    self.metrics["echo_failures"] += 1
                    raise AssetError("LOCAL_HTTPS_FAILED") from None

        listener = free_port()
        while listener == http.server_port:
            listener = free_port()
        config_path = directory / "server.yaml"
        private_file(
            config_path,
            yaml.safe_dump(
                {
                    "allow-lan": False,
                    "bind-address": "127.0.0.1",
                    "mode": "rule",
                    "log-level": "silent",
                    "dns": {"enable": False},
                    "listeners": [
                        {
                            "name": "synthetic-vless",
                            "type": "vless",
                            "listen": "127.0.0.1",
                            "port": listener,
                            "certificate": cert,
                            "private-key": key,
                            "users": [
                                {"username": str(i), "uuid": user} for i, user in enumerate(users)
                            ],
                        }
                    ],
                    "rules": ["MATCH,DIRECT"],
                }
            ).encode(),
        )
        process = None
        try:
            valid = subprocess.run(
                [binary, "-t", "-d", temporary, "-f", str(config_path)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
            )
            if valid.returncode:
                raise AssetError("LOCAL_SERVER_CONFIG_REJECTED")
            process = subprocess.Popen(
                [binary, "-d", temporary, "-f", str(config_path)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            # The real checker below performs the protocol/TLS readiness check.
            time.sleep(0.1)
            if process.poll() is not None:
                raise AssetError("LOCAL_SERVER_START_FAILED")
            yield listener, LocalEcho
        finally:
            if process:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=3)
            http.shutdown()
            http.server_close()
            thread.join(timeout=2)


def benchmark(url, count, binary, workers, baseline=False, batch=False, skip_exports=False):
    admin = make_engine(url)
    schema = "pipeline_benchmark_" + uuid4().hex
    with admin.begin() as conn:
        conn.execute(sa.text(f'CREATE SCHEMA "{schema}"'))
    engine = sa.create_engine(
        url,
        hide_parameters=True,
        pool_size=workers,
        max_overflow=0,
        connect_args={"options": f"-csearch_path={schema}", "connect_timeout": 10},
    )
    counters, lock = {"queries": 0, "connections": 0, "peak": 0}, threading.Lock()

    @sa.event.listens_for(engine, "checkout")
    def checkout(*args):
        with lock:
            counters["connections"] += 1
            counters["peak"] = max(counters["peak"], counters["connections"])

    @sa.event.listens_for(engine, "checkin")
    def checkin(*args):
        with lock:
            counters["connections"] -= 1

    @sa.event.listens_for(engine, "before_cursor_execute")
    def query(*args):
        with lock:
            counters["queries"] += 1

    try:
        migration = Config("alembic.ini")
        with engine.begin() as conn:
            migration.attributes["connection"] = conn
            command.upgrade(migration, "head")
        sessions = session_factory(engine)
        usage = Usage(sessions)
        empty_bytes = usage.database_sample()["table_bytes"]
        aes, hmac = secrets.token_bytes(32), secrets.token_bytes(32)
        assets = AssetService(sessions, hmac)
        settings = Settings(
            _env_file=None,
            database_url=url,
            encryption_key_b64=base64.b64encode(aes).decode(),
            fingerprint_key_b64=base64.b64encode(hmac).decode(),
            encryption_key_id="benchmark",
            retry_delay_seconds=0,
            shard_size=250,
            mihomo_binary=binary,
            check_concurrency=1
            if baseline
            else int(os.environ.get("BENCHMARK_CONCURRENCY", 16 if batch else 4)),
            check_batch_size=1 if baseline else 16,
            mihomo_reuse=not baseline,
            mihomo_batch_size=128 if batch else 0,
        )
        users = [str(uuid4()) for _ in range(count)]
        with fixture_server(binary, users) as (port, echo_class):
            started = time.monotonic()
            source = assets.create_source(
                name="synthetic-local-pipeline",
                source_type=SourceType.RAW_TEXT,
                payload="\n".join(
                    f"vless://{user}@127.0.0.1:{port}?security=tls&sni=localhost&allowInsecure=1"
                    for user in users
                ).encode(),
            )
            imported = assets.sync_source(source["id"])
            if imported["status"] != "SUCCESS" or imported["created_nodes"] != count:
                raise AssetError("BENCHMARK_IMPORT_FAILED")
            import_seconds = time.monotonic() - started
            imported_bytes = usage.database_sample()["table_bytes"]
            scans = ScanService(assets, settings)
            run = scans.create()
            shards = list(range(run["shard_count"]))
            checked_started = time.monotonic()

            def check(shard):
                first = time.monotonic()
                cache = EndpointCache(settings)
                runner = ScanService(
                    assets,
                    settings,
                    checker_factory=lambda: HealthChecker(
                        settings,
                        runtime=Mihomo(binary, reuse=not baseline),
                        cache=cache,
                        echo=echo_class(),
                        geoip=Geo(),
                    ),
                    pool_factory=(lambda: ListenerPool(binary)) if batch else None,
                )
                result = runner.run_shard(run["id"], shard)
                if result["status"] != "COMPLETED":
                    raise AssetError("BENCHMARK_SHARD_FAILED")
                print(f"{count} nodes: shard {shard} completed", file=sys.stderr, flush=True)
                return time.monotonic() - first

            with ThreadPoolExecutor(max_workers=workers) as executor:
                shard_seconds = list(executor.map(check, shards))
            check_seconds = time.monotonic() - checked_started
            if scans.finalize(run["id"])["status"] != "COMPLETED":
                raise AssetError("BENCHMARK_PUBLICATION_FAILED")
            published_bytes = usage.database_sample()["table_bytes"]
            exports = ExportService(assets, settings)
            export_bytes, export_counts = {}, {}
            # Exports build asynchronously since migration 0010; --skip-exports measures checks.
            for format in () if skip_exports else ("mihomo", "singbox", "uri", "json", "csv"):
                artifact = exports.create(format, build=True)
                export_counts[format] = artifact["node_count"]
                raw, _, _ = exports.download(artifact["id"], artifact["token"])
                export_bytes[format] = len(raw)
            total_seconds = time.monotonic() - started
            with sessions() as session:
                before_replay = session.scalar(sa.select(sa.func.count()).select_from(TestResult))
            # Replay finalization and already-completed shard execution, then verify uniqueness.
            for shard in shards:
                if not scans.run_shard(run["id"], shard).get("skipped"):
                    raise AssetError("BENCHMARK_REPLAY_FAILED")
            scans.finalize(run["id"])
            with sessions() as session:
                results = session.scalar(sa.select(sa.func.count()).select_from(TestResult))
                checked_nodes = session.scalar(
                    sa.select(sa.func.count(sa.distinct(TestResult.node_id)))
                )
                published = session.scalar(
                    sa.select(sa.func.count())
                    .select_from(NodeCurrentStatus)
                    .where(NodeCurrentStatus.status == "UP")
                )
                scheduled = session.scalar(sa.select(sa.func.sum(NodeDailyStats.scheduled_count)))
                if (
                    results != before_replay
                    or checked_nodes != count
                    or published != count
                    or scheduled != count
                ):
                    print(
                        json.dumps(
                            {
                                "nodes": count,
                                "results": results,
                                "before_replay": before_replay,
                                "checked_nodes": checked_nodes,
                                "published_up": published,
                                "scheduled": scheduled,
                            }
                        ),
                        file=sys.stderr,
                    )
                    raise AssetError("BENCHMARK_RESULT_COUNT_FAILED")
                errors = dict(
                    session.execute(
                        sa.select(TestResult.error_code, sa.func.count())
                        .where(TestResult.error_code.is_not(None))
                        .group_by(TestResult.error_code)
                    ).all()
                )
            summary = usage.summary()
            return {
                "mode": "serial-restart"
                if baseline
                else "shared-batch-runtime"
                if batch
                else "bounded-reuse",
                **{
                    key: summary["totals"][key]
                    for key in (
                        "full_checks",
                        "dns_requests",
                        "tcp_probes",
                        "tcp_cache_hits",
                        "runtime_starts",
                        "runtime_reloads",
                    )
                },
                "nodes": count,
                "shards": len(shards),
                "max_workers": workers,
                "import_seconds": round(import_seconds, 3),
                "check_wall_seconds": round(check_seconds, 3),
                "pipeline_seconds": round(total_seconds, 3),
                "local_worker_minutes": round(sum(shard_seconds) / 60, 3),
                "mean_check_ms": summary["health"]["mean_check_ms"],
                "timeout_ratio": summary["health"]["timeout_ratio"],
                "execution_failure_ratio": summary["executions"]["failure_ratio"],
                "attempts": summary["health"]["attempts"],
                "retry_attempts": results - count,
                "error_codes": errors,
                "published_up": published,
                "database_roundtrips": counters["queries"],
                "peak_pool_connections": counters["peak"],
                "empty_schema_bytes": empty_bytes,
                "after_import_bytes": imported_bytes,
                "after_publish_bytes": published_bytes,
                "database_bytes": usage.database_sample()["table_bytes"],
                "echo_requests": summary["totals"]["echo_requests"],
                "echo_response_bytes": summary["totals"]["echo_response_bytes"],
                "export_bytes": export_bytes,
                "export_counts": export_counts,
                "idempotent_replay": True,
                "github_actions_minutes": None,
                "public_network_bytes": None,
            }
    finally:
        engine.dispose()
        with admin.begin() as conn:
            conn.execute(sa.text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sizes", type=int, nargs="+", default=[100, 1000, 5000])
    parser.add_argument(
        "--baseline",
        action="store_true",
        help="Serial checks and a fresh runtime per node, with identical protocol and workload",
    )
    parser.add_argument(
        "--batch",
        action="store_true",
        help="Shared batch runtimes (one process per 128 nodes, 16 concurrent checks)",
    )
    parser.add_argument("--skip-exports", action="store_true")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--binary", default="private/bin/mihomo")
    args = parser.parse_args()
    if any(n < 1 or n > 5000 for n in args.sizes) or not 1 <= args.workers <= 4:
        raise AssetError("INVALID_BENCHMARK_SIZE")
    load_dotenv(".env")
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        raise AssetError("TEST_DATABASE_URL_REQUIRED")
    binary = str(Path(args.binary).resolve())
    Mihomo(binary).preflight()
    results = [
        benchmark(url, n, binary, args.workers, args.baseline, args.batch, args.skip_exports)
        for n in args.sizes
    ]
    print(
        json.dumps(
            {
                "benchmark": "loopback-vless-tls-full-pipeline",
                "synthetic_metadata": True,
                "results": results,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(error.code if isinstance(error, AssetError) else "BENCHMARK_FAILED", file=sys.stderr)
        sys.exit(1)
