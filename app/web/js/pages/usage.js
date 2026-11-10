import { api, badge, bytes, date, empty, h, pct, select, table } from "../core.js";

const KINDS = { CHECK: "检测", SOURCE: "来源同步", SUBSCRIPTION: "订阅下载", JOB: "任务采样" };

export async function render(root, { params, go }) {
  const days = params.get("days") || "30";
  const data = await api("/usage?days=" + encodeURIComponent(days));
  const t = data.totals;
  const range = select("days", [["7", "近 7 天"], ["30", "近 30 天"], ["90", "近 90 天"], ["365", "近 365 天"]], days);
  range.addEventListener("change", () => go("usage", new URLSearchParams({ days: range.value })));
  const stats = [
    ["Actions 分钟", Number(data.runner_minutes).toFixed(1)],
    ["检测次数", data.health.attempts],
    ["平均单次检测", data.health.mean_check_ms == null ? "—" : data.health.mean_check_ms + " ms"],
    ["含超时", pct(data.health.timeout_ratio)],
    ["执行失败率", pct(data.executions.failure_ratio)],
    ["完整验证 / 抽样", `${t.full_checks} / ${t.full_samples}`],
    ["预检跳过 / 冷却跳过", `${t.preflight_skips} / ${t.cooldown_skips}`],
    ["订阅下载", `${t.subscription_downloads} 次，${bytes(t.subscription_bytes)}`],
  ];
  const latest = data.database_samples[0];
  root.append(
    h("div", { class: "title-row" }, h("h1", { class: "page-title" }, "运行用量"), range),
    h("dl", { class: "stats" }, stats.map(([k, v]) => h("div", {}, h("dt", {}, k), h("dd", {}, v)))),
    h("p", { class: "hint" }, "按 UTC 日期统计。字节数为应用层载荷，不是运营商流量账单；Actions 分钟来自已完成的 Job 时长，不等同于计费分钟。"),
    h(
      "section",
      { class: "panel" },
      h("header", { class: "panel-head" }, h("h2", {}, "数据库")),
      latest
        ? h("p", {}, `项目数据 ${bytes(latest.table_bytes)}，数据库共 ${bytes(latest.database_bytes)}，窗口内增长 ${bytes(data.database_growth_bytes)}（${date(latest.taken_at)} 采样）。`)
        : h("p", { class: "muted" }, "还没有容量采样。"),
    ),
    h("h2", {}, "Actions 执行"),
    table(
      [
        { label: "工作流", render: (r) => r.workflow },
        { label: "结果", render: (r) => r.conclusion },
        { label: "开始", render: (r) => date(r.started_at) },
        { label: "分钟", class: "num", render: (r) => (r.runner_ms / 60000).toFixed(1) },
        { label: "Job / 失败", class: "num", render: (r) => `${r.job_count} / ${r.failed_jobs}` },
      ],
      data.action_runs,
      { empty: empty("还没有 Actions 记录") },
    ),
    h("h2", {}, "最近执行"),
    table(
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
  );
}
