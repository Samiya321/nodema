import { KIND, ago, api, badge, busy, debounce, empty, field, flag, h, pct, route, select, toast } from "../core.js";
import { ADVANCED, PROTOCOLS, SORTS, advancedFields, readFilters } from "../filters.js";
import { testNodes } from "../strip.js";
import { nodeDetail } from "./node-detail.js";

const QUICK = ["q", "node_group", "status", "exit_country", "protocol", "provider_id", "eligible", "enabled", "source_id"];
const KEYS = [...QUICK, ...ADVANCED.map(([key]) => key)];
const PERCENT = ["min_success_rate", "max_timeout_rate", "min_lifetime_availability"];
const VIEWS = [["country", "按落地国家"], ["asn", "按落地 ASN"], ["list", "列表"]];
const regionNames = new Intl.DisplayNames(["zh-CN"], { type: "region" });
const collator = new Intl.Collator("zh-CN", { numeric: true });

function countryName(code) {
  try {
    return regionNames.of(code) || code;
  } catch {
    return code;
  }
}

// Load every node matching the filters (500 per request) so grouping and
// "select all" cover the whole result, not just one page.
async function loadAll(filters, sort) {
  const items = [];
  let total = 0;
  for (let offset = 0; offset < 20000; offset += 500) {
    const page = await api("/nodes?" + new URLSearchParams({ ...filters, sort, offset: String(offset), limit: "500" }));
    total = page.total;
    items.push(...page.items);
    if (items.length >= total || !page.items.length) break;
  }
  return { items, total };
}

const seqOf = (node) => Number((/(\d+)$/.exec(node.name) || [])[1] || 0);
// Inside a group: by landing ASN label, then by the per-country+ASN number.
const byAsnThenSeq = (a, b) =>
  collator.compare(a.asn_label || "~", b.asn_label || "~") || seqOf(a) - seqOf(b) || collator.compare(a.name, b.name);

function groupKey(node, view) {
  if (view === "country") return node.exit_country || "";
  if (view === "asn") return node.exit_asn ? String(node.exit_asn) : "";
  return "all";
}

function groupTitle(view, key, sample) {
  if (!key) return [h("span", { class: "group-flag" }, "🏳"), "未检测或无落地信息"];
  if (view === "country") return [h("span", { class: "group-flag" }, flag(key)), `${countryName(key)} `, h("span", { class: "muted" }, key)];
  return [sample.asn_label || "AS" + key, h("span", { class: "muted" }, ` AS${key}${sample.exit_asn_org ? " · " + sample.exit_asn_org : ""}`)];
}

