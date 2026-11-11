"""Sub-Store indexes become parents of ordinary child sources.

A Sub-Store API can disappear while the remote subscriptions and local node lists it
pointed to keep working. Each entry is therefore materialized once as its own Source
(remote URL -> SUBSCRIPTION_URL child, local content -> RAW_TEXT child) that syncs and
fails independently. Later index fetches only add children or refresh non-empty local
content; nothing is deleted or overwritten with emptiness when an entry disappears.
"""

import hashlib
from datetime import datetime
from uuid import uuid4

import sqlalchemy as sa

from app.database.models import NodeSource, Provider, Source
from app.domain import AssetError, InputFormat, SourceType
from app.ingestion.fetcher import validate_url

MAX_DEPTH = 3


def _key(kind, value):
    return kind + ":" + hashlib.sha256(value.encode()).hexdigest()[:24]


def _label(value, fallback):
    text = " ".join(str(value or "").split())
    if not text or "://" in text or not text.isprintable():
        text = fallback
    return text[:60]


def _depth(session, source):
    depth, parent = 0, source.parent_source_id
    while parent is not None and depth <= MAX_DEPTH:
        depth += 1
        parent = session.scalar(sa.select(Source.parent_source_id).where(Source.id == parent))
    return depth


def materialize(session, parent, index, now: datetime, sync_interval: int):
    """Create/refresh children for one parsed index; returns a credential-free summary."""
    if _depth(session, parent) >= MAX_DEPTH:
        raise AssetError("SUBSTORE_DEPTH_LIMIT")
    children = {
        child.origin_key: child
        for child in session.scalars(
            sa.select(Source).where(
                Source.parent_source_id == parent.id, Source.deleted_at.is_(None)
            )
        )
    }
    wanted = set()
    summary = {"created": 0, "updated": 0, "unchanged": 0, "shared": 0, "duplicates": 0}
    for entry in index.entries:
        label = _label(entry.name, f"#{entry.ordinal}")
        parts = []
        for number, url in enumerate(entry.urls, 1):
            try:
                url = validate_url(url, allow_http=True)
            except AssetError:
                continue  # reported via index issues by the parser/resolver contract
            suffix = f" #{number}" if len(entry.urls) > 1 else ""
            parts.append((_key("remote", url), SourceType.SUBSCRIPTION_URL, url, label + suffix))
        if entry.content.strip():
            # Same-named local lists in one index stay separate: the first keeps the
            # plain key (existing children), later ones get "#2", "#3", ...
            key, repeat = _key("local", label), 1
            while key in wanted:
                repeat += 1
                key = _key("local", f"{label}#{repeat}")
            suffix = f" #{repeat}" if repeat > 1 else ""
            parts.append((key, SourceType.RAW_TEXT, entry.content, label + suffix + " · 本地"))
        for origin, kind, value, child_label in parts:
            if origin in wanted:
                # The same remote subscription listed twice in one index: one child.
                summary["duplicates"] += 1
                continue
            wanted.add(origin)
            data = value.encode()
            child = children.get(origin)
            if child is None and kind == SourceType.SUBSCRIPTION_URL:
                shared = session.scalar(
                    sa.select(Source.id).where(
                        Source.deleted_at.is_(None),
                        Source.type == SourceType.SUBSCRIPTION_URL.value,
                        Source.url_data == data,
                    )
                )
                if shared is not None:
                    summary["shared"] += 1  # already imported directly; keep that source
                    continue
            if child is None:
                session.add(
                    Source(
                        id=uuid4(),
                        name=f"{parent.name[:18]} · {child_label}"[:80],
                        type=kind.value,
                        format_hint=InputFormat.AUTO.value,
                        url_data=data if kind == SourceType.SUBSCRIPTION_URL else None,
                        payload_data=data if kind == SourceType.RAW_TEXT else None,
                        parent_source_id=parent.id,
                        origin_key=origin,
                        origin_label=child_label,
                        user_agent=entry.user_agent,
                        sync_interval_seconds=sync_interval,
                        sync_requested_at=now,
                    )
                )
                summary["created"] += 1
                continue
            changed = False
            if kind == SourceType.SUBSCRIPTION_URL and child.user_agent != entry.user_agent:
                child.user_agent, changed = entry.user_agent, True
            if kind == SourceType.RAW_TEXT and bytes(child.payload_data or b"") != data:
                child.payload_data, child.content_hash, changed = data, None, True
            if changed:
                child.sync_requested_at = child.updated_at = now
                child.revision += 1
                summary["updated"] += 1
            else:
                summary["unchanged"] += 1
    summary["missing_from_index"] = sorted(
        str(child.id) for origin, child in children.items() if origin not in wanted
    )
    summary["entries"] = len(index.entries)
    # Nodes imported before materialization stay linked for history, attributed to children.
    session.execute(
        sa.update(NodeSource)
        .where(NodeSource.source_id == parent.id, NodeSource.is_present.is_(True))
        .values(is_present=False)
    )
    return summary


def assign_provider(session, source, info, url_host, now):
    """Group airport links by profile title / website, else by subscription host."""
    if source.provider_id is not None:
        provider = session.get(Provider, source.provider_id)
        if provider is not None and info.website and not provider.website:
            provider.website, provider.updated_at = info.website, now
        return
    key = info.match_key or ("host:" + url_host if url_host else None)
    if key is None:
        return
    provider = session.scalar(sa.select(Provider).where(Provider.match_key == key))
    if provider is None:
        provider = Provider(
            id=uuid4(),
            name=(info.title or url_host or "机场")[:80],
            match_key=key,
            website=info.website,
        )
        session.add(provider)
        session.flush()
    source.provider_id = provider.id


def apply_airport(session, source, info, url_host, now):
    source.detected_kind = "AIRPORT"
    source.traffic_upload, source.traffic_download = info.upload, info.download
    source.traffic_total, source.expires_at = info.total, info.expires_at
    source.userinfo_at = now
    if info.title:
        source.profile_title = info.title
    if info.website:
        source.profile_url = info.website
    assign_provider(session, source, info, url_host, now)
