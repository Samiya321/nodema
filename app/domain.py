"""Internal secret-bearing objects; only explicit safe DTOs may leave the service layer."""

import hashlib
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
            "issues": [{"code": i.code, "ordinal": i.ordinal} for i in self.issues[:100]],
        }
        if self.subscription_summary:
            result["subscription"] = self.subscription_summary
        return result
