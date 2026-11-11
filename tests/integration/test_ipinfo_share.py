"""Landing-IP details (ip-api) and per-node share links. Documentation IPs only."""

import json

import pytest
import sqlalchemy as sa

from app import ipinfo, share_links
from app.catalog import Catalog
from app.ipinfo import BatchReply, clean, parse_as, parse_entry
from tests.integration.test_naming_scope import Checker, names, nodes, scan

pytestmark = pytest.mark.integration


class FakeClient:
    def __init__(self, replies):
        self.replies, self.calls = list(replies), []

    def lookup(self, ips):
        self.calls.append(list(ips))
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


def success(ip, org="Greencloud LLC", as_text="AS64500 xTom Japan Corporation"):
    return {
        "status": "success",
        "query": ip,
        "countryCode": "JP",
        "regionName": "Tokyo",
        "city": "Tokyo",
        "isp": "xTom Japan Corporation",
        "org": org,
        "as": as_text,
    }


def test_provider_text_is_sanitized_and_as_is_split():
    assert clean("Green‮cloud\x00 LLC" + "x" * 300).startswith("Green cloud LLC")
    assert len(clean("x" * 500)) == 200
    assert clean(5) is None
    assert parse_as("AS3258 xTom Japan Corporation") == (3258, "xTom Japan Corporation")
    assert parse_as("garbage") == (None, None)
    requested = {"192.0.2.1"}
    assert parse_entry(success("198.51.100.1"), requested) is None  # not asked for
    assert parse_entry({"status": "fail", "query": "192.0.2.1"}, requested) == {
        "ip": "192.0.2.1",
        "status": "FAILED",
    }


def test_refresh_saves_details_renames_and_skips_fresh_ips(service, monitor_settings, monkeypatch):
    nodes(service, 2)
    monkeypatch.setattr(
        Checker, "exit", {h: ("JP", 64500, None) for h in ("host-1.example", "host-2.example")}
    )
    scan(service, monitor_settings)
    # Documentation ranges are not public; treat them as public for this test only.
    monkeypatch.setattr(ipinfo, "public_ip", lambda ip: True)
    client = FakeClient(
        [BatchReply([success("192.0.2.1"), {"status": "fail", "query": "192.0.2.2"}], 14)]
    )
    result = ipinfo.refresh(service.sessions, monitor_settings, client)
    assert result == {
        "pending": 2,
        "saved": 2,
        "failed_lookups": 1,
        "names_changed": 1,
        "skipped": None,
    }
    assert names(service, monitor_settings)["host-1"] == "🇯🇵HK->JP|Greencloud|xTom 01"
    # Fresh details are not requested again; the failed IP waits a day.
    again = FakeClient([])
    assert ipinfo.refresh(service.sessions, monitor_settings, again)["pending"] == 0
    assert again.calls == []


def test_refresh_never_raises_on_provider_errors(service, monitor_settings, monkeypatch):
    nodes(service, 1)
    scan(service, monitor_settings)
    monkeypatch.setattr(ipinfo, "public_ip", lambda ip: True)
    result = ipinfo.refresh(service.sessions, monitor_settings, FakeClient([OSError("429")]))
    assert result["skipped"] == "LOOKUP_FAILED" and result["saved"] == 0
    with service.sessions() as session:
        assert session.scalar(sa.text("SELECT count(*) FROM ip_info")) == 0
    disabled = monitor_settings.model_copy(update={"ipinfo_enabled": False})
    assert ipinfo.refresh(service.sessions, disabled, FakeClient([]))["skipped"] == "DISABLED"


def test_private_landing_ips_are_never_sent(service, monitor_settings):
    nodes(service, 1)
    scan(service, monitor_settings)  # lands on 192.0.2.1, a documentation address
    client = FakeClient([])
    assert ipinfo.refresh(service.sessions, monitor_settings, client)["pending"] == 0
    assert client.calls == []


def test_share_links_are_created_once_without_a_name(service, monitor_settings):
    nodes(service, 2)
    created = {"created": 2, "unsupported": 0, "partial": 0}
    assert share_links.fill_missing(service.sessions) == created
    nothing = {"created": 0, "unsupported": 0, "partial": 0}
    assert share_links.fill_missing(service.sessions) == nothing
    with service.sessions() as session:
        uris = session.scalars(sa.text("SELECT uri FROM node_share_links ORDER BY uri")).all()
    assert all(u.startswith("trojan://secret-") and u.endswith("#") for u in uris)
    # Secrets stay out of list views: the catalog never carries the share link.
    item = Catalog(service, monitor_settings).page({}, limit=1)["items"][0]
    assert "trojan://" not in json.dumps(item, default=str)


