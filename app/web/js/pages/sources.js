import {
  KIND,
  ago,
  api,
  badge,
  busy,
  confirm,
  dialog,
  empty,
  errorText,
  field,
  h,
  pager,
  select,
  selection,
  table,
  toast,
} from "../core.js";
import { syncSources } from "../strip.js";

const TYPES = { SUBSCRIPTION_URL: "订阅链接", RAW_TEXT: "节点文本", UPLOADED_FILE: "上传文件", SINGLE_URI: "单个节点" };
const VIEWS = [
  ["", "全部"],
  ["SELF_HOSTED", "自建"],
  ["AIRPORT", "机场"],
  ["SUBSTORE", "Sub-Store"],
  ["CHILD", "来自 Sub-Store"],
];

function importPanel(refresh, open = false) {
  const result = h("div", { "aria-live": "polite" });
  const links = h(
    "form",
    { class: "stack" },
    field(
      "订阅链接或 Sub-Store API（每行一个，最多 100 个）",
      h("textarea", { name: "urls", rows: 5, required: true, placeholder: "https://example.com/sub?token=…\nhttps://substore.example.com/api/subs" }),
      "保存后不会立即拉取；准备好后点击顶部“同步来源”。带流量信息的订阅会自动识别为机场。",
    ),
    h("div", { class: "row" }, field("名称前缀", h("input", { name: "name_prefix", value: "订阅", maxlength: 60 })), h("button", { class: "primary", type: "submit" }, "保存链接")),
  );
  links.addEventListener("submit", async (e) => {
    e.preventDefault();
    await busy(e.submitter, async () => {
      const r = await api("/sources/bulk", { method: "POST", body: Object.fromEntries(new FormData(links)) });
      result.replaceChildren(
        h(
          "div",
          { class: "callout row wrap" },
          h("span", {}, `新增 ${r.created} 个，已存在 ${r.duplicates} 个，无效 ${r.invalid} 个。`),
          r.created
            ? h("button", { type: "button", class: "primary", onclick: (e) => syncSources(r.items.filter((i) => i.status === "CREATED").map((i) => i.id), e.target) }, "立即同步这些来源")
            : null,
        ),
        r.invalid
          ? h("ul", { class: "plain" }, r.items.filter((i) => i.status === "INVALID").map((i) => h("li", {}, `第 ${i.line} 行：${errorText(i.error_code)}`)))
          : null,
      );
      if (r.created) {
        links.reset();
        refresh();
      }
    });
  });
  const text = h(
    "form",
    { class: "stack" },
    field("名称", h("input", { name: "name", required: true, maxlength: 80 })),
    field(
      "节点内容",
      h("textarea", { name: "payload", rows: 6, required: true, placeholder: "vless://…、trojan://… 每行一个，或粘贴 Clash / sing-box 配置" }),
      "适合自建节点。内容以明文保存在你的数据库中。",
    ),
    h("div", { class: "row" }, field("类别", select("kind", [["SELF_HOSTED", "自建"], ["AUTO", "自动识别"], ["AIRPORT", "机场"]], "SELF_HOSTED")), h("button", { class: "primary", type: "submit" }, "保存节点")),
  );
  text.addEventListener("submit", async (e) => {
    e.preventDefault();
    await busy(e.submitter, async () => {
      const saved = await api("/sources", { method: "POST", body: { ...Object.fromEntries(new FormData(text)), type: "RAW_TEXT" } });
      result.replaceChildren(
        h("div", { class: "callout row wrap" }, h("span", {}, "已保存。"), h("button", { type: "button", class: "primary", onclick: (e) => syncSources([saved.id], e.target) }, "立即同步并解析")),
      );
      text.reset();
      refresh();
    });
  });
  return h(
    "details",
    { class: "panel import", open },
    h("summary", {}, "添加来源"),
    h("div", { class: "grid-2" }, h("section", {}, h("h3", {}, "链接"), links), h("section", {}, h("h3", {}, "节点文本"), text)),
    result,
  );
}

