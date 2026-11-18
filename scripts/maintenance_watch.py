"""Independent production signal and bounded recovery. Emit only fixed check names."""

import json
import os
import subprocess
import sys
from datetime import UTC, datetime, time, timedelta
from time import sleep
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

REPO = os.environ.get("GITHUB_REPOSITORY", "")
BRANCH = os.environ.get("NODEMA_TRUSTED_BRANCH", "")
ISSUE_MARKER = "<!-- nodema-maintenance-watch:v1 -->"
ISSUE_TITLE = "Nodema 生产巡检需要处理"
RETRY_PREFIX = "Maintenance retry · "
ACTIVE = {"queued", "in_progress", "waiting", "requested", "pending"}
ESCALATED = {
    "daily": "日检补跑后仍未完成",
    "probe": "接入测量补跑后仍无结果",
    "backup": "备份补跑后仍没有新产物",
}
DISPATCH_FAILED = {
    "daily": "无法自动派发日检",
    "probe": "无法自动派发接入测量",
    "backup": "无法自动派发备份",
}
WORKFLOWS = {"daily": "daily-check.yml", "probe": "entry-probe.yml", "backup": "backup.yml"}
BEIJING = ZoneInfo("Asia/Shanghai")


def gh(method, route, fields=None):
    cmd = ["gh", "api", f"repos/{REPO}/{route}", "-X", method]
    if fields is not None:
        cmd.extend(["--input", "-"])
    result = subprocess.run(
        cmd,
        input=json.dumps(fields).encode() if fields is not None else None,
        capture_output=True,
        timeout=20,
        check=True,
    )
    return json.loads(result.stdout) if result.stdout else None


def timestamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None


def older(value, now, **interval):
    return not value or now - timestamp(value) > timedelta(**interval)


def heartbeat():
    request = Request(
        os.environ["NODEMA_HEARTBEAT_URL"],
        headers={
            "Authorization": f"Bearer {os.environ['MONITOR_TOKEN']}",
            "Accept": "application/json",
            "User-Agent": "nodema-maintenance-watch/1.0",
        },
    )
    for attempt in range(3):
        try:
            with urlopen(request, timeout=15) as response:
                state = json.load(response)
                print("Heartbeat confirmed.")
                return state
        except HTTPError as error:
            print(f"Heartbeat HTTP {error.code}.")
            if error.code < 500 and error.code not in (408, 429):
                return None
        except (OSError, ValueError) as error:
            print(f"Heartbeat unavailable ({type(error).__name__}).")
        if attempt < 2:
            sleep(3 * (attempt + 1))
    return None


def workflow_runs(workflow, size=12):
    return gh("GET", f"actions/workflows/{workflow}/runs?branch={BRANCH}&per_page={size}")[
        "workflow_runs"
    ]


def backup_timestamp(runs, now):
    for run in runs:
        if run["conclusion"] != "success" or older(run["created_at"], now, days=7):
            continue
        payload = gh("GET", f"actions/runs/{run['id']}/artifacts?per_page=5")
        for artifact in payload["artifacts"]:
            if artifact["name"] == f"encrypted-database-{run['id']}" and not artifact["expired"]:
                return artifact["created_at"]
    return None


def inspect(state, backups, drills, now, skip_until=""):
    issues, repairs = set(), {}
    if not skip_until or now.date().isoformat() >= skip_until:
        if older(backup_timestamp(backups, now), now, hours=36):
            repairs["backup"] = {}
    drill = next((run for run in drills if run["status"] == "completed"), None)
    if not (drills and drills[0]["status"] in ACTIVE) and (
        not drill or drill["conclusion"] != "success" or older(drill["updated_at"], now, days=38)
    ):
        issues.add("恢复演练未通过或过期")
    if not state:
        issues.add("生产页面或 PostgreSQL 不可达")
        return issues, repairs
    local = now.astimezone(BEIJING)
    expected = local.date() - timedelta(days=local.time() < time(6, 45))
    last = state["last_daily"]
    due = state["daily_enabled"] and (
        not last
        or last["scan_date"] < expected.isoformat()
        or (last["status"] != "COMPLETED" and older(last["started_at"], now, hours=2, minutes=28))
    )
    if due:
        repairs["daily"] = (
            {"run_id": last["id"]}
            if last
            and last["scan_date"] >= expected.isoformat()
            and last["status"] != "COMPLETED"
            and not last["archived_at"]
            else {"trigger": "schedule"}
        )
    elif older(state["queued_scan_at"], now, minutes=45) and state["queued_scan_at"]:
        repairs["daily"] = {"trigger": "schedule"}
    probe = state["probe"]
    if state["probe_enabled"]:
        if (
            not probe
            or older(probe["started_at"], now, hours=3)
            or older(probe["finished_at"], now, hours=3)
        ):
            repairs["probe"] = {}
        elif probe["error_code"] and state["recent_probe_errors"] >= 2:
            issues.add("接入测量服务异常")
    host = state["host"]
    if not host or older(host["taken_at"], now, minutes=30):
        issues.add("主机容量样本已过期")
    else:
        if host["disk_free"] * 5 < host["disk_total"]:
            issues.add("PostgreSQL 磁盘剩余不到 20%")
        if host["mem_available"] * 20 < host["mem_total"]:
            issues.add("主机可用内存不到 5%")
        if timestamp(host["tls_expires_at"]) < now + timedelta(days=30):
            issues.add("PostgreSQL TLS 证书将在 30 天内到期")
    if state["exports"]["unavailable"]:
        issues.add("有生效中的订阅构建超时")
    return issues, repairs


