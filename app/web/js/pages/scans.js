import { KIND, SCAN_KIND, api, badge, busy, date, dialog, empty, errorText, h, table, toast } from "../core.js";

function duration(run) {
  if (!run.finished_at) return "—";
  const seconds = (new Date(run.finished_at) - new Date(run.started_at)) / 1000;
  return seconds < 90 ? Math.round(seconds) + " 秒" : Math.round(seconds / 60) + " 分钟";
}

async function detail(id) {
  const run = await api("/scans/" + id);
  const items = run.items || {};
  dialog(
    `${run.scan_date} ${SCAN_KIND[run.kind] || run.kind}检测`,
    h(
      "div",
      { class: "stack" },
      h(
        "dl",
        { class: "pairs" },
        h("dt", {}, "范围"),
        h("dd", {}, KIND[run.scope] || "全部"),
        h("dt", {}, "状态"),
        h("dd", {}, badge(run.status)),
        h("dt", {}, "完成 / 待重试 / 未开始"),
        h("dd", {}, `${items.DONE || 0} / ${items.RETRYABLE || 0} / ${items.PENDING || 0}`),
        h("dt", {}, "问题"),
        h("dd", {}, run.error_summary?.incomplete_shards ? `未完成分片 ${run.error_summary.incomplete_shards.join("、")}` : "—"),
      ),
      table(
        [
          { label: "分片", render: (s) => s.shard_no },
          { label: "状态", render: (s) => badge(s.status) },
          { label: "完成 / 计划", class: "num", render: (s) => `${s.completed_count} / ${s.planned_count}` },
          { label: "失败", class: "num", render: (s) => s.failed_count },
          { label: "原因", render: (s) => (s.error_summary?.code ? errorText(s.error_summary.code) : "—") },
        ],
        run.shards,
      ),
      h("p", { class: "hint" }, "未完成的批次里，已确认可用的节点会先发布；失败结果要等批次完整后才发布，避免环境故障把节点误判为不可用。"),
    ),
    { wide: true },
  );
}

const PROBE_ERRORS = { NETWORK: "无法连接 Globalping", TIMEOUT: "测量超时", INVALID_RESPONSE: "返回异常" };

async function probeRuns() {
  const status = await api("/probe-status");
  const daily = status.daily || [];
  return h(
    "div",
    { class: "stack" },
    h(
      "dl",
      { class: "stats" },
      h("div", {}, h("dt", {}, "今天已用测试"), h("dd", {}, status.tests_today)),
      h("div", {}, h("dt", {}, "7 天测试"), h("dd", {}, status.tests_7d)),
      h("div", {}, h("dt", {}, "已覆盖网段（7 天）"), h("dd", {}, status.prefixes_graded)),
      h("div", {}, h("dt", {}, "三网晚高峰覆盖"), h("dd", {}, status.prefixes_peak)),
      h("div", {}, h("dt", {}, "去程路由"), h("dd", {}, status.traces)),
    ),
    daily.length ? h("p", { class: "muted small" }, "每日测试数：" + daily.map((d) => `${d.date.slice(5)} ${d.tests}`).join(" · ")) : null,
    table(
      [
        { label: "开始", render: (r) => date(r.started_at) },
        { label: "时段", render: (r) => (r.peak ? "晚高峰（三网）" : "其他时段") },
        { label: "测量 / 测试", class: "num", render: (r) => `${r.measurements} / ${r.tests}` },
        { label: "写入", class: "num", render: (r) => r.stored },
        { label: "失败", class: "num", render: (r) => r.failed },
        { label: "额度用尽", class: "num", render: (r) => r.rate_limited },
        { label: "问题", render: (r) => (r.error_code ? PROBE_ERRORS[r.error_code] || r.error_code : "—") },
      ],
      status.runs || [],
      { empty: empty("还没有接入测量", "部署后每小时自动运行一次。") },
    ),
    h("p", { class: "hint" }, "Globalping 免费额度按小时计算（账号 500 次、匿名 250 次）；每个探针执行一次测量算 1 次测试。只记录计数，不记录目标。"),
  );
}

export async function render(root, { params, go, refresh, refreshStrip }) {
  const tab = params.get("tab") === "probes" ? "probes" : "scans";
  const tabs = h(
    "div",
    { class: "segmented", role: "group", "aria-label": "记录类型" },
    [["scans", "节点检测"], ["probes", "接入测量"]].map(([key, text]) =>
      h("button", { type: "button", class: "seg", "aria-pressed": String(tab === key), onclick: () => go("scans", new URLSearchParams(key === "probes" ? { tab: key } : {})) }, text),
    ),
  );
  if (tab === "probes") {
    root.append(h("div", { class: "title-row" }, h("h1", { class: "page-title" }, "检测记录"), tabs), await probeRuns());
    return;
  }
  const runs = await api("/scans");
  const retry = (run) => async (e) =>
    busy(e.target, async () => {
      const result = await api(`/scans/${run.id}/retry`, { method: "POST" });
      toast(result.dispatched ? "已提交继续执行。" : "该批次已完成。", "ok");
      refreshStrip();
      refresh();
    });
  root.append(
    h("div", { class: "title-row" }, h("h1", { class: "page-title" }, "检测记录"), tabs),
    table(
      [
        { label: "日期", render: (r) => h("button", { type: "button", class: "link", onclick: () => detail(r.id) }, r.scan_date) },
        { label: "类型", render: (r) => SCAN_KIND[r.kind] || r.kind },
        { label: "范围", render: (r) => KIND[r.scope] || "全部" },
        { label: "状态", render: (r) => badge(r.status) },
        { label: "节点", class: "num", render: (r) => r.node_count },
        { label: "开始", render: (r) => date(r.started_at) },
        { label: "耗时", render: duration },
        {
          label: "",
          render: (r) =>
            r.status !== "COMPLETED" && !r.archived_at
              ? h("button", { type: "button", class: "quiet", onclick: retry(r) }, "继续执行")
              : null,
        },
      ],
      runs,
      { empty: empty("还没有检测记录", "点击顶部“检测”按钮选择范围开始。") },
    ),
  );
}
