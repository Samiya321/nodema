"""Read trusted completed Actions attempts, storing timestamps/counts only."""

import re
from datetime import UTC, datetime

import httpcore
from sqlalchemy.dialects.postgresql import insert

from app.database.models import ActionRun
from app.domain import AssetError
from app.ingestion.fetcher import read_body
from app.parsers.core import _strict_json

WORKFLOWS = {
    ".github/workflows/daily-check.yml": "daily-check",
    ".github/workflows/source-sync.yml": "source-sync",
    ".github/workflows/backup.yml": "backup",
    ".github/workflows/export-build.yml": "export-build",
}
CONCLUSIONS = {
    "success",
    "failure",
    "cancelled",
    "skipped",
    "neutral",
    "timed_out",
    "action_required",
    "startup_failure",
    "stale",
}


def timestamp(value):
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if result.tzinfo is None:
            raise ValueError
        return result.astimezone(UTC)
    except (ValueError, TypeError, AttributeError):
        raise AssetError("INVALID_ACTIONS_RESPONSE") from None


def collect_actions(
    sessions, repository, token, run_id, attempt, *, trusted_branch="main", get=None
):
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", repository) or not token:
        raise AssetError("ACTIONS_CONFIGURATION_REQUIRED")
    if (
        type(run_id) is not int
        or not 0 < run_id < 2**63
        or type(attempt) is not int
        or not 0 < attempt <= 10000
    ):
        raise AssetError("INVALID_ACTIONS_RUN")

    def request(suffix):
        try:
            with (
                httpcore.ConnectionPool() as pool,
                pool.stream(
                    "GET",
                    f"https://api.github.com/repos/{repository}/actions/runs/{run_id}/attempts/{attempt}"
                    + suffix,
                    headers={
                        "Authorization": "Bearer " + token,
                        "Accept": "application/vnd.github+json",
                        "User-Agent": "nodema-usage",
                        "X-GitHub-Api-Version": "2026-03-10",
                    },
                    extensions={"timeout": {"connect": 5, "read": 10, "write": 5, "pool": 5}},
                ) as response,
            ):
                if response.status != 200:
                    raise AssetError("ACTIONS_USAGE_FETCH_FAILED")
                value = _strict_json(read_body(response.iter_stream(), b"", 2097152))
                if not isinstance(value, dict):
                    raise AssetError("INVALID_ACTIONS_RESPONSE")
                return value
        except AssetError:
            raise
        except Exception:
            raise AssetError("ACTIONS_USAGE_FETCH_FAILED") from None

    fetch = get or request
    run = fetch("")
    if not isinstance(run, dict):
        raise AssetError("INVALID_ACTIONS_RESPONSE")
    if (
        run.get("id") != run_id
        or run.get("run_attempt") != attempt
        or not isinstance(run.get("repository"), dict)
        or run["repository"].get("full_name") != repository
        or not isinstance(run.get("head_repository"), dict)
        or run["head_repository"].get("full_name") != repository
        or run.get("head_branch") != trusted_branch
        or run.get("event") not in ("schedule", "workflow_dispatch")
        or run.get("path") not in WORKFLOWS
    ):
        raise AssetError("UNTRUSTED_ACTIONS_RUN")
    if run.get("status") != "completed" or run.get("conclusion") not in CONCLUSIONS:
        raise AssetError("ACTIONS_RUN_NOT_COMPLETE")
    jobs = []
    for page in range(1, 31):
        response = fetch(f"/jobs?per_page=100&page={page}")
        if not isinstance(response, dict):
            raise AssetError("INVALID_ACTIONS_RESPONSE")
        values = response.get("jobs")
        if not isinstance(values, list) or len(values) > 100:
            raise AssetError("INVALID_ACTIONS_RESPONSE")
        jobs.extend(values)
        if len(values) < 100:
            break
    else:
        raise AssetError("ACTIONS_JOB_LIMIT")
    started = timestamp(run.get("run_started_at") or run.get("created_at"))
    finished = timestamp(run.get("updated_at"))
    runner_ms = failed = unknown = 0
    seen = set()
    for job in jobs:
        if (
            not isinstance(job, dict)
            or type(job.get("id")) is not int
            or job["id"] in seen
            or job.get("run_id") != run_id
        ):
            raise AssetError("INVALID_ACTIONS_RESPONSE")
        seen.add(job["id"])
        conclusion = job.get("conclusion")
        if conclusion not in CONCLUSIONS:
            raise AssetError("ACTIONS_RUN_NOT_COMPLETE")
        failed += int(conclusion not in ("success", "skipped", "neutral"))
        if job.get("started_at") and job.get("completed_at"):
            first, last = timestamp(job["started_at"]), timestamp(job["completed_at"])
            if last < first:
                raise AssetError("INVALID_ACTIONS_RESPONSE")
            runner_ms += round((last - first).total_seconds() * 1000)
        elif conclusion != "skipped":
            unknown += 1
    if finished < started:
        raise AssetError("INVALID_ACTIONS_RESPONSE")
    values = {
        "run_id": run_id,
        "attempt": attempt,
        "workflow": WORKFLOWS[run["path"]],
        "conclusion": run["conclusion"],
        "started_at": started,
        "finished_at": finished,
        "runner_ms": runner_ms,
        "job_count": len(jobs),
        "failed_jobs": failed,
        "unmeasured_jobs": unknown,
    }
    with sessions.begin() as session:
        statement = insert(ActionRun).values(values)
        session.execute(
            statement.on_conflict_do_update(
                index_elements=[ActionRun.run_id, ActionRun.attempt],
                set_={k: statement.excluded[k] for k in values if k not in ("run_id", "attempt")},
            )
        )
    return values
