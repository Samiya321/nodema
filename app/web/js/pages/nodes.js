// Node list: a grade bar that is also the grade filter, a single filter row, a drawer
// for the rest, and one sortable, paged table over the whole filtered set.
import { ago, api, busy, debounce, empty, field, h, select, toast } from "../core.js";
import { ADVANCED, PROTOCOLS, control, readFilters } from "../filters.js";
import { testNodes } from "../strip.js";
import { BUCKETS, COLUMNS, bucketOf, countryName, headRow, nodeRow, setRowVantage, sortNodes } from "./node-rows.js";
import { BUCKET_HINT, BUCKET_TEXT, defaultVantage, vantageSwitch } from "../grades.js";

// Filters the database applies (sent to the API). Grade buckets, sort and paging are local.
const QUICK = ["q", "node_group", "status", "protocol", "provider_id", "exit_country", "source_id", "best_per_server"];
const EXTRA = [
  ["exit_country", "落地国家（如 SG）", "text"],
  ["eligible", "参与检测", "select", [["", "全部"], ["true", "是"], ["false", "否"]]],
  ["enabled", "启用", "select", [["", "全部"], ["true", "已启用"], ["false", "已停用"]]],
];
const SPECS = new Map([...ADVANCED, ...EXTRA].map((spec) => [spec[0], spec]));
const DRAWER = [
  ["接入质量", ["max_peak_rtt_ms", "max_peak_loss", "min_avail_7d", "route_asn", "cross_border"]],
  ["落地", ["exit_country", "asn_label", "exit_asn", "exit_ip", "exit_ip_type", "exit_ip_proxy"]],
  ["入口", ["entry_country", "entry_asn", "server_host", "transport", "security"]],
  ["历史与标签", ["max_http_ms", "min_lifetime_availability", "min_available_days", "min_age_days", "tags", "eligible", "enabled"]],
];
const DRAWER_KEYS = DRAWER.flatMap(([, keys]) => keys);
const KEYS = [...new Set([...QUICK, ...DRAWER_KEYS])];
const PERCENT = ["min_success_rate", "max_timeout_rate", "min_lifetime_availability", "max_peak_loss", "min_avail_7d"];
const STATUS = [["", "全部状态"], ["UP", "可用"], ["DEGRADED", "较慢"], ["DOWN", "不可用"], ["UNKNOWN", "未检测"], ["STALE", "结果过期"], ["UNSUPPORTED", "不支持"]];
const GROUPS = [["", "全部类别"], ["SELF_HOSTED", "自建"], ["AIRPORT", "机场"]];
const SIZES = [50, 100, 200];
const FETCH_PAGE = 10000; // compact rows per request; there is no overall cap
// Database transfer is metered (Neon Free: 5 GB a month), so a loaded list is kept until
// something changes it (edits, finished tests or syncs) or the user presses 刷新.
const CACHE_MS = 10 * 60_000;

// Rows arrive as positional arrays; "fields" names the positions.
const objects = (page) => page.items.map((row) => Object.fromEntries(page.fields.map((name, i) => [name, row[i]])));

let cache = null;
async function load(filters) {
  const key = JSON.stringify(filters);
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.data;
  const fetchPage = (offset) =>
    api("/nodes?" + new URLSearchParams({ ...filters, sort: "short_id:asc", view: "compact", offset: String(offset), limit: String(FETCH_PAGE) }));
  const first = await fetchPage(0);
  const offsets = [];
  for (let offset = FETCH_PAGE; offset < first.total; offset += FETCH_PAGE) offsets.push(offset);
  const rest = await Promise.all(offsets.map(fetchPage));
  const data = { items: [first, ...rest].flatMap(objects), at: Date.now() };
  cache = { key, at: data.at, data };
  return data;
}
export const invalidateNodes = () => (cache = null);
window.addEventListener("nodema:nodes-changed", invalidateNodes);

