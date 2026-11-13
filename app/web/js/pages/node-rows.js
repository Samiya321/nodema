// Row, group and pager rendering for the nodes page. Rows are built lazily, a
// chunk at a time, so thousands of nodes never land in the DOM at once.
import { IP_TYPE, KIND, ago, badge, flag, h, pct, route } from "../core.js";
import { nodeDetail } from "./node-detail.js";
import { GRADES, accessText, gradeBadge, vantageName } from "../grades.js";

// The vantage the list is showing; rows render grades for it.
let vantage = "CN";
export const setRowVantage = (value) => (vantage = value);
export const rowVantage = () => vantage;

export const CHUNK = 100;
const regionNames = new Intl.DisplayNames(["zh-CN"], { type: "region" });
export const collator = new Intl.Collator("zh-CN", { numeric: true });

export function countryName(code) {
  try {
    return regionNames.of(code) || code;
  } catch {
    return code;
  }
}

// Names end with the server number, optionally followed by a protocol suffix ("01 VMess").
export const seqOf = (node) => Number((/ (\d+)(?: \S+)?$/.exec(node.name) || [])[1] || 0);
// "Greencloud|xTom" when the netblock holder differs from the ASN, else the ASN label.
export const operatorOf = (n) => (n.org_label ? `${n.org_label}|${n.asn_label || "Unknown"}` : n.asn_label || "");
const byOperatorThenSeq = (a, b) =>
  collator.compare(operatorOf(a) || "~", operatorOf(b) || "~") || seqOf(a) - seqOf(b) || collator.compare(a.name, b.name);

export function groupKey(node, view) {
  if (view === "grade") return node.quality_grade || "";
  if (view === "country") return node.exit_country || "";
  if (view === "asn") return node.exit_asn ? String(node.exit_asn) : "";
  if (view === "server") return node.exit_ip || "";
  return "all";
}

const byScore = (a, b) => (b.quality_score ?? -1) - (a.quality_score ?? -1) || collator.compare(a.name, b.name);
export const gradeOrder = (key) => (key ? GRADES.indexOf(key) : GRADES.length);

export function memberOrder(view) {
  if (view === "grade") return byScore;
  if (view === "country") return byOperatorThenSeq;
  if (view === "server") return (a, b) => collator.compare(a.protocol, b.protocol) || collator.compare(a.name, b.name);
  return (a, b) => collator.compare(a.exit_country || "~", b.exit_country || "~") || seqOf(a) - seqOf(b);
}

const GRADE_GROUP = {
  S: "接入优、稳定优",
  A: "接入与稳定都至少良",
  B: "都至少中；接入未测的节点最高在这一档",
  C: "能用，但接入或稳定有一项差",
  D: "该地区 TCP 握手全部失败",
  PENDING: "检测天数不足，暂不定档",
};

export function groupTitle(view, key, sample) {
  if (view === "grade")
    return key
      ? [gradeBadge(key, vantage), " ", h("span", { class: "muted" }, GRADE_GROUP[key])]
      : [h("span", { class: "group-flag" }, "·"), "当前不可用或未检测（不定档）"];
  if (!key) return [h("span", { class: "group-flag" }, "🏳"), "未检测或无落地信息"];
  if (view === "country") return [h("span", { class: "group-flag" }, flag(key)), `${countryName(key)} `, h("span", { class: "muted" }, key)];
  if (view === "server")
    return [
      h("span", { class: "group-flag" }, flag(sample.exit_country)),
      `${operatorOf(sample) || "未知运营商"} ${String(seqOf(sample)).padStart(2, "0")} `,
      h("span", { class: "muted" }, [key, sample.exit_org, sample.exit_region].filter(Boolean).join(" · ")),
    ];
  return [sample.asn_label || "AS" + key, h("span", { class: "muted" }, ` AS${key}${sample.exit_asn_org ? " · " + sample.exit_asn_org : ""}`)];
}

export function headRow(view) {
  const labels = ["", "节点", "等级 · " + vantageName(vantage), "晚高峰", "7 天可用", "入口 → 落地", view === "asn" ? "落地国家" : "落地运营商", "类别", "最近检测"];
  return h("thead", {}, h("tr", {}, labels.map((t, i) => h("th", { scope: "col", class: i === 0 ? "pick" : i === 4 ? "num" : "" }, t))));
}

