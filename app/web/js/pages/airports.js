import { api, badge, busy, bytes, confirm, date, daysUntil, dialog, empty, errorText, field, h, meter, select, toast } from "../core.js";
import { editSource, showSourceLink } from "./sources.js";

const STATES = {
  ok: ["可用", "ok"],
  low: ["即将用尽", "warn"],
  soon: ["即将到期", "warn"],
  exhausted: ["流量用完", "bad"],
  expired: ["已过期", "bad"],
  paused: ["已暂停", "mute"],
};
const SORTS = [
  ["remaining:asc", "剩余流量 少→多"],
  ["remaining:desc", "剩余流量 多→少"],
  ["expiry:asc", "到期时间 近→远"],
  ["up:desc", "可用节点 多→少"],
  ["name:asc", "名称"],
];

function describe(s) {
  const used = Number(s.traffic_upload || 0) + Number(s.traffic_download || 0);
  const total = s.traffic_total == null ? null : Number(s.traffic_total);
  const remaining = total ? Math.max(0, total - used) : null;
  const days = daysUntil(s.expires_at);
  const expired = s.expires_at && new Date(s.expires_at) <= new Date();
  let state = "ok";
  if (!s.enabled) state = "paused";
  else if (expired) state = "expired";
  else if (total && used >= total) state = "exhausted";
  else if (days !== null && days <= 7) state = "soon";
  else if (total && remaining / total < 0.1) state = "low";
  return { ...s, used, total, remaining, days, state };
}

function gauge(s) {
  if (!s.total)
    return h(
      "span",
      { class: "muted small", title: "订阅返回的总流量为 0 或缺失，按不限量处理，不会因流量停测" },
      s.userinfo_at ? (s.used ? `已用 ${bytes(s.used)} · 未提供总量` : "未提供总量（按不限量）") : "未获取流量信息",
    );
  const ratio = s.used / s.total;
  const tone = ratio >= 1 ? "bad" : ratio >= 0.9 ? "warn" : "ok";
  return h(
    "div",
    { class: "gauge" },
    meter(ratio, { tone, label: `已用 ${(ratio * 100).toFixed(0)}%` }),
    h("span", { class: "small" }, h("strong", {}, bytes(s.remaining)), ` 剩余 / 共 ${bytes(s.total)}`),
  );
}

function expiry(s) {
  if (!s.expires_at) return h("span", { class: "muted small" }, s.userinfo_at ? "长期" : "—");
  const text = s.state === "expired" ? (s.days < 0 ? `已过期 ${-s.days} 天` : "今天已过期") : s.days === 0 ? "今天到期" : `剩 ${s.days} 天`;
  return h("div", { class: "name-cell" }, h("span", { class: s.state === "expired" ? "bad-text" : s.days <= 7 ? "warn-text" : "" }, text), h("span", { class: "muted small" }, date(s.expires_at)));
}

function moveDialog(source, providers, done) {
  const form = h(
    "form",
    { class: "stack" },
    field("移到机场", select("provider_id", [["", "— 选择 —"], ...providers.filter((p) => p.id !== source.provider_id).map((p) => [p.id, p.name]), ["new", "新建机场…"]])),
    field("新机场名称", h("input", { name: "provider_name", maxlength: 80 }), "仅在选择“新建机场”时使用。"),
    h("div", { class: "row end" }, h("button", { type: "submit", class: "primary" }, "移动")),
  );
  const box = dialog(`移动「${source.name}」`, form);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    if (!data.provider_id) return;
    const body = data.provider_id === "new" ? { provider_id: "new", provider_name: data.provider_name } : { provider_id: data.provider_id };
    await busy(e.submitter, async () => {
      await api("/sources/" + source.id, { method: "PATCH", body });
      toast("已移动。", "ok");
      box.close();
      done();
    });
  });
}

