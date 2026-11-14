// Node list. The grade distribution is the page's headline and its grade filter; one
// row holds search, the view and two quick switches; every other condition sits in the
// "筛选" panel. Three views share the loaded set: a table, countries, and an ASN ranking.
import { ago, api, busy, debounce, empty, h, select, toast } from "../core.js";
import { testNodes } from "../strip.js";
import { BUCKETS, COLUMNS, bucketOf, headRow, nodeRow, setRowVantage, sortNodes } from "./node-rows.js";
import { countryView, revealCountry } from "./node-countries.js";
import { asnView } from "./node-asn.js";
import { ALL, API_KEYS, AVAILABLE, PERCENT, display, label, openPanel } from "./node-filters.js";
import { BUCKET_HINT, BUCKET_TEXT, VANTAGES, defaultVantage } from "../grades.js";

const SIZES = [50, 100, 200];
const VIEWS = [["", "列表"], ["country", "按国家"], ["asn", "ASN 排行"]];
// Local switches over the loaded rows (no new query): Wi-Fi Calling and residential IPs.
const QUICK = [
  ["udp", "UDP 可用", "经节点的 UDP 收到了回包（Wi-Fi Calling 需要）", (n) => n.udp === "SUCCESS"],
  ["home", "家宽 IP", "落地 IP 被 ip-api 标为家宽（不是机房）", (n) => n.exit_ip_type === "RESIDENTIAL"],
];
const FETCH_PAGE = 10000; // compact rows per request; there is no overall cap
// Database transfer is metered (Neon Free: 5 GB a month), so a loaded list is kept until
// something changes it (edits, finished tests or syncs) or the user presses 刷新.
const CACHE_MS = 10 * 60_000;
const count = (n) => n.toLocaleString("zh-CN");

// Rows arrive as positional arrays; "fields" names the positions.
const objects = (page) => page.items.map((row) => Object.fromEntries(page.fields.map((name, i) => [name, row[i]])));

let cache = null;
async function fetchAll(filters) {
  const fetchPage = (offset) =>
    api("/nodes?" + new URLSearchParams({ ...filters, sort: "short_id:asc", view: "compact", offset: String(offset), limit: String(FETCH_PAGE) }));
  const first = await fetchPage(0);
  const offsets = [];
  for (let offset = FETCH_PAGE; offset < first.total; offset += FETCH_PAGE) offsets.push(offset);
  const rest = await Promise.all(offsets.map(fetchPage));
  return [first, ...rest].flatMap(objects);
}

