"""Kill a real checker process after one committed result, then reclaim its lease."""

import base64
import json
import os
import subprocess
import sys
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import pytest
import sqlalchemy as sa

from app.checker.health import Observation
from app.database.models import NodeCurrentStatus, ScanShard
from app.database.models import TestResult as HealthResult
from app.domain import SourceType
from app.scans import ScanService
from app.usage import Usage

pytestmark = pytest.mark.integration


@pytest.mark.parametrize("concurrency,batch,count", [(1, 1, 3), (4, 4, 10)])
def test_killed_checker_only_rechecks_unfinished_items(
    service, monitor_settings, tmp_path, concurrency, batch, count
):
    source = service.create_source(
        name="synthetic-kill-recovery",
        source_type=SourceType.RAW_TEXT,
        payload="\n".join(
            f"vless://{uuid4()}@fixture.example:443?security=tls" for _ in range(count)
        ).encode(),
    )
    service.sync_source(source["id"])
    scans = ScanService(service, monitor_settings)
    run = scans.create()
    with service.sessions() as session:
        schema = session.scalar(sa.text("select current_schema()"))
        url = session.bind.url.render_as_string(hide_password=False)
    marker = tmp_path / "blocked"
    env = {
        **os.environ,
        "DATABASE_URL": url,
        "PGOPTIONS": f"-csearch_path={schema}",
        "ENCRYPTION_KEY_B64": base64.b64encode(b"E" * 32).decode(),
        "FINGERPRINT_KEY_B64": base64.b64encode(b"H" * 32).decode(),
        "ENCRYPTION_KEY_ID": "test-v1",
        "RUN_ID": str(run["id"]),
        "CHECK_CONCURRENCY": str(concurrency),
        "CHECK_BATCH_SIZE": str(batch),
        "MARKER": str(marker),
    }
    program = """
import os, time
from threading import Lock
from pathlib import Path
from uuid import UUID
from app.checker.health import Observation
from app.config import Settings
from app.database.session import make_engine, session_factory
from app.ingestion.service import AssetService
from app.security.crypto import Cipher
from app.scans import ScanService
class Checker:
    calls=0
    lock=Lock()
    def preflight(self): pass
    def close(self): pass
    def check(self,*args):
        with self.lock:
            Checker.calls+=1
            block=Checker.calls>int(os.environ["CHECK_BATCH_SIZE"])
        if block:
            Path(os.environ["MARKER"]).write_text("blocked")
            while True: time.sleep(1)
        return Observation(status="UP",exit_ip="8.8.8.8")
settings=Settings(_env_file=None)
engine=make_engine(os.environ["DATABASE_URL"])
assets=AssetService(session_factory(engine),b"H"*32)
ScanService(assets,settings,checker_factory=Checker).run_shard(UUID(os.environ["RUN_ID"]),0)
"""
    child = subprocess.Popen(
        [sys.executable, "-c", program],
        cwd=Path(__file__).resolve().parents[2],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.monotonic() + 15
        while not marker.exists() and child.poll() is None and time.monotonic() < deadline:
            time.sleep(0.05)
        assert marker.exists(), "Synthetic checker did not reach the recovery checkpoint"
        # Checks run in a sliding window, so completed results are committed shortly after
        # the next check starts; wait for exactly the unblocked ones to be durable.
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            with service.sessions() as session:
                if session.scalar(sa.select(sa.func.count()).select_from(HealthResult)) >= batch:
                    break
            time.sleep(0.1)
        child.kill()
        assert child.wait(timeout=5) != 0
        with service.sessions.begin() as session:
            assert session.scalar(sa.select(sa.func.count()).select_from(HealthResult)) == batch
            assert session.scalar(sa.select(sa.func.count()).select_from(NodeCurrentStatus)) == 0
            session.get(ScanShard, (run["id"], 0)).lease_until = datetime.now(UTC) - timedelta(
                seconds=1
            )
        assert Usage(service.sessions).summary()["executions"]["failed_executions"] == 1

        class Resume:
            calls = 0

            def preflight(self):
                pass

            def close(self):
                pass

            def check(self, *args):
                self.calls += 1
                return Observation(status="UP", exit_ip="8.8.8.8")

        checker = Resume()
        resumed = ScanService(service, monitor_settings, checker_factory=lambda: checker)
        resumed.run_shard(run["id"], 0)
        assert checker.calls == count - batch
        assert resumed.finalize(run["id"])["status"] == "COMPLETED"
        resumed.run_shard(run["id"], 0)
        resumed.finalize(run["id"])
        with service.sessions() as session:
            assert session.scalar(sa.select(sa.func.count()).select_from(HealthResult)) == count
            assert (
                session.scalar(sa.select(sa.func.count()).select_from(NodeCurrentStatus)) == count
            )
        assert "fixture.example" not in json.dumps(Usage(service.sessions).summary(), default=str)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=5)
