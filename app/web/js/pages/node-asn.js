// ASN ranking: which landing networks are good, by your own measurements. Aggregates
// the loaded (filtered) set per exit ASN; no extra queries. "Good" means S or A for the
// vantage being shown; everything here is measured, nothing is reputation.
import { flag, h, ms } from "../core.js";
import { GRADES, distribution, vantageName } from "../grades.js";
import { countryName, operatorOf, rowVantage } from "./node-rows.js";

const SHOWN = 40;
const count = (n) => n.toLocaleString("zh-CN");
const percent = (x) => (x == null ? "—" : Math.round(x * 100) + "%");

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const share = (part, whole) => (whole ? part / whole : null);

export function asnStats(items) {
  const groups = new Map();
  for (const n of items) {
    const key = n.exit_asn || 0;
    groups.set(key, [...(groups.get(key) || []), n]);
  }
  return [...groups].map(([asn, nodes]) => {
    const graded = nodes.filter((n) => GRADES.includes(n.quality_grade) && n.quality_grade !== "PENDING");
    const good = graded.filter((n) => n.quality_grade === "S" || n.quality_grade === "A").length;
    const countries = new Map();
    for (const n of nodes) if (n.exit_country) countries.set(n.exit_country, (countries.get(n.exit_country) || 0) + 1);
    const typed = nodes.filter((n) => n.exit_ip_type);
    const udpTested = nodes.filter((n) => n.udp === "SUCCESS" || n.udp === "FAILED");
    const checked = nodes.reduce((s, n) => s + (n.checked_7d || 0), 0);
    return {
      asn,
      nodes,
      name: operatorOf(nodes.find((n) => operatorOf(n)) || nodes[0]),
      countries: [...countries].sort((a, b) => b[1] - a[1]).map(([c]) => c),
      grades: Object.fromEntries(GRADES.map((g) => [g, nodes.filter((n) => n.quality_grade === g).length])),
      good: share(good, graded.length),
      rtt: median(nodes.filter((n) => n.quality_grade && !n.unreachable && n.peak_rtt_ms != null).map((n) => n.peak_rtt_ms)),
      avail: share(nodes.reduce((s, n) => s + (n.avail_7d || 0), 0), checked),
      home: share(typed.filter((n) => n.exit_ip_type === "RESIDENTIAL").length, typed.length),
      udp: share(udpTested.filter((n) => n.udp === "SUCCESS").length, udpTested.length),
    };
  });
}

// key -> [header, value, better direction, numeric column]
const COLUMNS = {
  good: ["优质占比", (r) => r.good, "desc", true],
  nodes: ["节点", (r) => r.nodes.length, "desc", true],
  rtt: ["延迟中位", (r) => r.rtt, "asc", true],
  avail: ["7 天可用", (r) => r.avail, "desc", true],
  home: ["家宽", (r) => r.home, "desc", true],
  udp: ["UDP 通", (r) => r.udp, "desc", true],
};

function sortRows(rows, key, direction) {
  const [, value] = COLUMNS[key] || COLUMNS.good;
  const sign = direction === "asc" ? 1 : -1;
  // Small samples last whatever the order, then nulls; ties by size.
  return [...rows].sort((a, b) => {
    const small = (a.nodes.length < 3) - (b.nodes.length < 3);
    const va = value(a), vb = value(b);
    const missing = (va == null) - (vb == null);
    return small || missing || (va == null ? 0 : sign * (va - vb)) || b.nodes.length - a.nodes.length || a.asn - b.asn;
  });
}

export function asnView(items, { sort, onSort, onOpen }) {
  const [key = "good", direction = COLUMNS[key]?.[2] || "desc"] = (sort || "").split(":");
  const rows = sortRows(asnStats(items), COLUMNS[key] ? key : "good", direction);
  const head = h(
    "tr",
    {},
    h("th", { scope: "col" }, "落地网络"),
    h("th", { scope: "col" }, "国家"),
    h("th", { scope: "col" }, `等级 · ${vantageName(rowVantage())}`),
    Object.entries(COLUMNS).map(([k, [label, , better]]) =>
      h(
        "th",
        { scope: "col", class: "num", "aria-sort": k === key ? (direction === "asc" ? "ascending" : "descending") : null },
        h(
          "button",
          { type: "button", class: "sort" + (k === key ? " on" : ""), onclick: () => onSort(`${k}:${k === key ? (direction === "asc" ? "desc" : "asc") : better}`) },
          label,
          h("span", { class: "sort-mark", "aria-hidden": "true" }, k === key ? (direction === "asc" ? "↑" : "↓") : "↕"),
        ),
      ),
    ),
  );
  const tbody = h("tbody");
  const render = (limit) =>
    tbody.replaceChildren(
      ...rows.slice(0, limit).map((r) =>
        h(
          "tr",
          { class: "asn-row" + (r.nodes.length < 3 ? " dim" : ""), tabindex: "0", onclick: () => onOpen(r.asn), onkeydown: (e) => e.key === "Enter" && onOpen(r.asn) },
          h(
            "td",
            { "data-label": "落地网络", class: "asn-net" },
            h("span", { class: "asn-id" }, r.asn ? "AS" + r.asn : "未知"),
            h("span", { class: "asn-name", title: r.name }, r.asn === 13335 ? "Cloudflare（不测不分级）" : r.name && r.name !== "AS" + r.asn ? r.name : ""),
          ),
          h(
            "td",
            { "data-label": "国家", class: "asn-flags", title: r.countries.map(countryName).join("、") },
            r.countries.slice(0, 3).map((c) => h("span", { "aria-label": countryName(c) }, flag(c))),
            r.countries.length > 3 ? h("span", { class: "faint" }, "+" + (r.countries.length - 3)) : null,
          ),
          h("td", { "data-label": "等级" }, distribution(r.grades)),
          h("td", { "data-label": "优质占比", class: "num strong" }, percent(r.good)),
          h("td", { "data-label": "节点", class: "num" }, count(r.nodes.length)),
          h("td", { "data-label": "延迟中位", class: "num" }, r.rtt == null ? "—" : ms(Math.round(r.rtt))),
          h("td", { "data-label": "7 天可用", class: "num" }, percent(r.avail)),
          h("td", { "data-label": "家宽", class: "num" }, percent(r.home)),
          h("td", { "data-label": "UDP 通", class: "num" }, percent(r.udp)),
        ),
      ),
    );
  render(SHOWN);
  const more =
    rows.length > SHOWN
      ? h("button", { type: "button", class: "quiet", onclick: (e) => { render(rows.length); e.target.remove(); } }, `显示全部 ${count(rows.length)} 个网络`)
      : null;
  return h(
    "div",
    { class: "table-card asn-card" },
    h("div", { class: "table-wrap" }, h("table", { class: "asn-table" }, h("thead", {}, head), tbody)),
    h(
      "footer",
      { class: "table-foot" },
      h("span", { class: "range" }, `${count(rows.length)} 个落地网络。优质指当前视角 S/A 级；少于 3 个节点的网络样本太少，排在后面`),
      more,
    ),
  );
}
