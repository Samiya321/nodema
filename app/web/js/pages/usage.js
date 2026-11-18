import { api, badge, bytes, date, empty, h, meter, pct, select, table } from "../core.js";

// Neon bills transfer in decimal units (5 GB = 5,000,000,000 bytes).
const gb = (value) => (value / 1e9).toFixed(2) + " GB";
const KINDS = { CHECK: "检测", SOURCE: "来源同步", SUBSCRIPTION: "订阅下载", JOB: "任务采样" };
const WORKFLOWS = {
  "daily-check": "检测节点",
  "source-sync": "同步来源",
  "export-build": "生成订阅",
  backup: "数据库备份",
  "entry-probe": "接入测量",
};
const CONCLUSIONS = { success: "SUCCESS", failure: "FAILED", cancelled: "CANCELLED", timed_out: "FAILED" };
const ROWS = 10; // long tables show their latest rows; the rest on request
const num = (value) => (value == null ? "—" : Number(value).toLocaleString("zh-CN"));
const DAY = 86400000;

// Rows beyond ROWS stay hidden behind one button.
function capped(columns, rows, options) {
  const element = table(columns, rows.slice(0, ROWS), options);
  if (rows.length <= ROWS) return element;
  const more = h("button", { type: "button", class: "quiet table-more" }, `显示全部 ${rows.length} 条`);
  const box = h("div", { class: "stack tight" }, element, more);
  more.addEventListener("click", () => box.replaceChildren(table(columns, rows, options)));
  return box;
}

// When the current pace would use the month's transfer up: from readings in this period
// at least 12 hours apart (Neon updates its counter in steps, shorter spans mislead).
export function projection(samples, transfer, now = Date.now()) {
  if (!transfer?.transfer_period_end || !transfer.transfer_limit_bytes) return null;
  const end = new Date(transfer.transfer_period_end).getTime();
  const readings = samples
    .filter((s) => s.transfer_bytes != null && s.transfer_period_end && new Date(s.transfer_period_end).getTime() === end)
    .map((s) => ({ at: new Date(s.taken_at).getTime(), used: Number(s.transfer_bytes) }))
    .filter((r) => now - r.at <= 7 * DAY)
    .sort((a, b) => a.at - b.at);
  if (readings.length < 2) return null;
  const first = readings[0], last = readings[readings.length - 1];
  const span = last.at - first.at;
  if (span < DAY / 2 || last.used <= first.used) return null;
  const perDay = ((last.used - first.used) / span) * DAY;
  const left = Number(transfer.transfer_limit_bytes) - last.used;
  const runsOut = last.at + (left / perDay) * DAY;
  return { perDay, runsOut, enough: runsOut >= end, spanDays: span / DAY };
}