function providerDialog(provider, done) {
  const form = h(
    "form",
    { class: "stack" },
    field("名称", h("input", { name: "name", value: provider.name, required: true, maxlength: 80 })),
    field("官网", h("input", { name: "website", type: "url", value: provider.website || "", placeholder: "https://" })),
    h("div", { class: "row end" }, h("button", { type: "submit", class: "primary" }, "保存")),
  );
  const box = dialog("编辑机场", form);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    await busy(e.submitter, async () => {
      await api("/providers/" + provider.id, { method: "PATCH", body: { name: data.name, website: data.website || null } });
      box.close();
      done();
    });
  });
}

function row(s, providers, reload) {
  const [label, tone] = STATES[s.state];
  const toggle = async (e) =>
    busy(e.target, async () => {
      await api("/sources/batch", { method: "POST", body: { ids: [s.id], action: s.enabled ? "disable" : "enable" } });
      reload();
    });
  const remove = async (e) => {
    if (!(await confirm("删除订阅", `删除「${s.name}」？它的节点将不再检测和导出。`, { action: "删除", danger: true }))) return;
    await busy(e.target, async () => {
      await api("/sources/batch", { method: "POST", body: { ids: [s.id], action: "delete" } });
      reload();
    });
  };
  return h(
    "li",
    { class: "air-row " + (s.state === "ok" ? "" : "state-" + s.state) },
    h(
      "div",
      { class: "name-cell" },
      // The airport's own name first; where the link came from underneath.
      h("span", { class: "node-name", title: s.name }, s.profile_title || s.origin_label || s.name),
      h(
        "span",
        { class: "muted small" },
        [s.parent_source_id ? `来自「${s.parent_name || "已删除的 Sub-Store"}」` : "直接导入", s.url_host].filter(Boolean).join(" · "),
      ),
    ),
    h("span", { class: "badge " + tone }, label),
    gauge(s),
    expiry(s),
    h("a", { class: "num", href: `#/nodes?source_id=${s.id}` }, `${s.up_count} 可用 / ${s.node_count}`),
    h("div", { class: "name-cell" }, badge(s.last_sync_status), s.last_error_code ? h("span", { class: "small bad-text" }, errorText(s.last_error_code)) : null),
    h(
      "div",
      { class: "row tight" },
      h("button", { type: "button", class: "quiet", onclick: (e) => showSourceLink(s, e.target) }, "订阅链接"),
      h("button", { type: "button", class: "quiet", onclick: () => moveDialog(s, providers, reload) }, "移动"),
      h("button", { type: "button", class: "quiet", onclick: () => editSource(s, reload) }, "编辑"),
      h("button", { type: "button", class: "quiet", onclick: toggle }, s.enabled ? "暂停" : "启用"),
      h("button", { type: "button", class: "quiet danger-text", onclick: remove }, "删除"),
    ),
  );
}

