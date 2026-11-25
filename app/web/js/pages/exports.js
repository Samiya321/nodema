import { api, badge, busy, bytes, confirm, date, dialog, empty, errorText, field, h, readAPI, select, table, toast } from "../core.js";
import { ADVANCED, PROTOCOLS, SORTS, advancedFields, readFilters } from "../filters.js";
import { BUCKET_TEXT, GRADE_TEXT, VANTAGES, defaultVantage, vantageName } from "../grades.js";
import { LINEAGE_PAGE_SIZE, copyPageLink, exportHref, lineagePager, nodeHref, readPage, sourceHref } from "../lineage.js";

const FORMATS = [["mihomo", "Mihomo / Clash Meta"], ["singbox", "sing-box"], ["uri", "节点链接（URI）"], ["json", "JSON 报告"], ["csv", "CSV 报告"]];
const STATES = { READY: ["可用", "ok"], UPDATING: ["更新中", "info"], BUILDING: ["生成中", "info"], PENDING: ["等待生成", "mute"], FAILED: ["生成失败", "bad"], REVOKED: ["已撤销", "mute"], EXPIRED: ["已过期", "mute"] };
const BASIC = ["node_group", "provider_id", "exit_country", "protocol", "vantage", "min_quality_grade", "best_per_server"];

// "电信 ≥ A · JP · 每服务器 1 个"
function summary(spec = {}) {
  const parts = [];
  if (spec.min_quality_grade) parts.push(`${vantageName(spec.vantage || "CN")} ≥ ${GRADE_TEXT[spec.min_quality_grade]}`);
  if (spec.quality_buckets?.length) {
    const grades = spec.quality_buckets.map((grade) => BUCKET_TEXT[grade] || grade).join("、");
    parts.push(`${vantageName(spec.vantage || "CN")} ${grades}`);
  } else if (!spec.min_quality_grade && spec.vantage) parts.push(`视角 ${vantageName(spec.vantage)}`);
  if (spec.node_group) parts.push(spec.node_group === "AIRPORT" ? "仅机场" : "仅自建");
  if (spec.exit_country) parts.push(spec.exit_country);
  if (spec.protocol) parts.push(spec.protocol);
  if (spec.best_per_server) parts.push("每服务器 1 个");
  if (spec.udp === true) parts.push("UDP 有回包");
  if (spec.exit_ip_type === "RESIDENTIAL") parts.push("家宽 IP");
  if (spec.endpoint_verified === true) parts.push("端点实测已确认");
  if (spec.stable_exit === true) parts.push("近 7 天出口稳定");
  if (spec.limit && spec.limit < 100000) parts.push(`前 ${spec.limit} 个`);
  return parts.join(" · ") || "全部可用节点";
}
const KEYS = ["q", "source_id", "enabled", ...BASIC, ...ADVANCED.map(([k]) => k).filter((k) => !BASIC.includes(k))];
const RATIO_KEYS = new Set(["min_success_rate", "max_timeout_rate", "min_lifetime_availability", "max_peak_loss", "min_avail_7d"]);
const BOOL_KEYS = new Set(["enabled", "udp", "best_per_server", "exit_ip_proxy", "unreachable", "cross_border", "endpoint_verified", "stable_exit"]);

function seedFilters(params) {
  const result = {};
  for (const key of KEYS) {
    const val = params.get(key);
    if (!val) continue;
    result[key] = RATIO_KEYS.has(key) ? Number(val) / 100
      : BOOL_KEYS.has(key) ? val === "true"
      : key === "tags" ? val.split(",").map((x) => x.trim()).filter(Boolean) : val;
  }
  result.quality_buckets = (params.get("g") || "").split(",").filter((g) => Object.hasOwn(BUCKET_TEXT, g));
  return result;
}

