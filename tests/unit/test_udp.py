import socket
import struct

import pytest

from app.checker import udp


def binding_response(transaction, ip="203.0.113.7", port=40000, xor=True):
    magic = struct.pack("!I", udp.STUN_MAGIC)
    raw = socket.inet_aton(ip)
    if xor:
        port ^= 0x2112
        raw = bytes(a ^ b for a, b in zip(raw, magic, strict=True))
    kind = 0x0020 if xor else 0x0001
    attr = struct.pack("!HHBBH", kind, 8, 0, 1, port) + raw
    return struct.pack("!HH", 0x0101, len(attr)) + magic + transaction + attr


def test_stun_mapped_address_reads_xor_and_plain_answers():
    transaction = bytes(range(12))
    assert udp.stun_mapped_address(binding_response(transaction), transaction) == "203.0.113.7"
    plain = binding_response(transaction, ip="198.51.100.2", xor=False)
    assert udp.stun_mapped_address(plain, transaction) == "198.51.100.2"


def test_stun_answer_for_another_transaction_is_ignored():
    assert udp.stun_mapped_address(binding_response(b"a" * 12), b"b" * 12) is None
    assert udp.stun_mapped_address(b"short", b"b" * 12) is None


def test_socks_addresses_round_trip():
    assert udp.socks_address("1.1.1.1", 53) == b"\x01\x01\x01\x01\x01\x005"
    assert udp.socks_address("stun.example", 3478)[:2] == b"\x03\x0c"
    wrapped = b"\0\0\0" + udp.socks_address("1.1.1.1", 53) + b"payload"
    assert udp.socks_unwrap(wrapped) == b"payload"
    assert udp.socks_unwrap(b"\0\0\1\1" + b"x" * 10) is None  # fragmented: dropped


def test_dns_answer_must_match_query_id():
    query = udp.dns_query(0x1234)
    answer = b"\x12\x34\x81\x80" + query[4:]
    assert udp.dns_answered(answer, 0x1234)
    assert not udp.dns_answered(answer, 0x9999)
    assert not udp.dns_answered(query, 0x1234)  # a query, not a response


def test_one_lost_packet_is_retried_not_failed(monkeypatch):
    calls = []

    def flaky(port, target, timeout):
        calls.append(target[0])
        if len(calls) == 1:
            raise TimeoutError
        return "203.0.113.9"

    monkeypatch.setattr(udp, "attempt", flaky)
    result = udp.probe(1080, pause=0)
    assert result.status == "SUCCESS" and result.exit_ip == "203.0.113.9"
    assert [a["ok"] for a in result.attempts] == [False, True]


def test_failed_only_after_every_attempt(monkeypatch):
    def dead(port, target, timeout):
        raise OSError("refused")

    monkeypatch.setattr(udp, "attempt", dead)
    result = udp.probe(1080, pause=0)
    assert result.status == "FAILED"
    assert len(result.attempts) == len(udp.TARGETS) >= 3
    assert {a["target"] for a in result.attempts} >= {"stun-cloudflare", "dns-cloudflare"}


def test_dns_fallback_success_has_no_exit_ip(monkeypatch):
    def only_dns(port, target, timeout):
        if target[3] != "dns":
            raise TimeoutError
        return ""

    monkeypatch.setattr(udp, "attempt", only_dns)
    result = udp.probe(1080, pause=0)
    assert result.status == "SUCCESS" and result.exit_ip is None


@pytest.mark.parametrize("declared,expected", [(False, "NOT_SUPPORTED"), (None, "SUCCESS")])
def test_checker_respects_tcp_only_nodes(monkeypatch, declared, expected):
    from types import SimpleNamespace

    from app.checker.health import HealthChecker, Observation

    checker = HealthChecker.__new__(HealthChecker)
    checker.settings = SimpleNamespace(udp_check_enabled=True, udp_timeout_seconds=1)
    checker.udp_targets = None
    monkeypatch.setattr(
        "app.checker.health.udp_probe",
        lambda port, timeout: udp.UdpResult("SUCCESS", 12, "203.0.113.1", []),
    )
    result = Observation()
    checker._udp(result, {"udp": declared is not False}, 1080)
    assert result.udp_status == expected


def test_failing_sources_are_retried_weekly_not_daily():
    from datetime import UTC, datetime, timedelta

    from app.ingestion.service import source_dormant

    at = datetime(2026, 11, 15, tzinfo=UTC)
    base = {
        "last_sync_status": "FAILED",
        "sync_requested_at": None,
        "last_success_at": None,
        "created_at": at - timedelta(days=10),
        "last_checked_at": at - timedelta(days=1),
    }
    assert source_dormant(base, at)  # never worked, added 10 days ago, tried yesterday
    assert not source_dormant(
        {**base, "last_checked_at": at - timedelta(days=8)}, at
    )  # weekly retry
    assert not source_dormant({**base, "created_at": at - timedelta(days=2)}, at)  # still new
    assert not source_dormant(
        {**base, "last_success_at": at - timedelta(days=3)}, at
    )  # worked recently
    assert not source_dormant({**base, "sync_requested_at": at}, at)  # user asked for a sync
    assert not source_dormant({**base, "last_sync_status": "SUCCESS"}, at)


def test_neon_transfer_reading_and_failures_never_raise():
    import io
    import json
    from contextlib import contextmanager
    from types import SimpleNamespace

    from pydantic import SecretStr

    from app.usage import neon_transfer

    settings = SimpleNamespace(
        neon_api_key=SecretStr("synthetic-key"),
        neon_project_id="synthetic-project",
        neon_transfer_limit_bytes=5_000_000_000,
    )
    body = {
        "project": {"data_transfer_bytes": 123, "consumption_period_end": "2026-12-01T00:00:00Z"}
    }

    @contextmanager
    def ok(request, timeout):
        assert request.get_header("Authorization") == "Bearer synthetic-key"
        yield io.BytesIO(json.dumps(body).encode())

    reading = neon_transfer(settings, opener=ok)
    assert reading["transfer_bytes"] == 123 and reading["transfer_period_end"].month == 12

    def broken(request, timeout):
        raise OSError("down")

    assert neon_transfer(settings, opener=broken) is None
    assert (
        neon_transfer(SimpleNamespace(**{**vars(settings), "neon_api_key": SecretStr("")})) is None
    )
