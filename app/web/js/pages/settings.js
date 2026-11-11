import { api, busy, date, field, h, select, table, toast } from "../core.js";
import { PROTOCOLS } from "../filters.js";

const TOKENS = [
  ["{FLAG}", "落地国旗"],
  ["{ROUTE}", "入口->落地，相同时只写一个"],
  ["{ASN}", "落地 ASN 简称"],
  ["{SEQ}", "落地国家+ASN 内的序号（01、02…）"],
  ["{ENTRY_FLAG}", "入口国旗"],
  ["{ENTRY_COUNTRY}", "入口地区代码"],
  ["{EXIT_COUNTRY}", "落地地区代码"],
  ["{PROTOCOL}", "协议"],
  ["{SHORT_ID}", "节点编号"],
];
const DEFAULT_TEMPLATE = "{FLAG}{ROUTE}|{ASN} {SEQ}";

function schedule(settings) {
  const form = h(
    "form",
    { class: "row wrap" },
    field("每日定时检测（北京时间 04:17 左右）", select("daily_scan_enabled", [["true", "开启"], ["false", "关闭"]], String(settings.daily_scan_enabled))),
    field("检测范围", select("daily_scan_scope", [["SELF_HOSTED", "仅自建"], ["AIRPORT", "仅机场"], ["ALL", "自建和机场（分开计数，同一批）"]], settings.daily_scan_scope)),
    h("button", { type: "submit", class: "primary" }, "保存"),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    await busy(e.submitter, async () => {
      await api("/settings", { method: "PUT", body: { daily_scan_enabled: data.daily_scan_enabled === "true", daily_scan_scope: data.daily_scan_scope } });
      toast("已保存定时检测设置。", "ok");
    });
  });
  return section("定时检测", "定时任务也会先同步到期的来源。随时可以在顶部手动开始任意范围的检测。", form);
}

function naming(rules) {
  const input = h("input", { name: "template", value: rules.template, class: "wide-input", maxlength: 200, spellcheck: "false" });
  const preview = h("ul", { class: "plain preview" });
  const showPreview = async (button) =>
    busy(button, async () => {
      const names = await api("/naming-rules/preview", { method: "POST", body: { template: input.value } });
      preview.replaceChildren(...(names.length ? names.map((n) => h("li", {}, n.name)) : [h("li", { class: "muted" }, "还没有节点可以预览。")]));
    });
  const form = h(
    "form",
    { class: "stack" },
    field("命名模板", input, "例：🇸🇬HK->SG|Webbing 01。序号按“落地国家 + ASN”递增且保持稳定，节点失效也不会让其他节点改号；还没检测过的节点用编号代替序号。"),
    h("div", { class: "chips" }, TOKENS.map(([token, text]) => h("button", { type: "button", class: "chip", title: text, onclick: () => { input.setRangeText(token, input.selectionStart, input.selectionEnd, "end"); input.focus(); } }, token))),
    h(
      "div",
      { class: "row" },
      h("button", { type: "button", onclick: (e) => showPreview(e.target) }, "预览"),
      h("button", { type: "button", class: "quiet", onclick: () => (input.value = DEFAULT_TEMPLATE) }, "恢复默认"),
      h("button", { type: "submit", class: "primary" }, "保存模板"),
    ),
    preview,
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    await busy(e.submitter, async () => {
      await api("/naming-rules", { method: "PUT", body: { template: input.value } });
      toast("模板已保存，订阅会在下一次生成时使用新名称。", "ok");
    });
  });
  return section("节点命名", "之后可加入线路标注等字段；线路类型不会自动推断。", form);
}

