import { IP_TYPE, KIND, ago, api, badge, busy, date, dialog, errorText, field, h, ms, pct, route, select, table, toast } from "../core.js";
import { testNodes } from "../strip.js";
import { showShare } from "../share.js";
import { VANTAGES, gradeBadge, vantageName } from "../grades.js";
import { rowVantage } from "./node-rows.js";

const MEASURE = { FULL: "完整代理验证", PREFLIGHT: "入口预检", SKIPPED: "本轮跳过" };
const BAND = { S: "优", A: "良", B: "中", C: "差" };
const lossText = (v) => (v === null || v === undefined ? "—" : (v * 100).toFixed(1) + "%");

function pairs(entries) {
  return h("dl", { class: "pairs" }, entries.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v ?? "—")]));
}

export async function nodeDetail(id) {
  const vantage = rowVantage();
  const [n, access] = await Promise.all([
    api(`/nodes/${id}?vantage=${encodeURIComponent(vantage)}`),
    api(`/nodes/${id}/access`).catch(() => null),
  ]);
  const obs = n.published_observation;
  const body = h("div", { class: "stack" });
  const sheet = dialog(n.name, body, { wide: true });
  const aliases = h("div");
  // Native append() would print "null" for skipped sections; drop them first.
  const add = (...items) => body.append(...items.filter((x) => x !== null && x !== undefined && x !== false));
  add(
    h(
      "div",
      { class: "detail-head" },
      badge(n.status),
      route(n.entry_country, n.exit_country),
      h("span", { class: "tag " + (n.node_group === "AIRPORT" ? "air" : "own") }, KIND[n.node_group]),
      h("span", { class: "muted" }, `最近检测 ${ago(n.last_checked_at)}`),
    ),
    accessSection(n, access, vantage),
    obs?.echo_source === "fallback"
      ? h("p", { class: "callout" }, "节点可用，但它的出口访问不了检测用的 Echo（Cloudflare），已通过备用地址确认连通，所以落地国家、ASN 暂时未知，名称不编号。")
      : null,
    h(
      "div",
      { class: "grid-2" },
      pairs([
        ["编号", n.short_id],
        ["协议", `${n.protocol} / ${n.transport || "—"} / ${n.security || "—"}`],
        ["入口", h("code", {}, `${n.server_host}:${n.server_port}`)],
        ["入口解析", obs?.entry_ips?.join("、")],
        ["入口地区 / ASN", `${n.entry_country || "—"} / ${n.entry_asn ? "AS" + n.entry_asn : "—"}`],
        ["落地 IP", n.exit_ip ? h("span", {}, h("code", {}, n.exit_ip), n.server_node_count > 1 ? h("span", { class: "tag" }, `同服务器 ×${n.server_node_count}`) : null) : null],
        ["落地位置", [n.exit_country, n.exit_region, n.exit_ip_city || obs?.exit_city].filter(Boolean).join(" · ") || null],
        ["IP 归属（org）", n.exit_org],
        ["ISP", n.exit_isp],
        ["IP 类型", n.exit_ip_type ? `${IP_TYPE[n.exit_ip_type]}${n.exit_ip_proxy ? "，被标记为 VPN/代理" : ""}（ip-api 数据库标记，非实测）` : null],
        ["落地 ASN", n.exit_asn ? `AS${n.exit_asn} ${n.exit_asn_org || ""}` : "—"],
      ]),
      pairs([
        ["美国 Runner 代理延迟", ms(n.http_duration_ms)],
        ["首次加入", `${date(n.first_seen_at)}（第 ${n.age_days} 天）`],
        ["累计可用", `${n.available_days} / ${n.checked_days} 天，${pct(n.lifetime_availability)}`],
        ["美国 Runner 成功率 / P95", `${pct(n.success_rate)} / ${ms(n.http_p95_ms)}`],
        ["检测方式", MEASURE[n.measurement_kind] || "—"],
        ["下次完整复查", n.next_full_check_at ? date(n.next_full_check_at) : "按计划"],
      ]),
    ),
    h(
      "div",
      { class: "row" },
      h("button", { type: "button", class: "primary", onclick: async () => { if (await testNodes([n.id])) sheet.close(); } }, "检测此节点"),
      h("button", { type: "button", onclick: (e) => showShare(n, e.target) }, "二维码 / 分享"),
      h("button", { type: "button", onclick: (e) => toggleEnabled(e.target, n) }, n.enabled ? "停用此节点" : "启用此节点"),
      h("button", { type: "button", onclick: () => annotate(n.id, sheet) }, "编辑标签"),
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
    n.server_node_count > 1 ? siblings(n) : null,
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
        { label: "落地", render: (r) => (r.exit_country ? `${r.exit_country} AS${r.exit_asn ?? "?"}` : r.echo_source === "fallback" ? "未知（Echo 不可达）" : "—") },
        { label: "延迟", class: "num", render: (r) => ms(r.http_duration_ms) },
        { label: "阶段", render: (r) => `DNS ${r.dns_status} · TCP ${r.tcp_status} · 代理 ${r.proxy_status}` },
        { label: "原因", render: (r) => (r.error_code ? errorText(r.error_code) : "—") },
      ],
      n.history,
    ),
  );
}

