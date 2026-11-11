"""Sub-Store indexes materialize independent child sources; airports are detected
from usage headers. Upstream failures never remove what was already imported."""

import json
from datetime import UTC, datetime, timedelta

import pytest
import sqlalchemy as sa

from app.checker.health import Observation
from app.database.models import Provider, Source
from app.domain import AssetError, SourceType
from app.scans import ScanService

pytestmark = pytest.mark.integration
API = "http://store.example:3000/api/subs"
REMOTE = "https://subscriptions.example/remote?token=synthetic-private"
LOCAL = "trojan://synthetic-local@local.example:443#Local"
URI = b"trojan://synthetic-remote@remote.example:443#Remote"
FUTURE = int((datetime.now(UTC) + timedelta(days=30)).timestamp())


def body(entries):
    return json.dumps({"status": "success", "data": entries}).encode()


class Fetcher:
    def __init__(self, entries, headers=None):
        self.index, self.remote, self.headers = body(entries), URI, headers or {}
        self.agents = {}

    def fetch_meta(self, url, *, user_agent=None):
        self.agents[url] = user_agent
        if url == API:
            if isinstance(self.index, AssetError):
                raise self.index
            return self.index, {}
        assert url == REMOTE
        if isinstance(self.remote, AssetError):
            raise self.remote
        return self.remote, dict(self.headers)


def sync_all(service, rounds=3):
    """Mirror `nodema source sync-all`: follow children created by an index."""
    results = []
    for _ in range(rounds):
        pending = [
            s["id"]
            for s in service.list_sources()
            if s["enabled"] and (s["sync_requested_at"] or s["last_sync_status"] == "NEVER")
        ]
        if not pending:
            break
        results += [service.sync_source(source_id) for source_id in pending]
    return results


def api_source(service, fetcher):
    service.fetcher = fetcher
    return service.create_source(
        name="Sub-Store", source_type=SourceType.SUBSCRIPTION_URL, payload=API.encode()
    )["id"]


def children(service, parent):
    return [s for s in service.list_sources() if s["parent_source_id"] == parent]


def test_index_materializes_independent_children(service):
    fetcher = Fetcher(
        [
            {"name": "remote-one", "url": REMOTE, "source": "remote", "ua": "custom-ua/1"},
            {"name": "mine", "source": "local", "content": LOCAL},
        ]
    )
    parent = api_source(service, fetcher)
    first = service.sync_source(parent)
    assert first["status"] == "SUCCESS" and first["children"]["created"] == 2
    assert service.get_source(parent)["detected_kind"] == "SUBSTORE"
    sync_all(service)
    kids = children(service, parent)
    assert {k["type"] for k in kids} == {"SUBSCRIPTION_URL", "RAW_TEXT"}
    assert all(k["last_sync_status"] == "SUCCESS" for k in kids)
    assert fetcher.agents[REMOTE] == "custom-ua/1"
    assert len(service.list_nodes()) == 2 and all(n["eligible"] for n in service.list_nodes())
    again = service.sync_source(parent)
    assert again["children"]["created"] == 0 and again["children"]["unchanged"] == 2
    assert REMOTE not in str(service.get_source(parent))


def test_dead_api_or_dead_link_never_hides_nodes(service):
    fetcher = Fetcher(
        [{"name": "remote", "url": REMOTE}, {"name": "local", "source": "local", "content": LOCAL}]
    )
    parent = api_source(service, fetcher)
    sync_all(service)
    assert sum(n["eligible"] for n in service.list_nodes()) == 2
    for broken in (
        AssetError("FETCH_TIMEOUT"),
        body([]),
        b'{"status":"failed","data":[],"message":"sensitive"}',
        b"<html>Login</html>",
    ):
        fetcher.index = broken
        assert service.sync_source(parent)["status"] == "FAILED"
        assert "sensitive" not in str(service.get_source(parent))
    fetcher.remote = AssetError("FETCH_HTTP_ERROR")
    for kid in children(service, parent):
        service.request_sync(kid["id"])
    sync_all(service)
    assert sum(n["eligible"] for n in service.list_nodes()) == 2
    # An upstream that drops a node also keeps it (retained, flagged as not present).
    fetcher.remote = b"trojan://another@other.example:443#Other"
    remote_kid = next(k for k in children(service, parent) if k["type"] == "SUBSCRIPTION_URL")
    service.sync_source(remote_kid["id"])
    nodes = service.list_nodes()
    assert len(nodes) == 3 and all(n["eligible"] for n in nodes)