export async function render(root, { params, go }) {
  const view = params.get("view") || "country";
  const sort = params.get("sort") || "name:asc";
  const filters = {};
  for (const key of KEYS) if (params.get(key)) filters[key] = params.get(key);
  const apiFilters = { ...filters };
  for (const key of PERCENT) if (apiFilters[key]) apiFilters[key] = String(Number(apiFilters[key]) / 100);
  const [{ items, total }, { providers }] = await Promise.all([loadAll(apiFilters, sort), api("/airports")]);

  // ---- filters (URL-backed) ----
  const form = h("form", { class: "toolbar", role: "search" });
  const apply = () => {
    const values = readFilters(form, KEYS);
    const next = new URLSearchParams({ view });
    for (const [k, v] of Object.entries(values)) next.set(k, Array.isArray(v) ? v.join(",") : String(v));
    for (const key of PERCENT) if (values[key] !== undefined) next.set(key, String(values[key] * 100));
    if (form.elements.sort) next.set("sort", form.elements.sort.value);
    go("nodes", next);
  };
  const setParam = (key, value) => {
    value ? params.set(key, value) : params.delete(key);
    go("nodes", params);
  };
  form.append(
    ...[
      h("input", { name: "q", type: "search", placeholder: "搜索名称、编号或主机", value: filters.q || "", "aria-label": "搜索", oninput: debounce(apply, 400) }),
      h(
        "div",
        { class: "segmented", role: "radiogroup", "aria-label": "节点类别" },
        [["", "全部"], ["SELF_HOSTED", "自建"], ["AIRPORT", "机场"]].map(([value, text]) =>
          h("label", { class: "seg" }, h("input", { type: "radio", name: "node_group", value, checked: (filters.node_group || "") === value, onchange: apply }), text),
        ),
      ),
      select("status", [["", "全部状态"], ["UP", "可用"], ["DEGRADED", "较慢"], ["DOWN", "不可用"], ["UNKNOWN", "未检测"], ["STALE", "结果过期"], ["UNSUPPORTED", "不支持"]], filters.status),
      select("protocol", [["", "全部协议"], ...PROTOCOLS.map((p) => [p, p])], filters.protocol),
      filters.node_group === "AIRPORT" || filters.provider_id ? select("provider_id", [["", "全部机场"], ...providers.map((p) => [p.id, p.name])], filters.provider_id) : null,
      view === "list" ? select("sort", SORTS, sort) : null,
    ].filter(Boolean),
  );
  for (const el of form.querySelectorAll("select")) el.addEventListener("change", apply);
  form.append(
    h(
      "details",
      { class: "advanced", open: ADVANCED.some(([key]) => filters[key]) || filters.exit_country },
      h("summary", {}, "更多筛选"),
      h(
        "div",
        { class: "form-grid" },
        field("落地国家（如 SG）", h("input", { name: "exit_country", value: filters.exit_country || "" })),
        advancedFields(apiFilters),
        field("参与检测", select("eligible", [["", "全部"], ["true", "是"], ["false", "否"]], filters.eligible)),
        field("启用", select("enabled", [["", "全部"], ["true", "已启用"], ["false", "已停用"]], filters.enabled)),
      ),
      h("div", { class: "row" }, h("button", { type: "submit", class: "primary" }, "应用筛选"), h("button", { type: "button", onclick: () => go("nodes", new URLSearchParams({ view })) }, "清除筛选")),
    ),
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    apply();
  });

  // ---- selection across every loaded node ----
  const picked = new Set();
  const byId = new Map(items.map((n) => [n.id, n]));
  const list = h("div", { class: "node-groups" });
  const count = h("span", { class: "bulk-count" });
  const allBox = h("input", { type: "checkbox", "aria-label": `全选 ${items.length} 个节点` });
  const bar = h("div", { class: "bulkbar" });
  const refreshChecks = () => {
    for (const box of list.querySelectorAll("input[data-id]")) box.checked = picked.has(box.dataset.id);
    for (const box of list.querySelectorAll("input[data-group]")) {
      const members = JSON.parse(box.dataset.group);
      const n = members.filter((id) => picked.has(id)).length;
      box.checked = n > 0 && n === members.length;
      box.indeterminate = n > 0 && n < members.length;
    }
    allBox.checked = picked.size > 0 && picked.size === items.length;
    allBox.indeterminate = picked.size > 0 && picked.size < items.length;
    count.textContent = picked.size ? `已选 ${picked.size} 个` : `共 ${total} 个节点`;
    bar.classList.toggle("active", picked.size > 0);
    for (const button of bar.querySelectorAll("button")) button.disabled = !picked.size;
  };
  const toggle = (ids, on) => {
    for (const id of ids) on ? picked.add(id) : picked.delete(id);
    refreshChecks();
  };
  allBox.addEventListener("change", () => toggle(ids(), allBox.checked));
  const ids = () => items.map((n) => n.id);
  const bulk = (enabled) => (e) =>
    busy(e.target, async () => {
      const chosen = [...picked];
      let changed = 0;
      for (let i = 0; i < chosen.length; i += 1000)
        changed += (await api("/nodes/batch", { method: "POST", body: { ids: chosen.slice(i, i + 1000), enabled } })).changed;
      toast(`${enabled ? "已启用" : "已停用"} ${changed} 个节点。`, "ok");
      go("nodes", params);
    });
  bar.append(
    h("label", { class: "check" }, allBox, "全选"),
    count,
    h("button", { type: "button", class: "primary", onclick: async () => { if (await testNodes([...picked])) { picked.clear(); refreshChecks(); } } }, "检测所选"),
    h("button", { type: "button", onclick: bulk(true) }, "启用"),
    h("button", { type: "button", onclick: bulk(false), title: "停用后不再检测和导出" }, "停用"),
    h("button", { type: "button", class: "quiet", onclick: () => toggle(ids(), false) }, "清除选择"),
  );

  // ---- rows ----
  const row = (n) =>
    h(
      "tr",
      { class: n.enabled ? "" : "dim" },
      h("td", { class: "pick" }, h("input", { type: "checkbox", "aria-label": "选择 " + n.name, dataset: { id: n.id }, onchange: (e) => toggle([n.id], e.target.checked) })),
      h(
        "td",
        { "data-label": "节点" },
        h(
          "button",
          { type: "button", class: "link name-cell", onclick: () => nodeDetail(n.id) },
          h("span", { class: "node-name" }, n.name),
          h("span", { class: "muted small" }, [n.short_id, n.protocol, n.enabled ? "" : "已停用", n.present_source_count ? "" : "上游已移除"].filter(Boolean).join(" · ")),
        ),
      ),
      h("td", { "data-label": "状态" }, badge(n.status)),
      h("td", { "data-label": "线路" }, route(n.entry_country, n.exit_country)),
      view === "asn"
        ? h("td", { "data-label": "落地国家" }, n.exit_country ? `${flag(n.exit_country)} ${n.exit_country}` : "—")
        : h("td", { "data-label": "落地 ASN" }, n.exit_asn ? h("span", {}, n.asn_label || "", h("span", { class: "muted small" }, ` AS${n.exit_asn}`)) : "—"),
      h("td", { class: "num", "data-label": "累计可用" }, n.checked_days ? `${pct(n.lifetime_availability)}（${n.available_days}/${n.checked_days} 天）` : "—"),
      h("td", { "data-label": "类别" }, h("span", { class: "tag " + (n.node_group === "AIRPORT" ? "air" : "own") }, KIND[n.node_group] || "—")),
      h("td", { "data-label": "最近检测" }, ago(n.last_checked_at)),
    );
  const head = () =>
    h(
      "thead",
      {},
      h("tr", {}, ["", "节点", "状态", "线路", view === "asn" ? "落地国家" : "落地 ASN", "累计可用", "类别", "最近检测"].map((t, i) => h("th", { scope: "col", class: i === 0 ? "pick" : i === 5 ? "num" : "" }, t))),
    );

  // In the country view, a light sub-header per landing ASN when a country has several.
  const withSubheads = (members, mode) => {
    const asns = new Set(members.map((n) => n.asn_label || ""));
    if (mode !== "country" || asns.size < 2) return members.map(row);
    const rows = [];
    let current;
    for (const n of members) {
      const label = n.asn_label || "";
      if (label !== current) {
        current = label;
        const size = members.filter((m) => (m.asn_label || "") === label).length;
        rows.push(h("tr", { class: "subhead" }, h("td", { colspan: 8 }, label || "无 ASN 信息", h("span", { class: "muted" }, ` ${size} 个${n.exit_asn ? " · AS" + n.exit_asn : ""}`))));
      }
      rows.push(row(n));
    }
    return rows;
  };

  if (!items.length) {
    list.append(
      empty(
        Object.keys(filters).length ? "没有符合条件的节点" : "还没有节点",
        Object.keys(filters).length ? "调整或清除筛选条件。" : "在“来源”页添加订阅或节点，然后点顶部“同步来源”。",
      ),
    );
  } else if (view === "list") {
    list.append(h("div", { class: "table-wrap" }, h("table", {}, head(), h("tbody", {}, items.map(row)))));
  } else {
    const groups = new Map();
    for (const n of items) {
      const key = groupKey(n, view);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(n);
    }
    const ordered = [...groups.entries()].sort(([a, x], [b, y]) => (!a) - (!b) || y.length - x.length || collator.compare(a, b));
    for (const [key, members] of ordered) {
      members.sort(view === "country" ? byAsnThenSeq : (a, b) => collator.compare(a.exit_country || "~", b.exit_country || "~") || seqOf(a) - seqOf(b));
      const up = members.filter((n) => ["UP", "DEGRADED"].includes(n.status)).length;
      const memberIds = members.map((n) => n.id);
      const groupBox = h("input", { type: "checkbox", "aria-label": "选择本组", dataset: { group: JSON.stringify(memberIds) } });
      groupBox.addEventListener("click", (e) => e.stopPropagation());
      groupBox.addEventListener("change", () => toggle(memberIds, groupBox.checked));
      list.append(
        h(
          "details",
          { class: "node-group", open: Boolean(key) || ordered.length === 1 },
          h(
            "summary",
            {},
            groupBox,
            h("span", { class: "group-title" }, groupTitle(view, key, members[0])),
            h("span", { class: "group-count" }, h("strong", {}, up), ` / ${members.length} 可用`),
          ),
          h("div", { class: "table-wrap flush" }, h("table", {}, head(), h("tbody", {}, withSubheads(members, view)))),
        ),
      );
    }
  }

  root.append(
    h(
      "div",
      { class: "title-row" },
      h("h1", { class: "page-title" }, "节点"),
      h("div", { class: "segmented", role: "group", "aria-label": "显示方式" }, VIEWS.map(([key, text]) => h("button", { type: "button", class: "seg", "aria-pressed": String(view === key), onclick: () => setParam("view", key) }, text))),
    ),
    form,
    bar,
    list,
  );
  refreshChecks();
}