// Other nodes landing on the same server (same exit IP), usually other protocols.
function siblings(n) {
  const box = h("div", {}, h("p", { class: "muted small" }, "加载中…"));
  api(`/nodes?exit_ip=${encodeURIComponent(n.exit_ip)}&vantage=${encodeURIComponent(rowVantage())}&sort=quality_grade:asc&limit=50`)
    .then((page) =>
      box.replaceChildren(
        table(
          [
            { label: "节点", render: (s) => (s.id === n.id ? h("strong", {}, s.name) : h("button", { type: "button", class: "link", onclick: () => nodeDetail(s.id) }, s.name)) },
            { label: "协议", render: (s) => `${s.protocol} / ${s.transport || "—"} / ${s.security || "—"}` },
            { label: "入口", render: (s) => h("code", {}, `${s.server_host}:${s.server_port}`) },
            { label: "状态", render: (s) => badge(s.status) },
            { label: "等级 · " + vantageName(rowVantage()), render: (s) => gradeBadge(s.quality_grade, rowVantage(), { withVantage: false }) || "—" },
          ],
          page.items,
        ),
      ),
    )
    .catch(() => box.replaceChildren(h("p", { class: "muted small" }, "无法加载同服务器节点。")));
  return h("section", {}, h("h3", {}, `同一落地服务器（${n.server_node_count} 个节点）`), h("p", { class: "hint" }, "这些节点落地 IP 相同，通常是同一台服务器上的不同协议或入口，共用一个序号。"), box);
}

async function toggleEnabled(button, node) {
  await busy(button, async () => {
    await api("/nodes/" + node.id, { method: "PATCH", body: { enabled: !node.enabled } });
    toast(node.enabled ? "已停用，不再检测和导出。" : "已启用。", "ok");
    window.dispatchEvent(new CustomEvent("nodema:nodes-changed"));
    button.closest("dialog").close();
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}

async function annotate(id, sheet) {
  const a = await api(`/nodes/${id}/annotations`);
  const form = h(
    "form",
    { class: "form-grid" },
    h("p", { class: "hint wide" }, "标签只用于筛选和整理，不影响等级。"),
    field("标签（逗号分隔）", h("input", { name: "tags", value: a.tags.join(",") })),
    h("div", { class: "row end wide" }, h("button", { class: "primary", type: "submit" }, "保存")),
  );
  const box = dialog("编辑标签", form);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const payload = { tags: String(data.get("tags")).split(",").map((t) => t.trim()).filter(Boolean) };
    await busy(e.submitter, async () => {
      await api(`/nodes/${id}/annotations`, { method: "PATCH", body: payload });
      toast("标签已保存。", "ok");
      window.dispatchEvent(new CustomEvent("nodema:nodes-changed"));
      box.close();
      sheet.close();
      nodeDetail(id);
    });
  });
}

