"""Parallel subscription downloads ahead of a sequential sync.

Hundreds of subscriptions fetched one after another can outlast an Actions job, while
syncing sources concurrently would race node upserts. So downloads run in a thread
pool first and the sync then consumes them in order. Each cached download carries its
own request metrics so per-source usage records stay accurate.
"""

from concurrent.futures import ThreadPoolExecutor

from app.domain import AssetError


class PrefetchingFetcher:
    def __init__(self, fetcher, workers: int = 8):
        self.fetcher, self.workers = fetcher, max(1, workers)
        self._ready: dict[tuple[str, str | None], tuple] = {}
        self._extra = {"source_requests": 0, "source_response_bytes": 0}

    # Metrics seen by AssetService.sync_source: live fetches plus replayed downloads.
    @property
    def metrics(self):
        live = self.fetcher.metrics
        return {k: live.get(k, 0) + v for k, v in self._extra.items()}

    def reset_metrics(self):
        self.fetcher.reset_metrics()
        self._extra = {"source_requests": 0, "source_response_bytes": 0}

    def batch(self, timeout):
        return self.fetcher.batch(timeout)

    def _download(self, key):
        url, user_agent = key
        try:
            result = ("ok", self.fetcher.fetch_meta(url, user_agent=user_agent))
        except AssetError as error:
            result = ("error", error)
        except Exception:  # noqa: BLE001 - one bad download must not stop the round
            # Not cached: that source falls back to a live fetch in its own sync,
            # where the error is handled and recorded like any other.
            return key, None, {}
        return key, result, dict(self.fetcher.metrics)

    def prefetch(self, targets, *, workers: int | None = None) -> int:
        """Download every (url, user_agent) target concurrently; returns how many."""
        keys = list(dict.fromkeys(targets))
        with ThreadPoolExecutor(
            max_workers=max(1, workers or self.workers), thread_name_prefix="nodema-fetch"
        ) as pool:
            for key, result, metrics in pool.map(self._download, keys):
                if result is not None:
                    self._ready[key] = (result, metrics)
        return len(keys)

    def fetch_meta(self, url, *, user_agent=None):
        cached = self._ready.pop((url, user_agent), None)
        if cached is None:
            return self.fetcher.fetch_meta(url, user_agent=user_agent)
        (kind, value), metrics = cached
        for key in self._extra:
            self._extra[key] += metrics.get(key, 0)
        if kind == "error":
            raise value
        return value

    def fetch(self, url, *, user_agent=None):
        return self.fetch_meta(url, user_agent=user_agent)[0]
