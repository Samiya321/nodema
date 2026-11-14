import { api, badge, bytes, date, empty, h, meter, pct, select, table } from "../core.js";

// Neon bills transfer in decimal units (5 GB = 5,000,000,000 bytes).
const gb = (value) => (value / 1e9).toFixed(2) + " GB";
const KINDS = { CHECK: "检测", SOURCE: "来源同步", SUBSCRIPTION: "订阅下载", JOB: "任务采样" };

export async function render(root, { params, go }) {
  const days = params.get("days") || "30";
  const [data, probe] = await Promise.all([
    api("/usage?days=" + encodeURIComponent(days)),
    api("/probe-status").catch(() => null),
  ]);
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
    ...(probe
      ? [
          ["Globalping 今日 / 7 天", `${probe.tests_today} / ${probe.tests_7d} 次测试`],
          ["接入测量占用", bytes(probe.storage_bytes)],
        ]
      : []),
  ];
  const latest = data.database_samples[0];
  const transfer = data.neon_transfer;
  const ratio = transfer ? transfer.transfer_bytes / transfer.transfer_limit_bytes : null;
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
          h(
            "p",
            { class: "hint" },
            `${transfer.transfer_period_end ? date(transfer.transfer_period_end) + " 重置" : "按月重置"}；用满后数据库会暂停到重置日（数据不丢）。${date(transfer.taken_at)} 读取。`,
          ),
        ]
      : h("p", { class: "muted" }, "还没有读数。在 GitHub 仓库添加 Secret NEON_API_KEY（项目级只读也可）和变量 NEON_PROJECT_ID 后，每次工作流结束都会记录一次。"),
  );
  root.append(
    h("div", { class: "title-row" }, h("h1", { class: "page-title" }, "运行用量"), range),
    transferPanel,
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
