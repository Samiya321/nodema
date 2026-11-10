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

export async function render(root, { refresh, refreshStrip }) {
  const runs = await api("/scans");
  const retry = (run) => async (e) =>
    busy(e.target, async () => {
      const result = await api(`/scans/${run.id}/retry`, { method: "POST" });
      toast(result.dispatched ? "已提交继续执行。" : "该批次已完成。", "ok");
      refreshStrip();
      refresh();
    });
  root.append(
    h("h1", { class: "page-title" }, "检测记录"),
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