function linkDialog(result) {
  const url = new URL(`/subscriptions/${result.id}`, location.origin);
  url.searchParams.set("token", result.token);
  const input = h("input", { readonly: true, value: url.href, class: "wide-input", "aria-label": "私有订阅链接", onfocus: (e) => e.target.select() });
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

function profileForm(providers, profile, done, fallbackVantage, seed = {}) {
  const spec = profile?.filter_spec || seed;
  const expiryOptions = [["", "长期有效（可撤销）"], ["24", "24 小时"], ["168", "7 天"], ["720", "30 天"]];
  const extra = (profile?.filter_spec || seed);
  const source = h("input", { type: "hidden", name: "source_id", value: spec.source_id || "" });
  const previewStatus = h("p", { class: "muted small wide", role: "status" });
  const previewButton = h("button", { type: "button" }, "预览节点数");
  const submit = h("button", { type: "submit", class: "primary" }, profile ? "保存修改" : "创建订阅");
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
    field("搜索匹配", h("input", { name: "q", value: spec.q || "", placeholder: "名称、编号或主机", autocomplete: "off" })),
    field("等级视角", select("vantage", VANTAGES, spec.vantage || fallbackVantage)),
    field("等级至少", select("min_quality_grade", [["", "不限"], ["S", "S"], ["A", "A 及以上"], ["B", "B 及以上"], ["C", "C 及以上"]], spec.min_quality_grade)),
    h("fieldset", { class: "check-set wide" }, h("legend", {}, "指定等级（留空不限）"),
      Object.entries(BUCKET_TEXT).map(([key, label]) => h("label", { class: "check" },
        h("input", { name: "quality_buckets", type: "checkbox", value: key, checked: spec.quality_buckets?.includes(key) }), label))),
    source,
    spec.source_id ? h("div", { class: "row wrap wide" },
      h("a", { href: sourceHref(spec.source_id), onclick: (event) => event.currentTarget.closest("dialog")?.close() }, "查看限定的上游来源"),
      h("button", { type: "button", class: "quiet", onclick: (event) => {
        source.value = "";
        event.currentTarget.parentElement.hidden = true;
        form.dispatchEvent(new Event("input"));
      } }, "取消来源限定")) : null,
    h("label", { class: "check wide" }, h("input", { type: "checkbox", name: "best_per_server", value: "true", checked: Boolean(spec.best_per_server) }), "每台落地服务器只保留等级最好的一个节点"),
    field("排序", select("sort", SORTS, (spec.sort || "quality_grade:asc").split(",")[0])),
    field("最多节点数", h("input", { name: "limit", type: "number", min: 1, max: 100000, value: spec.limit && spec.limit < 100000 ? spec.limit : "" }), "留空不限"),
    h("details", { class: "wide advanced", open: ADVANCED.some(([k]) => !BASIC.includes(k) && Object.hasOwn(spec, k)) },
      h("summary", {}, "更多筛选"), h("div", { class: "form-grid" },
        field("启用状态", select("enabled", [["", "不限"], ["true", "已启用"], ["false", "已停用"]], spec.enabled == null ? "" : String(spec.enabled))),
        advancedFields(spec).filter((label) => !BASIC.includes(label.querySelector("[name]").name)))),
    h("p", { class: "hint wide" }, "订阅包含参与检测、最近检测正常的节点。估算按当前数据，生成时可能跳过格式不兼容的节点。"),
    previewStatus,
    h("div", { class: "row end wrap wide" }, previewButton, submit),
  );
  const box = dialog(profile ? "编辑订阅方案" : "新建订阅方案", form, { wide: true });
  // Keep filter fields carried from earlier API clients when editing an existing profile.
  const read = () => {
    const data = Object.fromEntries(new FormData(form));
    const filters = Object.fromEntries(Object.entries(extra).filter(([key]) =>
      !KEYS.includes(key) && !["quality_buckets", "sort", "limit"].includes(key)));
    Object.assign(filters, readFilters(form, KEYS));
    const grades = new FormData(form).getAll("quality_buckets");
    if (grades.length) filters.quality_buckets = grades;
    filters.sort = data.sort;
    if (data.limit) filters.limit = Number(data.limit);
    return { data, filters };
  };
  const previewKey = (data, filters) => JSON.stringify([data.format, filters]);
  let estimated = "";
  let estimating = false;
  const updatePreview = async () => {
    if (estimating || !form.reportValidity()) return;
    const { data, filters } = read();
    const key = previewKey(data, filters);
    previewStatus.textContent = "正在估算节点数…";
    estimating = true;
    previewButton.disabled = true;
    try {
      const { count } = await api("/exports/preview", { method: "POST", body: { format: data.format, filters } });
      const next = read();
      if (key !== previewKey(next.data, next.filters)) return;
      estimated = key;
      previewStatus.textContent = `预计符合条件 ${count.toLocaleString("zh-CN")} 个节点。`;
    } catch (error) {
      previewStatus.textContent = errorText(error.code);
    } finally {
      estimating = false;
      previewButton.disabled = false;
    }
  };
  previewButton.addEventListener("click", updatePreview);
  form.addEventListener("input", () => {
    const { data, filters } = read();
    if (estimated !== previewKey(data, filters)) previewStatus.textContent = "条件已修改，创建前会重新估算。";
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const { data, filters } = read();
    if (estimated !== previewKey(data, filters)) {
      await updatePreview();
      return;
    }
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
  void updatePreview();
}

async function exportDetail(root, { params, go }) {
  const id = params.get("subscription");
  const page = readPage(params);
  const query = new URLSearchParams({ limit: LINEAGE_PAGE_SIZE, offset: page * LINEAGE_PAGE_SIZE });
  if (params.has("version")) query.set("version", params.get("version"));
  const path = `/exports/${encodeURIComponent(id)}`;
  const [profile, members] = await Promise.all([api(path), api(path + "/members?" + query)]);
  const move = (index) => {
    const next = new URLSearchParams({ subscription: id, version: members.version });
    if (index) next.set("page", index);
    go("exports", next);
  };
  root.append(
    h("a", { href: "#/exports", class: "return-link" }, "返回导出"),
    h("header", { class: "title-row" }, h("h1", { class: "page-title" }, profile.name), copyPageLink(exportHref(id))),
    h("section", { class: "panel stack" },
      h("h2", {}, "最近一次生成"),
      members.version ? h("p", {}, `v${members.version} · ${date(members.built_at)} · ${members.total} 个成员${members.serving ? "" : " · 当前未提供下载"}`)
        : h("p", { class: "muted" }, "首次生成完成后可查看成员。"),
      h("p", { class: "hint" }, "点开成员可追到直接来源和上级来源。成员对应最近成品，节点详情显示目前保留的来源记录。"),
    ),
    members.changed ? h("p", { class: "callout" }, "订阅已生成新版本。", h("a", { href: exportHref(id) }, "查看最新成员"))
      : table([
        { label: "节点", render: (n) => h("a", { href: nodeHref(n.id) }, n.name || n.short_id) },
        { label: "编号", render: (n) => n.short_id },
        { label: "当前状态", render: (n) => badge(n.status) },
      ], members.items, { empty: empty("没有可显示的成员") }),
    members.changed ? null : lineagePager(page, members.total, move),
  );
}

export async function render(root, { params, go, refresh, isCurrent }) {
  if (params.has("subscription")) return exportDetail(root, { params, go });
  const profiles = await readAPI("/exports");
  if (!isCurrent()) return;
  const seed = params.get("new") === "1" ? seedFilters(params) : {};
  const open = async (profile = null) => {
    const [providers, vantage, data] = await Promise.all([readAPI("/providers"), defaultVantage(), profile]);
    if (isCurrent()) profileForm(providers, data, !data && params.has("new") ? () => go("exports") : refresh, vantage, data ? {} : seed);
  };
  const act = (fn) => async (e) => busy(e.target, fn);
  const actions = (p) => {
    const active = !["REVOKED", "EXPIRED"].includes(p.status);
    return h(
      "div",
      { class: "row tight" },
      active ? h("button", { type: "button", class: "quiet", onclick: act(async () => linkDialog(await api(`/exports/${p.id}/link`))) }, "链接") : null,
      active ? h("button", { type: "button", class: "quiet", onclick: act(() => open(api("/exports/" + p.id))) }, "编辑") : null,
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
    h("div", { class: "title-row" }, h("h1", { class: "page-title" }, "导出"), h("button", { type: "button", class: "primary", onclick: act(() => open()) }, "新建订阅")),
    table(
      [
        { label: "方案", render: (p) => h("div", { class: "name-cell" }, h("a", { class: "node-name", href: exportHref(p.id) }, p.name), h("span", { class: "muted small" }, FORMATS.find(([k]) => k === p.format)?.[1] || p.format)) },
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
  if (params.get("new") === "1") void busy(null, () => open());
}
