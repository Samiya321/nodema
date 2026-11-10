import { KIND, ago, api, badge, busy, confirm, dialog, empty, errorText, field, h, table, toast } from "../core.js";

function validity(s) {
  if (s.last_sync_status === "NEVER" || !s.last_checked_at) return ["未同步", "mute"];
  if (s.last_sync_status === "FAILED") return ["失效", "bad"];
  return ["有效", "ok"];
}

async function children(store, reload) {
  const detail = await api("/substores/" + store.id);
  const missing = new Set(store.last_parse_summary?.children?.missing_from_index || []);
  dialog(
    `「${store.name}」的子来源`,
    h(
      "div",
      { class: "stack" },
      h("p", { class: "hint" }, "每个子来源独立拉取：Sub-Store 失效后，已生成的子来源和节点照常保留与同步。"),
      table(
        [
          { label: "子来源", render: (c) => h("div", { class: "name-cell" }, h("span", { class: "node-name" }, c.origin_label || c.name), h("span", { class: "muted small" }, c.type === "RAW_TEXT" ? "本地节点" : c.url_host || "远程订阅")) },
          { label: "类别", render: (c) => KIND[c.kind !== "AUTO" ? c.kind : c.detected_kind === "AIRPORT" ? "AIRPORT" : "SELF_HOSTED"] },
          { label: "同步", render: (c) => h("div", { class: "name-cell" }, badge(c.last_sync_status), c.last_error_code ? h("span", { class: "small bad-text" }, errorText(c.last_error_code)) : null) },
          { label: "节点", class: "num", render: (c) => h("a", { href: `#/nodes?source_id=${c.id}` }, c.node_count) },
          { label: "Sub-Store 中", render: (c) => (missing.has(c.id) ? h("span", { class: "warn-text" }, "已移除，子来源保留") : "存在") },
          { label: "最近成功", render: (c) => ago(c.last_success_at) },
        ],
        detail.children,
        { empty: empty("还没有子来源", "同步一次 Sub-Store 后生成。") },
      ),
    ),
    { wide: true },
  );
}

export async function render(root, { refresh, refreshStrip }) {
  const stores = await api("/substores");
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
  const sync = (store) => async (e) =>
    busy(e.target, async () => {
      await api("/sources/batch", { method: "POST", body: { ids: [store.id], action: "request_sync" } });
      toast("已标记待同步，点击顶部“同步来源”执行。", "ok");
      refreshStrip();
    });
  root.append(
    h("h1", { class: "page-title" }, "Sub-Store"),
    h("p", { class: "hint" }, "Nodema 只读取 Sub-Store 的订阅列表（/api/subs），把其中的远程订阅和本地节点拆成独立的子来源，不执行 Sub-Store 脚本。"),
    h("section", { class: "panel" }, form),
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
        { label: "子来源", render: (s) => h("button", { type: "button", class: "link", onclick: () => children(s, reload) }, `${s.healthy_children} 正常`, s.failed_children ? h("span", { class: "bad-text" }, ` · ${s.failed_children} 失败`) : "", ` / ${s.children}`) },
        { label: "节点", class: "num", render: (s) => s.node_count },
        {
          label: "",
          render: (s) =>
            h(
              "div",
              { class: "row tight" },
              h("button", { type: "button", class: "quiet", onclick: sync(s) }, "标记同步"),
              h("button", { type: "button", class: "quiet danger-text", onclick: remove(s) }, "删除"),
            ),
        },
      ],
      stores,
      { empty: empty("还没有 Sub-Store", "在上方填入 Sub-Store 后端的 /api/subs 地址。") },
    ),
  );
}
