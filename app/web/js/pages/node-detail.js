import { KIND, ago, api, badge, busy, date, dialog, errorText, field, h, ms, pct, route, select, table, toast } from "../core.js";

const MEASURE = { FULL: "完整代理验证", PREFLIGHT: "入口预检", SKIPPED: "本轮跳过" };
const OPERATORS = [["GENERAL", "通用"], ["CT", "电信"], ["CU", "联通"], ["CM", "移动"]];

function pairs(entries) {
  return h("dl", { class: "pairs" }, entries.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v ?? "—")]));
}

export async function nodeDetail(id) {
  const n = await api("/nodes/" + id);
  const obs = n.published_observation;
  const body = h("div", { class: "stack" });
  const sheet = dialog(n.name, body, { wide: true });
  const aliases = h("div");
  body.append(
    h(
      "div",
      { class: "detail-head" },
      badge(n.status),
      route(n.entry_country, n.exit_country),
      h("span", { class: "tag " + (n.node_group === "AIRPORT" ? "air" : "own") }, KIND[n.node_group]),
      h("span", { class: "muted" }, `最近检测 ${ago(n.last_checked_at)}`),
    ),
    h(
      "div",
      { class: "grid-2" },
      pairs([
        ["编号", n.short_id],
        ["协议", `${n.protocol} / ${n.transport || "—"} / ${n.security || "—"}`],
        ["入口", h("code", {}, `${n.server_host}:${n.server_port}`)],
        ["入口解析", obs?.entry_ips?.join("、")],
        ["入口地区 / ASN", `${n.entry_country || "—"} / ${n.entry_asn ? "AS" + n.entry_asn : "—"}`],
        ["出口 IP", n.exit_ip],
        ["落地", `${n.exit_country || "—"} ${obs?.exit_city || ""}`],
        ["落地 ASN", n.exit_asn ? `AS${n.exit_asn} ${n.exit_asn_org || ""}` : "—"],
      ]),
      pairs([
        ["延迟", ms(n.http_duration_ms)],
        ["首次加入", `${date(n.first_seen_at)}（第 ${n.age_days} 天）`],
        ["累计可用", `${n.available_days} / ${n.checked_days} 天，${pct(n.lifetime_availability)}`],
        ["Runner 成功率 / P95", `${pct(n.success_rate)} / ${ms(n.http_p95_ms)}`],
        ["检测方式", MEASURE[n.measurement_kind] || "—"],
        ["下次完整复查", n.next_full_check_at ? date(n.next_full_check_at) : "按计划"],
        ["大陆参考", `${n.grade || "U"}（理论候选，非实测）`],
        ["人工线路声明", n.line_claim === "UNKNOWN" ? "未知" : n.line_claim],
      ]),
    ),
    h(
      "div",
      { class: "row" },
      h("button", { type: "button", onclick: (e) => toggleEnabled(e.target, n) }, n.enabled ? "停用此节点" : "启用此节点"),
      h("button", { type: "button", onclick: () => annotate(n.id, sheet) }, "编辑人工资料"),
      h(
        "button",
        {
          type: "button",
          class: "quiet",
          onclick: (e) =>
            busy(e.target, async () => {
              const rows = await api(`/nodes/${n.id}/aliases`);
              aliases.replaceChildren(
                table(
                  [
                    { label: "来源", render: (r) => r.source_name },
                    { label: "原始名称", render: (r) => r.aliases.join("、") },
                    { label: "上游仍包含", render: (r) => (r.is_present ? "是" : "否") },
                  ],
                  rows,
                ),
              );
            }),
        },
        "显示原始名称",
      ),
    ),
    aliases,
    h("h3", {}, "来源"),
    table(
      [
        { label: "来源", render: (s) => s.name },
        { label: "上游仍包含", render: (s) => (s.is_present ? "是" : h("span", { class: "muted" }, "已移除（节点保留）")) },
        { label: "来源状态", render: (s) => (s.deleted ? "已删除" : s.enabled ? "启用" : "暂停") },
        { label: "最近出现", render: (s) => ago(s.last_seen_at) },
      ],
      n.sources,
    ),
    h("h3", {}, "检测历史"),
    table(
      [
        { label: "时间", render: (r) => date(r.checked_at) },
        { label: "结果", render: (r) => badge(r.status) },
        { label: "落地", render: (r) => (r.exit_country ? `${r.exit_country} AS${r.exit_asn ?? "?"}` : "—") },
        { label: "延迟", class: "num", render: (r) => ms(r.http_duration_ms) },
        { label: "阶段", render: (r) => `DNS ${r.dns_status} · TCP ${r.tcp_status} · 代理 ${r.proxy_status}` },
        { label: "原因", render: (r) => (r.error_code ? errorText(r.error_code) : "—") },
      ],
      n.history,
    ),
  );
}

async function toggleEnabled(button, node) {
  await busy(button, async () => {
    await api("/nodes/" + node.id, { method: "PATCH", body: { enabled: !node.enabled } });
    toast(node.enabled ? "已停用，不再检测和导出。" : "已启用。", "ok");
    button.closest("dialog").close();
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}

async function annotate(id, sheet) {
  const a = await api(`/nodes/${id}/annotations`);
  const form = h(
    "form",
    { class: "form-grid" },
    h("p", { class: "hint wide" }, "人工资料只影响参考排序，不代表实测线路。已保存的依据不会回显，留空即保留。"),
    field("标签（逗号分隔）", h("input", { name: "tags", value: a.tags.join(",") })),
    field("线路声明", select("line_claim", [["UNKNOWN", "未知"], ["IPLC", "IPLC（声明）"], ["IEPL", "IEPL（声明）"], ["CN2", "CN2（声明）"], ["OTHER", "其他"]], a.line_claim)),
    field("资料类型", select("evidence_level", [["NONE", "无"], ["DECLARED", "仅声明"], ["DOCUMENTED", "有资料"]], a.evidence_level)),
    field("人工优先级", select("manual_priority", [["NONE", "按规则"], ["P1", "P1"], ["P2", "P2"], ["P3", "P3"]], a.manual_priority)),
    h(
      "fieldset",
      { class: "wide checks" },
      h("legend", {}, "适用运营商"),
      OPERATORS.map(([v, t]) => h("label", {}, h("input", { type: "checkbox", name: "operators", value: v, checked: a.operators.includes(v) }), t)),
    ),
    field(a.has_evidence ? "替换依据（留空保留）" : "依据", h("textarea", { name: "reference", rows: 3 })),
    a.has_evidence ? h("label", { class: "check" }, h("input", { type: "checkbox", name: "clear_reference" }), "移除已保存的依据") : null,
    h("div", { class: "row end wide" }, h("button", { class: "primary", type: "submit" }, "保存")),
  );
  const box = dialog("人工资料", form);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const payload = {
      tags: String(data.get("tags")).split(",").map((t) => t.trim()).filter(Boolean),
      line_claim: data.get("line_claim"),
      evidence_level: data.get("evidence_level"),
      manual_priority: data.get("manual_priority"),
      operators: data.getAll("operators"),
    };
    if (data.get("reference")) payload.reference = data.get("reference");
    if (data.get("clear_reference")) payload.reference = null;
    await busy(e.submitter, async () => {
      await api(`/nodes/${id}/annotations`, { method: "PATCH", body: payload });
      toast("人工资料已保存。", "ok");
      box.close();
      sheet.close();
      nodeDetail(id);
    });
  });
}
