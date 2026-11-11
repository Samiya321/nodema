import { ago, api, busy, debounce, empty, field, h, pager, select, toast } from "../core.js";
import { ADVANCED, PROTOCOLS, SORTS, advancedFields, readFilters } from "../filters.js";
import { testNodes } from "../strip.js";
import { CHUNK, collator, groupKey, groupTitle, headRow, lazyBody, memberOrder, nodeRow } from "./node-rows.js";

const QUICK = ["q", "node_group", "status", "exit_country", "protocol", "provider_id", "eligible", "enabled", "source_id"];
const KEYS = [...QUICK, ...ADVANCED.map(([key]) => key)];
const PERCENT = ["min_success_rate", "max_timeout_rate", "min_lifetime_availability"];
const VIEWS = [["country", "按落地国家"], ["asn", "按落地 ASN"], ["server", "按落地服务器"], ["list", "列表"]];
const FETCH_PAGE = 10000; // compact rows per request; there is no overall cap
const OPEN_ALL_BELOW = 300; // small libraries open every group; large ones start collapsed
// Database transfer is metered (Neon Free: 5 GB a month), so a loaded list is kept until
// something changes it (edits, finished tests or syncs) or the user presses 刷新.
const CACHE_MS = 10 * 60_000;

// Rows arrive as positional arrays; "fields" names the positions.
const objects = (page) => page.items.map((row) => Object.fromEntries(page.fields.map((field, i) => [field, row[i]])));

// Every matching node is loaded with only the list fields (10 000 per request, the
// rest in parallel), so grouping, paging and "select all" cover the whole filtered set.
let cache = null;
async function load(filters, sort) {
  const key = JSON.stringify([filters, sort]);
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.data;
  const fetchPage = (offset) =>
    api("/nodes?" + new URLSearchParams({ ...filters, sort, view: "compact", offset: String(offset), limit: String(FETCH_PAGE) }));
  const first = await fetchPage(0);
  const offsets = [];
  for (let offset = FETCH_PAGE; offset < first.total; offset += FETCH_PAGE) offsets.push(offset);
  const rest = await Promise.all(offsets.map(fetchPage));
  const data = { total: first.total, items: [first, ...rest].flatMap(objects), at: Date.now() };
  cache = { key, at: data.at, data };
  return data;
}
export const invalidateNodes = () => (cache = null);
// Node edits elsewhere (detail dialog, tests finishing) announce themselves.
window.addEventListener("nodema:nodes-changed", invalidateNodes);