async function load(filters) {
  const key = JSON.stringify(filters);
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.data;
  const { status = AVAILABLE, ...rest } = filters;
  const statuses = status === AVAILABLE ? ["UP", "DEGRADED"] : status === ALL ? [null] : [status];
  const parts = await Promise.all(statuses.map((value) => fetchAll(value ? { ...rest, status: value } : rest)));
  const data = { items: parts.flat(), at: Date.now() };
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

export async function render(root, { params, go }) {
  const vantage = params.get("vantage") || (await defaultVantage());
  setRowVantage(vantage);
  const view = VIEWS.some(([v]) => v === params.get("by")) ? params.get("by") || "" : "";
  const chosen = new Set((params.get("g") ? params.get("g").split(",") : legacyBuckets(params)).filter((b) => BUCKETS.includes(b)));
  const quick = new Set(QUICK.filter(([key]) => params.get(key) === "1").map(([key]) => key));
  const [sortKey, sortDir] = (params.get("sort") || "grade:asc").split(":");
  const size = SIZES.includes(Number(params.get("size"))) ? Number(params.get("size")) : SIZES[0];
  const filters = {};
  for (const key of API_KEYS) if (params.get(key)) filters[key] = params.get(key);
  const apiFilters = { ...filters, vantage };
  for (const key of PERCENT) if (apiFilters[key]) apiFilters[key] = String(Number(apiFilters[key]) / 100);
  const [{ items: loaded, at: loadedAt }, { providers }] = await Promise.all([load(apiFilters), api("/airports")]);

  // Every state lives in the URL.
  const update = (changes, { keepPage = false } = {}) => {
    const next = new URLSearchParams(params);
    for (const legacy of ["view", "min_quality_grade", "quality_grade", "unreachable"]) next.delete(legacy);
    if (!next.has("g") && chosen.size) next.set("g", [...chosen].join(","));
    for (const [key, value] of Object.entries(changes)) value === "" || value == null ? next.delete(key) : next.set(key, value);
    if (!keepPage) next.delete("page");
    go("nodes", next);
  };
  const reset = () => go("nodes", new URLSearchParams({ vantage, ...(view ? { by: view } : {}) }));

  // Quick switches narrow the loaded set; grade buckets then narrow what is listed.
  const all = loaded.filter((n) => QUICK.every(([key, , , test]) => !quick.has(key) || test(n)));
  const counts = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  for (const n of all) counts[bucketOf(n)]++;
  const items = chosen.size ? all.filter((n) => chosen.has(bucketOf(n))) : all;
  const sorted = sortNodes(items, COLUMNS[sortKey] ? sortKey : "grade", sortDir === "desc" ? "desc" : "asc");

  // ---- headline: the grade distribution, one toggle per bucket ----
  const shown = BUCKETS.filter((b) => counts[b] || chosen.has(b) || ["S", "A", "B", "C", "D"].includes(b));
  const toggleBucket = (b) => {
    const next = new Set(chosen);
    next.has(b) ? next.delete(b) : next.add(b);
    update({ g: [...next].join(",") });
  };
  const track = h("div", { class: "spectrum-track", "aria-hidden": "true" });
  for (const b of BUCKETS) {
    if (!counts[b] || b === "OFF") continue;
    const part = h("span", { class: "seg-" + b + (chosen.size && !chosen.has(b) ? " off" : "") });
    part.style.flexGrow = String(counts[b]); // CSSOM: the CSP forbids style attributes
    track.append(part);
  }
  const vantagePick = select("vantage", VANTAGES, vantage);
  vantagePick.classList.add("vantage-pick");
  vantagePick.setAttribute("aria-label", "等级视角");
  vantagePick.addEventListener("change", () => update({ vantage: vantagePick.value }));
  const hero = h(
    "section",
    { class: "spectrum hero", "aria-label": "等级分布（点选筛选）" },
    h(
      "div",
      { class: "hero-top" },
      h("span", { class: "hero-label" }, "等级视角"),
      vantagePick,
      chosen.size ? h("button", { type: "button", class: "quiet clear-keys", onclick: () => update({ g: "" }) }, "取消等级筛选") : null,
    ),
    h(
      "div",
      { class: "tiles", role: "group", "aria-label": "按等级筛选（可多选）" },
      shown.map((b) =>
        h(
          "button",
          {
            type: "button",
            class: "tile tile-" + b + (chosen.size && !chosen.has(b) ? " dimmed" : ""),
            "aria-pressed": String(chosen.has(b)),
            disabled: !counts[b] && !chosen.has(b),
            title: BUCKET_HINT[b],
            onclick: () => toggleBucket(b),
          },
          h("span", { class: "tile-n" }, count(counts[b])),
          h("span", { class: "tile-name" }, h("span", { class: "swatch", "aria-hidden": "true" }), BUCKET_TEXT[b]),
        ),
      ),
    ),
    track.childElementCount ? track : null,
  );

  // ---- one control row ----
  const search = h("input", {
    name: "q",
    type: "search",
    class: "search",
    placeholder: "搜索名称、编号或主机",
    value: filters.q || "",
    "aria-label": "搜索节点",
    oninput: debounce((e) => update({ q: e.target.value.trim() }), 400),
  });
  const viewSwitch = h(
    "div",
    { class: "segmented", role: "group", "aria-label": "显示方式" },
    VIEWS.map(([value, text]) => h("button", { type: "button", class: "seg", "aria-pressed": String(view === value), onclick: () => update({ by: value, c: "", page: "", asort: "" }) }, text)),
  );
  const quickRow = QUICK.map(([key, text, hint, test]) =>
    h(
      "button",
      { type: "button", class: "toggle", "aria-pressed": String(quick.has(key)), title: hint, onclick: () => update({ [key]: quick.has(key) ? "" : "1" }) },
      text,
      h("span", { class: "toggle-n" }, count(loaded.filter(test).length)),
    ),
  );
  const panelSet = Object.keys(filters).filter((k) => k !== "q" && k !== "source_id").length;
  const countries = [...new Set(loaded.map((n) => n.exit_country).filter(Boolean))].sort();
  if (filters.exit_country && !countries.includes(filters.exit_country)) countries.unshift(filters.exit_country);
  const panelButton = h(
    "button",
    { type: "button", class: "toggle panel-button" + (panelSet ? " set" : ""), onclick: () => openPanel({ filters, providers, countries, onApply: (changes) => update(changes) }) },
    "筛选",
    panelSet ? h("span", { class: "pill-n" }, panelSet) : null,
  );
  const controls = h("div", { class: "controls", role: "search" }, search, viewSwitch, h("div", { class: "quick" }, quickRow, panelButton));

  // Conditions from the panel (and links from other pages), each removable.
  const chips = Object.entries(filters)
    .filter(([key]) => key !== "q")
    .map(([key, value]) => {
      const shownValue = key === "provider_id" ? providers.find((p) => p.id === value)?.name || "已选" : key === "source_id" ? "已选来源" : display(key, value);
      return h("button", { type: "button", class: "chip-x", title: "移除这个条件", onclick: () => update({ [key]: "" }) }, h("span", { class: "chip-k" }, label(key)), shownValue, h("span", { class: "x", "aria-hidden": "true" }, "×"));
    });
  const chipRow = chips.length ? h("div", { class: "chip-row" }, chips, h("button", { type: "button", class: "quiet", onclick: reset }, "清除全部条件")) : null;

  // ---- selection across the whole filtered set ----
  // Each checkbox in a table head selects a known set of ids (the page, or an ASN group).
  const picked = new Set();
  const scope = [];
  const rowsRoot = h("div", { class: "rows-root" });
  const bar = h("div", { class: "selection-bar", role: "region", "aria-label": "批量操作", hidden: true });
  const barCount = h("strong");
  const widen = h("button", { type: "button", class: "quiet" });
  const refreshPicks = () => {
    for (const box of rowsRoot.querySelectorAll("input[data-id]")) {
      box.checked = picked.has(box.dataset.id);
      box.closest("tr").classList.toggle("picked", box.checked);
    }
    for (const { box, ids } of scope) {
      const on = ids.filter((id) => picked.has(id)).length;
      box.checked = on > 0 && on === ids.length;
      box.indeterminate = on > 0 && on < ids.length;
    }
    bar.hidden = picked.size === 0;
    barCount.textContent = `已选 ${count(picked.size)} 个`;
    widen.hidden = picked.size >= sorted.length;
    widen.textContent = `选中全部 ${count(sorted.length)} 个结果`;
  };
  const toggle = (ids, on) => {
    for (const id of ids) on ? picked.add(id) : picked.delete(id);
    refreshPicks();
  };
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

  // ---- body ----
  const onSort = (key) => {
    const direction = key === sortKey ? (sortDir === "asc" ? "desc" : "asc") : COLUMNS[key][2];
    update({ sort: `${key}:${direction}` }, { keepPage: view === "country" });
  };
  let body;
  if (!sorted.length) {
    const filtered = Object.keys(filters).length || chosen.size || quick.size;
    body = h(
      "div",
      { class: "table-card" },
      empty(
        filtered ? "没有符合条件的节点" : "现在没有可用节点",
        filtered ? "放宽或清除条件后再看。" : "在“筛选”里把状态改成“全部状态”，可以看到不可用和未检测的节点。",
        filtered ? h("button", { type: "button", onclick: reset }, "清除全部条件") : null,
      ),
    );
  } else if (view === "country") {
    const result = countryView(sorted, {
      country: params.get("c"),
      onCountry: (code) => update({ c: code }),
      sortKey: COLUMNS[sortKey] ? sortKey : "grade",
      sortDir: sortDir === "desc" ? "desc" : "asc",
      onSort,
      onPick: toggle,
    });
    scope.push(...result.scope);
    rowsRoot.append(result.element);
    body = rowsRoot;
  } else if (view === "asn") {
    body = asnView(sorted, {
      sort: params.get("asort"),
      onSort: (value) => update({ asort: value }),
      onOpen: (asn) => update({ by: "", exit_asn: asn ? String(asn) : "", asort: "" }),
    });
  } else {
    const pages = Math.max(1, Math.ceil(sorted.length / size));
    const page = Math.min(Math.max(0, Number(params.get("page") || 0) || 0), pages - 1);
    const pickAll = h("input", { type: "checkbox", "aria-label": "选择本页节点" });
    const pageNodes = sorted.slice(page * size, (page + 1) * size);
    pickAll.addEventListener("change", () => toggle(pageNodes.map((n) => n.id), pickAll.checked));
    scope.push({ box: pickAll, ids: pageNodes.map((n) => n.id) });
    const tbody = h("tbody", {}, pageNodes.map((n) => nodeRow(n, false, toggle)));
    const sizePick = select("size", SIZES.map((n) => [n, String(n)]), size);
    sizePick.addEventListener("change", () => update({ size: sizePick.value === String(SIZES[0]) ? "" : sizePick.value }));
    rowsRoot.append(
      h(
        "div",
        { class: "table-card" },
        h("div", { class: "table-wrap" }, h("table", { class: "nodes" }, headRow(sortKey, sortDir, onSort, pickAll), tbody)),
        h(
          "footer",
          { class: "table-foot" },
          h("span", { class: "range" }, `第 ${count(page * size + 1)}–${count(Math.min(sorted.length, (page + 1) * size))} 个，共 ${count(sorted.length)} 个`),
          h("label", { class: "size" }, "每页", sizePick),
          pageLinks(page, pages, (target) => update({ page: target ? String(target) : "" }, { keepPage: true })),
        ),
      ),
    );
    body = rowsRoot;
  }

  // ---- header ----
  const available = loaded.filter((n) => n.status === "UP" || n.status === "DEGRADED").length;
  const subtitle = filters.status ? `${count(loaded.length)} 个节点，其中可用 ${count(available)} 个` : `${count(loaded.length)} 个可用节点`;
  root.append(
    h(
      "header",
      { class: "page-head" },
      h(
        "div",
        { class: "page-heading" },
        h("h1", { class: "page-title" }, "节点"),
        h(
          "p",
          { class: "page-sub" },
          subtitle,
          filters.status ? null : h("button", { type: "button", class: "link sub-link", title: "包括不可用、未检测和结果过期的节点", onclick: () => update({ status: ALL }) }, "看全部状态"),
        ),
      ),
      h(
        "div",
        { class: "page-actions" },
        h("span", { class: "loaded", title: "列表会缓存 10 分钟以节省数据库流量" }, `${ago(new Date(loadedAt).toISOString())}载入`),
        h("button", { type: "button", onclick: () => { invalidateNodes(); go("nodes", params); } }, "刷新"),
      ),
    ),
    hero,
    controls,
    chipRow,
    body,
    bar,
  );
  refreshPicks();
  if (view === "country") requestAnimationFrame(() => revealCountry(root)); // after the router mounts the page
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
