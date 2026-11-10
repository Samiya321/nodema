"""Pure Sub-Store /api/subs manifest adapter; no fetches or processor execution."""

from dataclasses import dataclass, field

from app.domain import AssetError, ParseIssue
from app.parsers.core import _strict_json


@dataclass(repr=False)
class SubstoreEntry:
    ordinal: int
    mode: str
    content: str = field(repr=False)
    urls: list[str] = field(repr=False)
    user_agent: str | None = field(default=None, repr=False)
    processors: bool = False


@dataclass(repr=False)
class SubstoreIndex:
    entries: list[SubstoreEntry] = field(default_factory=list, repr=False)
    issues: list[ParseIssue] = field(default_factory=list)
    total_count: int = 0


def parse_substore_index(payload: bytes, *, required=False, max_items=10000):
    """Return None for an ordinary document; validate a success/data manifest."""
    if not payload.lstrip(b"\xef\xbb\xbf \r\n\t").startswith(b"{"):
        if required:
            raise AssetError("INVALID_SUBSTORE_RESPONSE")
        return None
    root = _strict_json(payload)
    if not isinstance(root, dict) or not {"status", "data"} <= root.keys():
        if required:
            raise AssetError("INVALID_SUBSTORE_RESPONSE")
        return None
    if root["status"] != "success":
        raise AssetError("SUBSTORE_API_ERROR")
    entries = root["data"]
    if isinstance(entries, dict):  # Older stores can use a name-keyed object.
        entries = list(entries.values())
    if not isinstance(entries, list):
        raise AssetError("INVALID_SUBSTORE_RESPONSE")
    if len(entries) > max_items:
        raise AssetError("TOO_MANY_ITEMS")
    if not entries:
        raise AssetError("EMPTY_SUBSTORE_INDEX")
    result = SubstoreIndex(total_count=len(entries))
    for ordinal, entry in enumerate(entries, 1):
        try:
            if not isinstance(entry, dict):
                raise AssetError("INVALID_SUBSTORE_ENTRY")
            source = entry.get("source", "remote")
            merge = entry.get("mergeSources")
            if source not in ("local", "remote"):
                raise AssetError("UNSUPPORTED_SUBSTORE_SOURCE")
            if merge not in (None, "", "none", "localFirst", "remoteFirst"):
                raise AssetError("UNSUPPORTED_SUBSTORE_MERGE")
            mixed = merge in ("localFirst", "remoteFirst")
            mode = merge if mixed else source
            content = entry.get("content", "") if mixed or source == "local" else ""
            remote = entry.get("url", "") if mixed or source != "local" else ""
            if not isinstance(content, str) or not isinstance(remote, str):
                raise AssetError("INVALID_SUBSTORE_ENTRY")
            urls = [url.strip() for url in remote.splitlines() if url.strip()]
            if (source != "local" or mixed) and not urls and not (mixed and content.strip()):
                raise AssetError("EMPTY_SUBSTORE_REMOTE")
            if source == "local" and not mixed and not content.strip():
                raise AssetError("EMPTY_SUBSTORE_LOCAL")
            user_agent = entry.get("ua") or None
            if user_agent is not None and (
                not isinstance(user_agent, str)
                or not 1 <= len(user_agent) <= 512
                or any(ord(c) < 32 or ord(c) > 126 for c in user_agent)
            ):
                raise AssetError("INVALID_SUBSCRIPTION_USER_AGENT")
            result.entries.append(
                SubstoreEntry(ordinal, mode, content, urls, user_agent, bool(entry.get("process")))
            )
        except AssetError as error:
            result.issues.append(ParseIssue(error.code, ordinal))
    return result