def test_share_links_leave_out_what_a_uri_cannot_carry_and_say_so():
    vmess = {
        "protocol": "vmess",
        "server_host": "vm.example",
        "server_port": 443,
        "uuid": "11111111-2222-4333-8444-555555555555",
        "transport": "ws",
        "security": "tls",
        "transport_options": {"host": "cdn.example", "path": "/ws"},
        "protocol_options": {"alter_id": 0, "cipher": "auto"},
        "tls": {"sni": "cdn.example", "insecure": True},
        "extensions": {"clash": {"udp": True}},
    }
    uri, error, omitted = share_links.share_uri(vmess)
    assert error is None and uri.startswith("vmess://")
    assert omitted == ["CLIENT_OPTIONS", "SKIP_CERT_VERIFY"]
    # The stored identity is never modified.
    assert vmess["tls"]["insecure"] is True and "extensions" in vmess
    strict = {**vmess, "tls": {"sni": "cdn.example"}}
    strict.pop("extensions")
    assert share_links.share_uri(strict)[2] == []


def test_refresh_waits_for_the_rate_limit_reset_within_its_budget(
    service, monitor_settings, monkeypatch
):
    nodes(service, 3)
    monkeypatch.setattr(ipinfo, "BATCH_SIZE", 1)
    scan(service, monitor_settings)
    monkeypatch.setattr(ipinfo, "public_ip", lambda ip: True)
    reply = lambda ip: BatchReply([success(ip)], 0, 5)  # noqa: E731 - quota spent each time
    client = FakeClient([reply(f"192.0.2.{i}") for i in (1, 2, 3)])
    waits, now = [], [0.0]

    def sleep(seconds):
        waits.append(seconds)
        now[0] += seconds

    result = ipinfo.refresh(
        service.sessions, monitor_settings, client, sleep=sleep, clock=lambda: now[0]
    )
    assert result["saved"] == 3 and result["skipped"] is None
    assert waits == [6, 6]  # X-Ttl + 1 between batches, none after the last
    # A budget shorter than the reset stops early; the rest wait for the next run.
    with service.sessions.begin() as session:
        session.execute(sa.text("DELETE FROM ip_info"))
    tight = monitor_settings.model_copy(update={"ipinfo_time_budget_seconds": 3})
    client = FakeClient([reply(f"192.0.2.{i}") for i in (1, 2, 3)])
    result = ipinfo.refresh(service.sessions, tight, client, sleep=sleep, clock=lambda: now[0])
    assert result["saved"] == 1 and result["skipped"] == "RATE_LIMITED"


def test_landing_ip_type_flags_reach_catalog_filters_and_names(
    service, monitor_settings, monkeypatch
):
    nodes(service, 2)
    scan(service, monitor_settings)
    monkeypatch.setattr(ipinfo, "public_ip", lambda ip: True)
    home = {**success("192.0.2.1"), "mobile": False, "proxy": False, "hosting": False}
    idc = {**success("192.0.2.2"), "mobile": False, "proxy": True, "hosting": True}
    ipinfo.refresh(service.sessions, monitor_settings, FakeClient([BatchReply([home, idc], 14)]))
    catalog = Catalog(service, monitor_settings)
    by_ip = {n["exit_ip"]: n for n in catalog.page({}, limit=10)["items"]}
    assert by_ip["192.0.2.1"]["exit_ip_type"] == "RESIDENTIAL"
    assert by_ip["192.0.2.2"]["exit_ip_type"] == "HOSTING" and by_ip["192.0.2.2"]["exit_ip_proxy"]
    assert catalog.page({"exit_ip_type": "RESIDENTIAL"}, limit=10)["total"] == 1
    assert catalog.page({"exit_ip_proxy": True}, limit=10)["total"] == 1
    named = catalog.page({}, limit=10, template="{IPTYPE}|{SHORT_ID}")["items"]
    assert sorted(n["name"].split("|")[0] for n in named) == ["家宽", "机房"]
    assert (
        parse_entry({**success("192.0.2.9"), "hosting": "yes"}, {"192.0.2.9"})["is_hosting"] is None
    )
