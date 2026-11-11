"""Resolve an ordinary subscription or a bounded Sub-Store reference graph."""

import base64
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from contextvars import copy_context
from dataclasses import dataclass, field
from threading import Lock
from urllib.parse import urlsplit

from app.domain import AssetError, InputFormat, ParseIssue, ParseReport
from app.ingestion.fetcher import validate_url
from app.parsers import parse_document
from app.parsers.substore import parse_substore_index
from app.security.crypto import canonical_json


@dataclass(repr=False)
class ResolvedSubscription:
    snapshot: bytes = field(repr=False)
    report: ParseReport | None = field(default=None, repr=False)


class SubscriptionResolver:
    def __init__(
        self,
        fetcher,
        *,
        max_bytes=10_485_760,
        max_items=200_000,
        max_total_items=200_000,
        max_fetches=256,
        max_depth=3,
        timeout=120,
    ):
        self.fetcher = fetcher
        self.max_bytes, self.max_items = max_bytes, max_items
        self.max_total_items = max_total_items
        self.max_fetches, self.max_depth, self.timeout = max_fetches, max_depth, timeout
        self.documents, self.failures = {}, {}
        self.requested, self.lock = set(), Lock()
        self.total_bytes = self.items = 0
        self.report = ParseReport()
        self.stats = {
            key: 0
            for key in (
                "indexes",
                "subscriptions",
                "local",
                "remote",
                "mixed",
                "processor_entries",
                "invalid_entries",
                "remote_references",
                "resolved_references",
                "failed_references",
            )
        }

    def _download(self, url, user_agent=None):
        url = validate_url(url, allow_http=True)
        key = (url, user_agent or "")
        with self.lock:
            if key in self.documents:
                return url, self.documents[key]
            if key in self.failures:
                raise AssetError(self.failures[key])
            if len(self.requested) >= self.max_fetches:
                raise AssetError("SUBSTORE_FETCH_LIMIT")
            if time.monotonic() >= self.deadline:
                raise AssetError("SUBSTORE_TIMEOUT")
            self.requested.add(key)
        try:
            payload = (
                self.fetcher.fetch(url, user_agent=user_agent)
                if user_agent
                else self.fetcher.fetch(url)
            )
        except AssetError as error:
            with self.lock:
                self.failures[key] = error.code
            raise
        with self.lock:
            self.total_bytes += len(payload)
            if self.total_bytes > self.max_bytes:
                raise AssetError("INPUT_TOO_LARGE")
            self.documents[key] = payload
        return url, payload

    def _prefetch(self, entries, depth, trail):
        if depth >= self.max_depth:
            return
        available = self.max_fetches - len(self.requested)
        if available <= 0:
            return
        targets = set()
        for entry in entries:
            if len(targets) >= available:
                break
            for value in entry.urls:
                if len(targets) >= available:
                    break
                try:
                    url = validate_url(value, allow_http=True)
                except AssetError:
                    continue  # The ordered resolver reports the entry's safe error.
                key = (url, entry.user_agent or "")
                if url not in trail and key not in self.requested:
                    targets.add(key)
        with ThreadPoolExecutor(max_workers=4) as pool:
            # Copy context separately per worker; batch deadline/metrics follow it.
            futures = [
                pool.submit(copy_context().run, self._download, url, ua or None)
                for url, ua in sorted(targets)
            ]
            for future in futures:
                try:
                    future.result()
                except AssetError as error:
                    if error.code == "INPUT_TOO_LARGE":
                        raise

    def _append(self, report):
        self.items += len(report.nodes) + len(report.issues) + report.ignored_count
        if self.items > self.max_total_items:
            raise AssetError("TOO_MANY_ITEMS")
        self.report.nodes.extend(report.nodes)
        self.report.issues.extend(report.issues)
        self.report.ignored_count += report.ignored_count

    @staticmethod
    def _required(url):
        return urlsplit(url).path.rstrip("/").endswith("/api/subs")

    def _content(self, payload, url, depth, trail):
        index = parse_substore_index(
            payload, required=self._required(url), max_items=self.max_items
        )
        if index is None:
            self._append(
                parse_document(payload, max_bytes=self.max_bytes, max_items=self.max_total_items)
            )
            return
        self.stats["indexes"] += 1
        self.stats["subscriptions"] += index.total_count
        self.stats["invalid_entries"] += len(index.issues)
        self.report.issues.extend(index.issues)
        self.items += len(index.issues) + len(index.entries)
        if self.items > self.max_total_items:
            raise AssetError("TOO_MANY_ITEMS")
        self._prefetch(index.entries, depth, trail)
        for entry in index.entries:
            mode = entry.mode if entry.mode in ("local", "remote") else "mixed"
            self.stats[mode] += 1
            self.stats["processor_entries"] += entry.processors
            parts = [("url", value) for value in entry.urls]
            if entry.content.strip():
                if entry.mode == "localFirst" or entry.mode == "local":
                    parts.insert(0, ("local", entry.content))
                else:
                    parts.append(("local", entry.content))
            for kind, value in parts:
                self.items += 1
                if self.items > self.max_total_items:
                    raise AssetError("TOO_MANY_ITEMS")
                try:
                    if kind == "local":
                        self._append(
                            parse_document(
                                value.encode(),
                                max_bytes=self.max_bytes,
                                max_items=self.max_total_items,
                            )
                        )
                    else:
                        self.stats["remote_references"] += 1
                        target = validate_url(value, allow_http=True)
                        if target in trail:
                            raise AssetError("SUBSTORE_REFERENCE_CYCLE")
                        if depth >= self.max_depth:
                            raise AssetError("SUBSTORE_DEPTH_LIMIT")
                        target, raw = self._download(target, entry.user_agent)
                        self._content(raw, target, depth + 1, trail | {target})
                        self.stats["resolved_references"] += 1
                except AssetError as error:
                    if error.code in ("INPUT_TOO_LARGE", "TOO_MANY_ITEMS"):
                        raise
                    self.report.issues.append(ParseIssue(error.code, entry.ordinal))
                    if kind == "url":
                        self.stats["failed_references"] += 1

    def resolve(self, url, format_hint=InputFormat.AUTO):
        self.deadline = time.monotonic() + self.timeout
        batch = (
            self.fetcher.batch(self.timeout) if hasattr(self.fetcher, "batch") else nullcontext()
        )
        with batch:
            url, payload = self._download(url)
            # Explicit regular formats retain their existing meaning.
            if format_hint != InputFormat.AUTO:
                return ResolvedSubscription(payload)
            index = parse_substore_index(
                payload, required=self._required(url), max_items=self.max_items
            )
            if index is None:
                return ResolvedSubscription(payload)
            self._content(payload, url, 0, {url})
        self.report.subscription_summary = {"kind": "substore", "raw_import": True, **self.stats}
        # Child bodies participate in the hash even when /api/subs is unchanged.
        # This internal snapshot is stored only with Source's existing encryption.
        snapshot = canonical_json(
            {
                "format": "nodema-resolved-substore-v1",
                "documents": [
                    {"url": key[0], "ua": key[1], "body": base64.b64encode(body).decode()}
                    for key, body in sorted(self.documents.items())
                ],
                "failures": [
                    {"url": key[0], "ua": key[1], "code": code}
                    for key, code in sorted(self.failures.items())
                ],
            }
        )
        return ResolvedSubscription(snapshot, self.report)
