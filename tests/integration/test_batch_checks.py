"""Batched checks: workers prepare nodes, shared runtimes probe them (fake pool)."""

import threading

import pytest
import sqlalchemy as sa

from app.checker.health import Observation
from app.scans import ScanService
from tests.integration.test_naming_scope import nodes

pytestmark = pytest.mark.integration


class FakeBatch:
    def __init__(self, pool, names):
        self.pool, self.names = pool, names

    def listener(self, name):
        if name in self.pool.refused:
            return None

        def alive():
            # The node's first runtime dies under it; a later batch is a fresh process.
            if name in self.pool.crashed:
                self.pool.crashed.discard(name)
                return False
            return True

        return (40000, alive)

    def release(self):
        with self.pool.lock:
            self.pool.released += 1


class FakePool:
    def __init__(self):
        self.loads, self.released, self.closed = [], 0, False
        self.refused, self.crashed, self.lock = set(), set(), threading.Lock()

    def load(self, ready):
        self.loads.append(sorted(ready))
        return FakeBatch(self, set(ready))

    def close(self):
        self.closed = True


class Checker:
    probed = []

    def preflight(self):
        pass

    def close(self):
        pass

    def set_context(self, **context):
        pass

    def prepare(self, identity, short_id):
        result = Observation(entry_country="HK")
        if identity["server_host"].startswith("host-1."):
            result.status, result.error_code = "UNKNOWN", "ENTRY_DNS_NOT_FOUND"
            return result, None  # decided without a proxy
        return result, {"proxy": {"name": short_id}, "hosts": {}}

    def probe(self, result, ready, listener):
        name = ready["proxy"]["name"]
        Checker.probed.append((name, listener is not None))
        if listener is not None and not listener[1]():
            result.status, result.error_code = "ENVIRONMENT_ERROR", "MIHOMO_BATCH_CRASHED"
            return result
        result.status, result.exit_country, result.exit_ip = "UP", "SG", "192.0.2.50"
        result.exit_asn = 64512
        return result


def test_batched_scan_loads_batches_falls_back_and_retries_crashes(service, monitor_settings):
    nodes(service, 9)
    settings = monitor_settings.model_copy(update={"mihomo_batch_size": 4, "check_batch_size": 2})
    pool = FakePool()
    with service.sessions() as session:
        short_ids = dict(session.execute(sa.text("SELECT server_host, short_id FROM nodes")).all())
    pool.refused = {short_ids["host-2.example"]}  # config refused: probed per node instead
    crashed = short_ids["host-3.example"]
    pool.crashed = {crashed}
    Checker.probed = []

    scans = ScanService(service, settings, checker_factory=Checker, pool_factory=lambda: pool)
    run = scans.create(manual=True)

    for shard in scans.get(run["id"])["shards"]:
        scans.run_shard(run["id"], shard["shard_no"])
    assert scans.finalize(run["id"])["status"] == "COMPLETED"

    loaded = [name for batch in pool.loads for name in batch]
    assert all(len(batch) <= 4 for batch in pool.loads) and len(pool.loads) >= 2
    assert short_ids["host-1.example"] not in loaded  # never reached the proxy stage
    assert loaded.count(crashed) == 2  # crashed once, retried in a new batch
    assert (short_ids["host-2.example"], False) in Checker.probed  # own runtime fallback
    assert pool.released == len(loaded) - 1 and pool.closed  # refused node held no listener
    with service.sessions() as session:
        statuses = dict(
            session.execute(
                sa.text(
                    "SELECT n.server_host, c.status FROM node_current_status c "
                    "JOIN nodes n ON n.id=c.node_id"
                )
            ).all()
        )
    assert statuses["host-3.example"] == "UP"
    assert statuses["host-1.example"] == "DOWN"
    assert sum(status == "UP" for status in statuses.values()) == 8
