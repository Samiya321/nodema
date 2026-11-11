import { KIND, ago, api, badge, busy, confirm, debounce, dialog, empty, errorText, field, h, pager, select, table, toast } from "../core.js";
import { syncSources } from "../strip.js";

function validity(s) {
  if (s.last_sync_status === "NEVER" || !s.last_checked_at) return ["未同步", "mute"];
  if (s.last_sync_status === "FAILED") return ["失效", "bad"];
  return ["有效", "ok"];
}

const CHILD_PAGE = 50;

async function children(store) {
  const detail = await api("/substores/" + store.id);
  const missing = new Set(store.last_parse_summary?.children?.missing_from_index || []);
  const columns = [
    { label: "子来源", render: (c) => h("div", { class: "name-cell" }, h("span", { class: "node-name" }, c.origin_label || c.name), h("span", { class: "muted small" }, c.type === "RAW_TEXT" ? "本地节点" : c.url_host || "远程订阅")) },
    { label: "类别", render: (c) => KIND[c.kind !== "AUTO" ? c.kind : c.detected_kind === "AIRPORT" ? "AIRPORT" : "SELF_HOSTED"] },
    { label: "同步", render: (c) => h("div", { class: "name-cell" }, badge(c.last_sync_status), c.last_error_code ? h("span", { class: "small bad-text" }, errorText(c.last_error_code)) : null) },
    { label: "节点", class: "num", render: (c) => h("a", { href: `#/nodes?source_id=${c.id}` }, c.node_count) },
    { label: "Sub-Store 中", render: (c) => (missing.has(c.id) ? h("span", { class: "warn-text" }, "已移除，子来源保留") : "存在") },
    { label: "最近成功", render: (c) => ago(c.last_success_at) },
  ];
  const search = h("input", { type: "search", placeholder: "搜索子来源", "aria-label": "搜索子来源" });
  const onlyFailed = h("input", { type: "checkbox" });
  const holder = h("div");
  let page = 0;
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const rows = detail.children.filter(
      (c) =>
        (!onlyFailed.checked || c.last_sync_status === "FAILED") &&
        (!q || `${c.origin_label || ""} ${c.name} ${c.url_host || ""}`.toLowerCase().includes(q)),
    );
    const pages = Math.max(1, Math.ceil(rows.length / CHILD_PAGE));
    page = Math.min(page, pages - 1);
    holder.replaceChildren(
      table(columns, rows.slice(page * CHILD_PAGE, (page + 1) * CHILD_PAGE), {
        empty: detail.children.length ? empty("没有符合条件的子来源") : empty("还没有子来源", "同步一次 Sub-Store 后生成。"),
      }),
      pager(page, pages, (target) => {
        page = target;
        draw();
      }),
    );
  };
  search.addEventListener("input", debounce(() => { page = 0; draw(); }, 200));
  onlyFailed.addEventListener("change", () => { page = 0; draw(); });
  draw();
  dialog(
    `「${store.name}」的子来源（${detail.children.length}）`,
    h(
      "div",
      { class: "stack" },
      h("p", { class: "hint" }, "每个子来源独立拉取：Sub-Store 失效后，已生成的子来源和节点照常保留与同步。"),
      h("div", { class: "toolbar" }, search, h("label", { class: "check" }, onlyFailed, "只看失败")),
      holder,
    ),
    { wide: true },
  );
}

const STATES = [
  ["", "全部状态"],
  ["ok", "有效"],
  ["failed", "失效"],
  ["never", "未同步"],
  ["child_failed", "有子来源失败"],
];
const SORTS = [
  ["name", "按名称"],
  ["problems", "问题优先"],
  ["children", "子来源多→少"],
  ["nodes", "节点多→少"],
  ["recent", "最近有效"],
];
const collator = new Intl.Collator("zh-CN", { numeric: true });
const RANK = { failed: 0, never: 1, ok: 2 };
const stateOf = (s) => (s.last_sync_status === "NEVER" || !s.last_checked_at ? "never" : s.last_sync_status === "FAILED" ? "failed" : "ok");
const ORDER = {
  name: (a, b) => collator.compare(a.name, b.name),
  problems: (a, b) => RANK[stateOf(a)] - RANK[stateOf(b)] || b.failed_children - a.failed_children || collator.compare(a.name, b.name),
  children: (a, b) => b.children - a.children || collator.compare(a.name, b.name),
  nodes: (a, b) => b.node_count - a.node_count || collator.compare(a.name, b.name),
  recent: (a, b) => String(b.last_success_at || "").localeCompare(String(a.last_success_at || "")) || collator.compare(a.name, b.name),
};

