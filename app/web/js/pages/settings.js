import { api, busy, date, field, h, select, table, toast } from "../core.js";
import { VANTAGES, forgetGradingPolicy } from "../grades.js";

const TOKENS = [
  ["{FLAG}", "落地国旗"],
  ["{ROUTE}", "入口->落地，相同时只写一个"],
  ["{OPERATOR}", "IP 归属|ASN，如 Greencloud|xTom；两者相同时只写一个"],
  ["{ASN}", "落地 ASN 简称"],
  ["{ORG}", "落地 IP 归属（org）简称，与 ASN 相同时为空"],
  ["{SEQ}", "落地服务器序号（01、02…），同一落地 IP 共用"],
  ["{VARIANT}", "同服务器多个节点时的协议后缀，如 “ VLESS”"],
  ["{IPTYPE}", "落地 IP 类型：家宽 / 机房 / 移动（ip-api 判断，未知时为空）"],
  ["{ENTRY_FLAG}", "入口国旗"],
  ["{ENTRY_COUNTRY}", "入口地区代码"],
  ["{EXIT_COUNTRY}", "落地地区代码"],
  ["{PROTOCOL}", "协议"],
  ["{SHORT_ID}", "节点编号"],
];
const DEFAULT_TEMPLATE = "{FLAG}{ROUTE}|{OPERATOR} {SEQ}{VARIANT}";

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
    field("命名模板", input, "例：🇯🇵JP|Greencloud|xTom 01 VLESS。序号按落地服务器（落地 IP）在“落地国家 + 运营商”内递增并保持稳定；同一服务器的多个节点共用序号、用协议区分；还没检测过的节点用编号代替序号。"),
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

const BAND_LABEL = { S: "优（S）", A: "良（A 起）", B: "中（B 起）" };

function bandTable(prefix, table) {
  const input = (band, key, min, step) =>
    h("input", { name: `${prefix}.${band}.${key}`, type: "number", min, step, value: table[band][key] ?? "", "aria-label": `${band} ${key}` });
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      {},
      h("thead", {}, h("tr", {}, ["档", "RTT 至多（ms）", "丢包至多（%）", "抖动至多（ms）", "晚高峰涨幅至多（%）"].map((t) => h("th", { scope: "col" }, t)))),
      h(
        "tbody",
        {},
        ["S", "A", "B"].map((band) =>
          h(
            "tr",
            {},
            h("th", { scope: "row" }, BAND_LABEL[band]),
            h("td", {}, input(band, "rtt_ms", 1, 1)),
            h("td", {}, input(band, "loss_pct", 0, "any")),
            h("td", {}, input(band, "jitter_ms", 0, "any")),
            h("td", {}, band === "S" && prefix === "CN" ? input(band, "peak_rise_pct", 0, "any") : "—"),
          ),
        ),
      ),
    ),
  );
}

