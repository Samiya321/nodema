import { api, busy, bytes, confirm, date, dialog, empty, errorText, field, h, select, table, toast } from "../core.js";
import { ADVANCED, PROTOCOLS, SORTS, advancedFields, readFilters } from "../filters.js";
import { GRADE_TEXT, VANTAGES, defaultVantage, vantageName } from "../grades.js";

const FORMATS = [["mihomo", "Mihomo / Clash Meta"], ["singbox", "sing-box"], ["uri", "节点链接（URI）"], ["json", "JSON 报告"], ["csv", "CSV 报告"]];
const STATES = { READY: ["可用", "ok"], UPDATING: ["更新中", "info"], BUILDING: ["生成中", "info"], PENDING: ["等待生成", "mute"], FAILED: ["生成失败", "bad"], REVOKED: ["已撤销", "mute"], EXPIRED: ["已过期", "mute"] };
const BASIC = ["node_group", "provider_id", "exit_country", "protocol", "vantage", "min_quality_grade", "best_per_server"];

// "电信 ≥ A · JP · 每服务器 1 个"
function summary(spec = {}) {
  const parts = [];
  if (spec.min_quality_grade) parts.push(`${vantageName(spec.vantage || "CN")} ≥ ${GRADE_TEXT[spec.min_quality_grade]}`);
  else if (spec.vantage) parts.push(`视角 ${vantageName(spec.vantage)}`);
  if (spec.node_group) parts.push(spec.node_group === "AIRPORT" ? "仅机场" : "仅自建");
  if (spec.exit_country) parts.push(spec.exit_country);
  if (spec.protocol) parts.push(spec.protocol);
  if (spec.best_per_server) parts.push("每服务器 1 个");
  if (spec.limit && spec.limit < 100000) parts.push(`前 ${spec.limit} 个`);
  return parts.join(" · ") || "全部可用节点";
}
const KEYS = [...BASIC, ...ADVANCED.map(([k]) => k).filter((k) => !BASIC.includes(k))];

function linkDialog(result) {
  const url = new URL(`/subscriptions/${result.id}`, location.origin);
  url.searchParams.set("token", result.token);
  const input = h("input", { readonly: true, value: url.href, class: "wide-input", onfocus: (e) => e.target.select() });
  dialog(
    "订阅链接",
    h(
      "div",
      { class: "stack" },
      h("p", { class: "hint" }, "这是私有链接，请像密码一样保管。首次生成完成前访问会提示稍后重试。"),
      input,
      h(
        "div",
        { class: "row" },
        h("button", { type: "button", class: "primary", onclick: async (e) => { try { await navigator.clipboard.writeText(url.href); e.target.textContent = "已复制"; } catch { input.select(); } } }, "复制链接"),
      ),
    ),
  );
}

function profileForm(providers, profile, done, fallbackVantage) {
  const spec = profile?.filter_spec || {};
  const expiryOptions = [["", "长期有效（可撤销）"], ["24", "24 小时"], ["168", "7 天"], ["720", "30 天"]];
  const form = h(
    "form",
    { class: "form-grid" },
    field("方案名称", h("input", { name: "name", required: true, maxlength: 80, value: profile?.name || "我的订阅" })),
    field("格式", select("format", FORMATS, profile?.format || "mihomo")),
    field("链接有效期", select("expires_in_hours", profile?.expires_at ? [["keep", "保持现有到期时间"], ...expiryOptions] : expiryOptions, profile?.expires_at ? "keep" : "")),
    field("节点类别", select("node_group", [["", "自建与机场"], ["SELF_HOSTED", "仅自建"], ["AIRPORT", "仅机场"]], spec.node_group)),
    field("机场", select("provider_id", [["", "全部机场"], ...providers.map((p) => [p.id, p.name])], spec.provider_id)),
    field("落地地区", h("input", { name: "exit_country", value: spec.exit_country || "", placeholder: "如 SG" })),
    field("协议", select("protocol", [["", "全部"], ...PROTOCOLS.map((p) => [p, p])], spec.protocol)),
    field("等级视角", select("vantage", VANTAGES, spec.vantage || fallbackVantage)),
    field("等级至少", select("min_quality_grade", [["", "不限"], ["S", "S"], ["A", "A 及以上"], ["B", "B 及以上"], ["C", "C 及以上"]], spec.min_quality_grade)),
    h("label", { class: "check wide" }, h("input", { type: "checkbox", name: "best_per_server", value: "true", checked: Boolean(spec.best_per_server) }), "每台落地服务器只保留等级最好的一个节点"),
    field("排序", select("sort", SORTS, (spec.sort || "quality_grade:asc").split(",")[0])),
    field("最多节点数", h("input", { name: "limit", type: "number", min: 1, max: 100000, value: spec.limit && spec.limit < 100000 ? spec.limit : "" }), "留空不限"),
    h("details", { class: "wide advanced" }, h("summary", {}, "更多筛选"), h("div", { class: "form-grid" }, advancedFields(spec).filter((label) => !BASIC.includes(label.querySelector("[name]").name)))),
    h("p", { class: "hint wide" }, "只包含启用、参与检测、最近检测可用且结果未过期的节点。之后的同步和检测会自动更新同一个链接；等级每天随新测量变化，按等级筛选的订阅会跟着更新。"),
    h("div", { class: "row end wide" }, h("button", { type: "submit", class: "primary" }, profile ? "保存修改" : "创建订阅")),
  );
  const box = dialog(profile ? "编辑订阅方案" : "新建订阅方案", form, { wide: true });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const filters = readFilters(form, KEYS);
    filters.sort = data.sort;
    if (data.limit) filters.limit = Number(data.limit);
    const body = { name: data.name, format: data.format, filters };
    if (data.expires_in_hours !== "keep") body.expires_in_hours = data.expires_in_hours ? Number(data.expires_in_hours) : null;
    if (profile) body.expected_revision = profile.request_revision;
    await busy(e.submitter, async () => {
      const result = await api(profile ? "/exports/" + profile.id : "/exports", { method: profile ? "PATCH" : "POST", body });
      box.close();
      if (result.token) linkDialog(result);
      toast(result.pipeline?.dispatched ? "已保存，正在生成。" : "已保存，等待下一次生成。", "ok");
      done();
    });
  });
}

