import string

from app.domain import AssetError

DEFAULT_TEMPLATE = (
    "{ENTRY_COUNTRY} → {EXIT_COUNTRY} | {PROTOCOL}-{TRANSPORT}-{SECURITY} | {SHORT_ID}"
)
FIELDS = {"ENTRY_COUNTRY", "EXIT_COUNTRY", "PROTOCOL", "TRANSPORT", "SECURITY", "SHORT_ID"}


def render_name(
    short_id: str,
    protocol: str,
    transport: str | None,
    security: str | None,
    template: str = DEFAULT_TEMPLATE,
    *,
    entry_country: str | None = None,
    exit_country: str | None = None,
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
        )
        if len(result) > 500:
            raise ValueError
        return result
    except (ValueError, KeyError, IndexError):
        raise AssetError("INVALID_NAME_TEMPLATE") from None