function gradeCell(n) {
  if (!n.quality_grade) return badge(n.status);
  return h("span", { class: "grade-cell" }, gradeBadge(n.quality_grade, vantage, { withVantage: false }), n.status === "DEGRADED" ? badge(n.status) : null);
}

export function nodeRow(n, view, onPick) {
  const ipType = n.exit_ip_type ? IP_TYPE[n.exit_ip_type] + (n.exit_ip_proxy ? "（ip-api 标记代理）" : "") : "";
  const meta = [n.short_id, n.protocol, ipType, n.checked_days ? `累计 ${pct(n.lifetime_availability)}` : "", n.server_node_count > 1 ? `同服务器 ×${n.server_node_count}` : "", n.enabled ? "" : "已停用", n.present_source_count ? "" : "上游已移除"];
  return h(
    "tr",
    { class: n.enabled ? "" : "dim" },
    h("td", { class: "pick" }, h("input", { type: "checkbox", "aria-label": "选择 " + n.name, dataset: { id: n.id }, onchange: (e) => onPick([n.id], e.target.checked) })),
    h(
      "td",
      { "data-label": "节点" },
      h("button", { type: "button", class: "link name-cell", onclick: () => nodeDetail(n.id) }, h("span", { class: "node-name" }, n.name), h("span", { class: "muted small" }, meta.filter(Boolean).join(" · "))),
    ),
    h("td", { "data-label": "等级" }, gradeCell(n)),
    h("td", { "data-label": "晚高峰", class: "access-cell" + (n.unreachable ? " unreachable" : "") }, n.quality_grade ? accessText(n) : "—"),
    h("td", { class: "num", "data-label": "7 天可用" }, n.checked_7d ? `${n.avail_7d}/${n.checked_7d} 天` : "—"),
    h("td", { "data-label": "入口 → 落地" }, route(n.entry_country, n.exit_country)),
    view === "asn"
      ? h("td", { "data-label": "落地国家" }, n.exit_country ? `${flag(n.exit_country)} ${n.exit_country}` : "—")
      : h("td", { "data-label": "落地运营商" }, n.exit_asn ? h("span", {}, operatorOf(n), h("span", { class: "muted small" }, ` AS${n.exit_asn}`)) : "—"),
    h("td", { "data-label": "类别" }, h("span", { class: "tag " + (n.node_group === "AIRPORT" ? "air" : "own") }, KIND[n.node_group] || "—")),
    h("td", { "data-label": "最近检测" }, ago(n.last_checked_at)),
  );
}

// Table body that renders CHUNK nodes at a time ("显示更多"). In the country view a
// light sub-header separates operators when a country has several.
export function lazyBody(members, view, onPick, afterRender) {
  const operators = view === "country" ? new Set(members.map(operatorOf)) : new Set();
  const counts = new Map();
  for (const n of members) counts.set(operatorOf(n), (counts.get(operatorOf(n)) || 0) + 1);
  const tbody = h("tbody");
  const more = h("button", { type: "button", class: "quiet more" });
  let shown = 0;
  let current;
  const next = () => {
    const rows = [];
    for (const n of members.slice(shown, shown + CHUNK)) {
      const label = operatorOf(n);
      if (operators.size > 1 && label !== current) {
        current = label;
        rows.push(h("tr", { class: "subhead" }, h("td", { colspan: 9 }, label || "无 ASN 信息", h("span", { class: "muted" }, ` ${counts.get(label)} 个${n.exit_asn ? " · AS" + n.exit_asn : ""}`))));
      }
      rows.push(nodeRow(n, view, onPick));
    }
    tbody.append(...rows);
    shown = Math.min(members.length, shown + CHUNK);
    more.textContent = `显示更多（还有 ${members.length - shown} 个）`;
    more.hidden = shown >= members.length;
    afterRender();
  };
  more.addEventListener("click", next);
  next();
  return [h("div", { class: "table-wrap flush" }, h("table", {}, headRow(view), tbody)), more];
}