// Links from older pages still say min_quality_grade=A / quality_grade=PENDING / unreachable.
function legacyBuckets(params) {
  const min = params.get("min_quality_grade");
  if (min) return BUCKETS.slice(0, BUCKETS.indexOf(min) + 1);
  if (params.get("quality_grade")) return [params.get("quality_grade")];
  if (params.get("unreachable") === "true") return ["D"];
  return [];
}

function display(key, value) {
  if (value === undefined || value === "") return "";
  const spec = SPECS.get(key);
  if (spec?.[2] === "select") return spec[3].find(([v]) => v === value)?.[1] || value;
  if (PERCENT.includes(key)) return value + "%";
  if (key.endsWith("_ms")) return value + " ms";
  return value;
}

export async function render(root, { params, go }) {
  const vantage = params.get("vantage") || (await defaultVantage());
  setRowVantage(vantage);
  const chosen = new Set((params.get("g") ? params.get("g").split(",") : legacyBuckets(params)).filter((b) => BUCKETS.includes(b)));
  const [sortKey, sortDir] = (params.get("sort") || "grade:asc").split(":");
  const size = SIZES.includes(Number(params.get("size"))) ? Number(params.get("size")) : SIZES[0];
  const filters = {};
  for (const key of KEYS) if (params.get(key)) filters[key] = params.get(key);
  const apiFilters = { ...filters, vantage };
  for (const key of PERCENT) if (apiFilters[key]) apiFilters[key] = String(Number(apiFilters[key]) / 100);
  const [{ items: all, at: loadedAt }, { providers }] = await Promise.all([load(apiFilters), api("/airports")]);

  // ---- navigation helpers (every state lives in the URL) ----
  const update = (changes, { keepPage = false } = {}) => {
    const next = new URLSearchParams(params);
    for (const legacy of ["view", "min_quality_grade", "quality_grade", "unreachable"]) next.delete(legacy);
    if (!next.has("g") && chosen.size) next.set("g", [...chosen].join(","));
    for (const [key, value] of Object.entries(changes)) value === "" || value == null ? next.delete(key) : next.set(key, value);
    if (!keepPage) next.delete("page");
    go("nodes", next);
  };

  // ---- grade bar: proportions on top, a toggle per bucket below ----
  const counts = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  for (const n of all) counts[bucketOf(n)]++;
  const track = h("div", { class: "spectrum-track", "aria-hidden": "true" });
  for (const b of BUCKETS) {
    if (!counts[b]) continue;
    const part = h("span", { class: "seg-" + b + (chosen.size && !chosen.has(b) ? " off" : "") });
    part.style.flexGrow = String(counts[b]); // CSSOM: the CSP forbids style attributes
    track.append(part);
  }
  const keys = h(
    "div",
    { class: "spectrum-keys", role: "group", "aria-label": "按等级筛选（可多选）" },
    BUCKETS.map((b) =>
      h(
        "button",
        {
          type: "button",
          class: "key key-" + b,
          "aria-pressed": String(chosen.has(b)),
          disabled: !counts[b] && !chosen.has(b),
          title: BUCKET_HINT[b],
          onclick: () => {
            const next = new Set(chosen);
            next.has(b) ? next.delete(b) : next.add(b);
            update({ g: [...next].join(",") });
          },
        },
        h("span", { class: "swatch", "aria-hidden": "true" }),
        h("span", { class: "key-name" }, BUCKET_TEXT[b]),
        h("span", { class: "key-count" }, counts[b].toLocaleString("zh-CN")),
      ),
    ),
    chosen.size ? h("button", { type: "button", class: "quiet clear-keys", onclick: () => update({ g: "" }) }, "显示全部") : null,
  );
  const spectrum = h("section", { class: "spectrum", "aria-label": "等级分布" }, track, keys);

  // ---- filter row ----
  const search = h("input", {
    name: "q",
    type: "search",
    class: "search",
    placeholder: "搜索名称、编号或主机",
    value: filters.q || "",
    "aria-label": "搜索节点",
    oninput: debounce((e) => update({ q: e.target.value.trim() }), 400),
  });
  const pill = (name, options) => {
    const el = select(name, options, filters[name] || "");
    el.classList.add("pill");
    el.classList.toggle("set", Boolean(filters[name]));
    el.setAttribute("aria-label", options[0][1]);
    el.addEventListener("change", () => update({ [name]: el.value }));
    return el;
  };
  const countries = [...new Set(all.map((n) => n.exit_country).filter(Boolean))].sort();
  if (filters.exit_country && !countries.includes(filters.exit_country)) countries.unshift(filters.exit_country);
  const advancedCount = DRAWER_KEYS.filter((k) => filters[k] && k !== "exit_country").length;
  const bestBox = h("input", { type: "checkbox", checked: filters.best_per_server === "true", onchange: (e) => update({ best_per_server: e.target.checked ? "true" : "" }) });
  const filterRow = h(
    "div",
    { class: "filter-row", role: "search" },
    search,
    pill("status", STATUS),
    pill("protocol", [["", "全部协议"], ...PROTOCOLS.map((p) => [p, p])]),
    pill("node_group", GROUPS),
    filters.node_group === "AIRPORT" || filters.provider_id ? pill("provider_id", [["", "全部机场"], ...providers.map((p) => [p.id, p.name])]) : null,
    pill("exit_country", [["", "全部落地"], ...countries.map((c) => [c, `${countryName(c)} ${c}`])]),
    h("button", { type: "button", class: "pill more" + (advancedCount ? " set" : ""), onclick: () => openDrawer() }, "更多筛选", advancedCount ? h("span", { class: "pill-n" }, advancedCount) : null),
    h("label", { class: "check best", title: "同一台落地服务器只保留当前视角等级最好的一个节点" }, bestBox, "每台服务器只看最好的"),
  );

  // ---- active filter chips ----
  const chips = Object.entries(filters)
    .filter(([key]) => key !== "q" && key !== "best_per_server")
    .map(([key, value]) => {
      const label = key === "provider_id" ? "机场" : key === "source_id" ? "来源" : key === "status" ? "状态" : key === "protocol" ? "协议" : key === "node_group" ? "类别" : SPECS.get(key)?.[1].replace(/（.*?）/g, "") || key;
      const shown =
        key === "provider_id" ? providers.find((p) => p.id === value)?.name || "已选" : key === "source_id" ? "已选来源" : key === "status" ? STATUS.find(([v]) => v === value)?.[1] : key === "node_group" ? GROUPS.find(([v]) => v === value)?.[1] : display(key, value);
      return h("button", { type: "button", class: "chip-x", title: "移除这个条件", onclick: () => update({ [key]: "" }) }, h("span", { class: "chip-k" }, label), shown, h("span", { class: "x", "aria-hidden": "true" }, "×"));
    });
  const chipRow = chips.length
    ? h("div", { class: "chip-row" }, chips, h("button", { type: "button", class: "quiet", onclick: () => go("nodes", new URLSearchParams({ vantage })) }, "清除全部条件"))
    : null;

  // ---- drawer with every other condition ----
  function openDrawer() {
    const form = h("form", { class: "drawer-form" });
    for (const [title, keys] of DRAWER)
      form.append(
        h(
          "fieldset",
          { class: "drawer-group" },
          h("legend", {}, title),
          keys.map((key) => {
            const [, label, kind, options] = SPECS.get(key);
            return field(label, control(key, kind, options, filters[key] ?? ""));
          }),
        ),
      );
    const box = h(
      "dialog",
      { class: "drawer", "aria-labelledby": "drawer-title" },
      h("header", {}, h("h2", { id: "drawer-title" }, "更多筛选"), h("button", { type: "button", class: "icon", "aria-label": "关闭", onclick: () => box.close() }, "✕")),
      form,
      h(
        "footer",
        {},
        h("button", { type: "button", class: "quiet", onclick: () => { for (const el of form.elements) if (el.name) el.value = ""; } }, "清空这些条件"),
        h("button", { type: "submit", class: "primary", form: "drawer-form" }, "应用"),
      ),
    );
    form.id = "drawer-form";
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const values = readFilters(form, DRAWER_KEYS);
      const changes = Object.fromEntries(DRAWER_KEYS.map((k) => [k, ""]));
      for (const [k, v] of Object.entries(values)) changes[k] = PERCENT.includes(k) ? String(v * 100) : Array.isArray(v) ? v.join(",") : String(v);
      box.close();
      update(changes);
    });
    box.addEventListener("close", () => box.remove());
    box.addEventListener("click", (e) => e.target === box && box.close()); // backdrop
    document.body.append(box);
    box.showModal();
  }

  // ---- local grade filter, sort and page ----
  const items = chosen.size ? all.filter((n) => chosen.has(bucketOf(n))) : all;
  const sorted = sortNodes(items, COLUMNS[sortKey] ? sortKey : "grade", sortDir === "desc" ? "desc" : "asc");
  const pages = Math.max(1, Math.ceil(sorted.length / size));
  const page = Math.min(Math.max(0, Number(params.get("page") || 0) || 0), pages - 1);
  const visible = sorted.slice(page * size, (page + 1) * size);

  // ---- selection across the whole filtered set ----
  const picked = new Set();
  const pickAll = h("input", { type: "checkbox", "aria-label": "选择本页节点" });
  const tbody = h("tbody");
  const bar = h("div", { class: "selection-bar", role: "region", "aria-label": "批量操作", hidden: true });
  const barCount = h("strong");
  const widen = h("button", { type: "button", class: "quiet" });
  const refreshPicks = () => {
    for (const box of tbody.querySelectorAll("input[data-id]")) {
      box.checked = picked.has(box.dataset.id);
      box.closest("tr").classList.toggle("picked", box.checked);
    }
    const onPage = visible.filter((n) => picked.has(n.id)).length;
    pickAll.checked = onPage > 0 && onPage === visible.length;
    pickAll.indeterminate = onPage > 0 && onPage < visible.length;
    bar.hidden = picked.size === 0;
    barCount.textContent = `已选 ${picked.size.toLocaleString("zh-CN")} 个`;
    widen.hidden = picked.size >= sorted.length;
    widen.textContent = `选中全部 ${sorted.length.toLocaleString("zh-CN")} 个结果`;
  };
  const toggle = (ids, on) => {
    for (const id of ids) on ? picked.add(id) : picked.delete(id);
    refreshPicks();
  };
  pickAll.addEventListener("change", () => toggle(visible.map((n) => n.id), pickAll.checked));
  widen.addEventListener("click", () => toggle(sorted.map((n) => n.id), true));
  const bulk = (enabled) => (e) =>
    busy(e.target, async () => {
      const ids = [...picked];
      let changed = 0;
      for (let i = 0; i < ids.length; i += 1000) changed += (await api("/nodes/batch", { method: "POST", body: { ids: ids.slice(i, i + 1000), enabled } })).changed;
      toast(`${enabled ? "已启用" : "已停用"} ${changed} 个节点。`, "ok");
      invalidateNodes();
      go("nodes", params);
    });
  bar.append(
    barCount,
    widen,
    h("span", { class: "bar-gap" }),
    h("button", { type: "button", class: "primary", onclick: async () => (await testNodes([...picked])) && toggle([...picked], false) }, "检测所选"),
    h("button", { type: "button", onclick: bulk(true) }, "启用"),
    h("button", { type: "button", onclick: bulk(false), title: "停用后不再检测和导出" }, "停用"),
    h("button", { type: "button", class: "quiet", onclick: () => toggle([...picked], false) }, "取消选择"),
  );

  // ---- table and pager ----
  const onSort = (key) => {
    const direction = key === sortKey ? (sortDir === "asc" ? "desc" : "asc") : COLUMNS[key][2];
    update({ sort: `${key}:${direction}` });
  };
  let body;
  if (!sorted.length) {
    const filtered = Object.keys(filters).length || chosen.size;
    body = h(
      "div",
      { class: "table-card" },
      empty(
        filtered ? "没有符合条件的节点" : "还没有节点",
        filtered ? "放宽或清除筛选条件后再看。" : "在“来源”页添加订阅或节点，然后点顶部“同步来源”。",
        filtered ? h("button", { type: "button", onclick: () => go("nodes", new URLSearchParams({ vantage })) }, "清除全部条件") : null,
      ),
    );
  } else {
    tbody.append(...visible.map((n) => nodeRow(n, false, toggle)));
    const from = page * size + 1;
    const to = Math.min(sorted.length, (page + 1) * size);
    body = h(
      "div",
      { class: "table-card" },
      h("div", { class: "table-wrap" }, h("table", { class: "nodes" }, headRow(sortKey, sortDir, onSort, pickAll), tbody)),
      h(
        "footer",
        { class: "table-foot" },
        h("span", { class: "range" }, `第 ${from.toLocaleString("zh-CN")}–${to.toLocaleString("zh-CN")} 个，共 ${sorted.length.toLocaleString("zh-CN")} 个`),
        h(
          "label",
          { class: "size" },
          "每页",
          select("size", SIZES.map((n) => [n, String(n)]), size),
        ),
        pageLinks(page, pages, (target) => update({ page: target ? String(target) : "" }, { keepPage: true })),
      ),
    );
    body.querySelector("select[name=size]").addEventListener("change", (e) => update({ size: e.target.value === String(SIZES[0]) ? "" : e.target.value }));
  }

  // ---- header ----
  const available = all.filter((n) => n.status === "UP" || n.status === "DEGRADED").length;
  root.append(
    h(
      "header",
      { class: "page-head" },
      h(
        "div",
        { class: "page-heading" },
        h("h1", { class: "page-title" }, "节点"),
        h("p", { class: "page-sub" }, `${all.length.toLocaleString("zh-CN")} 个，当前可用 ${available.toLocaleString("zh-CN")} 个`),
      ),
      h(
        "div",
        { class: "page-actions" },
        h("span", { class: "loaded", title: "列表会缓存 10 分钟以节省数据库流量" }, `${ago(new Date(loadedAt).toISOString())}载入`),
        h("button", { type: "button", onclick: () => { invalidateNodes(); go("nodes", params); } }, "刷新"),
      ),
    ),
    h("div", { class: "vantage-row" }, h("span", { class: "vantage-label" }, "等级视角"), vantageSwitch(vantage, (value) => update({ vantage: value }))),
    spectrum,
    filterRow,
    chipRow,
    body,
    bar,
  );
  refreshPicks();
}

// « 1 … 4 5 6 … 20 »
function pageLinks(page, pages, onPage) {
  if (pages <= 1) return h("span");
  const wanted = new Set([0, pages - 1, page - 1, page, page + 1].filter((p) => p >= 0 && p < pages));
  const list = [...wanted].sort((a, b) => a - b);
  const nav = h("nav", { class: "pages", "aria-label": "分页" });
  nav.append(h("button", { type: "button", class: "page-btn", disabled: page === 0, "aria-label": "上一页", onclick: () => onPage(page - 1) }, "‹"));
  list.forEach((p, i) => {
    if (i && p - list[i - 1] > 1) nav.append(h("span", { class: "gap" }, "…"));
    nav.append(h("button", { type: "button", class: "page-btn", "aria-current": p === page ? "page" : null, onclick: () => onPage(p) }, String(p + 1)));
  });
  nav.append(h("button", { type: "button", class: "page-btn", disabled: page === pages - 1, "aria-label": "下一页", onclick: () => onPage(page + 1) }, "›"));
  return nav;
}
