"""source sync-all downloads in parallel, then syncs sequentially from the cache."""

import pytest

from app.domain import SourceType
from app.ingestion.prefetch import PrefetchingFetcher

pytestmark = pytest.mark.integration


class Fetch:
    def __init__(self):
        self.calls, self.metrics = [], {}

    def reset_metrics(self):
        self.metrics = {"source_requests": 0, "source_response_bytes": 0}

    def fetch_meta(self, url, *, user_agent=None):
        self.calls.append((url, user_agent))
        host = url.split("//")[1].split("/")[0]
        return f"trojan://secret@{host}:443#n".encode(), {}


def test_prefetched_subscriptions_are_not_downloaded_twice(service):
    ids = [
        service.create_source(
            name=f"s{i}",
            source_type=SourceType.SUBSCRIPTION_URL,
            payload=f"https://sub{i}.example/api".encode(),
            user_agent="clash-verge" if i == 0 else None,
        )["id"]
        for i in range(3)
    ]
    base = Fetch()
    service.fetcher = PrefetchingFetcher(base, workers=3)
    targets = service.fetch_targets(ids)
    assert sorted(targets) == [
        ("https://sub0.example/api", "clash-verge"),
        ("https://sub1.example/api", None),
        ("https://sub2.example/api", None),
    ]
    service.fetcher.prefetch(targets)
    assert all(service.sync_source(i)["status"] == "SUCCESS" for i in ids)
    assert len(base.calls) == 3
