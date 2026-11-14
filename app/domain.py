"""Internal secret-bearing objects; only explicit safe DTOs may leave the service layer."""

import hashlib
import re
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

PROTOCOLS = ("shadowsocks", "trojan", "anytls", "hysteria2", "vmess", "vless")
PASSWORD_PROTOCOLS = PROTOCOLS[:4]


def credential_key(identity: dict) -> str | None:
    """Same value as migration 0020's backfill: md5("uuid:"+lower(uuid)) for VLESS/VMess,
    md5("pw:"+password) otherwise; None without a credential."""
    if identity["protocol"] in PASSWORD_PROTOCOLS:
        prefix, value = "pw:", identity.get("password")
    else:
        prefix, value = "uuid:", (identity.get("uuid") or "").lower()
    return hashlib.md5((prefix + value).encode()).hexdigest() if value else None


class AssetError(Exception):
    """A fixed, credential-free error code. Never embed third-party exception text."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def field_label(names) -> str:
    """First of some field names, for diagnostics; odd names collapse to "other"."""
    name = sorted(str(n) for n in names)[0]
    return name if re.fullmatch(r"[A-Za-z0-9_.-]{1,40}", name) else "other"


class UnsupportedProtocol(AssetError):
    def __init__(self, protocol=None):
        super().__init__("UNSUPPORTED_PROTOCOL")
        named = isinstance(protocol, str) and protocol
        self.detail = field_label([protocol]) if named else "missing"


class Unsupported(AssetError):
    """RUNTIME_UNSUPPORTED plus which field made a node inexpressible. The reason is
    a fixed label or a field name (never a value), so it is safe in logs."""

    def __init__(self, reason: str = "unknown"):
        super().__init__("RUNTIME_UNSUPPORTED")
        self.reason = reason


class SourceType(StrEnum):
    SUBSCRIPTION_URL = "SUBSCRIPTION_URL"
    SINGLE_URI = "SINGLE_URI"
    UPLOADED_FILE = "UPLOADED_FILE"
    RAW_TEXT = "RAW_TEXT"


class InputFormat(StrEnum):
    AUTO = "AUTO"
    URI = "URI"
    BASE64 = "BASE64"
    CLASH = "CLASH"
    SINGBOX = "SINGBOX"


@dataclass(frozen=True, repr=False)
class NormalizedNode:
    identity: dict[str, Any] = field(repr=False)
    original_name: str = field(default="", repr=False)

    def __repr__(self) -> str:
        return "<NormalizedNode redacted>"


@dataclass(frozen=True)
class ParseIssue:
    code: str
    ordinal: int = 0
    detail: str | None = None  # e.g. the unsupported protocol's name (never a value)

    @classmethod
    def of(cls, error: AssetError, ordinal: int) -> "ParseIssue":
        return cls(error.code, ordinal, getattr(error, "detail", None))


def issue_dicts(issues) -> list[dict]:
    return [
        {"code": i.code, "ordinal": i.ordinal, **({"detail": i.detail} if i.detail else {})}
        for i in issues
    ]


def unsupported_protocols(issues) -> dict:
    """Counts of share-link/Clash protocol names this parser cannot read."""
    counts: dict = {}
    for i in issues:
        if i.code == "UNSUPPORTED_PROTOCOL" and i.detail:
            counts[i.detail] = counts.get(i.detail, 0) + 1
    return dict(sorted(counts.items(), key=lambda kv: -kv[1]))


@dataclass(repr=False)
class ParseReport:
    nodes: list[NormalizedNode] = field(default_factory=list, repr=False)
    issues: list[ParseIssue] = field(default_factory=list)
    ignored_count: int = 0
    subscription_summary: dict = field(default_factory=dict)

    @property
    def complete(self) -> bool:
        return not self.issues

    def summary(self) -> dict:
        result = {
            "valid": len(self.nodes),
            "ignored": self.ignored_count,
            "issue_count": len(self.issues),
            "issues": issue_dicts(self.issues[:100]),
        }
        protocols = unsupported_protocols(self.issues)
        if protocols:
            result["unsupported_protocols"] = protocols
        if self.subscription_summary:
            result["subscription"] = self.subscription_summary
        return result
