"""Airport ("机场") subscription metadata from response headers.

Panels and Sub-Store report usage with ``subscription-userinfo: upload=..; download=..;
total=..; expire=<unix seconds>`` and often name themselves via ``profile-title`` or
``content-disposition``. Only these bounded, non-credential headers are kept.
"""

import base64
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import unquote, urlsplit

KEPT_HEADERS = (
    "subscription-userinfo",
    "profile-title",
    "profile-web-page-url",
    "content-disposition",
)
MAX_HEADER_LENGTH = 1024
_NUMBER = r"\s*=\s*(-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)"
_FIELDS = {
    key: re.compile(rf"(?:^|[;,\s]){key}{_NUMBER}", re.I)
    for key in (
        "upload",
        "download",
        "total",
        "expire",
    )
}
# Airports add pseudo "nodes" that only carry account notices (traffic, expiry, website).
INFO_NODE = re.compile(
    r"(剩余流量|流量剩余|已用流量|套餐到期|到期时间|过期时间|有效期|距离下次重置|重置剩余|下次重置"
    r"|官网|官方网址|最新网址|备用网址|网址导航|客服|售后|公告|"
    r"traffic\s*[:：]|expire[sd]?\s*[:：]|remaining\s*[:：]|reset\s*[:：])",
    re.I,
)


@dataclass(frozen=True)
class AirportInfo:
    upload: int | None
    download: int | None
    total: int | None
    expires_at: datetime | None
    title: str | None
    website: str | None

    @property
    def match_key(self):
        if self.title:
            return "title:" + self.title.casefold()
        if self.website:
            return "site:" + (urlsplit(self.website).hostname or "")
        return None


def _clean_label(value):
    if not isinstance(value, str):
        return None
    value = " ".join(value.split()).strip()
    if not value or "://" in value or not value.isprintable():
        return None
    return value[:80]


def _title(headers):
    raw = headers.get("profile-title")
    if raw:
        if raw.lower().startswith("base64:"):
            try:
                raw = base64.b64decode(raw[7:], validate=True).decode("utf-8")
            except (ValueError, UnicodeError):
                raw = None
        title = _clean_label(raw)
        if title:
            return title
    disposition = headers.get("content-disposition") or ""
    match = re.search(r"filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)", disposition)
    if match:
        try:
            return _clean_label(unquote(match.group(1), errors="strict"))
        except UnicodeError:
            return None
    match = re.search(r'filename\s*=\s*"([^"]+)"', disposition)
    return _clean_label(match.group(1)) if match else None


def _website(headers):
    raw = (headers.get("profile-web-page-url") or "").strip()
    try:
        parts = urlsplit(raw)
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or not parts.hostname or len(raw) > 300:
        return None
    if parts.username or parts.password:
        return None
    # Keep only the site origin; paths of panel URLs can embed account tokens.
    return f"{parts.scheme}://{parts.hostname}" + (f":{parts.port}" if parts.port else "")


def _number(text, key):
    match = _FIELDS[key].search(text)
    if not match:
        return None
    try:
        value = float(match.group(1))
    except ValueError:
        return None
    if value != value or value in (float("inf"), float("-inf")):
        return None
    return max(0, min(int(value), 2**62))


def parse_airport_headers(headers) -> AirportInfo | None:
    """Return airport metadata, or None when the response carries no usage header."""
    headers = {k.lower(): v for k, v in (headers or {}).items() if isinstance(v, str)}
    usage = headers.get("subscription-userinfo", "")[:MAX_HEADER_LENGTH]
    upload, download, total = (_number(usage, key) for key in ("upload", "download", "total"))
    if upload is None and download is None and total is None:
        return None
    expire = _number(usage, "expire")
    expires_at = None
    if expire:
        if expire > 10**11:  # some panels send milliseconds
            expire //= 1000
        try:
            expires_at = datetime.fromtimestamp(expire, UTC)
        except (OverflowError, OSError, ValueError):
            expires_at = None
    return AirportInfo(upload, download, total, expires_at, _title(headers), _website(headers))


def is_info_node(name) -> bool:
    return isinstance(name, str) and bool(INFO_NODE.search(name))