function grading(data, refresh) {
  const p = data.policy;
  const form = h(
    "form",
    { class: "stack" },
    h(
      "div",
      { class: "form-grid" },
      field("默认视角", select("default_vantage", VANTAGES, p.default_vantage), "节点页、总览和新订阅默认按它显示等级"),
      field("定档最少检测天数（7 天内）", h("input", { name: "min_checked_days", type: "number", min: 1, max: 7, value: p.min_checked_days })),
      field("每家运营商至少探针数", h("input", { name: "min_probes", type: "number", min: 1, max: 5, value: p.min_probes }), "不足时接入记为样本不足，最高 B"),
      field("稳定优（S）7 天可用率至少（%）", h("input", { name: "stability.S", type: "number", min: 0, max: 100, step: "any", value: p.stability_pct.S })),
      field("稳定良（A）至少（%）", h("input", { name: "stability.A", type: "number", min: 0, max: 100, step: "any", value: p.stability_pct.A })),
      field("稳定中（B）至少（%）", h("input", { name: "stability.B", type: "number", min: 0, max: 100, step: "any", value: p.stability_pct.B })),
    ),
    h("h3", {}, "大陆三网接入（晚高峰中位数）"),
    bandTable("CN", p.bands.CN),
    h("h3", {}, "香港 / 新加坡接入（全天中位数）"),
    bandTable("OVERSEAS", p.bands.OVERSEAS),
    h("label", { class: "check" }, h("input", { type: "checkbox", name: "s_requires_clean_exit", checked: p.s_requires_clean_exit }), "S 要求落地 IP 没有 ip-api 代理标记"),
    h("h3", {}, "接入测量"),
    h(
      "div",
      { class: "form-grid" },
      h("label", { class: "check" }, h("input", { type: "checkbox", name: "probe_enabled", checked: p.probe_enabled }), "启用每小时的 Globalping 接入测量"),
      field("晚高峰开始（北京时间）", h("input", { name: "peak_start", type: "time", value: p.peak_start })),
      field("晚高峰结束", h("input", { name: "peak_end", type: "time", value: p.peak_end })),
      field("覆盖范围", select("coverage", [["ALL", "全部可用节点"], ["EXPORTS", "只覆盖订阅方案里的节点"]], p.coverage), "额度不够时选后者"),
    ),
    h("p", { class: "hint" }, "Globalping token 存在 GitHub 仓库 Secret（GLOBALPING_TOKEN），不能在这里填写或查看；没有 token 时使用匿名额度（每小时 250 次）。规则保存后，下一次测量运行（每小时）会按新规则重新定档。"),
    h("div", { class: "row end" }, h("button", { type: "button", class: "quiet", onclick: () => fill(data.defaults) }, "恢复默认值"), h("button", { type: "submit", class: "primary" }, "保存规则")),
  );
  function fill(values) {
    for (const el of form.elements) {
      if (!el.name) continue;
      const [a, b, c] = el.name.split(".");
      const value = c ? values.bands[a][b][c] : b ? values.stability_pct[b] : values[a];
      if (el.type === "checkbox") el.checked = Boolean(value);
      else el.value = value ?? "";
    }
  }
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = new FormData(form);
    const n = (k) => Number(d.get(k));
    const band = (prefix, b) => {
      const out = { rtt_ms: n(`${prefix}.${b}.rtt_ms`), loss_pct: n(`${prefix}.${b}.loss_pct`) };
      if (d.get(`${prefix}.${b}.jitter_ms`)) out.jitter_ms = n(`${prefix}.${b}.jitter_ms`);
      if (d.get(`${prefix}.${b}.peak_rise_pct`)) out.peak_rise_pct = n(`${prefix}.${b}.peak_rise_pct`);
      return out;
    };
    const policy = {
      default_vantage: d.get("default_vantage"),
      min_checked_days: n("min_checked_days"),
      min_probes: n("min_probes"),
      stability_pct: { S: n("stability.S"), A: n("stability.A"), B: n("stability.B") },
      bands: Object.fromEntries(["CN", "OVERSEAS"].map((x) => [x, Object.fromEntries(["S", "A", "B"].map((b) => [b, band(x, b)]))])),
      s_requires_clean_exit: d.get("s_requires_clean_exit") === "on",
      probe_enabled: d.get("probe_enabled") === "on",
      peak_start: d.get("peak_start"),
      peak_end: d.get("peak_end"),
      coverage: d.get("coverage"),
    };
    await busy(e.submitter, async () => {
      await api("/grading-policy", { method: "PUT", body: { policy, expected_version: data.version } });
      forgetGradingPolicy();
      window.dispatchEvent(new CustomEvent("nodema:nodes-changed"));
      toast("分级规则已保存，下一次测量运行时重新定档。", "ok");
      refresh();
    });
  });
  return section(
    "质量分级规则",
    `当前第 ${data.version} 版，更新于 ${date(data.updated_at)}。等级 = 接入档与稳定档中较差的一项；只使用实测数据，不判断线路类型。`,
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
  const [pipeline, rules, labels, policy] = await Promise.all([api("/pipeline"), api("/naming-rules"), api("/asn-labels"), api("/grading-policy")]);
  root.append(
    h("h1", { class: "page-title" }, "设置"),
    schedule(pipeline.settings),
    naming(rules),
    asnLabels(labels, refresh),
    grading(policy, refresh),
  );
}
