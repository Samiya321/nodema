// Node table: columns, row rendering and client-side ordering. The page loads the
// whole filtered set once (compact rows), so sorting and paging never hit the database.
import { IP_TYPE, KIND, ago, badge, flag, h, ms } from "../core.js";
import { nodeDetail } from "./node-detail.js";
import { GRADES, gradeBadge, isCarrier, vantageName } from "../grades.js";

// The vantage the list is showing; rows (and the detail dialog) render grades for it.
let vantage = "CN";
export const setRowVantage = (value) => (vantage = value);
export const rowVantage = () => vantage;

const regionNames = new Intl.DisplayNames(["zh-CN"], { type: "region" });
export const collator = new Intl.Collator("zh-CN", { numeric: true });

export function countryName(code) {
  try {
    return regionNames.of(code) || code;
  } catch {
    return code;
  }
}

// "Greencloud|xTom" when the netblock holder differs from the ASN, else the ASN label.
export const operatorOf = (n) => (n.org_label ? `${n.org_label}|${n.asn_label || "Unknown"}` : n.asn_label || "");

// Every node falls in exactly one bucket of the grade bar.
export const BUCKETS = [...GRADES, "NONE", "OFF"];
export const isAvailable = (n) => n.status === "UP" || n.status === "DEGRADED";
export const bucketOf = (n) => n.quality_grade || (isAvailable(n) ? "NONE" : "OFF");
const rank = (n) => BUCKETS.indexOf(bucketOf(n));

const nullsLast = (a, b, compare) => (a == null) - (b == null) || (a == null ? 0 : compare(a, b));
const number = (key) => (a, b) => nullsLast(a[key], b[key], (x, y) => x - y);
const text = (pick) => (a, b) => nullsLast(pick(a) || null, pick(b) || null, collator.compare);
const ratio = (n) => (n.checked_7d ? n.avail_7d / n.checked_7d : null);
const UDP_RANK = { SUCCESS: 0, FAILED: 1, NOT_SUPPORTED: 2 };
const udpRank = (n) => UDP_RANK[n.udp] ?? 3;

// key -> [header, comparator for ascending, default direction]
export const COLUMNS = {
  name: ["节点", text((n) => n.name), "asc"],
  grade: ["等级", (a, b) => rank(a) - rank(b) || (b.quality_score ?? -1) - (a.quality_score ?? -1), "asc"],
  rtt: ["延迟", number("peak_rtt_ms"), "asc"],
  udp: ["UDP", (a, b) => udpRank(a) - udpRank(b) || (a.udp_ms ?? 1e9) - (b.udp_ms ?? 1e9), "asc"],
  avail: ["7 天可用", (a, b) => nullsLast(ratio(a), ratio(b), (x, y) => x - y) || (a.checked_7d ?? 0) - (b.checked_7d ?? 0), "desc"],
  route: ["线路", text((n) => (n.entry_country || "") + (n.exit_country || "")), "asc"],
  operator: ["落地运营商", text(operatorOf), "asc"],
  checked: ["最近检测", text((n) => n.last_checked_at), "desc"],
};

export function sortNodes(items, key, direction) {
  const [, compare] = COLUMNS[key] || COLUMNS.grade;
  const sign = direction === "desc" ? -1 : 1;
  // Nulls stay last in both directions; ties fall back to the name.
  return [...items].sort((a, b) => {
    const value = compare(a, b);
    const missing = key === "rtt" ? (a.peak_rtt_ms == null) - (b.peak_rtt_ms == null) : 0;
    return missing || sign * value || collator.compare(a.name, b.name);
  });
}

export function headRow(sortKey, direction, onSort, pickAll) {
  const cell = (key, extra = "") => {
    const [label] = COLUMNS[key];
    const title = key === "rtt" ? (isCarrier(vantage) ? `${vantageName(vantage)}晚高峰` : `${vantageName(vantage)}延迟`) : key === "grade" ? `等级 · ${vantageName(vantage)}` : label;
    const active = sortKey === key;
    return h(
      "th",
      { scope: "col", class: extra, "aria-sort": active ? (direction === "asc" ? "ascending" : "descending") : null },
      h(
        "button",
        { type: "button", class: "sort" + (active ? " on" : ""), onclick: () => onSort(key) },
        title,
        h("span", { class: "sort-mark", "aria-hidden": "true" }, active ? (direction === "asc" ? "↑" : "↓") : "↕"),
      ),
    );
  };
  return h(
    "thead",
    {},
    h(
      "tr",
      {},
      h("th", { class: "pick" }, pickAll),
      cell("name"),
      cell("grade"),
      cell("rtt", "num"),
      cell("udp"),
      cell("avail"),
      cell("route"),
      cell("operator", "operator"),
      cell("checked", "num"),
    ),
  );
}

function gradeCell(n) {
  if (n.quality_grade) return h("span", { class: "grade-cell" }, gradeBadge(n.quality_grade, vantage, { withVantage: false }), n.status === "DEGRADED" ? badge(n.status) : null);
  if (isAvailable(n)) return h("span", { class: "ungraded", title: n.exit_asn === 13335 ? "落地是 Cloudflare：不测、不分级" : "下次计算等级时补上" }, n.exit_asn === 13335 ? "CF 落地" : "未分级");
  return badge(n.status);
}

