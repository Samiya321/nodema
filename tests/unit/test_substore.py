import json
import threading
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager

import httpcore
import pytest

from app.domain import AssetError
from app.ingestion.fetcher import Fetcher, validate_url
from app.ingestion.subscriptions import SubscriptionResolver
from app.parsers.substore import parse_substore_index

ROOT = "http://store.example:3000/api/subs"
ONE = "https://subscriptions.example/one"
TWO = "http://subscriptions.example:3000/two"


def manifest(entries):
    return json.dumps({"status": "success", "data": entries}).encode()


class FakeFetcher:
    def __init__(self, documents):
        self.documents, self.calls = documents, []

    def fetch(self, url, **kwargs):
        self.calls.append((url, kwargs.get("user_agent")))
        value = self.documents[url]
        if isinstance(value, AssetError):
            raise value
        return value


def test_local_remote_and_mixed_share_parser_and_deduplicate_fetches(fixture_bytes):
    fetcher = FakeFetcher(
        {
            ROOT: fixture_bytes("substore_subs.json"),
            ONE: fixture_bytes("sample_loon.conf"),
            TWO: fixture_bytes("sample_surge.conf"),
        }
    )
    result = SubscriptionResolver(fetcher).resolve(ROOT)
    report = result.report
    assert report.complete and len(report.nodes) == 17
    assert Counter(url for url, _ in fetcher.calls) == {ROOT: 1, ONE: 1, TWO: 1}
    stats = report.summary()["subscription"]
    assert stats["local"] == stats["remote"] == stats["mixed"] == 1
    assert stats["remote_references"] == 3 and stats["processor_entries"] == 1
    assert "synthetic-local" not in str(report.summary())
    assert "subscriptions.example" not in str(report.summary())
    assert "synthetic" not in repr(result) + repr(report) + repr(
        parse_substore_index(fetcher.documents[ROOT])
    )


@pytest.mark.parametrize("mode", ["localFirst", "remoteFirst"])
def test_mixed_order_and_root_unchanged_remote_change(mode):
    local = "trojan://synthetic-local@local.example:443"
    remote = b"trojan://synthetic-remote@remote.example:443"
    fetcher = FakeFetcher(
        {
            ROOT: manifest(
                [{"source": "local", "mergeSources": mode, "content": local, "url": ONE}]
            ),
            ONE: remote,
        }
    )
    first = SubscriptionResolver(fetcher).resolve(ROOT)
    assert [n.identity["server_host"] for n in first.report.nodes] == (
        ["local.example", "remote.example"]
        if mode == "localFirst"
        else ["remote.example", "local.example"]
    )
    fetcher.documents[ONE] = remote.replace(b"synthetic-remote", b"synthetic-changed")
    second = SubscriptionResolver(fetcher).resolve(ROOT)
    assert first.snapshot != second.snapshot


def test_partial_remote_failure_retains_successful_local_content():
    fetcher = FakeFetcher(
        {
            ROOT: manifest(
                [
                    {
                        "source": "remote",
                        "mergeSources": "remoteFirst",
                        "url": ONE,
                        "content": "ss://YWVzLTEyOC1nY206c3ludGhldGlj@ss.example:443",
                    }
                ]
            ),
            ONE: AssetError("FETCH_TIMEOUT"),
        }
    )
    report = SubscriptionResolver(fetcher).resolve(ROOT).report
    assert len(report.nodes) == 1 and not report.complete
    assert report.issues[0].code == "FETCH_TIMEOUT"


def test_reference_cycle_depth_fetch_count_and_total_byte_limits():
    for options, documents, code in [
        ({}, {ROOT: manifest([{"url": ROOT}])}, "SUBSTORE_REFERENCE_CYCLE"),
        ({"max_depth": 0}, {ROOT: manifest([{"url": ONE}])}, "SUBSTORE_DEPTH_LIMIT"),
        ({"max_fetches": 1}, {ROOT: manifest([{"url": ONE}])}, "SUBSTORE_FETCH_LIMIT"),
    ]:
        fetcher = FakeFetcher(documents)
        report = SubscriptionResolver(fetcher, **options).resolve(ROOT).report
        assert report.issues[0].code == code
        assert len(fetcher.calls) == 1
    raw = manifest([{"url": ONE}])
    with pytest.raises(AssetError, match="INPUT_TOO_LARGE"):
        SubscriptionResolver(
            FakeFetcher({ROOT: raw, ONE: b"x" * 100}), max_bytes=len(raw) + 10
        ).resolve(ROOT)
    with pytest.raises(AssetError, match="TOO_MANY_ITEMS"):
        SubscriptionResolver(
            FakeFetcher(
                {
                    ROOT: manifest(
                        [
                            {
                                "source": "local",
                                "content": "trojan://synthetic@one.example:443\ntrojan://synthetic@two.example:443",
                            }
                        ]
                    )
                }
            ),
            max_total_items=2,
        ).resolve(ROOT)


