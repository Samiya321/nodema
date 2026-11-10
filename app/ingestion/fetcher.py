"""Bounded subscription fetching with DNS validation at the connection boundary."""

import ipaddress
import socket
import ssl
import time
import zlib
from contextlib import contextmanager
from contextvars import ContextVar
from threading import Lock
from urllib.parse import quote, urljoin, urlsplit, urlunsplit

import dns.resolver
import httpcore

from app.domain import AssetError

# Panels commonly send subscription-userinfo (and a Clash/Mihomo document, which is
# parsed like any other format) only to client-like user agents.
DEFAULT_USER_AGENT = "clash.meta"


def public_ip(value: str) -> bool:
    try:
        ip = ipaddress.ip_address(value)
        if isinstance(ip, ipaddress.IPv6Address):
            if (
                ip.ipv4_mapped
                or ip.sixtofour
                or ip.teredo
                or ip in ipaddress.ip_network("64:ff9b::/96")
            ):
                return False
        return ip.is_global and not (
            ip.is_multicast or ip.is_reserved or ip.is_unspecified or ip.is_loopback
        )
    except ValueError:
        return False


def validate_url(value: str, *, allow_http=False) -> str:
    try:
        if any(ord(c) <= 32 or ord(c) == 127 for c in value) or "\\" in value:
            raise ValueError
        u = urlsplit(value)
        if (
            u.scheme not in (("http", "https") if allow_http else ("https",))
            or not u.hostname
            or u.username is not None
            or u.password is not None
            or u.fragment
        ):
            raise ValueError
        host = u.hostname.encode("idna").decode("ascii").lower()
        if "%" in host or host == "localhost" or host.endswith((".localhost", ".local")):
            raise ValueError
        try:
            ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            if not public_ip(host):
                raise ValueError
        port = u.port
        if port is not None and not 1 <= port <= 65535:
            raise ValueError
        netloc = f"[{host}]" if ":" in host else host
        if port:
            netloc += f":{port}"
        return urlunsplit(
            (
                u.scheme,
                netloc,
                quote(u.path or "/", safe="/%:@!$&'()*+,;=-._~"),
                quote(u.query, safe="%=&/?@!$'()*+,;:-._~"),
                "",
            )
        )
    except (ValueError, UnicodeError, TypeError):
        raise AssetError("UNSAFE_SUBSCRIPTION_URL") from None


def _remaining(deadline, limit=None):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise AssetError("FETCH_TIMEOUT")
    return min(remaining, limit) if limit is not None else remaining


class DeadlineStream(httpcore.NetworkStream):
    def __init__(self, stream, deadline):
        self.stream, self.deadline = stream, deadline

    def read(self, max_bytes, timeout=None):
        return self.stream.read(max_bytes, timeout=_remaining(self.deadline, timeout))

    def write(self, buffer, timeout=None):
        return self.stream.write(buffer, timeout=_remaining(self.deadline, timeout))

    def close(self):
        self.stream.close()

    def start_tls(self, ssl_context, server_hostname=None, timeout=None):
        return DeadlineStream(
            self.stream.start_tls(
                ssl_context,
                server_hostname=server_hostname,
                timeout=_remaining(self.deadline, timeout),
            ),
            self.deadline,
        )

    def get_extra_info(self, info):
        return self.stream.get_extra_info(info)


class SafeBackend(httpcore.SyncBackend):
    def __init__(self, deadline, resolver=None):
        self.deadline = deadline
        self.resolver = resolver or dns.resolver.Resolver()

    def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        try:
            ipaddress.ip_address(host)
            addresses = [host]
        except ValueError:
            try:
                answer = self.resolver.resolve_name(
                    host,
                    family=socket.AF_UNSPEC,
                    search=False,
                    lifetime=_remaining(self.deadline, 5),
                )
                addresses = list(answer.addresses())
            except dns.exception.DNSException:
                raise AssetError("FETCH_DNS_FAILED") from None
        if not addresses or not all(public_ip(ip) for ip in addresses):
            raise AssetError("UNSAFE_SUBSCRIPTION_TARGET")
        for ip in addresses:
            try:
                stream = super().connect_tcp(
                    ip,
                    port,
                    timeout=_remaining(self.deadline, timeout),
                    local_address=local_address,
                    socket_options=socket_options,
                )
                return DeadlineStream(stream, self.deadline)
            except (httpcore.ConnectError, httpcore.ConnectTimeout):
                continue
        raise AssetError("FETCH_CONNECT_FAILED")


