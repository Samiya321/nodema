"""Bounded URL lists; results refer to line numbers, never subscription credentials."""

from urllib.parse import urlsplit

from app.domain import AssetError
from app.ingestion.fetcher import validate_url

MAX_BULK_LINKS = 100
MAX_BULK_BYTES = 131072
MAX_URL_BYTES = 8192


def prepare_links(value, name_prefix="批量订阅"):
    if not isinstance(value, str):
        raise AssetError("INVALID_REQUEST")
    if len(value.encode()) > MAX_BULK_BYTES:
        raise AssetError("INPUT_TOO_LARGE")
    lines = [(i, line.strip()) for i, line in enumerate(value.split("\n"), 1) if line.strip()]
    if not lines:
        raise AssetError("EMPTY_INPUT")
    if len(lines) > MAX_BULK_LINKS:
        raise AssetError("TOO_MANY_SUBSCRIPTION_LINKS")
    if (
        not isinstance(name_prefix, str)
        or not 1 <= len(name_prefix.strip()) <= 60
        or "://" in name_prefix
        or any(ord(c) < 32 for c in name_prefix)
    ):
        raise AssetError("INVALID_SOURCE_LABEL")
    items = []
    for line, value in lines:
        item = {"line": line}
        try:
            if len(value.encode()) > MAX_URL_BYTES:
                raise AssetError("SUBSCRIPTION_URL_TOO_LONG")
            url = validate_url(value, allow_http=True)
            parsed = urlsplit(url)
            if (parsed.scheme, parsed.port) in (("https", 443), ("http", 80)):
                host = f"[{parsed.hostname}]" if ":" in parsed.hostname else parsed.hostname
                url = parsed._replace(netloc=host).geturl()
            item.update(url=url, name=f"{name_prefix.strip()} {line:03d}")
        except AssetError as error:
            item.update(status="INVALID", error_code=error.code)
        items.append(item)
    return items


def bulk_result(items):
    return {
        "created": sum(i["status"] == "CREATED" for i in items),
        "duplicates": sum(i["status"] == "DUPLICATE" for i in items),
        "invalid": sum(i["status"] == "INVALID" for i in items),
        "items": [{k: v for k, v in item.items() if k != "url"} for item in items],
    }
