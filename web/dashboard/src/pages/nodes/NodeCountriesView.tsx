import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { GradeDistribution } from "../../components/ui";
import { sortNodeItems, type NodeSortKey, type SortDir } from "../../lib/filters";
import {
  countryFlag,
  countryName,
  formatMs,
  formatNumber,
  operatorOf,
  zhCollator,
} from "../../lib/format";
import {
  BUCKETS,
  GRADES,
  bucketOfNode,
  isCarrierVantage,
  vantageName,
} from "../../lib/grades";
import { getCountryOpenGroups, setCountryOpenGroups } from "../../state/nodeListStore";
import type { NodeListItem, QualityGrade, Vantage } from "../../types/api";
import { NodeTable } from "./NodeTable";

const UNKNOWN = "UNK";
const CLOUDFLARE_ASN = 13335;
const ROWS_SHOWN = 10;
const OPEN_GROUPS = 4;

const countryOf = (n: NodeListItem) => n.exit_country || UNKNOWN;
const countryLabel = (code: string) => (code === UNKNOWN ? "落地未知" : countryName(code));
const rankOf = (n: NodeListItem) => BUCKETS.indexOf(bucketOfNode(n));

function groupBy<T, K>(items: T[], keyOf: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const list = map.get(key);
    if (list) list.push(item);
    else map.set(key, [item]);
  }
  return map;
}

function gradeCounts(nodes: NodeListItem[]): Partial<Record<QualityGrade, number>> {
  const counts: Partial<Record<QualityGrade, number>> = {};
  for (const g of GRADES) counts[g] = 0;
  for (const n of nodes) {
    if (n.quality_grade) counts[n.quality_grade] = (counts[n.quality_grade] || 0) + 1;
  }
  return counts;
}

function fastestRtt(nodes: NodeListItem[]): number | null {
  let min: number | null = null;
  for (const n of nodes) {
    if (n.quality_grade && !n.unreachable && n.peak_rtt_ms != null) {
      if (min === null || n.peak_rtt_ms < min) min = n.peak_rtt_ms;
    }
  }
  return min;
}

function groupFacts(nodes: NodeListItem[]): Array<[string, string]> {
  let udpTested = 0;
  let udpOk = 0;
  let home = 0;
  for (const n of nodes) {
    if (n.udp === "SUCCESS" || n.udp === "FAILED") {
      udpTested++;
      if (n.udp === "SUCCESS") udpOk++;
    }
    if (n.exit_ip_type === "RESIDENTIAL") home++;
  }
  const out: Array<[string, string]> = [];
  if (udpTested > 0) out.push([`UDP ${udpOk}/${udpTested}`, "UDP 测通 / 已测"]);
  if (home > 0) out.push([`家宽 ${home}`, "落地 IP 为家宽的节点数"]);
  return out;
}

