import { useMemo, useState } from "react";
import { GradeDistribution } from "../../components/ui";
import { countryFlag, countryName, formatMs, formatNumber, operatorOf } from "../../lib/format";
import { GRADES, vantageName } from "../../lib/grades";
import type { NodeListItem, QualityGrade, Vantage } from "../../types/api";

const INITIAL_SHOWN = 40;
const formatIntPct = (x: number | null) => (x == null ? "—" : Math.round(x * 100) + "%");

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const share = (part: number, whole: number) => (whole ? part / whole : null);

export interface AsnRowStat {
  asn: number;
  nodes: NodeListItem[];
  name: string;
  countries: string[];
  grades: Partial<Record<QualityGrade, number>>;
  ipCount: number;
  covered: number;
  coverage: number | null;
  good: number | null;
  rtt: number | null;
  avail: number | null;
  home: number | null;
  udp: number | null;
}

export function computeAsnStats(items: NodeListItem[]): AsnRowStat[] {
  const groups = new Map<number, NodeListItem[]>();
  for (const n of items) {
    const key = n.exit_asn || 0;
    const list = groups.get(key);
    if (list) list.push(n);
    else groups.set(key, [n]);
  }
  return [...groups].map(([asn, nodes]) => {
    const ips = new Map<string, NodeListItem | null>();
    for (const node of nodes) {
      if (!node.exit_ip) continue;
      if (!ips.has(node.exit_ip)) ips.set(node.exit_ip, null);
      if (!node.endpoint_verified || !node.quality_grade || !["S", "A", "B", "C"].includes(node.quality_grade)) {
        continue;
      }
      const other = ips.get(node.exit_ip);
      if (
        !other ||
        GRADES.indexOf(node.quality_grade) < GRADES.indexOf(other.quality_grade!) ||
        (node.quality_grade === other.quality_grade &&
          (node.quality_score ?? -1) > (other.quality_score ?? -1))
      ) {
        ips.set(node.exit_ip, node);
      }
    }
    const covered = [...ips.values()].filter((x): x is NodeListItem => Boolean(x));
    const better = covered.filter((n) => n.quality_grade === "S" || n.quality_grade === "A").length;
    const countryMap = new Map<string, number>();
    for (const n of nodes) {
      if (n.exit_country) countryMap.set(n.exit_country, (countryMap.get(n.exit_country) || 0) + 1);
    }
    const typed = nodes.filter((n) => n.exit_ip_type);
    const udpTested = nodes.filter((n) => n.udp === "SUCCESS" || n.udp === "FAILED");
    const checked = nodes.reduce((s, n) => s + (n.checked_7d || 0), 0);
    const grades: Partial<Record<QualityGrade, number>> = {};
    for (const g of GRADES) grades[g] = nodes.filter((n) => n.quality_grade === g).length;

    return {
      asn,
      nodes,
      name: operatorOf(nodes.find((n) => operatorOf(n)) || nodes[0]),
      countries: [...countryMap].sort((a, b) => b[1] - a[1]).map(([c]) => c),
      grades,
      ipCount: ips.size,
      covered: covered.length,
      coverage: share(covered.length, ips.size),
      good: share(better, covered.length),
      rtt: median(
        covered
          .filter((n) => n.peak_rtt_ms != null)
          .map((n) => n.peak_rtt_ms as number),
      ),
      avail: share(
        nodes.reduce((s, n) => s + (n.avail_7d || 0), 0),
        checked,
      ),
      home: share(typed.filter((n) => n.exit_ip_type === "RESIDENTIAL").length, typed.length),
      udp: share(udpTested.filter((n) => n.udp === "SUCCESS").length, udpTested.length),
    };
  });
}

type AsnSortKey = "good" | "nodes" | "ips" | "coverage" | "rtt" | "avail" | "home" | "udp";

const ASN_COLUMNS: ReadonlyArray<{
  key: AsnSortKey;
  label: string;
  pick: (r: AsnRowStat) => number | null;
  defaultDir: "asc" | "desc";
}> = [
  { key: "good", label: "S/A 占比", pick: (r) => r.good, defaultDir: "desc" },
  { key: "nodes", label: "节点", pick: (r) => r.nodes.length, defaultDir: "desc" },
  { key: "ips", label: "独立 IP", pick: (r) => r.ipCount, defaultDir: "desc" },
  { key: "coverage", label: "实测覆盖", pick: (r) => r.coverage, defaultDir: "desc" },
  { key: "rtt", label: "入口延迟", pick: (r) => r.rtt, defaultDir: "asc" },
  { key: "avail", label: "7 天可用", pick: (r) => r.avail, defaultDir: "desc" },
  { key: "home", label: "家宽", pick: (r) => r.home, defaultDir: "desc" },
  { key: "udp", label: "UDP 通", pick: (r) => r.udp, defaultDir: "desc" },
];

