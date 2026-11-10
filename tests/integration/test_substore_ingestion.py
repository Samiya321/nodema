import json

import pytest
import sqlalchemy as sa

from app.database.models import Node, NodeSource, Source
from app.domain import AssetError, SourceType

pytestmark = pytest.mark.integration
API = "http://store.example:3000/api/subs"
REMOTE = "https://subscriptions.example/remote?token=synthetic-private"
LOCAL = "trojan://synthetic-local@local.example:443"
URI = b"trojan://synthetic-remote@remote.example:443"


def body(entries):
    return json.dumps({"status": "success", "data": entries}).encode()


class Fetcher:
    def __init__(self, entries):
        self.index, self.remote = body(entries), URI

    def fetch(self, url, **kwargs):
        if url == API:
            return self.index
        assert url == REMOTE
        if isinstance(self.remote, AssetError):
            raise self.remote
        return self.remote


def test_substore_child_change_without_index_change_and_plaintext_snapshots(service):
    fetcher = Fetcher([{"name": "synthetic", "url": REMOTE, "source": "remote"}])
    service.fetcher = fetcher
    source = service.create_source(
        name="Sub-Store", source_type=SourceType.SUBSCRIPTION_URL, payload=API.encode()
    )["id"]
    first = service.sync_source(source)
    assert first["status"] == "SUCCESS" and first["created_nodes"] == 1
    assert service.sync_source(source)["status"] == "UNCHANGED"
    assert service.get_source(source)["last_parse_summary"]["subscription"]["remote"] == 1
    old_hash = service.get_source(source)["content_hash"]
    fetcher.remote = URI.replace(b"synthetic-remote", b"synthetic-changed")
    assert service.sync_source(source)["created_nodes"] == 1
    assert service.get_source(source)["content_hash"] != old_hash
    assert len(service.list_nodes()) == 2 and sum(n["eligible"] for n in service.list_nodes()) == 1
    with service.sessions() as session:
        saved = session.get(Source, source)
        assert b"synthetic-private" in saved.payload_data + saved.url_data
        snapshot = json.loads(bytes(saved.payload_data))
        assert snapshot["format"] == "nodema-resolved-substore-v1"
        assert len(snapshot["documents"]) == 2
        assert all(
            json.loads(n.config_data)["protocol"] == n.protocol
            for n in session.scalars(sa.select(Node))
        )
    assert REMOTE not in str(service.get_source(source))


def test_substore_partial_failure_keeps_memberships_until_complete_snapshot(service):
    fetcher = Fetcher(
        [{"source": "local", "mergeSources": "localFirst", "content": LOCAL, "url": REMOTE}]
    )
    service.fetcher = fetcher
    source = service.create_source(
        name="Sub-Store", source_type=SourceType.SUBSCRIPTION_URL, payload=API.encode()
    )["id"]
    assert service.sync_source(source)["unique_nodes"] == 2
    fetcher.remote = AssetError("FETCH_TIMEOUT")
    result = service.sync_source(source)
    assert result["status"] == "PARTIAL"
    assert result["subscription"]["failed_references"] == 1
    assert sum(n["eligible"] for n in service.list_nodes()) == 2
    fetcher.index = body([{"source": "local", "content": LOCAL}])
    assert service.sync_source(source)["status"] == "SUCCESS"
    assert sum(n["eligible"] for n in service.list_nodes()) == 1
    with service.sessions() as session:
        assert session.scalar(sa.select(sa.func.count()).select_from(NodeSource)) == 2


def test_invalid_or_empty_api_response_never_clears_assets(service):
    fetcher = Fetcher([{"source": "local", "content": LOCAL}])
    service.fetcher = fetcher
    source = service.create_source(
        name="Sub-Store", source_type=SourceType.SUBSCRIPTION_URL, payload=API.encode()
    )["id"]
    service.sync_source(source)
    for raw in (
        body([]),
        b'{"status":"failed","data":[],"message":"sensitive"}',
        b"<html>Login</html>",
    ):
        fetcher.index = raw
        result = service.sync_source(source)
        assert result["status"] == "FAILED"
        assert service.list_nodes()[0]["eligible"]
        assert "sensitive" not in str(service.get_source(source))


def test_substore_aggregate_budget_is_separate_from_ordinary_document_budget(service):
    service.max_items = 1
    service.fetcher = Fetcher([{"url": REMOTE}])
    service.fetcher.remote = URI + b"\n" + URI.replace(b"remote.example", b"other.example")
    api = service.create_source(
        name="API", source_type=SourceType.SUBSCRIPTION_URL, payload=API.encode()
    )["id"]
    assert service.sync_source(api)["unique_nodes"] == 2
    ordinary = service.create_source(
        name="ordinary", source_type=SourceType.RAW_TEXT, payload=service.fetcher.remote
    )["id"]
    result = service.sync_source(ordinary)
    assert result["status"] == "FAILED" and result["error_code"] == "TOO_MANY_ITEMS"
