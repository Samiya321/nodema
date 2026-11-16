import io
import json
import threading
import urllib.error
from concurrent.futures import ThreadPoolExecutor

import pytest

from app.probes import globalping
from app.probes.pool import ClientPool

BASE = "https://api.example.test/v1"
BODY = {"type": "ping", "locations": [{"country": "CN", "limit": 1}]}


class Response(io.BytesIO):
    def __init__(self, body, headers=None):
        super().__init__(json.dumps(body).encode())
        self.status = 200
        self.headers = headers or {}


class Api:
    def __init__(self, budgets, failures=None):
        self.budgets = budgets.copy()
        self.failures = failures or {}
        self.calls = []
        self.lock = threading.Lock()

    def open(self, request, timeout):
        token = request.get_header("Authorization")
        assert token and token.startswith("Bearer ")  # no anonymous fallback
        token = token.removeprefix("Bearer ")
        method, path = request.get_method(), request.full_url.removeprefix(BASE)
        with self.lock:
            self.calls.append((token, method, path))
            failure = self.failures.get((token, method, path))
            if failure:
                raise urllib.error.HTTPError(request.full_url, failure, "error", {}, None)
            if path == "/limits":
                return Response(
                    {"rateLimit": {"measurements": {"create": {"remaining": self.budgets[token]}}}}
                )
            if path == "/probes":
                return Response([])
            if method == "POST":
                body = json.loads(request.data)
                cost = body.get("limit") or sum(loc.get("limit", 1) for loc in body["locations"])
                self.budgets[token] -= cost
                return Response(
                    {"id": f"id{len(self.calls)}"},
                    {"X-RateLimit-Remaining": str(self.budgets[token])},
                )
            return Response({"status": "finished", "results": [{"owner": token}]})

    def pool(self):
        return ClientPool(
            [globalping.Client(BASE, token, opener=self.open) for token in self.budgets]
        )


@pytest.mark.parametrize(
    ("tokens", "legacy", "expected"),
    [
        ("one,two\nthree one\r\n two", "old", ["one", "two", "three"]),
        (" , \n", " old ", ["old"]),
        ("", "", []),
    ],
)
def test_credentials_precedence_deduplication_and_secret_repr(
    monitor_settings, tokens, legacy, expected
):
    settings = monitor_settings.model_copy(
        update={
            "globalping_tokens": globalping_secret(tokens),
            "globalping_token": globalping_secret(legacy),
        }
    )
    assert settings.globalping_credentials() == expected
    assert tokens not in repr(settings) if tokens else True


def globalping_secret(value):
    from pydantic import SecretStr

    return SecretStr(value)


def test_multiline_tokens_loaded_from_environment(monitor_settings, monkeypatch):
    monkeypatch.setenv("GLOBALPING_TOKENS", "account-a\naccount-b,account-c")
    settings = type(monitor_settings)(
        _env_file=None,
        database_url="postgresql+psycopg://unused",
        fingerprint_key_b64="synthetic",
    )
    assert settings.globalping_credentials() == ["account-a", "account-b", "account-c"]
    assert "account-a" not in repr(settings)


def test_round_robin_budgets_and_polling_stay_with_creator():
    api = Api({"one": 20, "two": 30})
    pool = api.pool()
    assert pool.limits() == 50 and pool.available == 40
    ids = [pool.create(BODY) for _ in range(4)]
    assert [t for t, m, _ in api.calls if m == "POST"] == ["one", "two", "one", "two"]
    assert [pool.wait(identifier) for identifier in ids] == [
        [{"owner": "one"}],
        [{"owner": "two"}],
        [{"owner": "one"}],
        [{"owner": "two"}],
    ]
    assert pool.remaining == 46 and pool.available == 36 and not pool.owners


def test_empty_and_small_accounts_do_not_reduce_other_accounts_budget():
    api = Api({"empty": 0, "small": 3, "one": 10})
    pool = api.pool()
    assert pool.limits() == 13 and pool.available == 5
    pool.create(BODY | {"locations": [{"country": "CN", "limit": 3}]})
    assert pool.available == 2
    with pytest.raises(globalping.RateLimited):
        pool.create(BODY | {"limit": 3})
    assert pool.create(BODY)
    assert [t for t, m, _ in api.calls if m == "POST"] == ["one", "one"]


