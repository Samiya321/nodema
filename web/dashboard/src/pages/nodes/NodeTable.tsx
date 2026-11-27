import { useEffect, useRef } from "react";
import { QrCode } from "lucide-react";
import { GradeBadge, RouteChip, StatusBadge } from "../../components/ui";
import { NODE_COLUMNS, type NodeSortKey, type SortDir } from "../../lib/filters";
import {
  IP_TYPE_LABEL,
  classificationLabel,
  formatAgo,
  formatMs,
  operatorOf,
} from "../../lib/format";
import { ACCESS_EVIDENCE_LABEL, isAvailableStatus, isCarrierVantage, vantageName } from "../../lib/grades";
import { nodeHref } from "../../lib/router";
import type { NodeListItem, Vantage } from "../../types/api";

const UDP_LABEL: Record<string, string> = {
  SUCCESS: "通",
  FAILED: "不通",
  NOT_SUPPORTED: "仅 TCP",
};

function IndeterminateCheckbox({
  checked,
  indeterminate,
  ariaLabel,
  onChange,
}: {
  checked: boolean;
  indeterminate: boolean;
  ariaLabel: string;
  onChange: (checked: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

function GradeCell({ node, vantage }: { node: NodeListItem; vantage: Vantage }) {
  if (node.quality_grade) {
    const limiting =
      vantage === "CN" && node.limiting_vantage
        ? `${vantageName(node.limiting_vantage)}短板`
        : null;
    const evidence =
      node.endpoint_verified || node.unreachable
        ? null
        : node.access_evidence === "ENDPOINT"
          ? "端点待补测"
          : (node.access_evidence ? ACCESS_EVIDENCE_LABEL[node.access_evidence] : null) || "接入待测";
    const caption = [limiting, evidence].filter(Boolean).join(" · ");
    return (
      <div className="grade-cell">
        <div className="grade-cell-main">
          <GradeBadge grade={node.quality_grade} vantage={vantage} withVantage={false} />
          {node.status === "DEGRADED" && <StatusBadge status={node.status} />}
        </div>
        {caption && <span className="grade-cell-caption">{caption}</span>}
      </div>
    );
  }
  if (isAvailableStatus(node.status)) {
    return (
      <span
        className="ungraded-pill"
        title={node.exit_asn === 13335 ? "落地是 Cloudflare：不测、不分级" : "下次计算等级时补上"}
      >
        {node.exit_asn === 13335 ? "CF 落地" : "未分级"}
      </span>
    );
  }
  return <StatusBadge status={node.status} />;
}

function LatencyCell({ node }: { node: NodeListItem }) {
  if (!node.quality_grade) return <span className="faint">—</span>;
  if (node.unreachable) return <span className="bad-text strong">入口重复失败</span>;
  if (node.peak_rtt_ms == null) {
    return (
      <span
        className="faint"
        title={node.icmp_only ? "UDP 入口，按同网段测" : "还没有测量样本"}
      >
        未测
      </span>
    );
  }
  return (
    <div className="rtt-cell">
      <strong>{formatMs(node.peak_rtt_ms)}</strong>
      {node.peak_loss != null && (
        <span className={node.peak_loss > 0.03 ? "rtt-loss bad-text" : "rtt-loss"}>
          丢 {(node.peak_loss * 100).toFixed(1)}%
        </span>
      )}
    </div>
  );
}

function UdpCell({ node }: { node: NodeListItem }) {
  if (!node.udp || node.udp === "NOT_RUN") {
    return (
      <span
        className="faint"
        title={isAvailableStatus(node.status) ? "下次每日检测后显示" : "节点当前不可用"}
      >
        —
      </span>
    );
  }
  const title =
    node.udp === "SUCCESS"
      ? `UDP 往返约 ${node.udp_ms} ms（STUN/DNS 经节点转发）`
      : node.udp === "FAILED"
        ? "多次重试仍收不到 UDP 回包"
        : "节点配置声明只走 TCP";
  return (
    <span className={`udp-pill udp-${node.udp}`} title={title}>
      <span className="udp-dot" aria-hidden="true" />
      <span>{UDP_LABEL[node.udp] || node.udp}</span>
    </span>
  );
}

export function NodeTable({
  nodes,
  vantage,
  sortKey,
  sortDir,
  onSort,
  selectedIds,
  onToggleIds,
  onShare,
  onNavigateDetail,
  hideOperator = false,
  selectAllLabel = "选择本页节点",
  wrapClassName = "table-wrap nodes-table-wrap",
}: {
  nodes: NodeListItem[];
  vantage: Vantage;
  sortKey: NodeSortKey;
  sortDir: SortDir;
  onSort: (key: NodeSortKey) => void;
  selectedIds: Set<string>;
  onToggleIds: (ids: string[], checked: boolean) => void;
  onShare: (node: NodeListItem) => void;
  onNavigateDetail: (node: NodeListItem) => void;
  hideOperator?: boolean;
  selectAllLabel?: string;
  wrapClassName?: string;
}) {
  const rowIds = nodes.map((n) => n.id);
  const pickedCount = rowIds.filter((id) => selectedIds.has(id)).length;
  const allChecked = rowIds.length > 0 && pickedCount === rowIds.length;
  const someChecked = pickedCount > 0 && pickedCount < rowIds.length;

  const sortHeader = (key: NodeSortKey, extraClass = "") => {
    const baseLabel = NODE_COLUMNS[key].label;
    const title =
      key === "rtt"
        ? vantage === "CN"
          ? "三网短板 RTT"
          : isCarrierVantage(vantage)
            ? `${vantageName(vantage)}晚高峰`
            : `${vantageName(vantage)}延迟`
        : key === "grade"
          ? `等级 · ${vantageName(vantage)}`
          : baseLabel;
    const active = sortKey === key;
    return (
      <th
        scope="col"
        className={extraClass || undefined}
        aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : undefined}
      >
        <button
          type="button"
          className={`sort-btn${active ? " is-active" : ""}`}
          onClick={() => onSort(key)}
        >
          <span>{title}</span>
          <span className="sort-mark" aria-hidden="true">
            {active ? (sortDir === "asc" ? "↑" : "↓") : "↕"}
          </span>
        </button>
      </th>
    );
  };

  return (
    <div className={wrapClassName}>
      <table className="data-table nodes-table">
        <thead>
          <tr>
            <th className="col-pick">
              <IndeterminateCheckbox
                checked={allChecked}
                indeterminate={someChecked}
                ariaLabel={selectAllLabel}
                onChange={(checked) => onToggleIds(rowIds, checked)}
              />
            </th>
            {sortHeader("name")}
            {sortHeader("grade")}
            {sortHeader("rtt", "num")}
            {sortHeader("udp")}
            {sortHeader("avail")}
            {sortHeader("route")}
            {!hideOperator && sortHeader("operator", "col-operator")}
            {sortHeader("checked", "num")}
          </tr>
        </thead>
        <tbody>
          {nodes.map((n) => {
            const picked = selectedIds.has(n.id);
            const flags = n.identity_flags || 0;
            const ipType = n.exit_ip_type
              ? IP_TYPE_LABEL[n.exit_ip_type] + (n.exit_ip_proxy ? "·代理标记" : "")
              : "";
            const meta = [
              n.short_id,
              n.protocol,
              classificationLabel(n),
              ipType,
              (n.server_node_count || 0) > 1 ? `同 IP ${n.server_node_count}` : "",
              flags & 6 ? "归属有分歧" : "",
              flags & 8 ? "历史落地" : "",
              n.enabled ? "" : "已停用",
              n.present_source_count ? "" : "上游已移除",
            ].filter(Boolean);
            const asn = n.exit_asn ? `AS${n.exit_asn}` : "";
            const opName = operatorOf(n);

            return (
              <tr
                key={n.id}
                className={`${!n.enabled ? "is-dim " : ""}${picked ? "is-picked" : ""}`.trim() || undefined}
              >
                <td className="col-pick">
                  <input
                    type="checkbox"
                    checked={picked}
                    aria-label={`选择 ${n.name}`}
                    onChange={(e) => onToggleIds([n.id], e.target.checked)}
                  />
                </td>
                <td className="col-node-name" data-label="节点">
                  <div className="node-row-head">
                    <a
                      href={nodeHref(n.id, vantage)}
                      className="node-link"
                      onClick={() => onNavigateDetail(n)}
                    >
                      <span className="node-title" title={n.name}>
                        {n.name}
                      </span>
                      <span className="node-meta">
                        {meta.map((m, idx) => (
                          <span key={idx} className="meta-pill">
                            {m}
                          </span>
                        ))}
                      </span>
                    </a>
                    <button
                      type="button"
                      className="btn-icon node-qr-btn"
                      aria-label={`二维码 · ${n.name}`}
                      title="二维码 / 分享"
                      onClick={() => onShare(n)}
                    >
                      <QrCode size={15} />
                    </button>
                  </div>
                </td>
                <td data-label="等级">
                  <GradeCell node={n} vantage={vantage} />
                </td>
                <td
                  className="num"
                  data-label={
                    vantage === "CN" ? "短板入口 RTT" : isCarrierVantage(vantage) ? "晚高峰" : "延迟"
                  }
                >
                  <LatencyCell node={n} />
                </td>
                <td data-label="UDP">
                  <UdpCell node={n} />
                </td>
                <td data-label="7 天可用">
                  {n.checked_7d ? (
                    <span
                      className="avail-pill"
                      title={`7 天内检测 ${n.checked_7d} 天，${n.avail_7d} 天可用`}
                    >
                      {n.avail_7d}/{n.checked_7d} 天
                    </span>
                  ) : (
                    <span className="faint">—</span>
                  )}
                </td>
                <td
                  data-label="入口 / 落地"
                  title="IP 数据库归属，不代表已验证的物理中转路线"
                >
                  <RouteChip entry={n.entry_country} exit={n.exit_country} withFlags />
                </td>
                {!hideOperator && (
                  <td className="col-operator" data-label="落地运营商">
                    {!n.exit_asn ? (
                      <span className="faint">—</span>
                    ) : !opName || opName === asn ? (
                      <span className="op-name mono">{asn}</span>
                    ) : (
                      <div className="op-cell">
                        <span className="op-name" title={opName}>
                          {opName}
                        </span>
                        <span className="op-asn mono">{asn}</span>
                      </div>
                    )}
                  </td>
                )}
                <td className="num muted" data-label="最近检测">
                  {formatAgo(n.last_checked_at)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
