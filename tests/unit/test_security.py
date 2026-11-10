import base64
import gzip
import time
from contextlib import contextmanager

import httpcore
import pytest

from app.config import Settings
from app.domain import AssetError
from app.ingestion.fetcher import Fetcher, SafeBackend, public_ip, read_body, validate_url
from app.naming import render_name
from app.parsers import parse_vless
from app.security.crypto import Cipher, fingerprint


def test_authenticated_encryption_and_record_binding(cipher):
    secret = b"synthetic-auth-sentinel"
    a = cipher.encrypt(secret, context="nodes:one:config")
    b = cipher.encrypt(secret, context="nodes:one:config")
    assert a != b and secret not in a
    assert cipher.decrypt(a, context="nodes:one:config") == secret
    for wrong in (a[:-1] + bytes([a[-1] ^ 1]), b"bad", b"NMA1" + bytes([255]) + a[5:]):
        with pytest.raises(AssetError, match="DECRYPTION_FAILED"):
            cipher.decrypt(wrong, context="nodes:one:config")
    with pytest.raises(AssetError):
        cipher.decrypt(a, context="nodes:two:config")
    with pytest.raises(AssetError):
        Cipher(b"X" * 32, "test-v1").decrypt(a, context="nodes:one:config")
    with pytest.raises(AssetError):
        Cipher(b"E" * 32, "different").decrypt(a, context="nodes:one:config")


def test_identity_fields_and_display_name():
    uri = "vless://00000000-0000-4000-8000-000000000001@edge.example:443?type=ws"
    original = fingerprint(parse_vless(uri + "#name1"), b"H" * 32)
    assert original == fingerprint(parse_vless(uri + "#name2"), b"H" * 32)
    for changed in (
        uri.replace("000001", "000002"),
        uri + "&path=/different",
        uri + "&pbk=synthetic-key",
        uri + "&sid=abcd",
        uri.replace(":443", ":444"),
    ):
        assert original != fingerprint(parse_vless(changed), b"H" * 32)
    assert original != fingerprint(parse_vless(uri), b"X" * 32)


@pytest.mark.parametrize(
    "ip",
    [
        "127.0.0.1",
        "10.0.0.1",
        "169.254.169.254",
        "::1",
        "fe80::1",
        "fc00::1",
        "::ffff:8.8.8.8",
        "224.0.0.1",
        "2001:db8::1",
        "64:ff9b::a00:1",
    ],
)
def test_non_public_addresses(ip):
    assert not public_ip(ip)


@pytest.mark.parametrize(
    "url",
    [
        "http://edge.example/sub",
        "https://localhost/sub",
        "https://127.0.0.1/sub",
        "https://[::1]/sub",
        "https://user:secret@edge.example/sub",
        "file:///secret",
        "https://edge.example/\r\nsecret",
        "https://edge.example\\@127.0.0.1/sub",
    ],
)
def test_unsafe_urls(url):
    with pytest.raises(AssetError, match="UNSAFE_SUBSCRIPTION_URL"):
        validate_url(url)


def test_dns_rebinding_protection_and_mixed_answers(monkeypatch):
    class Answer:
        def addresses(self):
            return ["8.8.8.8", "127.0.0.1"]

    class Resolver:
        def resolve_name(self, *args, **kwargs):
            return Answer()

    backend = SafeBackend(time.monotonic() + 30, Resolver())
    with pytest.raises(AssetError, match="UNSAFE_SUBSCRIPTION_TARGET"):
        backend.connect_tcp("untrusted.example", 443)
    called = []
    monkeypatch.setattr(
        httpcore.SyncBackend, "connect_tcp", lambda _, host, *a, **k: called.append(host)
    )
    monkeypatch.setattr(Answer, "addresses", lambda _: ["8.8.8.8"])
    backend.connect_tcp("untrusted.example", 443)
    assert called == ["8.8.8.8"]  # connect receives the validated IP, never re-resolves hostname


def test_fetch_redirect_boundary_and_mocked_download():
    class Pool:
        @contextmanager
        def stream(self, *args, **kwargs):
            yield httpcore.Response(302, headers={"Location": "https://127.0.0.1/private"})

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

    with pytest.raises(AssetError, match="UNSAFE_SUBSCRIPTION_URL"):
        Fetcher(pool_factory=lambda _: Pool()).fetch("https://edge.example/sub?token=synthetic")

    @contextmanager
    def success(*args, **kwargs):
        yield httpcore.Response(200, content=b"synthetic-body")

    Pool.stream = success
    assert (
        Fetcher(pool_factory=lambda _: Pool()).fetch("https://edge.example/sub")
        == b"synthetic-body"
    )


def test_stream_limits_compression_and_deadline():
    assert read_body([gzip.compress(b"hello")], b"gzip", 100) == b"hello"
    for chunks, encoding in (([b"x" * 101], b""), ([gzip.compress(b"x" * 1000)], b"gzip")):
        with pytest.raises(AssetError, match="INPUT_TOO_LARGE"):
            read_body(chunks, encoding, 100)
    with pytest.raises(AssetError, match="INVALID_COMPRESSED_RESPONSE"):
        read_body([b"bad"], b"gzip", 100)
    with pytest.raises(AssetError, match="FETCH_TIMEOUT"):
        SafeBackend(time.monotonic() - 1).connect_tcp("8.8.8.8", 443)


def test_keys_and_naming():
    settings = Settings(
        _env_file=None,
        database_url="postgresql+psycopg://",
        encryption_key_b64=base64.b64encode(b"E" * 32).decode(),
        fingerprint_key_b64=base64.b64encode(b"H" * 32).decode(),
    )
    assert settings.keys() == (b"E" * 32, b"H" * 32)
    settings.fingerprint_key_b64 = settings.encryption_key_b64
    with pytest.raises(AssetError, match="INVALID_KEYS"):
        settings.keys()
    assert render_name("N000001", "vless", "ws", "tls") == "🏳?|Unknown N000001"
    assert (
        render_name(
            "N1",
            "vless",
            None,
            None,
            entry_country="HK",
            exit_country="SG",
            asn_label="Webbing",
            seq=1,
        )
        == "🇸🇬HK->SG|Webbing 01"
    )
    assert render_name(
        "N1", "vless", None, None, entry_country="SG", exit_country="SG", seq=12
    ) == ("🇸🇬SG|Unknown 12")
    with pytest.raises(AssetError, match="INVALID_NAME_TEMPLATE"):
        render_name("N000001", "vless", None, None, "{SHORT_ID.__class__}")