function latency(n) {
  if (!n.quality_grade) return h("span", { class: "faint" }, "—");
  if (n.unreachable) return h("span", { class: "bad-text strong" }, "TCP 不通");
  if (n.peak_rtt_ms == null) return h("span", { class: "faint", title: n.icmp_only ? "UDP 入口，按同网段测" : "还没有测量样本" }, "未测");
  const loss = n.peak_loss ? h("span", { class: n.peak_loss > 0.03 ? "loss bad-text" : "loss" }, `丢 ${(n.peak_loss * 100).toFixed(1)}%`) : null;
  return h("span", { class: "rtt" }, h("strong", {}, ms(n.peak_rtt_ms)), loss);
}

// UDP through the node (Wi-Fi Calling): only shown for nodes that work now.
const UDP_TEXT = { SUCCESS: "通", FAILED: "不通", NOT_SUPPORTED: "仅 TCP" };
function udpCell(n) {
  if (!n.udp || n.udp === "NOT_RUN") return h("span", { class: "faint", title: isAvailable(n) ? "下次每日检测后显示" : "节点当前不可用" }, "—");
  const title = n.udp === "SUCCESS" ? `UDP 往返约 ${n.udp_ms} ms（STUN/DNS 经节点转发）` : n.udp === "FAILED" ? "多次重试仍收不到 UDP 回包" : "节点配置声明只走 TCP";
  return h("span", { class: "udp udp-" + n.udp, title }, h("span", { class: "udp-dot", "aria-hidden": "true" }), UDP_TEXT[n.udp] || n.udp);
}

// Seven cells: green for days with a success, red for checked days without one.
function week(n) {
  if (!n.checked_7d) return h("span", { class: "faint" }, "—");
  const cells = h("span", { class: "week", "aria-hidden": "true" });
  for (let i = 0; i < 7; i++) cells.append(h("span", { class: i < n.avail_7d ? "ok" : i < n.checked_7d ? "bad" : "" }));
  return h("span", { class: "week-cell", title: `7 天内检测 ${n.checked_7d} 天，${n.avail_7d} 天可用` }, cells, h("span", { class: "week-n" }, `${n.avail_7d}/${n.checked_7d}`));
}

function route(n) {
  const code = (c, cls) => h("span", { class: "code " + cls }, c ? `${flag(c)} ${c}` : "?");
  if (!n.entry_country && !n.exit_country) return h("span", { class: "faint" }, "—");
  if (!n.entry_country || n.entry_country === n.exit_country) return h("span", { class: "route" }, code(n.exit_country || n.entry_country, "to"));
  return h("span", { class: "route" }, code(n.entry_country, "from"), h("span", { class: "arrow", "aria-label": "到" }, "→"), code(n.exit_country, "to"));
}

function operatorCell(n) {
  if (!n.exit_asn) return h("span", { class: "faint" }, "—");
  const asn = "AS" + n.exit_asn;
  const name = operatorOf(n);
  // Unnamed networks only have their number: show it once.
  return !name || name === asn ? h("span", { class: "op-name" }, asn) : [h("span", { class: "op-name", title: name }, name), h("span", { class: "op-asn" }, asn)];
}

export function nodeRow(n, picked, onPick) {
  const ipType = n.exit_ip_type ? IP_TYPE[n.exit_ip_type] + (n.exit_ip_proxy ? "·代理标记" : "") : "";
  const meta = [n.short_id, n.protocol, KIND[n.node_group] || "", ipType, n.server_node_count > 1 ? `同服务器 ${n.server_node_count} 个` : "", n.enabled ? "" : "已停用", n.present_source_count ? "" : "上游已移除"].filter(Boolean);
  return h(
    "tr",
    { class: (n.enabled ? "" : "dim ") + (picked ? "picked" : "") },
    h("td", { class: "pick" }, h("input", { type: "checkbox", checked: picked, "aria-label": "选择 " + n.name, dataset: { id: n.id }, onchange: (e) => onPick([n.id], e.target.checked) })),
    h(
      "td",
      { "data-label": "节点", class: "name-td" },
      h("button", { type: "button", class: "link name-cell", onclick: () => nodeDetail(n.id) }, h("span", { class: "node-name" }, n.name), h("span", { class: "node-meta" }, meta.map((m) => h("span", {}, m)))),
    ),
    h("td", { "data-label": "等级" }, gradeCell(n)),
    h("td", { "data-label": isCarrier(vantage) ? "晚高峰" : "延迟", class: "num" }, latency(n)),
    h("td", { "data-label": "UDP" }, udpCell(n)),
    h("td", { "data-label": "7 天可用" }, week(n)),
    h("td", { "data-label": "线路" }, route(n)),
    h("td", { "data-label": "落地运营商", class: "operator" }, operatorCell(n)),
    h("td", { "data-label": "最近检测", class: "num faint-text" }, ago(n.last_checked_at)),
  );
}
