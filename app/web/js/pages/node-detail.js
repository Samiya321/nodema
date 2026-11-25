import { IP_TYPE, ago, api, badge, busy, date, dialog, empty, errorText, field, h, ms, pct, route, select, table, toast } from "../core.js";
import { testNodes } from "../strip.js";
import { showShare } from "../share.js";
import { ACCESS_EVIDENCE, VANTAGES, gradeBadge, vantageName } from "../grades.js";
import { copyPageLink, exportHref, nodeHref, pageHref, sourcePath } from "../lineage.js";
import { classificationLabel, classificationSection } from "./node-classification.js";

const MEASURE = { FULL: "完整代理验证", PREFLIGHT: "入口预检", SKIPPED: "本轮跳过" };
const BAND = { S: "优", A: "良", B: "中", C: "差" };
const lossText = (v) => (v === null || v === undefined ? "—" : (v * 100).toFixed(1) + "%");

// UDP through the node (Wi-Fi Calling): the latest check, and its exit when it differs.
function udpText(n) {
  if (!n.udp_state || n.udp_state === "NOT_RUN") return n.udp_success_at ? `最近一次通过：${ago(n.udp_success_at)}` : "还没有测过";
  if (n.udp_state === "NOT_SUPPORTED") return "节点配置声明只走 TCP";
  if (n.udp_state === "FAILED") return n.udp_success_at ? `这次不通（重试多次）；上次通过 ${ago(n.udp_success_at)}` : "不通（重试多次仍收不到回包）";
  const other = n.udp_exit_ip && n.exit_ip && n.udp_exit_ip !== n.exit_ip;
  const sample = n.published_observation?.precheck_metadata?.udp?.find((a) => a.ok);
  const label = sample?.target?.startsWith("stun-") ? "STUN 有回包"
    : { VALID: "DNS 解析正确", ERROR: "DNS 有回包，解析返回错误", UNEXPECTED: "DNS 有回包，答案不符" }[sample?.dns_response]
      || "公共 STUN/DNS 有回包";
  return h("span", {}, `${label} · 往返约 ${n.udp_ms} ms`, n.udp_success_at ? ` · ${date(n.udp_success_at)}` : "", other ? h("span", { class: "muted" }, `；UDP 出口 ${n.udp_exit_ip}（与 TCP 落地不同）`) : null);
}

function exitHistory(summary) {
  if (!summary?.observed_days) return "近 7 天无出口观测";
  return h("span", {}, `${summary.observed_days} 天有观测 · ${summary.ip_count} 个 IP · ${summary.country_count} 个已识别地区 · ${summary.asn_count} 个已识别 ASN`,
    summary.last_change_at ? h("small", { class: "muted" }, ` · 最近换 IP ${date(summary.last_change_at)}`) : null);
}

function pairs(entries) {
  return h("dl", { class: "pairs" }, entries.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v ?? "—")]));
}

function detailFold(title, ...children) {
  return h("details", { class: "panel node-fold" }, h("summary", {}, title), h("div", { class: "stack" }, children));
}

function lazyDetail(title, read) {
  const content = h("div", { class: "stack" });
  const section = detailFold(title, content);
  async function load() {
    content.replaceChildren(h("p", { class: "muted", role: "status" }, "正在加载…"));
    try {
      content.replaceChildren(await read());
    } catch (error) {
      content.replaceChildren(
        h("p", { class: "form-error", role: "alert" }, errorText(error.code)),
        h("button", { type: "button", onclick: load }, "重试"),
      );
    }
  }
  section.addEventListener("toggle", () => {
    if (section.open && !content.hasChildNodes()) void load();
  });
  return section;
}