@pytest.mark.parametrize("failure", [401, 403, 429])
def test_bad_token_during_initial_limits_does_not_block_healthy_account(failure):
    api = Api({"bad": 500, "good": 10}, {("bad", "GET", "/limits"): failure})
    pool = api.pool()
    assert pool.limits() == 10 and pool.available == 5
    assert pool.probes() == []
    pool.create(BODY)
    assert [t for t, m, _ in api.calls if m == "POST"] == ["good"]


@pytest.mark.parametrize("failure", [401, 403, 429])
def test_rejected_creation_moves_to_another_account(failure):
    api = Api({"bad": 10, "good": 10}, {("bad", "POST", "/measurements"): failure})
    pool = api.pool()
    pool.limits()
    identifier = pool.create(BODY)
    assert pool.wait(identifier) == [{"owner": "good"}]
    assert pool.available == 4 and pool.remaining == 9
    assert pool.rate_limited == (1 if failure == 429 else 0)
    assert not pool.accounts[0].enabled


def test_all_exhausted_accounts_stop_without_anonymous_fallback():
    api = Api({"one": 0, "two": 5})
    pool = api.pool()
    pool.limits()
    assert pool.available == 0
    with pytest.raises(globalping.RateLimited):
        pool.create(BODY)
    assert not any(method == "POST" for _, method, _ in api.calls)


def test_unknown_budget_and_network_error_are_not_guessed_or_retried():
    unknown = globalping.Client(BASE, "unknown", opener=lambda *a, **k: Response({}))
    pool = ClientPool([unknown])
    with pytest.raises(globalping.ApiError, match="INVALID_RESPONSE"):
        pool.limits()
    api = Api({"one": 10, "two": 10}, {("one", "POST", "/measurements"): 503})
    pool = api.pool()
    pool.limits()
    with pytest.raises(globalping.ApiError, match="HTTP_503"):
        pool.create(BODY)
    assert len([c for c in api.calls if c[1] == "POST"]) == 1


def test_run_cap_also_covers_rejected_and_uncertain_submissions():
    api = Api({"one": 500, "two": 500}, {("one", "POST", "/measurements"): 422})
    pool = ClientPool(
        [globalping.Client(BASE, token, opener=api.open) for token in api.budgets], max_tests=2
    )
    pool.limits()
    assert pool.available == 2
    with pytest.raises(globalping.ApiError, match="HTTP_422"):
        pool.create(BODY)
    assert pool.create(BODY)
    with pytest.raises(globalping.RateLimited):
        pool.create(BODY)
    assert pool.available == 0 and len([c for c in api.calls if c[1] == "POST"]) == 2


def test_concurrent_workers_cannot_spend_the_same_remaining_tests():
    api = Api({"one": 20, "two": 20})
    pool = api.pool()
    pool.limits()

    def submit(_):
        try:
            identifier = pool.create(BODY | {"limit": 3})
            pool.wait(identifier)
            return True
        except globalping.RateLimited:
            return False

    with ThreadPoolExecutor(max_workers=16) as executor:
        assert sum(executor.map(submit, range(100))) == 10
    assert api.budgets == {"one": 5, "two": 5} and pool.available == 0


def test_poll_rate_limit_retries_same_measurement_within_deadline(monkeypatch):
    calls = []

    def limited_then_finished(request, timeout):
        calls.append(request.full_url)
        if len(calls) == 1:
            raise urllib.error.HTTPError(request.full_url, 429, "limit", {}, None)
        return Response({"status": "finished", "results": []})

    slept = []
    client = globalping.Client(BASE, "one", opener=limited_then_finished)
    assert client.wait("abc", sleep=slept.append) == []
    assert slept == [1.0] and calls == [BASE + "/measurements/abc"] * 2

    def limited(request, timeout):
        raise urllib.error.HTTPError(request.full_url, 429, "limit", {}, None)

    times = iter([0.0, 61.0])
    monkeypatch.setattr(globalping.time, "monotonic", lambda: next(times))
    with pytest.raises(globalping.ApiError, match="TIMEOUT"):
        globalping.Client(BASE, "one", opener=limited).wait("abc", sleep=slept.append)