export function editSource(source, done) {
  const form = h(
    "form",
    { class: "form-grid" },
    field("名称", h("input", { name: "name", value: source.name, required: true, maxlength: 80 })),
    field("类别", select("kind", [["AUTO", `自动识别（当前：${KIND[source.detected_kind] || "未识别"}）`], ["SELF_HOSTED", "自建"], ["AIRPORT", "机场"]], source.kind), "机场节点只在你选择检测机场时参与；过期或流量用完会自动停测。"),
    source.type === "SUBSCRIPTION_URL"
      ? field("User-Agent", h("input", { name: "user_agent", value: source.user_agent || "", placeholder: "默认 clash.meta" }), "部分机场只对特定客户端返回流量信息。")
      : null,
    field("启用同步", select("enabled", [["true", "启用"], ["false", "暂停"]], String(source.enabled)), "暂停只停止拉取；自建节点继续保留和检测。"),
    field(
      source.type === "SUBSCRIPTION_URL" ? "更换链接（留空不变）" : "替换内容（留空不变）",
      h("textarea", { name: "payload", rows: 3 }),
    ),
    h("div", { class: "row end wide" }, h("button", { class: "primary", type: "submit" }, "保存")),
  );
  const box = dialog("编辑来源", form);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const body = { name: data.name, kind: data.kind, enabled: data.enabled === "true" };
    if ("user_agent" in data) body.user_agent = data.user_agent || null;
    if (data.payload) body.payload = data.payload;
    await busy(e.submitter, async () => {
      await api("/sources/" + source.id, { method: "PATCH", body });
      toast(data.payload ? "已保存，同步后生效。" : "已保存。", "ok");
      box.close();
      done();
    });
  });
}

const PAGE = 50;
const SORT_OPTIONS = [
  ["name", "按名称"],
  ["problems", "失败优先"],
  ["nodes", "节点多→少"],
  ["recent", "最近成功"],
];
const STATUS_RANK = { FAILED: 0, PARTIAL: 1, NEVER: 2, SUCCESS: 3 };
const collator = new Intl.Collator("zh-CN", { numeric: true });
const ORDER = {
  name: (a, b) => collator.compare(a.name, b.name),
  problems: (a, b) => (STATUS_RANK[a.last_sync_status] ?? 9) - (STATUS_RANK[b.last_sync_status] ?? 9) || collator.compare(a.name, b.name),
  nodes: (a, b) => (b.node_count || 0) - (a.node_count || 0) || collator.compare(a.name, b.name),
  recent: (a, b) => String(b.last_success_at || "").localeCompare(String(a.last_success_at || "")) || collator.compare(a.name, b.name),
};

