import json

import pytest
import sqlalchemy as sa

from app.conversion import to_mihomo
from app.database.models import Node, NodeSource
from app.domain import SourceType
from app.parsers import parse_document

pytestmark = pytest.mark.integration


@pytest.mark.parametrize(
    "filename,count",
    [("sample_loon.conf", 6), ("sample_surge.conf", 3), ("sample_quantumult_x.conf", 5)],
)
@pytest.mark.parametrize(
    "source_type", [SourceType.RAW_TEXT, SourceType.UPLOADED_FILE, SourceType.SUBSCRIPTION_URL]
)
def test_local_and_remote_proxy_lists_share_plaintext_ingestion(
    service, fixture_bytes, filename, count, source_type
):
    raw = fixture_bytes(filename)
    calls = []

    class Fetcher:
        def fetch(self, url):
            calls.append(url)
            assert url == "https://subscriptions.example/synthetic"
            return raw

    service.fetcher = Fetcher()
    payload = (
        b"https://subscriptions.example/synthetic"
        if source_type == SourceType.SUBSCRIPTION_URL
        else raw
    )
    source = service.create_source(name=filename, source_type=source_type, payload=payload)
    result = service.sync_source(source["id"])
    assert result["status"] == "SUCCESS" and result["unique_nodes"] == count
    assert len(calls) == (1 if source_type == SourceType.SUBSCRIPTION_URL else 0)
    assert service.sync_source(source["id"])["status"] == "UNCHANGED"
    assert service.sync_source(source["id"], force=True)["created_nodes"] == 0
    with service.sessions() as session:
        assert session.scalar(sa.select(sa.func.count()).select_from(Node)) == count
        assert session.scalar(sa.select(sa.func.count()).select_from(NodeSource)) == count
        for node in session.scalars(sa.select(Node)):
            assert json.loads(node.config_data)["protocol"] == node.protocol
    for node in parse_document(raw).nodes:
        assert to_mihomo(node.identity, "synthetic")["server"] == node.identity["server_host"]