export async function render(root, { refresh }) {
  const [profiles, { providers }, vantage] = await Promise.all([api("/exports"), api("/airports"), defaultVantage()]);
  const act = (fn) => async (e) => busy(e.target, fn);
  const actions = (p) => {
    const active = !["REVOKED", "EXPIRED"].includes(p.status);
    return h(
      "div",
      { class: "row tight" },
      active ? h("button", { type: "button", class: "quiet", onclick: act(async () => linkDialog(await api(`/exports/${p.id}/link`))) }, "链接") : null,
      active ? h("button", { type: "button", class: "quiet", onclick: act(async () => profileForm(providers, await api("/exports/" + p.id), refresh, vantage)) }, "编辑") : null,
      active && p.status !== "BUILDING" ? h("button", { type: "button", class: "quiet", onclick: act(async () => { await api(`/exports/${p.id}/retry`, { method: "POST" }); toast("已提交重新生成。", "ok"); refresh(); }) }, "重新生成") : null,
      active
        ? h("button", {
            type: "button",
            class: "quiet",
            onclick: async (e) => {
              if (await confirm("更换密钥", "旧链接会立即失效，客户端需要更新为新链接。", { action: "更换" }))
                busy(e.target, async () => linkDialog(await api(`/exports/${p.id}/token`, { method: "POST" })));
            },
          }, "更换密钥")
        : null,
      p.current_version
        ? h("button", {
            type: "button",
            class: "quiet",
            onclick: act(async () => {
              const versions = await api(`/exports/${p.id}/versions`);
              dialog("版本记录", table([
                { label: "版本", render: (v) => "v" + v.version_no },
                { label: "生成时间", render: (v) => date(v.created_at) },
                { label: "节点", class: "num", render: (v) => v.node_count },
                { label: "大小", class: "num", render: (v) => bytes(v.payload_bytes) },
              ], versions));
            }),
          }, "版本")
        : null,
      active
        ? h("button", {
            type: "button",
            class: "quiet danger-text",
            onclick: async (e) => {
              if (await confirm("撤销订阅", `撤销「${p.name}」？链接会立即失效且无法恢复。`, { action: "撤销", danger: true }))
                busy(e.target, async () => { await api("/exports/" + p.id, { method: "DELETE" }); refresh(); });
            },
          }, "撤销")
        : null,
    );
  };
  root.append(
    h("div", { class: "title-row" }, h("h1", { class: "page-title" }, "订阅导出"), h("button", { type: "button", class: "primary", onclick: () => profileForm(providers, null, refresh, vantage) }, "新建订阅")),
    table(
      [
        { label: "方案", render: (p) => h("div", { class: "name-cell" }, h("span", { class: "node-name" }, p.name), h("span", { class: "muted small" }, FORMATS.find(([k]) => k === p.format)?.[1] || p.format)) },
        { label: "条件", render: (p) => h("span", { class: "small" }, summary(p.filter_spec)) },
        { label: "状态", render: (p) => { const [t, tone] = STATES[p.status] || [p.status, "mute"]; return h("div", { class: "name-cell" }, h("span", { class: "badge " + tone }, t), p.error_code ? h("span", { class: "small bad-text" }, errorText(p.error_code)) : null); } },
        { label: "节点", class: "num", render: (p) => (p.serving ? `${p.node_count}（${bytes(p.payload_bytes)}）` : "—") },
        { label: "最近生成", render: (p) => (p.current_version ? `v${p.current_version} ${date(p.built_at)}` : "尚未生成") },
        { label: "有效期", render: (p) => (p.expires_at ? date(p.expires_at) : "长期") },
        { label: "", render: actions },
      ],
      profiles,
      { empty: empty("还没有订阅方案", "新建一个方案，按类别、地区等条件生成固定的私有订阅链接。") },
    ),
  );
}