export async function render(root, { params, go, refresh, refreshStrip }) {
  const all = await api("/sources");
  const view = params.get("view") || "";
  const status = params.get("status") || "";
  const sort = ORDER[params.get("sort")] ? params.get("sort") : "name";
  const q = (params.get("q") || "").toLowerCase();
  const names = Object.fromEntries(all.map((s) => [s.id, s.name]));
  const list = all
    .filter((s) => {
      if (view === "CHILD" ? !s.parent_source_id : view && s.effective_kind !== view) return false;
      if (status && s.last_sync_status !== status) return false;
      return !q || s.name.toLowerCase().includes(q) || (s.url_host || "").includes(q);
    })
    .sort(ORDER[sort]);
  // Without a search or status filter, Sub-Store children fold under their parent.
  const nested = !q && !status && (view === "" || view === "SUBSTORE");
  const inList = new Set(list.map((s) => s.id));
  const children = new Map();
  if (nested)
    for (const s of list)
      if (s.parent_source_id && names[s.parent_source_id]) {
        if (!children.has(s.parent_source_id)) children.set(s.parent_source_id, []);
        children.get(s.parent_source_id).push(s);
      }
  // In the Sub-Store view children are not in the list; fetch them from all sources.
  if (nested && view === "SUBSTORE")
    for (const s of all)
      if (s.parent_source_id && inList.has(s.parent_source_id) && !inList.has(s.id)) {
        if (!children.has(s.parent_source_id)) children.set(s.parent_source_id, []);
        children.get(s.parent_source_id).push(s);
      }
  for (const group of children.values()) group.sort(ORDER[sort]);
  const top = nested ? list.filter((s) => !(s.parent_source_id && names[s.parent_source_id])) : list;
  const pages = Math.max(1, Math.ceil(top.length / PAGE));
  const page = Math.min(Math.max(0, Number(params.get("page") || 0) || 0), pages - 1);
  const expanded = new Set();
  const reload = () => {
    refresh();
    refreshStrip();
  };
  const set = (key, value) => {
    value ? params.set(key, value) : params.delete(key);
    if (key !== "page") params.delete("page");
    go("sources", params);
  };
  const bar = h("div", { class: "bulkbar" });
  const count = h("span", { class: "bulk-count" });
  const allBox = h("input", { type: "checkbox", "aria-label": "全选" });
  const selectable = nested ? [...top, ...[...children.values()].flat()] : list;
  const picked = selection((chosen) => {
    count.textContent = chosen.size ? `已选 ${chosen.size} 个` : `共 ${selectable.length} 个来源`;
    bar.classList.toggle("active", chosen.size > 0);
    for (const button of bar.querySelectorAll("button")) button.disabled = !chosen.size;
    allBox.checked = chosen.size > 0 && chosen.size === selectable.length;
    allBox.indeterminate = chosen.size > 0 && chosen.size < selectable.length;
    for (const box of root.querySelectorAll("input[data-source]")) box.checked = chosen.has(box.dataset.source);
  });
  allBox.addEventListener("change", () => {
    for (const s of selectable) allBox.checked ? picked.ids.add(s.id) : picked.ids.delete(s.id);
    picked.refresh();
  });
  const batch = (action, done) => async (e) => {
    let ids = [...picked.ids];
    let include = false;
    if (action === "delete") {
      const hasParents = all.some((s) => ids.includes(s.id) && s.effective_kind === "SUBSTORE");
      const box = hasParents ? h("label", { class: "check" }, h("input", { type: "checkbox" }), "同时删除这些 Sub-Store 生成的子来源") : null;
      if (!(await confirm("删除来源", `删除 ${ids.length} 个来源？自建节点会保留并继续检测；机场节点随订阅停止检测。`, { action: "删除", danger: true, extra: box }))) return;
      include = Boolean(box?.querySelector("input").checked);
      // Folded children picked up by "select all" follow the checkbox, not the selection.
      if (!include) {
        const chosen = new Set(ids);
        const parentOf = Object.fromEntries(all.map((s) => [s.id, s.parent_source_id]));
        ids = ids.filter((id) => !chosen.has(parentOf[id]));
      }
      if (!ids.length) return;
    }
    await busy(e.target, async () => {
      const r = await api("/sources/batch", { method: "POST", body: { ids, action, include_children: include } });
      toast(done(r.changed), "ok");
      picked.clear();
      reload();
    });
  };
  bar.append(
    h("label", { class: "check", title: "选择当前筛选条件下的全部来源（含其他页和折叠的子来源）" }, allBox, "全选"),
    count,
    h("button", { type: "button", class: "primary", onclick: async (e) => { if (await syncSources([...picked.ids], e.target)) { picked.clear(); reload(); } } }, "同步所选"),
    h("button", { type: "button", onclick: batch("enable", (n) => `已启用 ${n} 个。`) }, "启用"),
    h("button", { type: "button", onclick: batch("disable", (n) => `已暂停 ${n} 个。`) }, "暂停"),
    h("button", { type: "button", class: "danger", onclick: batch("delete", (n) => `已删除 ${n} 个。`) }, "删除"),
  );
  const childSummary = (s) => {
    const kids = children.get(s.id) || [];
    const failed = kids.filter((k) => k.last_sync_status === "FAILED").length;
    const nodes = kids.reduce((n, k) => n + (k.node_count || 0), 0);
    const up = kids.reduce((n, k) => n + (k.up_count || 0), 0);
    if (!kids.length) return h("span", { class: "muted small" }, "同步后生成子来源");
    return h(
      "button",
      { type: "button", class: "link", "aria-expanded": String(expanded.has(s.id)), onclick: () => { expanded.has(s.id) ? expanded.delete(s.id) : expanded.add(s.id); draw(); } },
      `${expanded.has(s.id) ? "▾" : "▸"} ${kids.length} 个子来源`,
      failed ? h("span", { class: "bad-text" }, ` · ${failed} 失败`) : "",
      h("span", { class: "muted small" }, ` · ${up} 可用 / ${nodes} 节点`),
    );
  };
  const columns = [
    { label: "", class: "pick", render: (s) => { const box = picked.box(s.id); box.dataset.source = s.id; return box; } },
    {
      label: "来源",
      render: (s) =>
        h(
          "div",
          { class: "name-cell" + (nested && s.parent_source_id ? " child" : "") },
          h("span", { class: "node-name" }, s.name, s.enabled ? "" : h("span", { class: "muted" }, "（已暂停）")),
          h("span", { class: "muted small" }, [TYPES[s.type], s.url_host, !nested && s.parent_source_id ? `来自 ${names[s.parent_source_id] || "已删除的 Sub-Store"}` : ""].filter(Boolean).join(" · ")),
        ),
    },
    {
      label: "类别",
      render: (s) =>
        s.kind === "AUTO" && s.detected_kind === "UNKNOWN" && s.effective_kind !== "SUBSTORE"
          ? h("span", { class: "tag", title: "同步后根据响应自动识别为自建或机场" }, "待识别")
          : h("span", { class: "tag " + ({ AIRPORT: "air", SUBSTORE: "store" }[s.effective_kind] || "own") }, KIND[s.effective_kind]),
    },
    { label: "同步", render: (s) => h("div", { class: "name-cell" }, badge(s.last_sync_status), s.last_error_code ? h("span", { class: "small bad-text" }, errorText(s.last_error_code)) : null, s.sync_requested_at ? h("span", { class: "small muted" }, "待同步") : null) },
    {
      label: "节点",
      class: "num",
      render: (s) => (s.effective_kind === "SUBSTORE" ? (nested ? childSummary(s) : h("a", { href: "#/substore" }, "见子来源")) : h("a", { href: `#/nodes?source_id=${s.id}` }, `${s.up_count} 可用 / ${s.node_count}`)),
    },
    { label: "最近成功", render: (s) => ago(s.last_success_at) },
    { label: "", render: (s) => h("button", { type: "button", class: "quiet", onclick: () => editSource(s, reload) }, "编辑") },
  ];
  const holder = h("div");
  const draw = () => {
    const rows = [];
    for (const s of top.slice(page * PAGE, (page + 1) * PAGE)) {
      rows.push(s);
      if (expanded.has(s.id)) rows.push(...(children.get(s.id) || []));
    }
    holder.replaceChildren(
      table(columns, rows, {
        empty: all.length ? empty("没有符合条件的来源") : empty("还没有来源", "展开上方“添加来源”，粘贴订阅链接、Sub-Store API 或节点。"),
        rowClass: (s) => [s.enabled ? "" : "dim", nested && s.parent_source_id ? "child-row" : ""].join(" ").trim(),
      }),
      pager(page, pages, (target) => set("page", target ? String(target) : "")),
    );
    picked.refresh();
  };
  root.append(
    h("h1", { class: "page-title" }, "来源"),
    importPanel(reload, all.length === 0),
    h(
      "div",
      { class: "toolbar" },
      h("input", { type: "search", placeholder: "搜索名称或域名", value: params.get("q") || "", "aria-label": "搜索来源", onchange: (e) => set("q", e.target.value) }),
      h("div", { class: "segmented", role: "group", "aria-label": "来源类别" }, VIEWS.map(([key, text]) => h("button", { type: "button", class: "seg", "aria-pressed": String(view === key), onclick: () => set("view", key) }, text))),
      select("status", [["", "全部状态"], ["SUCCESS", "成功"], ["PARTIAL", "部分成功"], ["FAILED", "失败"], ["NEVER", "未同步"]], status),
      select("sort", SORT_OPTIONS, sort),
    ),
    bar,
    holder,
  );
  root.querySelector("select[name=status]").addEventListener("change", (e) => set("status", e.target.value));
  root.querySelector("select[name=sort]").addEventListener("change", (e) => set("sort", e.target.value === "name" ? "" : e.target.value));
  draw();
}