def repair_decision(runs, job, now):
    if any(run["status"] in ACTIVE for run in runs):
        return "waiting"
    previous = next((run for run in runs if run["display_title"] == RETRY_PREFIX + job), None)
    # One attempt per rolling incident window, with time for dispatched runs to appear.
    if previous and not older(previous["created_at"], now, hours=24):
        return "waiting" if not older(previous["created_at"], now, hours=2) else "escalate"
    return "dispatch"


def issue_body(issues):
    checks = "\n".join("- " + issue for issue in sorted(issues))
    return (
        f"{ISSUE_MARKER}\n独立巡检发现以下情况需要检查。\n\n{checks}\n\n"
        "[打开 Nodema 总览](https://nodema-dashboard.pages.dev/#/overview) · "
        f"[本次巡检](https://github.com/{REPO}/actions/runs/{os.environ['GITHUB_RUN_ID']})"
    )


def open_incident():
    recent = gh("GET", "issues?creator=github-actions%5Bbot%5D&state=open&per_page=100")
    return next(
        (
            item
            for item in recent
            if item["title"] == ISSUE_TITLE and item.get("body", "").startswith(ISSUE_MARKER)
        ),
        None,
    )


def publish(issues, existing):
    if issues and not existing:
        gh(
            "POST",
            "issues",
            {"title": ISSUE_TITLE, "body": issue_body(issues), "assignees": [REPO.split("/")[0]]},
        )
    elif issues and existing:
        body = issue_body(issues)
        # The run link changes every hour. Compare the check list, so repeated failures stay quiet.
        if existing["body"].split("[打开 Nodema 总览]")[0] != body.split("[打开 Nodema 总览]")[0]:
            gh("PATCH", f"issues/{existing['number']}", {"body": body})
    elif existing and not issues:
        gh(
            "PATCH",
            f"issues/{existing['number']}",
            {"state": "closed", "state_reason": "completed"},
        )
        gh("POST", f"issues/{existing['number']}/comments", {"body": "上述巡检项目已恢复。"})


def main():
    now = datetime.now(UTC)
    apply = os.environ.get("ENABLE_RECOVERY") == "true"
    backups = workflow_runs(WORKFLOWS["backup"])
    state = heartbeat()
    issues, repairs = inspect(
        state,
        backups,
        workflow_runs("restore-drill.yml"),
        now,
        os.environ.get("BACKUP_SKIP_UNTIL", ""),
    )
    incident = open_incident() if apply else None
    reported = incident["body"] if incident else ""
    messages = []
    waiting = False
    for job, inputs in repairs.items():
        workflow = WORKFLOWS[job]
        runs = backups if job == "backup" else workflow_runs(workflow, 50)
        previous_alert = next(
            (code for code in (ESCALATED[job], DISPATCH_FAILED[job]) if f"- {code}\n" in reported),
            None,
        )
        last = state.get("last_daily") if state else None
        leased = job == "daily" and last and last["lease_active"]
        if previous_alert:
            decision = "escalate"
        elif leased:
            decision = "waiting"
        else:
            decision = repair_decision(runs, job, now)
        messages.append(f"- {job}: {decision}")
        if decision == "escalate":
            issues.add(previous_alert or ESCALATED[job])
        elif decision == "dispatch" and apply:
            try:
                gh(
                    "POST",
                    f"actions/workflows/{workflow}/dispatches",
                    {
                        "ref": BRANCH,
                        "inputs": {**inputs, "monitor_retry": "true"},
                    },
                )
            except subprocess.CalledProcessError:
                issues.add(DISPATCH_FAILED[job])
            else:
                waiting = True
        elif decision == "waiting":
            waiting = True
    if apply and (issues or not waiting):
        publish(issues, incident)
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
        summary.write(
            "\n".join(
                [
                    f"Checks requiring attention: {len(issues)}",
                    *(f"- {issue}" for issue in sorted(issues)),
                    *messages,
                ]
            )
            + "\n"
        )


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        print("Production maintenance watch could not complete its checks.", file=sys.stderr)
        sys.exit(1)
