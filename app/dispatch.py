import json
from uuid import UUID

import httpcore

from app.domain import AssetError


def dispatch_scan(settings, run_id: UUID):
    token = settings.github_dispatch_token.get_secret_value()
    if not settings.github_repository or not token:
        return {"dispatched": False, "reason": "DISPATCH_NOT_CONFIGURED"}
    try:
        with httpcore.ConnectionPool() as pool:
            response = pool.request(
                "POST",
                "https://api.github.com/repos/"
                + settings.github_repository
                + "/actions/workflows/daily-check.yml/dispatches",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/vnd.github+json",
                    "Content-Type": "application/json",
                    "User-Agent": "nodema",
                },
                content=json.dumps(
                    {"ref": settings.github_workflow_ref, "inputs": {"run_id": str(run_id)}}
                ).encode(),
                extensions={"timeout": {"connect": 5, "read": 10, "write": 5, "pool": 5}},
            )
        if response.status != 204:
            raise AssetError("DISPATCH_FAILED")
        return {"dispatched": True}
    except (httpcore.NetworkError, httpcore.TimeoutException, httpcore.ProtocolError):
        raise AssetError("DISPATCH_FAILED") from None


def dispatch_export_build(settings):
    """A persisted request survives a missing token or temporary dispatch failure."""
    token = settings.github_dispatch_token.get_secret_value()
    if not settings.github_repository or not token:
        return {"status": "PENDING", "dispatched": False, "reason": "DISPATCH_NOT_CONFIGURED"}
    try:
        with httpcore.ConnectionPool() as pool:
            response = pool.request(
                "POST",
                "https://api.github.com/repos/"
                + settings.github_repository
                + "/actions/workflows/export-build.yml/dispatches",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/vnd.github+json",
                    "Content-Type": "application/json",
                    "User-Agent": "nodema",
                },
                content=json.dumps({"ref": settings.github_workflow_ref}).encode(),
                extensions={"timeout": {"connect": 5, "read": 10, "write": 5, "pool": 5}},
            )
        if response.status == 204:
            return {"status": "QUEUED", "dispatched": True}
    except (httpcore.NetworkError, httpcore.TimeoutException, httpcore.ProtocolError):
        pass
    return {"status": "PENDING", "dispatched": False, "reason": "DISPATCH_FAILED"}