def test_unsafe_targets_and_api_errors_never_expose_upstream_messages():
    for target in (
        "http://127.0.0.1/secret",
        "http://169.254.169.254/metadata",
        "file:///secret",
        "https://subscription.example/sub#insecure",
    ):
        fetcher = FakeFetcher({ROOT: manifest([{"url": target}])})
        report = SubscriptionResolver(fetcher).resolve(ROOT).report
        assert report.issues[0].code == "UNSAFE_SUBSCRIPTION_URL"
        assert len(fetcher.calls) == 1
        assert target not in str(report.summary())
    with pytest.raises(AssetError, match="SUBSTORE_API_ERROR") as error:
        parse_substore_index(b'{"status":"failed","data":[],"error":"sensitive-upstream-message"}')
    assert "sensitive-upstream-message" not in str(error.value)
    for raw in (
        b'{"status":"success","data":[]}',
        b'{"status":"success","data":null}',
        b'{"status":"success","data":[],"data":[]}',
    ):
        with pytest.raises(AssetError):
            parse_substore_index(raw)


def test_object_store_defaults_and_user_agent_validation():
    raw = manifest({"opaque-name": {"url": ONE, "ua": "SyntheticClient/1.0"}})
    fetcher = FakeFetcher({ROOT: raw, ONE: b"trojan://synthetic@remote.example:443"})
    assert SubscriptionResolver(fetcher).resolve(ROOT).report.complete
    assert (ONE, "SyntheticClient/1.0") in fetcher.calls
    index = parse_substore_index(
        manifest([{"url": ONE, "ua": "bad\r\nsecret"}, {"source": "local", "content": ""}])
    )
    assert [i.code for i in index.issues] == [
        "INVALID_SUBSCRIPTION_USER_AGENT",
        "EMPTY_SUBSTORE_LOCAL",
    ]


def test_http_is_opt_in_for_fetching_and_https_cannot_redirect_downward():
    assert validate_url(ROOT, allow_http=True) == ROOT
    with pytest.raises(AssetError):
        validate_url(ROOT)  # Echo and other HTTPS-only callers keep their policy.

    class Pool:
        @contextmanager
        def stream(self, *args, **kwargs):
            yield httpcore.Response(302, headers={"Location": ROOT})

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

    with pytest.raises(AssetError, match="UNSAFE_SUBSCRIPTION_URL"):
        Fetcher(allow_http=True, pool_factory=lambda _: Pool()).fetch(
            "https://store.example/api/subs"
        )


def test_concurrent_index_fetches_keep_cumulative_metrics_and_deadline():
    barrier = threading.Barrier(4)

    class Pool:
        @contextmanager
        def stream(self, method, url, **kwargs):
            if url == ROOT:
                raw = manifest([{"url": f"https://subscription.example/{i}"} for i in range(4)])
            else:
                barrier.wait(timeout=3)
                raw = b"trojan://synthetic@remote.example:443"
            yield httpcore.Response(200, content=raw)

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

    fetcher = Fetcher(allow_http=True, pool_factory=lambda _: Pool())
    result = SubscriptionResolver(fetcher).resolve(ROOT)
    assert result.report.complete and len(result.report.nodes) == 4
    assert fetcher.metrics["source_requests"] == 5
    assert fetcher.metrics["source_response_bytes"] > 4 * 30
    # Batch metrics also remain separate when the same Fetcher syncs two sources.
    with ThreadPoolExecutor(max_workers=2) as pool:
        counts = list(pool.map(lambda _: _one_batch(fetcher), range(2)))
    assert counts == [1, 1]


def _one_batch(fetcher):
    with fetcher.batch(1):
        fetcher.fetch(ROOT)
        return fetcher.metrics["source_requests"]


def test_large_reference_list_obeys_fetch_and_aggregate_limits():
    urls = "\n".join(f"https://subscriptions.example/{i}" for i in range(1000))
    fetcher = FakeFetcher({ROOT: manifest([{"url": urls}])})
    with pytest.raises(AssetError, match="TOO_MANY_ITEMS"):
        SubscriptionResolver(fetcher, max_fetches=1, max_total_items=10).resolve(ROOT)
    assert len(fetcher.calls) == 1


@pytest.mark.parametrize("mode", ["localFirst", "remoteFirst"])
def test_mixed_definition_can_temporarily_have_only_local_content(mode):
    fetcher = FakeFetcher(
        {
            ROOT: manifest(
                [
                    {
                        "source": "local",
                        "mergeSources": mode,
                        "content": "trojan://synthetic@local.example:443",
                        "url": "",
                    }
                ]
            )
        }
    )
    report = SubscriptionResolver(fetcher).resolve(ROOT).report
    assert report.complete and len(report.nodes) == 1
    assert len(fetcher.calls) == 1