function asnLabels(data, refresh) {
  const save = (asn, input) => async (e) =>
    busy(e.target, async () => {
      if (input.value.trim()) await api(`/asn-labels/${asn}`, { method: "PUT", body: { label: input.value } });
      else await api(`/asn-labels/${asn}`, { method: "DELETE" });
      toast("已更新，节点名称随之刷新。", "ok");
      refresh();
    });
  const rows = data.observed.map((o) => ({ ...o, input: h("input", { value: o.overridden ? o.label : "", placeholder: o.label, size: 14, "aria-label": `AS${o.asn} 简称` }) }));
  return section(
    "落地 ASN 简称",
    "自动从运营商名称提取简称（如 WEBBING HONG KONG LIMITED → Webbing）。不满意可以在这里改，留空恢复自动。",
    table(
      [
        { label: "ASN", render: (o) => "AS" + o.asn },
        { label: "运营商名称", render: (o) => o.organization || h("span", { class: "muted" }, "未知") },
        { label: "节点", class: "num", render: (o) => o.nodes },
        { label: "简称", render: (o) => o.input },
        { label: "", render: (o) => h("button", { type: "button", class: "quiet", onclick: save(o.asn, o.input) }, "保存") },
      ],
      rows,
    ),
  );
}

function quality(data, refresh) {
  const p = data.policy;
  const list = (name, value) => h("input", { name, value: (value || []).join(","), placeholder: "逗号分隔" });
  const form = h(
    "form",
    { class: "form-grid" },
    field("同测点最少样本（近 7 天）", h("input", { name: "min_samples", type: "number", min: 1, max: 7, value: p.min_samples })),
    field("Runner 成功率低于（%）列为备用", h("input", { name: "poor_success_rate", type: "number", min: 0, max: 100, step: "any", value: p.poor_success_rate * 100 })),
    field("人工资料有效期（天）", h("input", { name: "evidence_max_age_days", type: "number", min: 1, max: 365, value: p.evidence_max_age_days })),
    field("优先入口地区", list("preferred_entry_countries", p.preferred_entry_countries)),
    field("优先落地地区", list("preferred_exit_countries", p.preferred_exit_countries)),
    field("优先入口 ASN", list("preferred_entry_asns", p.preferred_entry_asns)),
    field("优先落地 ASN", list("preferred_exit_asns", p.preferred_exit_asns)),
    h("fieldset", { class: "wide checks" }, h("legend", {}, "优先协议"), PROTOCOLS.map((x) => h("label", {}, h("input", { type: "checkbox", name: "preferred_protocols", value: x, checked: (p.preferred_protocols || []).includes(x) }), x))),
    h("div", { class: "row end wide" }, h("button", { type: "submit", class: "primary" }, "保存规则")),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = new FormData(form);
    const split = (k, fn = (v) => v) => String(d.get(k) || "").split(",").map((v) => v.trim()).filter(Boolean).map(fn);
    const policy = {
      ...p,
      min_samples: Number(d.get("min_samples")),
      poor_success_rate: Number(d.get("poor_success_rate")) / 100,
      evidence_max_age_days: Number(d.get("evidence_max_age_days")),
      preferred_entry_countries: split("preferred_entry_countries", (v) => v.toUpperCase()),
      preferred_exit_countries: split("preferred_exit_countries", (v) => v.toUpperCase()),
      preferred_entry_asns: split("preferred_entry_asns", Number),
      preferred_exit_asns: split("preferred_exit_asns", Number),
      preferred_protocols: d.getAll("preferred_protocols"),
    };
    await busy(e.submitter, async () => {
      await api("/quality-policy", { method: "PUT", body: { policy, expected_version: data.version } });
      toast("参考规则已更新。", "ok");
      refresh();
    });
  });
  return section(
    "大陆参考规则",
    `当前第 ${data.version} 版，更新于 ${date(data.history?.[0]?.created_at)}。P1/P2/P3 只是根据 GitHub Runner 测量和你的偏好排出的理论候选，不代表大陆实测或线路类型。运营商细分规则保持不变。`,
    form,
    true,
  );
}

function section(title, hint, content, collapsed = false) {
  const body = [h("p", { class: "hint" }, hint), content];
  return collapsed
    ? h("details", { class: "panel" }, h("summary", {}, h("h2", { class: "inline" }, title)), ...body)
    : h("section", { class: "panel" }, h("header", { class: "panel-head" }, h("h2", {}, title)), ...body);
}

export async function render(root, { refresh }) {
  const [pipeline, rules, labels, policy] = await Promise.all([api("/pipeline"), api("/naming-rules"), api("/asn-labels"), api("/quality-policy")]);
  root.append(
    h("h1", { class: "page-title" }, "设置"),
    schedule(pipeline.settings),
    naming(rules),
    asnLabels(labels, refresh),
    quality(policy, refresh),
  );
}