export function NodeAsnView({
  items,
  vantage,
  sort,
  onSort,
  onOpenAsn,
}: {
  items: NodeListItem[];
  vantage: Vantage;
  sort: string | null;
  onSort: (val: string) => void;
  onOpenAsn: (asn: number) => void;
}) {
  const [showAll, setShowAll] = useState(false);

  const [rawKey, rawDir] = (sort || "").split(":");
  const colSpec = ASN_COLUMNS.find((c) => c.key === rawKey) || ASN_COLUMNS[0];
  const sortKey = colSpec.key;
  const sortDir: "asc" | "desc" =
    rawDir === "asc" || rawDir === "desc" ? rawDir : colSpec.defaultDir;

  const rows = useMemo(() => {
    const stats = computeAsnStats(items);
    const sign = sortDir === "asc" ? 1 : -1;
    return [...stats].sort((a, b) => {
      const small = Number(a.covered < 3) - Number(b.covered < 3);
      const va = colSpec.pick(a);
      const vb = colSpec.pick(b);
      const missing = Number(va == null) - Number(vb == null);
      return (
        small ||
        missing ||
        (va == null || vb == null ? 0 : sign * (va - vb)) ||
        b.covered - a.covered ||
        b.ipCount - a.ipCount ||
        a.asn - b.asn
      );
    });
  }, [items, colSpec, sortDir]);

  const visible = showAll ? rows : rows.slice(0, INITIAL_SHOWN);

  return (
    <div className="table-card">
      <div className="table-wrap table-wrap-flush">
        <table className="data-table asn-table">
          <thead>
            <tr>
              <th scope="col">落地网络</th>
              <th scope="col">国家</th>
              <th scope="col">等级 · {vantageName(vantage)}</th>
              {ASN_COLUMNS.map((c) => {
                const active = c.key === sortKey;
                const nextDir = active
                  ? sortDir === "asc"
                    ? "desc"
                    : "asc"
                  : c.defaultDir;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    className="num"
                    aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : undefined}
                  >
                    <button
                      type="button"
                      className={`sort-btn${active ? " is-active" : ""}`}
                      onClick={() => onSort(`${c.key}:${nextDir}`)}
                    >
                      <span>{c.label}</span>
                      <span className="sort-mark" aria-hidden="true">
                        {active ? (sortDir === "asc" ? "↑" : "↓") : "↕"}
                      </span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr
                key={r.asn}
                className={`asn-row${r.covered < 3 ? " is-dim" : ""}`}
                tabIndex={0}
                onClick={() => onOpenAsn(r.asn)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOpenAsn(r.asn);
                  }
                }}
              >
                <td className="asn-net-cell" data-label="落地网络">
                  <span className="asn-badge mono">{r.asn ? `AS${r.asn}` : "未知"}</span>
                  <span className="asn-org" title={r.name}>
                    {r.asn === 13335
                      ? "Cloudflare（不测不分级）"
                      : r.name && r.name !== `AS${r.asn}`
                        ? r.name
                        : ""}
                  </span>
                </td>
                <td
                  className="asn-flags"
                  data-label="国家"
                  title={r.countries.map(countryName).join("、")}
                >
                  {r.countries.slice(0, 3).map((c) => (
                    <span key={c} aria-label={countryName(c)}>
                      {countryFlag(c)}
                    </span>
                  ))}
                  {r.countries.length > 3 && (
                    <span className="faint small">+{r.countries.length - 3}</span>
                  )}
                </td>
                <td data-label="等级">
                  <GradeDistribution counts={r.grades} compact />
                </td>
                <td className="num strong" data-label="S/A 占比">
                  {formatIntPct(r.good)}
                </td>
                <td className="num" data-label="节点">
                  {formatNumber(r.nodes.length)}
                </td>
                <td className="num" data-label="独立 IP">
                  {formatNumber(r.ipCount)}
                </td>
                <td
                  className="num"
                  data-label="实测覆盖"
                  title="已取得端点证据并定出 S/A/B/C 的落地 IP"
                >
                  {r.ipCount ? `${r.covered}/${r.ipCount}` : "—"}
                </td>
                <td
                  className="num"
                  data-label="入口延迟"
                  title="每个落地 IP 取当前视角实测等级最好的一个节点，再算入口 RTT 中位数"
                >
                  {r.rtt == null ? "—" : formatMs(Math.round(r.rtt))}
                </td>
                <td className="num" data-label="7 天可用">
                  {formatIntPct(r.avail)}
                </td>
                <td className="num" data-label="家宽">
                  {formatIntPct(r.home)}
                </td>
                <td className="num" data-label="UDP 通">
                  {formatIntPct(r.udp)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <footer className="table-footer">
        <span className="table-range">
          {formatNumber(rows.length)} 个落地网络。S/A 占比按已确认的独立落地 IP 计算，少于 3
          个实测 IP 的网络排在后面。点击任意行筛选该网络节点。
        </span>
        {!showAll && rows.length > INITIAL_SHOWN && (
          <button type="button" className="btn btn-quiet" onClick={() => setShowAll(true)}>
            显示全部 {formatNumber(rows.length)} 个网络
          </button>
        )}
      </footer>
    </div>
  );
}