export async function render(root, { params, returnTo, refresh, isCurrent }) {
  const id = params.get("node");
  const requestedVantage = params.get("vantage");
  const heading = h("h1", { class: "page-title" }, "节点详情");
  const header = h("header", { class: "title-row" }, heading);
  root.append(h("a", {
    class: "return-link", href: returnTo?.href || pageHref("nodes", requestedVantage ? { vantage: requestedVantage } : {}),
    onclick: (event) => {
      if (!returnTo?.direct || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      history.back();
    },
  }, "返回节点列表"), header);
  const path = `/nodes/${encodeURIComponent(id)}`;
  const n = await api(path + (requestedVantage ? `?vantage=${encodeURIComponent(requestedVantage)}` : ""));
  if (!isCurrent()) return;
  const vantage = n.vantage || "CN";
  const obs = n.published_observation;
  const body = h("div", { class: "sheet-body lineage-body stack" });
  heading.textContent = n.name;
  header.append(copyPageLink(nodeHref(n.id, vantage)));
  root.append(body);
  const aliases = h("div");
  // Native append() would print "null" for skipped sections; drop them first.
  const add = (...items) => body.append(...items.filter((x) => x !== null && x !== undefined && x !== false));
  add(
    h(
      "div",
      { class: "detail-head" },
      badge(n.status),
      route(n.entry_country, n.exit_country),
      h("span", { class: "muted" }, [n.short_id, n.protocol].filter(Boolean).join(" · ")),
      h("span", { class: "tag " + (n.node_group === "AIRPORT" ? "air" : "own") }, classificationLabel(n)),
      h("span", { class: "muted" }, `最近检测 ${ago(n.last_checked_at)}`),
    ),
    h("div", { class: "row wrap" },
      h("button", { type: "button", class: "primary", onclick: () => showShare(n) }, "二维码 / 分享"),
      h("button", { type: "button", disabled: n.eligible === false, onclick: () => testNodes([n.id]) }, "检测此节点"),
      h("button", { type: "button", onclick: (e) => toggleEnabled(e.currentTarget, n, refresh) }, n.enabled ? "停用此节点" : "启用此节点"),
      h("button", { type: "button", onclick: () => annotate(n.id, refresh) }, "编辑标签"),
    ),
    h("section", { class: "panel stack" },
      h("h2", {}, "质量概览"),
      h("div", { class: "row wrap" },
        gradeBadge(n.quality_grade, vantage) || h("span", { class: "muted" }, n.exit_asn === 13335 ? "CF 落地 · 不分级" : "当前暂无等级"),
        n.quality_grade && n.limiting_vantage && vantage === "CN" ? h("span", { class: "muted" }, `${vantageName(n.limiting_vantage)}短板`) : null,
        n.quality_grade ? h("span", { class: "muted" }, n.unreachable ? "入口重复失败" : n.endpoint_verified ? "端点已确认"
          : n.access_evidence === "ENDPOINT" ? "端点待补测" : ACCESS_EVIDENCE[n.access_evidence] || "接入待测") : null,
        n.checked_7d > 0 ? h("span", { class: "muted" }, `近 7 天可用 ${n.avail_7d}/${n.checked_7d} 个受检日`) : null,
      ),
      weekTimeline(n.observations?.days),
    ),
    classificationSection(n, refresh),
    lazyDetail("接入测量与分级依据", async () => accessSection(n, await api(path + "/access"), vantage)),
    detailFold("来源与订阅",
      h("h2", {}, "直接来源"),
      table([
        { label: "来源路径", render: (s) => sourcePath(s.chain) },
        { label: "关联", render: (s) => s.is_present ? "上游仍包含" : "上游已移除" },
        { label: "来源状态", render: (s) => s.deleted ? "已删除" : s.enabled ? "启用" : "暂停" },
        { label: "首次收录", render: (s) => date(s.first_seen_at) },
        { label: "最近出现", render: (s) => date(s.last_seen_at) },
      ], n.sources, { empty: empty("没有保留来源记录") }),
      h("h2", {}, "包含此节点的订阅"),
      n.exports?.length ? h("ul", { class: "notes" }, n.exports.map((item) => h("li", {},
        h("a", { href: exportHref(item.id) }, item.name),
        h("span", { class: "muted small" }, `v${item.version}${item.serving ? "" : " · 当前未提供下载"}`),
      ))) : h("p", { class: "muted" }, "当前没有包含此节点的订阅"),
      h("div", {}, h("button", { type: "button", onclick: (e) =>
        busy(e.currentTarget, async () => {
          const rows = await api(path + "/aliases");
          aliases.replaceChildren(table([
            { label: "来源", render: (r) => r.source_name },
            { label: "原始名称", render: (r) => r.aliases.join("、") },
            { label: "上游仍包含", render: (r) => (r.is_present ? "是" : "否") },
          ], rows));
        }),
      }, "查看原始名称")),
      aliases,
    ),
    obs?.echo_source === "fallback"
      ? h("p", { class: "callout" }, "备用地址已确认代理连通，本轮未观测到出口 IP。已有落地资料来自历史检测，不能用本次检测时间判断其新鲜度。")
      : null,
    obs?.precheck_metadata?.direct_exit_match === true
      ? h("p", { class: "callout" }, "本轮代理出口与同地址族的 Runner 直连出口一致，建议复核代理链路。")
      : null,
    detailFold("入口、落地与检测参数", h(
      "div",
      { class: "grid-2" },
      pairs([
        ["编号", n.short_id],
        ["协议", `${n.protocol} / ${n.transport || "—"} / ${n.security || "—"}`],
        ["入口", h("code", {}, `${n.server_host}:${n.server_port}`)],
        ["入口解析", obs?.entry_ips?.join("、")],
        ["入口地区 / ASN（GeoLite 原始值）", `${n.identity?.raw_entry_country || "未知"} / ${n.entry_asn ? "AS" + n.entry_asn : "—"}`],
        ["落地 IP", n.exit_ip ? h("span", {}, h("code", {}, n.exit_ip), n.server_node_count > 1 ? h("span", { class: "tag" }, `同服务器 ×${n.server_node_count}`) : null) : null],
        ["落地国家（Echo，缺失回退 GeoLite）", n.exit_country],
        ["ip-api 位置（独立数据源）", [n.identity?.ipapi_country, n.exit_region, n.exit_ip_city].filter(Boolean).join(" · ") || null],
        ["出口 IP 最后观测", n.exit_ip ? (n.exit_observed_at ? date(n.exit_observed_at) : "时间未知（历史明细已清理）") : null],
        ["近 7 天出口变动", exitHistory(n.observations?.exit)],
        ["IP 归属（org）", n.exit_org],
        ["ISP", n.exit_isp],
        ["IP 类型", n.exit_ip_type ? `${IP_TYPE[n.exit_ip_type]}${n.exit_ip_proxy ? "，被标记为 VPN/代理" : ""}（ip-api 数据库标记，非实测）` : null],
        ["落地 ASN", n.exit_asn ? `AS${n.exit_asn} ${n.exit_asn_org || ""}` : "—"],
        ["UDP", udpText(n)],
      ]),
      pairs([
        ["美国 Runner 代理延迟", ms(n.http_duration_ms)],
        ["首次加入", `${date(n.first_seen_at)}（第 ${n.age_days} 天）`],
        ["累计可用", `${n.available_days} / ${n.checked_days} 天，${pct(n.lifetime_availability)}`],
        ["美国 Runner 成功率 / P95", `${pct(n.success_rate)} / ${ms(n.http_p95_ms)}`],
        ["检测方式", MEASURE[n.measurement_kind] || "—"],
        ["最近检测原因", n.last_error_code ? errorText(n.last_error_code) : "—"],
        ["同地址族直连对照", obs?.precheck_metadata?.direct_exit_match === true ? "出口一致"
          : obs?.precheck_metadata?.direct_exit_match === false ? "出口不同" : "无可比观测"],
        ["下次完整复查", n.next_full_check_at ? date(n.next_full_check_at) : "按计划"],
      ]),
    ), identitySection(n)),
    n.exit_ip && n.server_node_count > 1 ? lazyDetail(`相同落地 IP（${n.server_node_count} 个节点）`, () => siblings(n, vantage)) : null,
    detailFold("检测历史", table(
      [
        { label: "时间", render: (r) => date(r.checked_at) },
        { label: "结果", render: (r) => badge(r.status) },
        { label: "落地", render: (r) => (r.exit_country ? `${r.exit_country} AS${r.exit_asn ?? "?"}` : r.echo_source === "fallback" ? "未知（Echo 不可达）" : "—") },
        { label: "延迟", class: "num", render: (r) => ms(r.http_duration_ms) },
        { label: "阶段", render: (r) => `DNS ${r.dns_status} · TCP ${r.tcp_status} · 代理 ${r.proxy_status}` },
        { label: "原因", render: (r) => (r.error_code ? errorText(r.error_code) : "—") },
      ],
      n.history,
    )),
  );
}

function identitySection(n) {
  const i = n.identity;
  if (!i) return null;
  const flags = n.identity_flags || 0;
  const messages = [
    flags & 1 ? "入口唯一解析 IP 与已观测出口 IP 相同，名称统一采用落地国家；同 IP 不证明同一物理机房。" : null,
    flags & 2 ? "国家归属源有分歧，不能据此确认物理中转或机房位置。" : null,
    flags & 4 ? "ASN 来源有分歧，下方分别保留各来源的数值与组织文本。" : null,
    flags & 8 ? "当前展示的是历史落地资料；本轮没有重新确认出口。" : null,
    flags & 16 ? "入口国家未知，名称以 ? 标明。" : null,
  ].filter(Boolean);
  return h("section", { class: "stack" }, h("h3", {}, "归属依据"),
    h("p", { class: "hint" }, "国家、组织与 ISP 都是数据库元数据；只实测代理出口 IP，不据此推断回程或线路类型。运营商简称优先使用已核实或手动设置的 ASN 别名。"),
    ...messages.map((m) => h("p", { class: "callout" }, m)),
    pairs([
      ["出口国家来源", i.exit_country_source === "echo" ? "Echo / Cloudflare" : i.exit_country_source === "geolite" ? "GeoLite" : "Echo 优先，GeoLite 回退（旧记录未细分）"],
      ["GeoLite 出口国家 / ASN（本轮）", [i.geolite_exit_country, i.geolite_exit_asn ? `AS${i.geolite_exit_asn}` : null].filter(Boolean).join(" / ") || null],
      ["检测保存的 ASN / 组织原文", [i.observed_exit_asn ? `AS${i.observed_exit_asn}` : null, i.observed_exit_org].filter(Boolean).join(" · ") || null],
      ["ip-api ASN / AS 组织", [i.ipapi_asn ? `AS${i.ipapi_asn}` : null, i.ipapi_as_org].filter(Boolean).join(" · ") || null],
      ["ip-api 查询时间", i.ipapi_queried_at ? date(i.ipapi_queried_at) : null],
    ]));
}

// Other nodes landing on the same server (same exit IP), usually other protocols.
async function siblings(n, vantage) {
  const query = new URLSearchParams({ exit_ip: n.exit_ip, vantage, sort: "quality_grade:asc", limit: "50" });
  const page = await api("/nodes?" + query);
  return h("div", { class: "stack" },
    h("p", { class: "hint" }, "这些节点观测到的落地 IP 相同，共用一个序号；同 IP 也可能来自共享出口或任播，不证明同一台服务器。"),
    table([
      { label: "节点", render: (s) => s.id === n.id ? h("strong", {}, s.name) : h("a", { href: nodeHref(s.id, vantage) }, s.name) },
      { label: "协议", render: (s) => `${s.protocol} / ${s.transport || "—"} / ${s.security || "—"}` },
      { label: "入口", render: (s) => h("code", {}, `${s.server_host}:${s.server_port}`) },
      { label: "状态", render: (s) => badge(s.status) },
      { label: "等级 · " + vantageName(vantage), render: (s) => gradeBadge(s.quality_grade, vantage, { withVantage: false }) || "—" },
    ], page.items),
  );
}

async function toggleEnabled(button, node, refresh) {
  await busy(button, async () => {
    await api("/nodes/" + node.id, { method: "PATCH", body: { enabled: !node.enabled } });
    toast(node.enabled ? "已停用，不再检测和导出。" : "已启用。", "ok");
    window.dispatchEvent(new CustomEvent("nodema:nodes-changed"));
    await refresh();
  });
}

async function annotate(id, refresh) {
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
      await refresh();
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
        h("p", { class: "row tight" }, gradeBadge(n.quality_grade, current),
          current === "CN" && chosen.limiting_vantage ? h("span", { class: "muted" }, `短板 · ${vantageName(chosen.limiting_vantage)}`) : null,
          h("span", { class: "muted small" }, ACCESS_EVIDENCE[chosen.access_evidence] || "接入待测")),
        chosen.reasons?.length ? h("ul", { class: "reasons" }, chosen.reasons.map((r) => h("li", {}, r))) : null,
      )
    : h("p", { class: "muted" }, n.exit_asn === 13335 ? "CF 落地 · 不分级" : "当前暂无等级");
  const why = (v) => {
    if (access?.icmp_only) return "UDP 入口 · 暂无参考样本";
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
        { label: "目标", render: (m) => m.target === access?.target ? "本入口" : "共享参考入口" },
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
        { label: "样本范围", render: (r) => ACCESS_EVIDENCE[r.g?.access_evidence] || "—" },
        { label: "RTT（晚高峰/中位）", class: "num", render: (r) => r.g?.unreachable ? h("span", { class: "bad-text" }, "入口重复失败")
          : r.g?.peak_rtt_ms != null ? ms(r.g.peak_rtt_ms) : h("span", { class: "muted small" }, why(r.v)) },
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
      "接入数据来自 Globalping 社区探针。大陆以北京时间晚高峰的 TCP 样本定档，海外使用全天样本。入口范围见表，去程显示实测 ASN。稳定性来自美国 Runner 日检。",
    ),
    raw,
  );
}

function weekTimeline(days) {
  if (!days?.length) return null;
  const labels = { UP: "通过", DOWN: "失败", UNTESTED: "未检测" };
  const describe = (day) => day.status === "UNTESTED" ? `${day.day} · 未取得可用性结果`
    : `${day.day} · ${day.successful} 次通过 · ${day.failed} 次失败`;
  const output = h("p", { class: "muted small", role: "status" }, describe(days.at(-1)));
  const buttons = days.map((day, index) => h("button", {
    type: "button", class: "timeline-day", "data-status": day.status,
    "aria-label": `${day.day} ${labels[day.status]}`, "aria-pressed": String(index === days.length - 1),
    onclick: () => {
      buttons.forEach((button, i) => button.setAttribute("aria-pressed", String(i === index)));
      output.textContent = describe(day);
    },
  }, h("time", { datetime: day.day }, day.day.slice(5)), h("span", {}, labels[day.status])));
  return h("section", { class: "stack tight" }, h("h3", {}, "最近 7 天 · 北京时间"),
    h("div", { class: "node-timeline" }, buttons), output);
}