export async function render(root, { params, go }) {
  const view = params.get("view") || "country";
  const sort = params.get("sort") || "name:asc";
  const page = Math.max(0, Number(params.get("page") || 0) || 0);
  const filters = {};
  for (const key of KEYS) if (params.get(key)) filters[key] = params.get(key);
  const apiFilters = { ...filters };
  for (const key of PERCENT) if (apiFilters[key]) apiFilters[key] = String(Number(apiFilters[key]) / 100);
  const [{ items, total, at: loadedAt }, { providers }] = await Promise.all([load(apiFilters, sort), api("/airports")]);

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
    params.delete("page");
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

  // ---- selection across the whole filtered set (not just rendered rows) ----
  const picked = new Set();
  const list = h("div", { class: "node-groups" });
  const count = h("span", { class: "bulk-count" });
  const allBox = h("input", { type: "checkbox", "aria-label": `全选筛选结果 ${items.length} 个节点` });
  const bar = h("div", { class: "bulkbar" });
  const groupBoxes = new Map();
  const refreshChecks = () => {
    for (const box of list.querySelectorAll("input[data-id]")) box.checked = picked.has(box.dataset.id);
    for (const [box, members] of groupBoxes) {
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
  const allIds = () => items.map((n) => n.id);
  allBox.addEventListener("change", () => toggle(allIds(), allBox.checked));
  const bulk = (enabled) => (e) =>
    busy(e.target, async () => {
      const chosen = [...picked];
      let changed = 0;
      for (let i = 0; i < chosen.length; i += 1000)
        changed += (await api("/nodes/batch", { method: "POST", body: { ids: chosen.slice(i, i + 1000), enabled } })).changed;
      toast(`${enabled ? "已启用" : "已停用"} ${changed} 个节点。`, "ok");
      invalidateNodes();
      go("nodes", params);
    });
  const test = async () => {
    if (await testNodes([...picked])) toggle(allIds(), false);
  };
  bar.append(
    h("label", { class: "check", title: "选择当前筛选条件下的全部节点，包括未展开的分组和其他页" }, allBox, "全选"),
    count,
    h("button", { type: "button", class: "primary", onclick: test }, "检测所选"),
    h("button", { type: "button", onclick: bulk(true) }, "启用"),
    h("button", { type: "button", onclick: bulk(false), title: "停用后不再检测和导出" }, "停用"),
    h("button", { type: "button", class: "quiet", onclick: () => toggle(allIds(), false) }, "清除选择"),
  );


  if (!items.length) {
    list.append(
      empty(
        Object.keys(filters).length ? "没有符合条件的节点" : "还没有节点",
        Object.keys(filters).length ? "调整或清除筛选条件。" : "在“来源”页添加订阅或节点，然后点顶部“同步来源”。",
      ),
    );
  } else if (view === "list") {
    const pages = Math.ceil(items.length / CHUNK);
    const current = Math.min(page, pages - 1);
    const goPage = (target) => {
      target ? params.set("page", String(target)) : params.delete("page");
      go("nodes", params);
    };
    list.append(
      h("div", { class: "table-wrap" }, h("table", {}, headRow(view), h("tbody", {}, items.slice(current * CHUNK, (current + 1) * CHUNK).map((n) => nodeRow(n, view, toggle))))),
      pager(current, pages, goPage),
    );
  } else {
    const groups = new Map();
    for (const n of items) {
      const key = groupKey(n, view);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(n);
    }
    const ordered = [...groups.entries()].sort(([a, x], [b, y]) => (!a) - (!b) || y.length - x.length || collator.compare(a, b));
    const openAll = items.length <= OPEN_ALL_BELOW || ordered.length === 1;
    // Thousands of landing servers are possible: groups appear 100 at a time too.
    const moreGroups = h("button", { type: "button", class: "quiet more-groups" });
    let shownGroups = 0;
    const appendGroups = () => {
      for (const [key, members] of ordered.slice(shownGroups, shownGroups + CHUNK)) list.insertBefore(groupFor(key, members), moreGroups);
      shownGroups = Math.min(ordered.length, shownGroups + CHUNK);
      moreGroups.textContent = `显示更多分组（还有 ${ordered.length - shownGroups} 组）`;
      moreGroups.hidden = shownGroups >= ordered.length;
      refreshChecks();
    };
    moreGroups.addEventListener("click", appendGroups);
    list.append(moreGroups);
    function groupFor(key, members) {
      members.sort(memberOrder(view));
      const up = members.filter((n) => ["UP", "DEGRADED"].includes(n.status)).length;
      const memberIds = members.map((n) => n.id);
      const groupBox = h("input", { type: "checkbox", "aria-label": "选择本组" });
      groupBoxes.set(groupBox, memberIds);
      groupBox.addEventListener("click", (e) => e.stopPropagation());
      groupBox.addEventListener("change", () => toggle(memberIds, groupBox.checked));
      const group = h(
        "details",
        { class: "node-group" },
        h("summary", {}, groupBox, h("span", { class: "group-title" }, groupTitle(view, key, members[0])), h("span", { class: "group-count" }, h("strong", {}, up), ` / ${members.length} 可用`)),
      );
      // Rows are built the first time a group opens.
      let built = false;
      const build = () => {
        if (built || !group.open) return;
        built = true;
        group.append(...lazyBody(members, view, toggle, refreshChecks));
      };
      group.addEventListener("toggle", build);
      group.open = openAll && Boolean(key);
      build();
      return group;
    }
    appendGroups();
  }

  root.append(
    h(
      "div",
      { class: "title-row" },
      h("h1", { class: "page-title" }, "节点"),
      h(
        "button",
        { type: "button", class: "quiet", title: "重新从数据库读取节点列表", onclick: () => { invalidateNodes(); go("nodes", params); } },
        `刷新（${ago(new Date(loadedAt).toISOString())}载入）`,
      ),
      h("div", { class: "segmented", role: "group", "aria-label": "显示方式" }, VIEWS.map(([key, text]) => h("button", { type: "button", class: "seg", "aria-pressed": String(view === key), onclick: () => setParam("view", key) }, text))),
    ),
    form,
    bar,
    list,
  );
  refreshChecks();
}
