import json
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import UUID

import pytest
import sqlalchemy as sa
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from app.api import create_app
from app.cli import app
from app.database.models import Source
from app.domain import AssetError, SourceType
from app.ingestion.bulk import prepare_links

pytestmark = pytest.mark.integration


def test_bulk_mixed_duplicates_invalid_and_no_fetch(service, monkeypatch):
    monkeypatch.setattr(service.fetcher, "fetch", lambda *a: pytest.fail("must not fetch"))
    original = service.create_source(
        name="paused",
        source_type=SourceType.SUBSCRIPTION_URL,
        payload=b"https://subs.example/sub?token=synthetic-demo",
    )
    service.update_source(original["id"], enabled=False)
    text = "\nhttps://SUBS.example:443/sub?token=synthetic-demo\nhttp://store.example:3000/api/subs\nhttp://store.example:3000/api/subs\nhttp://127.0.0.1/private?token=synthetic-secret\nnot-a-url"
    result = service.create_sources_bulk(text)
    assert (result["created"], result["duplicates"], result["invalid"]) == (1, 2, 2)
    assert [i["line"] for i in result["items"]] == [2, 3, 4, 5, 6]
    assert result["items"][0]["id"] == str(original["id"])
    assert result["items"][1]["id"] == result["items"][2]["id"]
    assert "synthetic-" not in json.dumps(result)
    assert not service.get_source(original["id"])["enabled"]
    created_id = UUID(result["items"][1]["id"])
    assert service.get_source(created_id)["sync_requested_at"]
    assert service.create_sources_bulk(text)["created"] == 0
    service.delete_source(created_id)
    assert service.create_sources_bulk(text)["created"] == 1


def test_bulk_concurrent_submissions_deduplicate(service):
    barrier = Barrier(2)

    def submit():
        barrier.wait(timeout=5)
        return service.create_sources_bulk("https://concurrent.example/api/subs")

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: submit(), range(2)))
    assert sum(r["created"] for r in results) == 1
    assert sum(r["duplicates"] for r in results) == 1
    assert results[0]["items"][0]["id"] == results[1]["items"][0]["id"]


@pytest.mark.parametrize(
    "text,code",
    [
        ("\n \n", "EMPTY_INPUT"),
        ("https://subs.example/\n" * 101, "TOO_MANY_SUBSCRIPTION_LINKS"),
        ("x" * 131073, "INPUT_TOO_LARGE"),
    ],
)
def test_bulk_limits_before_write(service, text, code):
    with pytest.raises(AssetError, match=code):
        service.create_sources_bulk(text)
    assert not service.list_sources()


def test_bulk_api_never_dispatches_and_retains_requests(service, monitor_settings, monkeypatch):
    import app.api as api

    client = TestClient(create_app(monitor_settings, assets=service))
    data = {
        "urls": "https://subs.example/sub?token=synthetic-demo\nhttp://store.example:3000/api/subs\nfile:///etc/passwd"
    }
    assert client.post("/api/sources/bulk", json=data).status_code == 401
    calls = []

    def dispatch(settings):
        calls.append(settings)
        return {"dispatched": False, "reason": "DISPATCH_FAILED"}

    monkeypatch.setattr(api, "dispatch_source_sync", dispatch)
    headers = {"Authorization": "Bearer " + monitor_settings.admin_password.get_secret_value()}
    result = client.post("/api/sources/bulk", headers=headers, json=data)
    assert result.status_code == 200
    assert "synthetic-demo" not in result.text
    # Imports only persist sync requests; Actions start from an explicit "sync" click.
    assert calls == [] and result.json()["created"] == 2
    assert result.json()["pipeline"] == {"dispatched": False, "reason": "MANUAL_SYNC"}
    assert all(s["sync_requested_at"] for s in service.list_sources())
    assert client.post("/api/sources/bulk", headers=headers, json=data).json()["duplicates"] == 2
    assert client.post("/api/pipeline/sync", headers=headers).status_code == 202
    assert len(calls) == 1
    assert (
        "synthetic-demo"
        not in client.post(
            "/api/sources/bulk", headers=headers, json={**data, "unexpected": "synthetic-demo"}
        ).text
    )


def test_bulk_cli_uses_private_file_and_redacts(service, monitor_settings, monkeypatch, tmp_path):
    import app.cli as cli

    monkeypatch.setattr(cli, "service", lambda: service)
    monkeypatch.setattr(cli, "Settings", lambda: monitor_settings)
    path = tmp_path / "subscriptions.txt"
    path.write_text(
        "https://subs.example/sub?token=synthetic-secret\nhttps://store.example/api/subs"
    )
    result = CliRunner().invoke(app, ["source", "import-links", "--input-file", str(path)])
    assert result.exit_code == 0, result.stdout
    assert json.loads(result.stdout)["created"] == 2
    assert "synthetic-secret" not in result.stdout
    with service.sessions() as session:
        assert session.scalar(sa.select(sa.func.count()).select_from(Source)) == 2


def test_bulk_url_validation_shared_fixture(fixture_bytes):
    for case in json.loads(fixture_bytes("bulk_links.json")):
        item = prepare_links(case["value"])[0]
        if "url" in case:
            assert item["url"] == case["url"]
        else:
            assert item["status"] == "INVALID", case