export async function render(root, { params, go }) {
  const days = params.get("days") || "30";
  const [data, probe] = await Promise.all([
    api("/usage?days=" + encodeURIComponent(days)),
    api("/probe-status").catch(() => null),
  ]);
  const t = data.totals;
  const range = select("days", [["7", "近 7 天"], ["30", "近 30 天"], ["90", "近 90 天"], ["365", "近 365 天"]], days, "用量时间范围");
  range.addEventListener("change", () => go("usage", new URLSearchParams({ days: range.value })));
  const stats = [
    ["Actions 分钟", num(Math.round(Number(data.runner_minutes)))],
    ["节点检测", num(data.health.attempts), "完整检测的次数"],
    ["平均每次", data.health.mean_check_ms == null ? "—" : (data.health.mean_check_ms / 1000).toFixed(1) + " 秒"],
    ["超时占比", pct(data.health.timeout_ratio)],
    ["任务失败率", pct(data.executions.failure_ratio)],
    ["跳过", num(Number(t.preflight_skips) + Number(t.cooldown_skips)), `入口连不上 ${num(t.preflight_skips)} 次，连续失败冷却中 ${num(t.cooldown_skips)} 次`],
    ...(probe ? [["接入测量", num(probe.tests_7d), `Globalping 近 7 天测试次数；今天 ${num(probe.tests_today)} 次，存储 ${bytes(probe.storage_bytes)}`]] : []),
  ];
  const latest = data.database_samples[0];
  const transfer = data.neon_transfer;
  const selfHosted = data.database_provider === "self_hosted";
  const ratio = transfer ? transfer.transfer_bytes / transfer.transfer_limit_bytes : null;
  const pace = selfHosted ? null : projection(data.database_samples, transfer);
  const paceText = (p) =>
    p.enough
      ? `按最近 ${p.spanDays.toFixed(1)} 天的速度（每天约 ${gb(p.perDay)}），本周期够用。`
      : `按最近 ${p.spanDays.toFixed(1)} 天的速度（每天约 ${gb(p.perDay)}），约 ${date(new Date(p.runsOut).toISOString()).slice(0, 10)} 用完。`;
  const transferPanel = h(
    "section",
    { class: "panel transfer" },
    h("header", { class: "panel-head" }, h("h2", {}, "数据库流量（Neon 公网传输）")),
    transfer
      ? [
          h(
            "p",
            { class: "big-figure" },
            h("span", { class: "figure" }, pct(ratio)),
            h("span", { class: "of" }, `  ${gb(transfer.transfer_bytes)} / ${gb(transfer.transfer_limit_bytes)}`),
          ),
          meter(ratio, { tone: ratio >= 0.9 ? "bad" : ratio >= 0.7 ? "warn" : "" }),
          pace ? h("p", { class: pace.enough ? "" : "bad-text strong" }, paceText(pace)) : null,
          h(
            "p",
            { class: "hint" },
            `${transfer.transfer_period_end ? date(transfer.transfer_period_end) + " 重置" : "按月重置"}；用满后数据库会暂停到重置日（数据不丢）。${date(transfer.taken_at)} 读取，Neon 的计数会滞后一段时间。`,
          ),
        ]
      : h("p", { class: "muted" }, "还没有读数。在 GitHub 仓库添加 Secret NEON_API_KEY（项目级只读也可）和变量 NEON_PROJECT_ID 后，每次工作流结束都会记录一次。"),
  );
  root.append(
    h("div", { class: "title-row" }, h("h1", { class: "page-title" }, "运行用量"), range),
    selfHosted ? null : transferPanel,
    h("dl", { class: "stats" }, stats.map(([k, v, hint]) => h("div", { title: hint || null }, h("dt", {}, k), h("dd", {}, v)))),
    h("p", { class: "hint" }, "按 UTC 日期统计。字节数为应用层载荷，不是运营商流量账单；Actions 分钟来自已完成的 Job 时长，不等同于计费分钟。"),
    h(
      "section",
      { class: "panel" },
      h("header", { class: "panel-head" }, h("h2", {}, "数据库")),
      latest
        ? h("p", {}, `项目数据 ${bytes(latest.table_bytes)}，数据库共 ${bytes(latest.database_bytes)}，窗口内增长 ${bytes(data.database_growth_bytes)}（${date(latest.taken_at)} 采样）。`)
        : h("p", { class: "muted" }, "还没有容量采样。"),
      data.latest_backup
        ? h("p", { class: data.latest_backup.expired ? "bad-text" : "muted" }, `最近加密备份 ${date(data.latest_backup.created_at)} · ${data.latest_backup.expired ? "已过期" : "有效至 " + date(data.latest_backup.expires_at)}`)
        : h("p", { class: "muted" }, "暂时无法确认加密备份产物。"),
    ),
    h("h2", {}, "Actions 执行"),
    capped(
      [
        { label: "工作流", render: (r) => WORKFLOWS[r.workflow] || r.workflow },
        { label: "结果", render: (r) => badge(CONCLUSIONS[r.conclusion] || r.conclusion) },
        { label: "开始", render: (r) => date(r.started_at) },
        { label: "分钟", class: "num", render: (r) => (r.runner_ms / 60000).toFixed(1) },
        { label: "Job / 失败", class: "num", render: (r) => `${r.job_count} / ${r.failed_jobs}` },
      ],
      data.action_runs,
      { empty: empty("还没有 Actions 记录") },
    ),
    h("h2", {}, "最近执行"),
    capped(
      [
        { label: "类型", render: (r) => KINDS[r.kind] || r.kind },
        { label: "开始", render: (r) => date(r.started_at) },
        { label: "结果", render: (r) => badge(r.outcome) },
        { label: "检测 / 超时", class: "num", render: (r) => `${r.check_count} / ${r.timeout_checks}` },
      ],
      data.recent,
    ),
    h("h2", {}, "每日"),
    table(
      [
        { label: "日期", render: (d) => d.day },
        { label: "检测", class: "num", render: (d) => d.check_count },
        { label: "回显请求 / 失败", class: "num", render: (d) => `${d.echo_requests} / ${d.echo_failures}` },
        { label: "来源请求", class: "num", render: (d) => `${d.source_requests}（${bytes(d.source_response_bytes)}）` },
        { label: "订阅下载", class: "num", render: (d) => `${d.subscription_downloads}（${bytes(d.subscription_bytes)}）` },
      ],
      data.daily,
    ),
    selfHosted && transfer ? h("details", { class: "panel" },
      h("summary", {}, "Neon 历史流量"),
      h("p", { class: "muted" }, `最后一条读数 ${gb(transfer.transfer_bytes)}，采于 ${date(transfer.taken_at)}。`)) : null,
  );
}
