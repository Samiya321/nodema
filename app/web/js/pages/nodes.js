import {
  KIND,
  ago,
  api,
  badge,
  busy,
  debounce,
  empty,
  field,
  h,
  ms,
  pct,
  route,
  select,
  selection,
  table,
  toast,
} from "../core.js";
import { ADVANCED, PROTOCOLS, SORTS, advancedFields, readFilters } from "../filters.js";
import { nodeDetail } from "./node-detail.js";

const QUICK = ["q", "node_group", "status", "exit_country", "protocol", "provider_id", "eligible", "enabled", "source_id"];
const KEYS = [...QUICK, ...ADVANCED.map(([key]) => key)];
const PAGE_SIZE = 100;

export async function render(root, { params, go }) {
  const providers = (await api("/airports")).providers;
  const offset = Number(params.get("offset") || 0);
  const sort = params.get("sort") || "short_id:asc";
  const filters = {};
  for (const key of KEYS) if (params.get(key)) filters[key] = params.get(key);
  // The URL keeps percentages people can read; the API takes ratios.
  const PERCENT = ["min_success_rate", "max_timeout_rate", "min_lifetime_availability"];
  const apiFilters = { ...filters };
  for (const key of PERCENT) if (apiFilters[key]) apiFilters[key] = String(Number(apiFilters[key]) / 100);

  const form = h("form", { class: "toolbar", role: "search" });
  const apply = () => {
    const values = readFilters(form, KEYS);
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(values)) next.set(k, Array.isArray(v) ? v.join(",") : String(v));
    for (const key of PERCENT) if (values[key] !== undefined) next.set(key, String(values[key] * 100));
    next.set("sort", form.elements.sort.value);
    go("nodes", next);
  };
  const quick = [
    h("input", { name: "q", type: "search", placeholder: "搜索名称、编号或主机", value: filters.q || "", "aria-label": "搜索", oninput: debounce(apply, 400) }),
    h(
      "div",
      { class: "segmented", role: "radiogroup", "aria-label": "节点类别" },
      [["", "全部"], ["SELF_HOSTED", "自建"], ["AIRPORT", "机场"]].map(([value, text]) =>
        h(
          "label",
          { class: "seg" },
          h("input", { type: "radio", name: "node_group", value, checked: (filters.node_group || "") === value, onchange: apply }),
          text,
        ),
      ),
    ),
    select("status", [["", "全部状态"], ["UP", "可用"], ["DEGRADED", "较慢"], ["DOWN", "不可用"], ["UNKNOWN", "未检测"], ["STALE", "结果过期"], ["UNSUPPORTED", "不支持"]], filters.status),
    h("input", { name: "exit_country", placeholder: "落地地区", size: 6, value: filters.exit_country || "", "aria-label": "落地地区，如 SG", onchange: apply }),
    select("protocol", [["", "全部协议"], ...PROTOCOLS.map((p) => [p, p])], filters.protocol),
    filters.node_group === "AIRPORT" || filters.provider_id
      ? select("provider_id", [["", "全部机场"], ...providers.map((p) => [p.id, p.name])], filters.provider_id)
      : null,
    select("sort", SORTS, sort),
  ];
  form.append(...quick.filter(Boolean));
  for (const el of form.querySelectorAll("select")) el.addEventListener("change", apply);
  const advanced = h(
    "details",
    { class: "advanced", open: ADVANCED.some(([key]) => filters[key]) },
    h("summary", {}, "更多筛选"),
    h("div", { class: "form-grid" }, advancedFields(apiFilters), field("参与检测", select("eligible", [["", "全部"], ["true", "是"], ["false", "否"]], filters.eligible)), field("启用", select("enabled", [["", "全部"], ["true", "已启用"], ["false", "已停用"]], filters.enabled))),
    h("div", { class: "row" }, h("button", { type: "submit", class: "primary" }, "应用筛选"), h("button", { type: "button", onclick: () => go("nodes") }, "清除全部")),
  );
  form.append(advanced);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    apply();
  });
  const query = new URLSearchParams({ ...apiFilters, sort, offset: String(offset), limit: String(PAGE_SIZE) });
  const data = await api("/nodes?" + query);
  const bar = h("div", { class: "bulkbar", hidden: true });
  const picked = selection((ids) => {
    bar.hidden = ids.size === 0;
    bar.querySelector(".bulk-count").textContent = `已选 ${ids.size} 个`;
  });
  const bulk = (enabled) => async (e) =>
    busy(e.target, async () => {
      const result = await api("/nodes/batch", { method: "POST", body: { ids: [...picked.ids], enabled } });
      toast(`${enabled ? "已启用" : "已停用"} ${result.changed} 个节点。`, "ok");
      picked.clear();
      go("nodes", params);
    });
  bar.append(
    h("span", { class: "bulk-count" }),
    h("button", { type: "button", onclick: bulk(true) }, "启用"),
    h("button", { type: "button", onclick: bulk(false) }, "停用（不再检测和导出）"),
    h("button", { type: "button", class: "quiet", onclick: () => picked.clear() }, "取消选择"),
  );

  const ids = data.items.map((n) => n.id);
  const columns = [
    { label: picked.all(ids), class: "pick", render: (n) => picked.box(n.id) },
    {
      label: "节点",
      render: (n) =>
        h(
          "button",
          { type: "button", class: "link name-cell", onclick: () => nodeDetail(n.id) },
          h("span", { class: "node-name" }, n.name),
          h("span", { class: "muted small" }, `${n.short_id} · ${n.protocol}${n.enabled ? "" : " · 已停用"}`),
        ),
    },
    { label: "状态", render: (n) => badge(n.status) },
    { label: "线路", render: (n) => route(n.entry_country, n.exit_country) },
    { label: "落地 ASN", render: (n) => (n.exit_asn ? h("span", {}, n.asn_label || "", h("span", { class: "muted small" }, ` AS${n.exit_asn}`)) : "—") },
    { label: "延迟", class: "num", render: (n) => ms(n.http_duration_ms) },
    { label: "累计可用", class: "num", render: (n) => (n.checked_days ? `${pct(n.lifetime_availability)}（${n.available_days}/${n.checked_days} 天）` : "—") },
    { label: "类别", render: (n) => h("span", { class: "tag " + (n.node_group === "AIRPORT" ? "air" : "own") }, KIND[n.node_group] || "—", n.present_source_count ? "" : h("span", { class: "muted small", title: "所有来源都已不再包含此节点；节点保留并继续检测" }, " · 上游已移除")) },
    { label: "最近检测", render: (n) => ago(n.last_checked_at) },
  ];
  const pager = h(
    "nav",
    { class: "pager", "aria-label": "分页" },
    h("span", { class: "muted" }, `共 ${data.total} 个，第 ${offset + 1}–${Math.min(offset + PAGE_SIZE, data.total)} 个`),
    h("button", { type: "button", disabled: offset === 0, onclick: () => { params.set("offset", String(Math.max(0, offset - PAGE_SIZE))); go("nodes", params); } }, "上一页"),
    h("button", { type: "button", disabled: offset + PAGE_SIZE >= data.total, onclick: () => { params.set("offset", String(offset + PAGE_SIZE)); go("nodes", params); } }, "下一页"),
  );
  root.append(
    h("h1", { class: "page-title" }, "节点"),
    form,
    bar,
    table(columns, data.items, {
      empty: empty(Object.keys(filters).length ? "没有符合条件的节点" : "还没有节点", Object.keys(filters).length ? "调整或清除筛选条件。" : "在“来源”页导入订阅或节点后，点击顶部“同步来源”。"),
      rowClass: (n) => (n.enabled ? "" : "dim"),
    }),
    data.total > PAGE_SIZE ? pager : null,
  );
}