// Entry quality per vantage: measured facts only, with their source and limits.
function accessSection(n, access, current) {
  const grades = access?.grades || {};
  const chosen = grades[current] || {};
  const head = n.quality_grade
    ? h(
        "div",
        { class: "stack tight" },
        h("p", { class: "row tight" }, gradeBadge(n.quality_grade, current), weekStrip(n)),
        chosen.reasons?.length ? h("ul", { class: "reasons" }, chosen.reasons.map((r) => h("li", {}, r))) : null,
      )
    : h("p", { class: "muted" }, "节点当前不可用或未检测，不定档。");
  const why = (v) => {
    if (access?.icmp_only) return "Hysteria2 走 UDP：按同网段 TCP 测得";
    if (access?.cloudflare) return "Cloudflare 入口：共用 CF 类结果";
    if (!access?.target) return "无 IPv4 入口，未测";
    return v.startsWith("CN-") ? "等待晚高峰测量" : "等待测量";
  };
  const trace = (v) => {
    const t = access?.traces?.[v];
    return t ? h("span", { class: "route-asns", title: `测于 ${date(t.measured_at)}` }, t.hop_asns.map((x) => "AS" + x).join(" → ")) : "—";
  };
  const rows = VANTAGES.map(([v, name]) => ({ v, name, g: grades[v] }));
  const measurements = access?.measurements || [];
  const raw = h("details", {}, h("summary", {}, `单次测量记录（${measurements.length}）`),
    table(
      [
        { label: "时间", render: (m) => date(m.measured_at) },
        { label: "视角", render: (m) => (m.purpose === "REACH" ? "大陆可达检查" : vantageName(m.vantage)) + (m.peak ? "（晚高峰）" : "") },
        { label: "探针", render: (m) => [m.probe_city, m.probe_asn ? "AS" + m.probe_asn : null].filter(Boolean).join(" · ") || "—" },
        { label: "收到/发送", class: "num", render: (m) => `${m.received}/${m.sent}` },
        { label: "平均 RTT", class: "num", render: (m) => ms(m.rtt_avg) },
        { label: "测量 ID", render: (m) => (m.measurement_id ? h("a", { href: `https://api.globalping.io/v1/measurements/${encodeURIComponent(m.measurement_id)}`, target: "_blank", rel: "noreferrer" }, m.measurement_id) : "—") },
      ],
      measurements,
    ),
  );
  return h(
    "section",
    { class: "stack" },
    h("h3", {}, "接入质量"),
    head,
    table(
      [
        { label: "视角", render: (r) => r.name },
        { label: "等级", render: (r) => (r.g ? gradeBadge(r.g.grade, r.v, { withVantage: false }) : "—") },
        { label: "RTT（晚高峰/中位）", class: "num", render: (r) => (r.g?.peak_rtt_ms != null ? ms(r.g.peak_rtt_ms) : h("span", { class: "muted small" }, why(r.v))) },
        { label: "空闲 RTT", class: "num", render: (r) => ms(r.g?.idle_rtt_ms) },
        { label: "丢包", class: "num", render: (r) => lossText(r.g?.loss) },
        { label: "抖动", class: "num", render: (r) => ms(r.g?.jitter_ms) },
        { label: "样本（探针）", class: "num", render: (r) => (r.g ? `${r.g.samples}（${r.g.probes}）` : "—") },
        { label: "接入/稳定", render: (r) => (r.g ? `${BAND[r.g.access_band] || "未测"} / ${BAND[r.g.stability_band] || "不足"}` : "—") },
        { label: "去程经过", render: (r) => (r.v.startsWith("CN-") ? trace(r.v) : "—") },
      ],
      rows,
    ),
    h(
      "p",
      { class: "hint" },
      "接入数据来自 Globalping 社区探针对入口的 TCP 握手（三网为家宽探针、北京时间晚高峰），只说明 TCP 能否连通及延迟丢包；不代表代理协议一定可用，不测带宽，也不判断线路类型。去程只记录实测经过的 ASN，回程无法从国内测得。稳定性来自每日完整检测（美国 Runner）。",
    ),
    raw,
  );
}

function weekStrip(n) {
  const days = n.checked_7d || 0;
  const ok = n.avail_7d || 0;
  const strip = h("span", { class: "week", title: `7 天内检测 ${days} 天，可用 ${ok} 天` });
  for (let i = 0; i < 7; i++) strip.append(h("span", { class: i < ok ? "ok" : i < days ? "bad" : "" }));
  return h("span", { class: "muted small" }, strip, ` 7 天可用 ${ok}/${days}`);
}