export async function render(root, { params, go, refresh, refreshStrip }) {
  const { providers, sources } = await api("/airports");
  const reload = () => {
    refresh();
    refreshStrip();
  };
  const state = params.get("state") || "";
  const providerId = params.get("provider") || "";
  const sort = params.get("sort") || "remaining:asc";
  const q = (params.get("q") || "").toLowerCase();
  const items = sources.map(describe).filter(
    (s) =>
      (!state || (state === "usable" ? s.usable : s.state === state)) &&
      (!providerId || (providerId === "none" ? !s.provider_id : s.provider_id === providerId)) &&
      (!q || `${s.name} ${s.origin_label || ""} ${s.parent_name || ""} ${s.url_host || ""} ${s.profile_title || ""}`.toLowerCase().includes(q)),
  );
  const [key, direction] = sort.split(":");
  const value = {
    remaining: (s) => s.remaining ?? Infinity,
    expiry: (s) => (s.expires_at ? new Date(s.expires_at).getTime() : Infinity),
    up: (s) => s.up_count,
    name: (s) => s.profile_title || s.origin_label || s.name,
  }[key];
  items.sort((a, b) => {
    const x = value(a),
      y = value(b);
    return (x < y ? -1 : x > y ? 1 : 0) * (direction === "desc" ? -1 : 1);
  });
  const set = (k, v) => {
    v ? params.set(k, v) : params.delete(k);
    go("airports", params);
  };
  const all = sources.map(describe);
  const usable = all.filter((s) => s.usable);
  const remainingTotal = usable.reduce((n, s) => n + (s.remaining || 0), 0);
  const groups = new Map([...providers.map((p) => [p.id, { provider: p, items: [] }]), ["none", { provider: null, items: [] }]]);
  for (const s of items) groups.get(s.provider_id && groups.has(s.provider_id) ? s.provider_id : "none").items.push(s);

  root.append(
    h("h1", { class: "page-title" }, "机场"),
    h(
      "dl",
      { class: "stats" },
      h("div", {}, h("dt", {}, "可用订阅"), h("dd", {}, `${usable.length} / ${all.length}`)),
      h("div", {}, h("dt", {}, "可用剩余流量"), h("dd", {}, bytes(remainingTotal))),
      h("div", {}, h("dt", {}, "7 天内到期"), h("dd", {}, all.filter((s) => s.state === "soon").length)),
      h("div", {}, h("dt", {}, "已过期或用完"), h("dd", {}, all.filter((s) => ["expired", "exhausted"].includes(s.state)).length)),
    ),
    h(
      "div",
      { class: "toolbar" },
      h("input", { type: "search", placeholder: "搜索订阅或机场", value: params.get("q") || "", "aria-label": "搜索", onchange: (e) => set("q", e.target.value) }),
      select("state", [["", "全部状态"], ["usable", "仍可使用"], ...Object.entries(STATES).map(([k, [t]]) => [k, t])], state),
      select("provider", [["", "全部机场"], ...providers.map((p) => [p.id, p.name]), ["none", "未分组"]], providerId),
      select("sort", SORTS, sort),
    ),
    h("p", { class: "hint" }, "过期、流量用完或暂停的订阅，其节点不会参与检测和导出。同一机场的多条订阅会按官网或名称自动归到一起，也可以手动移动。"),
    items.length
      ? [...groups.values()]
          .filter((g) => g.items.length)
          .map(({ provider, items: list }, _i, shown) => {
            const problems = list.filter((x) => ["expired", "exhausted", "soon", "low"].includes(x.state)).length;
            // Few airports (or an active filter) open everything; many start collapsed.
            const open = shown.length <= 6 || Boolean(q || state || providerId);
            return h(
              "details",
              { class: "panel air-group", open },
              h(
                "summary",
                { class: "panel-head" },
                h("h2", { class: "inline" }, provider ? provider.name : "未分组"),
                h(
                  "span",
                  { class: "muted" },
                  `${list.filter((x) => x.usable).length}/${list.length} 条可用 · 剩余 ${bytes(list.reduce((n, x) => n + (x.usable ? x.remaining || 0 : 0), 0))} · ${list.reduce((n, x) => n + (x.up_count || 0), 0)} 个可用节点`,
                ),
                problems ? h("span", { class: "warn-text small" }, `${problems} 条需要注意`) : null,
              ),
              h(
                "div",
                { class: "row tight air-links" },
                provider?.website ? h("a", { href: provider.website, rel: "noreferrer noopener", target: "_blank" }, new URL(provider.website).host) : null,
                provider ? h("button", { type: "button", class: "quiet", onclick: () => providerDialog(provider, reload) }, "编辑机场") : null,
              ),
              h("ul", { class: "air-list" }, list.map((x) => row(x, providers, reload))),
            );
          })
      : all.length
        ? empty("没有符合条件的订阅", "调整筛选条件。")
        : empty("还没有机场订阅", "在“来源”页添加订阅链接并同步；响应里带流量信息的订阅会出现在这里。"),
  );
  for (const name of ["state", "provider", "sort"]) root.querySelector(`select[name=${name}]`).addEventListener("change", (e) => set(name, e.target.value));
}