def test_entries_removed_from_index_keep_their_child(service):
    fetcher = Fetcher(
        [{"name": "remote", "url": REMOTE}, {"name": "local", "source": "local", "content": LOCAL}]
    )
    parent = api_source(service, fetcher)
    sync_all(service)
    fetcher.index = body([{"name": "local", "source": "local", "content": LOCAL}])
    result = service.sync_source(parent)
    assert len(result["children"]["missing_from_index"]) == 1
    assert len(children(service, parent)) == 2


def test_direct_import_is_not_duplicated_by_index(service):
    fetcher = Fetcher([{"name": "remote", "url": REMOTE}])
    service.fetcher = fetcher
    service.create_source(
        name="direct", source_type=SourceType.SUBSCRIPTION_URL, payload=REMOTE.encode()
    )
    parent = api_source(service, fetcher)
    assert service.sync_source(parent)["children"]["shared"] == 1
    assert children(service, parent) == []


def airport_headers(expire=FUTURE, used=100, total=1000):
    return {
        "subscription-userinfo": f"upload=0; download={used}; total={total}; expire={expire}",
        "profile-title": "base64:" + "U3ludGhldGljIEFpcg==",  # "Synthetic Air"
        "profile-web-page-url": "https://air.example/user/login?token=secret",
    }


def airport_source(service, headers):
    fetcher = Fetcher([], headers)
    fetcher.remote = (
        URI
        + b"\ntrojan://info@remote.example:443#%E5%89%A9%E4%BD%99%E6%B5%81%E9%87%8F%EF%BC%9A10GB"
    )
    service.fetcher = fetcher
    source = service.create_source(
        name="air", source_type=SourceType.SUBSCRIPTION_URL, payload=REMOTE.encode()
    )["id"]
    return source, service.sync_source(source)


def test_airport_headers_classify_group_and_filter_info_nodes(service):
    source, result = airport_source(service, airport_headers())
    assert result["info_nodes"] == 1 and result["unique_nodes"] == 1
    saved = service.get_source(source)
    assert saved["detected_kind"] == "AIRPORT"
    assert saved["traffic_total"] == 1000 and saved["traffic_download"] == 100
    assert saved["profile_url"] == "https://air.example"  # never the token-bearing path
    with service.sessions() as session:
        provider = session.get(Provider, saved["provider_id"])
        assert provider.name == "Synthetic Air"
        group = session.scalar(sa.text("SELECT node_group FROM nodema_node_scope"))
        assert group == "AIRPORT"
    assert service.list_nodes()[0]["eligible"]


@pytest.mark.parametrize(
    "headers",
    [
        airport_headers(expire=int((datetime.now(UTC) - timedelta(days=1)).timestamp())),
        airport_headers(used=1000, total=1000),
    ],
)
def test_expired_or_exhausted_airport_is_not_tested(service, headers):
    airport_source(service, headers)
    assert not service.list_nodes()[0]["eligible"]


