"""Display-name templates. SQL nodema_render_name() is the production renderer;
this mirror validates templates and serves the optional local API."""

import string

from app.domain import AssetError

DEFAULT_TEMPLATE = "{FLAG}{ROUTE}|{OPERATOR} {SEQ}{VARIANT}"
LEGACY_TEMPLATE = (
    "{ENTRY_COUNTRY} → {EXIT_COUNTRY} | {PROTOCOL}-{TRANSPORT}-{SECURITY} | {SHORT_ID}"
)
FIELDS = {
    "ENTRY_COUNTRY",
    "EXIT_COUNTRY",
    "PROTOCOL",
    "TRANSPORT",
    "SECURITY",
    "SHORT_ID",
    "FLAG",
    "ENTRY_FLAG",
    "ROUTE",
    "ASN",
    "ORG",
    "OPERATOR",
    "SEQ",
    "VARIANT",
    "IPTYPE",
}
IP_TYPES = {"RESIDENTIAL": "家宽", "HOSTING": "机房", "MOBILE": "移动"}
UNKNOWN_FLAG = "🏳"


def flag(country: str | None) -> str:
    if not country or len(country) != 2 or not country.isascii() or not country.isalpha():
        return UNKNOWN_FLAG
    return "".join(chr(127397 + ord(c)) for c in country.upper())


def route(entry: str | None, exit_country: str | None) -> str:
    """HK->SG when entry and exit differ, a single code when they match."""
    if exit_country is None:
        return "?" if entry is None else f"{entry}->?"
    if entry is None or entry == exit_country:
        return exit_country
    return f"{entry}->{exit_country}"


def render_name(
    short_id: str,
    protocol: str,
    transport: str | None,
    security: str | None,
    template: str = DEFAULT_TEMPLATE,
    *,
    entry_country: str | None = None,
    exit_country: str | None = None,
    asn_label: str | None = None,
    org_label: str | None = None,
    seq: int | None = None,
    variant: str | None = None,
    ip_type: str | None = None,
) -> str:
    try:
        if len(template) > 200 or any(ord(c) < 32 for c in template):
            raise ValueError
        for _, field, spec, conversion in string.Formatter().parse(template):
            if field is not None and (field not in FIELDS or spec or conversion):
                raise ValueError
        result = template.format(
            ENTRY_COUNTRY=entry_country or "UNK",
            EXIT_COUNTRY=exit_country or "UNK",
            SHORT_ID=short_id,
            PROTOCOL=protocol.upper(),
            TRANSPORT=(transport or "UNK").upper(),
            SECURITY=(security or "UNK").upper(),
            FLAG=flag(exit_country),
            ENTRY_FLAG=flag(entry_country),
            ROUTE=route(entry_country, exit_country),
            ASN=asn_label or "Unknown",
            ORG=org_label or "",
            OPERATOR=f"{org_label}|{asn_label or 'Unknown'}"
            if org_label
            else asn_label or "Unknown",
            SEQ=short_id if seq is None else f"{seq:02d}",
            VARIANT=f" {variant}" if variant else "",
            IPTYPE=IP_TYPES.get(ip_type or "", ""),
        )
        if len(result) > 500:
            raise ValueError
        return result
    except (ValueError, KeyError, IndexError):
        raise AssetError("INVALID_NAME_TEMPLATE") from None