def read_body(chunks, encoding: bytes, max_bytes: int) -> bytes:
    if encoding not in (b"", b"identity", b"gzip"):
        raise AssetError("UNSUPPORTED_CONTENT_ENCODING")
    decoder = zlib.decompressobj(16 + zlib.MAX_WBITS) if encoding == b"gzip" else None
    wire_size, body = 0, bytearray()
    try:
        for chunk in chunks:
            wire_size += len(chunk)
            if wire_size > max_bytes:
                raise AssetError("INPUT_TOO_LARGE")
            part = decoder.decompress(chunk, max_bytes - len(body) + 1) if decoder else chunk
            body.extend(part)
            if len(body) > max_bytes or decoder and decoder.unconsumed_tail:
                raise AssetError("INPUT_TOO_LARGE")
        if decoder and (not decoder.eof or decoder.unused_data):
            raise AssetError("INVALID_COMPRESSED_RESPONSE")
    except zlib.error:
        raise AssetError("INVALID_COMPRESSED_RESPONSE") from None
    return bytes(body)


class Fetcher:
    def __init__(
        self,
        *,
        max_bytes=10_485_760,
        timeout=30,
        max_redirects=3,
        pool_factory=None,
        allow_http=False,
        user_agent=DEFAULT_USER_AGENT,
    ):
        self.max_bytes, self.timeout, self.max_redirects = max_bytes, timeout, max_redirects
        self.pool_factory = pool_factory or self._pool
        self._metrics = ContextVar("nodema_fetch_metrics", default=None)
        self._deadline = ContextVar("nodema_fetch_deadline", default=None)
        self.allow_http = allow_http
        self.user_agent = user_agent
        self._metric_lock = Lock()

    @property
    def metrics(self):
        return self._metrics.get() or {}

    def reset_metrics(self):
        self._metrics.set({"source_requests": 0, "source_response_bytes": 0})

    @contextmanager
    def batch(self, timeout):
        """One deadline and cumulative metrics for an index and its references."""
        token = self._deadline.set(time.monotonic() + timeout)
        self.reset_metrics()
        try:
            yield
        finally:
            self._deadline.reset(token)

    @staticmethod
    def _pool(deadline):
        return httpcore.ConnectionPool(
            ssl_context=ssl.create_default_context(),
            network_backend=SafeBackend(deadline),
            max_connections=1,
            max_keepalive_connections=0,
            retries=0,
        )

    def fetch(self, url: str, *, user_agent=None) -> bytes:
        return self.fetch_meta(url, user_agent=user_agent)[0]

    def fetch_meta(self, url: str, *, user_agent=None) -> tuple[bytes, dict]:
        """Body plus a few bounded, non-credential metadata headers (airport usage)."""
        from app.ingestion.airport import KEPT_HEADERS, MAX_HEADER_LENGTH

        if self._deadline.get() is None:
            self.reset_metrics()
        metrics = self.metrics
        deadline = time.monotonic() + self.timeout
        if self._deadline.get() is not None:
            deadline = min(deadline, self._deadline.get())
        if user_agent is not None and (
            not isinstance(user_agent, str)
            or not 1 <= len(user_agent) <= 512
            or any(ord(c) < 32 or ord(c) > 126 for c in user_agent)
        ):
            raise AssetError("INVALID_SUBSCRIPTION_USER_AGENT")
        secure = False
        try:
            for hop in range(self.max_redirects + 1):
                url = validate_url(url, allow_http=self.allow_http and not secure)
                secure = urlsplit(url).scheme == "https"
                _remaining(deadline)
                with self.pool_factory(deadline) as pool:
                    with self._metric_lock:
                        metrics["source_requests"] += 1
                    with pool.stream(
                        "GET",
                        url,
                        headers={
                            "User-Agent": user_agent or self.user_agent,
                            "Accept-Encoding": "identity",
                        },
                        extensions={"timeout": {"connect": 5, "read": 10, "write": 5, "pool": 5}},
                    ) as response:
                        headers = {k.lower(): v for k, v in response.headers}
                        if response.status in (301, 302, 303, 307, 308):
                            if hop == self.max_redirects or b"location" not in headers:
                                raise AssetError("FETCH_REDIRECT_LIMIT")
                            url = urljoin(url, headers[b"location"].decode("ascii"))
                            continue
                        if not 200 <= response.status < 300:
                            raise AssetError("FETCH_HTTP_ERROR")

                        def measured_chunks():
                            for chunk in response.iter_stream():
                                with self._metric_lock:
                                    metrics["source_response_bytes"] += len(chunk)
                                yield chunk

                        body = read_body(
                            measured_chunks(),
                            headers.get(b"content-encoding", b"").lower(),
                            self.max_bytes,
                        )
                        _remaining(deadline)
                        kept = {}
                        for name in KEPT_HEADERS:
                            value = headers.get(name.encode())
                            if value is not None:
                                kept[name] = value[:MAX_HEADER_LENGTH].decode("latin-1")
                        return body, kept
            raise AssetError("FETCH_REDIRECT_LIMIT")
        except AssetError:
            raise
        except (httpcore.TimeoutException, TimeoutError):
            raise AssetError("FETCH_TIMEOUT") from None
        except (httpcore.NetworkError, httpcore.ProtocolError, ValueError, UnicodeError, OSError):
            raise AssetError("FETCH_FAILED") from None