export async function render(root, { params, go, refresh, refreshStrip }) {
  const all = await api("/substores");
  const q = (params.get("q") || "").toLowerCase();
  const state = params.get("state") || "";
  const sort = ORDER[params.get("sort")] ? params.get("sort") : "name";
  const stores = all
    .filter(
      (s) =>
        (!q || `${s.name} ${s.url_host || ""}`.toLowerCase().includes(q)) &&
        (!state || (state === "child_failed" ? s.failed_children > 0 : stateOf(s) === state)),
    )
    .sort(ORDER[sort]);
  const set = (key, value) => {
    value ? params.set(key, value) : params.delete(key);
    go("substore", params);
  };
  const reload = () => {
    refresh();
    refreshStrip();
  };
  const form = h(
    "form",
    { class: "row wrap" },
    field("名称", h("input", { name: "name", required: true, maxlength: 80, value: "Sub-Store" })),
    field("API 地址", h("input", { name: "payload", type: "url", required: true, size: 48, placeholder: "https://…/api/subs" })),
    h("button", { type: "submit", class: "primary" }, "添加"),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    await busy(e.submitter, async () => {
      await api("/sources", { method: "POST", body: { ...Object.fromEntries(new FormData(form)), type: "SUBSCRIPTION_URL" } });
      toast("已添加。点击顶部“同步来源”读取订阅列表。", "ok");
      reload();
    });
  });
  const remove = (store) => async (e) => {
    const box = h("label", { class: "check" }, h("input", { type: "checkbox" }), "同时删除它生成的子来源（自建节点仍保留）");
    if (!(await confirm("删除 Sub-Store", `删除「${store.name}」？默认保留子来源，它们会继续独立同步。`, { action: "删除", danger: true, extra: box }))) return;
    await busy(e.target, async () => {
      await api("/sources/batch", { method: "POST", body: { ids: [store.id], action: "delete", include_children: box.querySelector("input").checked } });
      reload();
    });
  };
  const sync = (store) => (e) => syncSources([store.id], e.target);
  root.append(
    h("h1", { class: "page-title" }, "Sub-Store"),
    h("p", { class: "hint" }, "Nodema 只读取 Sub-Store 的订阅列表（/api/subs），把其中的远程订阅和本地节点拆成独立的子来源，不执行 Sub-Store 脚本。"),
    h("section", { class: "panel" }, form),
    h(
      "dl",
      { class: "stats" },
      h("div", {}, h("dt", {}, "Sub-Store"), h("dd", {}, all.length)),
      h("div", {}, h("dt", {}, "失效"), h("dd", {}, all.filter((s) => stateOf(s) === "failed").length)),
      h("div", {}, h("dt", {}, "子来源"), h("dd", {}, all.reduce((n, s) => n + s.children, 0))),
      h("div", {}, h("dt", {}, "子来源失败"), h("dd", {}, all.reduce((n, s) => n + s.failed_children, 0))),
    ),
    h(
      "div",
      { class: "toolbar" },
      h("input", { type: "search", placeholder: "搜索名称或域名", value: params.get("q") || "", "aria-label": "搜索 Sub-Store", onchange: (e) => set("q", e.target.value) }),
      select("state", STATES, state),
      select("sort", SORTS, sort),
    ),
    table(
      [
        { label: "Sub-Store", render: (s) => h("div", { class: "name-cell" }, h("span", { class: "node-name" }, s.name), h("span", { class: "muted small" }, s.url_host)) },
        {
          label: "API 状态",
          render: (s) => {
            const [text, tone] = validity(s);
            return h("div", { class: "name-cell" }, h("span", { class: "badge " + tone }, text), s.last_error_code ? h("span", { class: "small bad-text" }, errorText(s.last_error_code)) : null);
          },
        },
        { label: "最近有效", render: (s) => ago(s.last_success_at) },
        { label: "子来源", render: (s) => h("button", { type: "button", class: "link", onclick: () => children(s) }, `${s.healthy_children} 正常`, s.failed_children ? h("span", { class: "bad-text" }, ` · ${s.failed_children} 失败`) : "", ` / ${s.children}`) },
        { label: "节点", class: "num", render: (s) => s.node_count },
        {
          label: "",
          render: (s) =>
            h(
              "div",
              { class: "row tight" },
              h("button", { type: "button", class: "quiet", onclick: sync(s) }, "同步"),
              h("button", { type: "button", class: "quiet danger-text", onclick: remove(s) }, "删除"),
            ),
        },
      ],
      stores,
      { empty: all.length ? empty("没有符合条件的 Sub-Store", "调整搜索或筛选。") : empty("还没有 Sub-Store", "在上方填入 Sub-Store 后端的 /api/subs 地址。") },
    ),
  );
  root.querySelector("select[name=state]").addEventListener("change", (e) => set("state", e.target.value));
  root.querySelector("select[name=sort]").addEventListener("change", (e) => set("sort", e.target.value === "name" ? "" : e.target.value));
}