def test_scan_scope_separates_airport_and_self_hosted(service, monitor_settings):
    airport_source(service, airport_headers())
    service.create_source(
        name="vps", source_type=SourceType.RAW_TEXT, payload=b"trojan://own@vps.example:443#VPS"
    )
    sync_all(service)

    class Checker:
        def preflight(self):
            pass

        def close(self):
            pass

        def check(self, identity, short_id):
            return Observation(status="UP", exit_country="JP", exit_ip="8.8.8.8")

    scans = ScanService(service, monitor_settings, checker_factory=Checker)
    self_hosted = scans.create(scope="SELF_HOSTED", manual=True)
    assert self_hosted["node_count"] == 1 and self_hosted["kind"] == "MANUAL"
    airports = scans.create(scope="AIRPORT", manual=True)
    assert airports["node_count"] == 1
    # A manual retest of the same scope while the first is unfinished skips pending nodes.
    assert scans.create(scope="SELF_HOSTED", manual=True)["node_count"] == 0
    for run in (self_hosted, airports):
        scans.run_shard(run["id"], 0)
        assert scans.finalize(run["id"])["status"] == "COMPLETED"
    assert scans.create(scope="ALL", manual=True)["node_count"] == 2
    with service.sessions() as session:
        assert session.scalar(sa.select(sa.func.count()).select_from(Source)) == 2


def test_index_listing_a_subscription_twice_or_reusing_a_local_name(service):
    # Production crash: two entries with one origin key inserted twice in one pass.
    other = "trojan://synthetic-other@other.example:443#Other"
    fetcher = Fetcher(
        [
            {"name": "remote-a", "url": REMOTE, "source": "remote"},
            {"name": "remote-b", "url": REMOTE, "source": "remote"},
            {"name": "home", "source": "local", "content": LOCAL},
            {"name": "home", "source": "local", "content": other},
        ]
    )
    parent = api_source(service, fetcher)
    first = service.sync_source(parent)
    assert first["status"] == "SUCCESS"
    assert first["children"]["created"] == 3 and first["children"]["duplicates"] == 1
    labels = sorted(k["origin_label"] for k in children(service, parent))
    assert labels == ["home #2 · 本地", "home · 本地", "remote-a"]
    again = service.sync_source(parent)  # stable keys: nothing new on the next sync
    assert again["children"]["created"] == 0 and again["children"]["unchanged"] == 3


def test_airports_served_by_the_substore_host_group_by_entry_name(service):
    links = {
        "http://store.example:3000/download/alpha": b"trojan://a@alpha.example:443#A",
        "http://store.example:3000/download/beta": b"trojan://b@beta.example:443#B",
    }
    usage = {"subscription-userinfo": f"upload=1; download=2; total=0; expire={FUTURE}"}

    class StoreFetcher:
        def fetch_meta(self, url, *, user_agent=None):
            if url == API:
                return body(
                    [
                        {"name": name, "url": link}
                        for name, link in zip(("Alpha Air", "Beta Air"), links, strict=True)
                    ]
                ), {}
            return links[url], dict(usage)

    parent = api_source(service, StoreFetcher())
    sync_all(service)
    with service.sessions() as session:
        groups = sorted(
            session.execute(
                sa.text(
                    "SELECT p.name, p.match_key FROM sources s "
                    "JOIN providers p ON p.id=s.provider_id WHERE s.parent_source_id=:parent"
                ),
                {"parent": parent},
            ).all()
        )
    assert groups == [("Alpha Air", "label:alpha air"), ("Beta Air", "label:beta air")]

    # Links an earlier version lumped together by host are regrouped on the next sync.
    with service.sessions.begin() as session:
        session.execute(sa.text("DELETE FROM providers"))
        session.execute(
            sa.text(
                "INSERT INTO providers(id,name,match_key) VALUES "
                "('00000000-0000-4000-8000-0000000000aa','store.example','host:store.example')"
            )
        )
        session.execute(
            sa.text(
                "UPDATE sources SET provider_id='00000000-0000-4000-8000-0000000000aa' "
                "WHERE parent_source_id=:parent"
            ),
            {"parent": parent},
        )
    for child in children(service, parent):
        service.sync_source(child["id"], force=True)
    with service.sessions() as session:
        keys = sorted(session.scalars(sa.text("SELECT match_key FROM providers")).all())
    assert keys == ["label:alpha air", "label:beta air"]  # the lumped group is gone
