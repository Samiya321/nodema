import { KIND, SCAN_KIND, ago, api, badge, bytes, daysUntil, empty, errorText, flag, h } from "../core.js";

const GROUPS = ["SELF_HOSTED", "AIRPORT"];

function groupPanel(key, data) {
  const statuses = data?.statuses || {};
  const up = (statuses.UP || 0) + (statuses.DEGRADED || 0);
  const total = data?.total || 0;
  const rows = [
    ["可用", up, "ok", "UP"],
    ["不可用", statuses.DOWN || 0, "bad", "DOWN"],
    ["未检测 / 过期", (statuses.UNKNOWN || 0) + (statuses.STALE || 0), "mute", "UNKNOWN"],
  ];
  return h(
    "section",
    { class: "panel group-panel" },
    h(
      "header",
      { class: "panel-head" },
      h("h2", {}, KIND[key] + "节点"),
      h("a", { href: `#/nodes?node_group=${key}` }, "查看全部"),
    ),
    h(
      "p",
      { class: "big-figure" },
      h("span", { class: "figure" }, up),
      h("span", { class: "of" }, ` / ${total} 可用`),
    ),
    h(
      "ul",
      { class: "tally" },
      rows.map(([label, n, tone, status]) =>
        h(
          "li",
          {},
          h("a", { href: `#/nodes?node_group=${key}&status=${status}` }, h("span", { class: "dot " + tone }), label),
          h("strong", {}, n),
        ),
      ),
    ),
    h("p", { class: "muted small" }, `参与检测 ${data?.eligible || 0} 个`),
  );
}

function attention(airports, substores, sources) {
  const items = [];
  for (const s of airports.sources) {
    const days = daysUntil(s.expires_at);
    const used = Number(s.traffic_upload || 0) + Number(s.traffic_download || 0);
    const total = Number(s.traffic_total || 0);
    if (s.expires_at && new Date(s.expires_at) <= new Date()) items.push(["bad", `${s.name} 已过期`, "#/airports"]);
    else if (total && used >= total) items.push(["bad", `${s.name} 流量已用完`, "#/airports"]);
    else if (days !== null && days <= 7) items.push(["warn", `${s.name} ${days} 天后到期`, "#/airports"]);
    else if (total && (total - used) / total < 0.1)
      items.push(["warn", `${s.name} 剩余 ${bytes(total - used)}`, "#/airports"]);
  }
  for (const s of substores)
    if (s.last_sync_status === "FAILED")
      items.push(["bad", `Sub-Store「${s.name}」无法访问：${errorText(s.last_error_code)}`, "#/substore"]);
  const failed = sources.filter((s) => s.last_sync_status === "FAILED" && s.effective_kind !== "SUBSTORE");
  if (failed.length) items.push(["warn", `${failed.length} 个来源最近拉取失败，已解析的节点仍保留`, "#/sources?status=FAILED"]);
  return items;
}

export async function render(root) {
  const [overview, airports, substores, sources] = await Promise.all([
    api("/overview"),
    api("/airports"),
    api("/substores"),
    api("/sources"),
  ]);
  const latest = overview.latest_scan;
  const notes = attention(airports, substores, sources);
  const countries = Object.entries(overview.countries || {})
    .filter(([c]) => c !== "UNK")
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12);
  root.append(
    h("h1", { class: "page-title" }, "总览"),
    h("div", { class: "grid-2" }, GROUPS.map((key) => groupPanel(key, overview.groups?.[key]))),
    h(
      "div",
      { class: "grid-2" },
      h(
        "section",
        { class: "panel" },
        h("header", { class: "panel-head" }, h("h2", {}, "需要处理")),
        notes.length
          ? h(
              "ul",
              { class: "notes" },
              notes.map(([tone, text, href]) => h("li", {}, h("span", { class: "dot " + tone }), h("a", { href }, text))),
            )
          : h("p", { class: "muted" }, "没有过期机场、失效 Sub-Store 或失败的来源。"),
      ),
      h(
        "section",
        { class: "panel" },
        h("header", { class: "panel-head" }, h("h2", {}, "最近一次检测"), h("a", { href: "#/scans" }, "全部记录")),
        latest
          ? h(
              "dl",
              { class: "pairs" },
              h("dt", {}, "批次"),
              h("dd", {}, `${latest.scan_date} ${SCAN_KIND[latest.kind] || latest.kind} · ${KIND[latest.scope] || "全部"}`),
              h("dt", {}, "状态"),
              h("dd", {}, badge(latest.status)),
              h("dt", {}, "节点"),
              h("dd", {}, `${latest.items?.DONE || 0} / ${latest.node_count} 已完成`),
              h("dt", {}, "开始"),
              h("dd", {}, ago(latest.started_at)),
            )
          : empty("还没有检测记录", "点击顶部的检测按钮开始。"),
      ),
    ),
    h(
      "section",
      { class: "panel" },
      h("header", { class: "panel-head" }, h("h2", {}, "落地地区")),
      countries.length
        ? h(
            "ul",
            { class: "country-list" },
            countries.map(([code, n]) =>
              h("li", {}, h("a", { href: `#/nodes?exit_country=${code}` }, flag(code), " ", code, h("strong", {}, n))),
            ),
          )
        : h("p", { class: "muted" }, "完成检测后显示节点的落地地区。"),
    ),
  );
}