export function NodeCountriesView({
  items,
  vantage,
  country,
  onCountry,
  sortKey,
  sortDir,
  onSort,
  selectedIds,
  onToggleIds,
  onShare,
  onNavigateDetail,
}: {
  items: NodeListItem[];
  vantage: Vantage;
  country: string | null;
  onCountry: (code: string) => void;
  sortKey: NodeSortKey;
  sortDir: SortDir;
  onSort: (key: NodeSortKey) => void;
  selectedIds: Set<string>;
  onToggleIds: (ids: string[], checked: boolean) => void;
  onShare: (node: NodeListItem) => void;
  onNavigateDetail: (node: NodeListItem) => void;
}) {
  const railRef = useRef<HTMLElement>(null);

  const countries = useMemo(() => {
    return [...groupBy(items, countryOf)]
      .map(([code, nodes]) => ({
        code,
        nodes,
        asns: new Set(nodes.map((n) => n.exit_asn || 0)).size,
      }))
      .sort(
        (a, b) =>
          Number(a.code === UNKNOWN) - Number(b.code === UNKNOWN) ||
          b.nodes.length - a.nodes.length ||
          zhCollator.compare(countryLabel(a.code), countryLabel(b.code)),
      );
  }, [items]);

  const chosen = useMemo(
    () => countries.find((c) => c.code === country) || countries[0] || null,
    [countries, country],
  );

  const asnGroups = useMemo(() => {
    if (!chosen) return [];
    const tail = (asn: number) => (asn === CLOUDFLARE_ASN ? 2 : asn === 0 ? 1 : 0);
    return [...groupBy(chosen.nodes, (n) => n.exit_asn || 0)]
      .map(([asn, members]) => ({
        asn,
        nodes: sortNodeItems(members, sortKey, sortDir),
        bestRank: Math.min(...members.map(rankOf)),
        name: operatorOf(members.find((n) => operatorOf(n)) || members[0]),
        bestRtt: fastestRtt(members),
        counts: gradeCounts(members),
        facts: groupFacts(members),
      }))
      .sort(
        (a, b) =>
          tail(a.asn) - tail(b.asn) ||
          a.bestRank - b.bestRank ||
          b.nodes.length - a.nodes.length ||
          a.asn - b.asn,
      );
  }, [chosen, sortKey, sortDir]);

  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});
  const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({});

  useEffect(() => {
    if (!chosen) return;
    const saved = getCountryOpenGroups(chosen.code);
    if (saved) {
      setOpenMap(saved);
    } else {
      const openAll = asnGroups.length <= OPEN_GROUPS + 2;
      const initial: Record<string, boolean> = {};
      asnGroups.forEach((g, idx) => {
        initial[String(g.asn)] = (openAll || idx < OPEN_GROUPS) && g.asn !== CLOUDFLARE_ASN;
      });
      setOpenMap(initial);
    }
    setExpandedRows({});
  }, [chosen?.code, asnGroups.length]);

  useEffect(() => {
    const rail = railRef.current;
    const active = rail?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!rail || !active) return;
    rail.scrollLeft = active.offsetLeft - (rail.clientWidth - active.offsetWidth) / 2;
    rail.scrollTop = active.offsetTop - (rail.clientHeight - active.offsetHeight) / 2;
  }, [chosen?.code]);

  if (!chosen) return null;

  const allOpen = asnGroups.every((g) => openMap[String(g.asn)]);

  const setGroupOpen = (asn: number, nextOpen: boolean) => {
    setOpenMap((prev) => {
      const next = { ...prev, [String(asn)]: nextOpen };
      setCountryOpenGroups(chosen.code, next);
      return next;
    });
  };

  const toggleAllGroups = () => {
    const target = !allOpen;
    const next: Record<string, boolean> = {};
    for (const g of asnGroups) next[String(g.asn)] = target;
    setOpenMap(next);
    setCountryOpenGroups(chosen.code, next);
  };

  return (
    <div className="country-layout">
      <nav ref={railRef} className="country-rail" aria-label="落地国家">
        {countries.map(({ code, nodes, asns }) => {
          const active = code === chosen.code;
          return (
            <button
              key={code}
              type="button"
              className={`country-rail-item${active ? " is-active" : ""}`}
              aria-pressed={active}
              onClick={() => onCountry(code)}
            >
              <span className="country-flag" aria-hidden="true">
                {code === UNKNOWN ? "·" : countryFlag(code)}
              </span>
              <span className="country-rail-name">
                <span>{countryLabel(code)}</span>
                {code !== UNKNOWN && <span className="country-code mono">{code}</span>}
              </span>
              <span className="country-rail-count" title={`${asns} 个 ASN`}>
                {formatNumber(nodes.length)}
              </span>
            </button>
          );
        })}
      </nav>

      <section className="country-main" aria-label={countryLabel(chosen.code)}>
        <header className="card country-summary">
          <div className="country-summary-id">
            <span className="country-flag-lg" aria-hidden="true">
              {chosen.code === UNKNOWN ? "🌐" : countryFlag(chosen.code)}
            </span>
            <div>
              <h2>
                {countryLabel(chosen.code)}
                {chosen.code !== UNKNOWN && <span className="country-code mono">{chosen.code}</span>}
              </h2>
              <p className="muted small">
                {formatNumber(chosen.nodes.length)} 个节点 · {asnGroups.length} 个 ASN
              </p>
            </div>
          </div>
          <div className="country-summary-right">
            <GradeDistribution counts={gradeCounts(chosen.nodes)} />
            <button type="button" className="btn btn-quiet" onClick={toggleAllGroups}>
              {allOpen ? "全部收起" : "全部展开"}
            </button>
          </div>
        </header>

        <div className="asn-groups">
          {asnGroups.map((group) => {
            const isCf = group.asn === CLOUDFLARE_ASN;
            const isOpen = Boolean(openMap[String(group.asn)]);
            const showAll = Boolean(expandedRows[group.asn]);
            const visibleNodes = showAll ? group.nodes : group.nodes.slice(0, ROWS_SHOWN);
            const rest = group.nodes.length - visibleNodes.length;

            return (
              <div
                key={group.asn}
                className={`asn-group-card${isCf ? " is-cf" : ""}${isOpen ? " is-open" : ""}`}
              >
                <button
                  type="button"
                  className="asn-group-summary"
                  aria-expanded={isOpen}
                  onClick={() => setGroupOpen(group.asn, !isOpen)}
                >
                  <ChevronRight size={15} className="asn-chevron" aria-hidden="true" />
                  <span className="asn-badge mono">
                    {group.asn ? `AS${group.asn}` : "ASN 未知"}
                  </span>
                  <span className="asn-org" title={group.name}>
                    {isCf
                      ? "Cloudflare（落地不测、不分级）"
                      : group.name && group.name !== `AS${group.asn}`
                        ? group.name
                        : ""}
                  </span>
                  <span className="asn-dist">
                    {!isCf && <GradeDistribution counts={group.counts} compact />}
                  </span>
                  <span
                    className="asn-best"
                    title={`${vantageName(vantage)}${isCarrierVantage(vantage) ? "晚高峰" : ""}最低延迟`}
                  >
                    {group.bestRtt == null ? "" : formatMs(group.bestRtt)}
                  </span>
                  <span className="asn-facts">
                    {group.facts.map(([text, hint], i) => (
                      <span key={i} className="meta-pill" title={hint}>
                        {text}
                      </span>
                    ))}
                  </span>
                  <span className="asn-count">{formatNumber(group.nodes.length)} 个</span>
                </button>

                {isOpen && (
                  <div className="asn-group-body">
                    <NodeTable
                      nodes={visibleNodes}
                      vantage={vantage}
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={onSort}
                      selectedIds={selectedIds}
                      onToggleIds={(ids, checked) => {
                        // Selecting group header selects all nodes in the group, not just visible slice
                        if (ids.length === visibleNodes.length && visibleNodes.length < group.nodes.length && ids.every((id, idx) => id === visibleNodes[idx].id)) {
                          onToggleIds(group.nodes.map((n) => n.id), checked);
                        } else {
                          onToggleIds(ids, checked);
                        }
                      }}
                      onShare={onShare}
                      onNavigateDetail={onNavigateDetail}
                      hideOperator
                      selectAllLabel={`选择 AS${group.asn} 的全部节点`}
                      wrapClassName="table-wrap table-wrap-flush"
                    />
                    {rest > 0 && (
                      <button
                        type="button"
                        className="btn-more-rows"
                        onClick={() =>
                          setExpandedRows((prev) => ({ ...prev, [group.asn]: true }))
                        }
                      >
                        显示其余 {formatNumber(rest)} 个节点
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
