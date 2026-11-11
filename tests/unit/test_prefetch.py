"""Parallel subscription downloads replay results and usage metrics in order."""

import threading

import pytest

from app.domain import AssetError
from app.ingestion.prefetch import PrefetchingFetcher


class Fake:
    def __init__(self):
        self.calls, self.local = [], threading.local()

    @property
    def metrics(self):
        return getattr(self.local, "metrics", {})

    def reset_metrics(self):
        self.local.metrics = {"source_requests": 0, "source_response_bytes": 0}

    def fetch_meta(self, url, *, user_agent=None):
        self.calls.append((url, user_agent, threading.current_thread().name))
        self.local.metrics = {"source_requests": 1, "source_response_bytes": len(url)}
        if "bad" in url:
            raise AssetError("FETCH_HTTP_ERROR")
        return url.encode(), {"subscription-userinfo": "total=1"}


def test_prefetched_downloads_are_replayed_once_with_their_metrics():
    base = Fake()
    fetcher = PrefetchingFetcher(base, workers=4)
    urls = [(f"https://s{i}.example/sub", None) for i in range(20)] + [
        ("https://bad.example", "ua")
    ]
    assert fetcher.prefetch(urls + urls[:3]) == 21  # duplicates fetched once
    assert len(base.calls) == 21
    assert any(name.startswith("nodema-fetch") for *_, name in base.calls)

    fetcher.reset_metrics()
    body, headers = fetcher.fetch_meta("https://s3.example/sub")
    assert body == b"https://s3.example/sub" and headers
    assert fetcher.metrics["source_requests"] == 1
    fetcher.reset_metrics()
    with pytest.raises(AssetError, match="FETCH_HTTP_ERROR"):
        fetcher.fetch_meta("https://bad.example", user_agent="ua")
    assert fetcher.metrics["source_requests"] == 1
    # Consumed entries fall back to a live download.
    fetcher.fetch_meta("https://s3.example/sub")
    assert len(base.calls) == 22
