import React, { useState } from "react";
import {
  ArrowLeft,
  ChevronDown,
  ExternalLink,
  Play,
  Power,
  QrCode,
  RefreshCw,
  Tag,
} from "lucide-react";
import { ApiError, api, invalidateReads, useApiQuery } from "../api/client";
import {
  CopyPageLinkButton,
  EmptyState,
  ErrorState,
  GradeBadge,
  Modal,
  RouteChip,
  SkeletonBlock,
  SourcePathCrumbs,
  StatusBadge,
} from "../components/ui";
import { errorText } from "../lib/errors";
import {
  CLASSIFICATION_REASONS,
  IP_TYPE_LABEL,
  KIND_LABEL,
  classificationLabel,
  formatAgo,
  formatDate,
  formatMs,
  formatPercent,
} from "../lib/format";
import { ACCESS_EVIDENCE_LABEL, BAND_LABEL, VANTAGES, vantageName } from "../lib/grades";
import { exportHref, nodeHref, pageHref } from "../lib/router";
import { useApp } from "../state/AppContext";
import {
  invalidateNodeCaches,
  resolveDetailReturnTo,
  type NodeListReturnState,
} from "../state/nodeListStore";
import type {
  NodeAccessData,
  NodeAliasRow,
  NodeAnnotation,
  NodeDetail,
  NodeGroup,
  NodeListItem,
  ObservationDay,
  Vantage,
} from "../types/api";

const MEASURE_LABEL: Record<string, string> = {
  FULL: "完整代理验证",
  PREFLIGHT: "入口预检",
  SKIPPED: "本轮跳过",
};

const DAY_LABELS: Record<string, string> = {
  UP: "通过",
  DOWN: "失败",
  UNTESTED: "未检测",
};

function lossText(v?: number | null): string {
  return v === null || v === undefined ? "—" : (v * 100).toFixed(1) + "%";
}

function UdpSummary({ node }: { node: NodeDetail }) {
  if (!node.udp_state || node.udp_state === "NOT_RUN") {
    return (
      <span>
        {node.udp_success_at ? `最近一次通过：${formatAgo(node.udp_success_at)}` : "还没有测过"}
      </span>
    );
  }
  if (node.udp_state === "NOT_SUPPORTED") return <span>节点配置声明只走 TCP</span>;
  if (node.udp_state === "FAILED") {
    return (
      <span>
        {node.udp_success_at
          ? `这次不通（重试多次）；上次通过 ${formatAgo(node.udp_success_at)}`
          : "不通（重试多次仍收不到回包）"}
      </span>
    );
  }
  const other = node.udp_exit_ip && node.exit_ip && node.udp_exit_ip !== node.exit_ip;
  const sample = node.published_observation?.precheck_metadata?.udp?.find((a) => a.ok);
  const dnsMap: Record<string, string> = {
    VALID: "DNS 解析正确",
    ERROR: "DNS 有回包，解析返回错误",
    UNEXPECTED: "DNS 有回包，答案不符",
  };
  const label = sample?.target?.startsWith("stun-")
    ? "STUN 有回包"
    : (sample?.dns_response ? dnsMap[sample.dns_response] : undefined) || "公共 STUN/DNS 有回包";
  return (
    <span>
      {label} · 往返约 {node.udp_ms} ms
      {node.udp_success_at ? ` · ${formatDate(node.udp_success_at)}` : ""}
      {other && (
        <span className="muted">；UDP 出口 {node.udp_exit_ip}（与 TCP 落地不同）</span>
      )}
    </span>
  );
}

function WeekTimeline({ days }: { days?: ObservationDay[] }) {
  const [selectedIdx, setSelectedIdx] = useState(() => (days ? Math.max(0, days.length - 1) : 0));
  if (!days || !days.length) return null;
  const active = days[Math.min(selectedIdx, days.length - 1)];
  const desc =
    active.status === "UNTESTED"
      ? `${active.day} · 未取得可用性结果`
      : `${active.day} · ${active.successful} 次通过 · ${active.failed} 次失败`;

  return (
    <div className="stack-sm">
      <h3>最近 7 天 · 北京时间</h3>
      <div className="timeline-grid" role="group" aria-label="近 7 天检测状态">
        {days.map((day, idx) => {
          const pressed = idx === Math.min(selectedIdx, days.length - 1);
          return (
            <button
              key={day.day}
              type="button"
              className={`timeline-cell status-${day.status}${pressed ? " is-active" : ""}`}
              aria-label={`${day.day} ${DAY_LABELS[day.status] || day.status}`}
              aria-pressed={pressed}
              onClick={() => setSelectedIdx(idx)}
            >
              <time dateTime={day.day}>{day.day.slice(5)}</time>
              <span>{DAY_LABELS[day.status] || day.status}</span>
            </button>
          );
        })}
      </div>
      <p className="hint" role="status">
        {desc}
      </p>
    </div>
  );
}

function FoldSection({
  title,
  summary,
  defaultOpen = false,
  onOpen,
  children,
}: {
  title: string;
  summary?: string | null;
  defaultOpen?: boolean;
  onOpen?: () => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && onOpen) onOpen();
  };

  return (
    <section className={`card fold-card${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="fold-trigger"
        aria-expanded={open}
        onClick={toggle}
      >
        <div className="fold-title-group">
          <h2>{title}</h2>
          {summary && <span className="meta-pill">{summary}</span>}
        </div>
        <ChevronDown
          size={16}
          className={`fold-chevron${open ? " is-open" : ""}`}
          aria-hidden="true"
        />
      </button>
      {open && <div className="fold-body stack">{children}</div>}
    </section>
  );
}

function AccessContent({
  node,
  access,
  vantage,
}: {
  node: NodeDetail;
  access: NodeAccessData;
  vantage: Vantage;
}) {
  const grades = access.grades || {};
  const chosen = grades[vantage];
  const why = (v: Vantage) => {
    if (access.icmp_only) return "UDP 入口 · 暂无参考样本";
    if (access.cloudflare) return "Cloudflare 入口：共用 CF 类结果";
    if (!access.target) return "无 IPv4 入口，未测";
    return v.startsWith("CN-") ? "等待晚高峰测量" : "等待测量";
  };
  const measurements = access.measurements || [];

  return (
    <div className="stack">
      <div className="stack-xs">
        {node.quality_grade ? (
          <>
            <div className="row-wrap">
              <GradeBadge grade={node.quality_grade} vantage={vantage} />
              {vantage === "CN" && chosen?.limiting_vantage && (
                <span className="muted small">短板 · {vantageName(chosen.limiting_vantage)}</span>
              )}
              <span className="tag">
                {(chosen?.access_evidence && ACCESS_EVIDENCE_LABEL[chosen.access_evidence]) ||
                  "接入待测"}
              </span>
            </div>
            {chosen?.reasons && chosen.reasons.length > 0 && (
              <ul className="reason-list">
                {chosen.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="muted">
            {node.exit_asn === 13335 ? "CF 落地 · 不分级" : "当前暂无等级"}
          </p>
        )}
      </div>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">视角</th>
              <th scope="col">等级</th>
              <th scope="col">样本范围</th>
              <th scope="col" className="num">
                RTT（晚高峰/中位）
              </th>
              <th scope="col" className="num">
                空闲 RTT
              </th>
              <th scope="col" className="num">
                丢包
              </th>
              <th scope="col" className="num">
                抖动
              </th>
              <th scope="col" className="num">
                样本（探针）
              </th>
              <th scope="col">接入 / 稳定</th>
              <th scope="col">去程经过</th>
            </tr>
          </thead>
          <tbody>
            {VANTAGES.map(([v, name]) => {
              const g = grades[v];
              const trace = v.startsWith("CN-") ? access.traces?.[v] : undefined;
              return (
                <tr key={v} className={v === vantage ? "is-picked" : undefined}>
                  <td data-label="视角">
                    {v === vantage ? <strong>{name}</strong> : name}
                  </td>
                  <td data-label="等级">
                    {g ? <GradeBadge grade={g.grade} vantage={v} withVantage={false} /> : "—"}
                  </td>
                  <td data-label="样本范围">
                    {(g?.access_evidence && ACCESS_EVIDENCE_LABEL[g.access_evidence]) || "—"}
                  </td>
                  <td className="num" data-label="RTT">
                    {g?.unreachable ? (
                      <span className="bad-text strong">入口重复失败</span>
                    ) : g?.peak_rtt_ms != null ? (
                      formatMs(g.peak_rtt_ms)
                    ) : (
                      <span className="muted small">{why(v)}</span>
                    )}
                  </td>
                  <td className="num" data-label="空闲 RTT">
                    {formatMs(g?.idle_rtt_ms)}
                  </td>
                  <td className="num" data-label="丢包">
                    {lossText(g?.loss)}
                  </td>
                  <td className="num" data-label="抖动">
                    {formatMs(g?.jitter_ms)}
                  </td>
                  <td className="num" data-label="样本">
                    {g ? `${g.samples}（${g.probes}）` : "—"}
                  </td>
                  <td data-label="接入/稳定">
                    {g
                      ? `${(g.access_band && BAND_LABEL[g.access_band]) || "未测"} / ${(g.stability_band && BAND_LABEL[g.stability_band]) || "不足"}`
                      : "—"}
                  </td>
                  <td data-label="去程经过">
                    {trace ? (
                      <span
                        className="mono small"
                        title={`测于 ${formatDate(trace.measured_at)}`}
                      >
                        {trace.hop_asns.map((x) => "AS" + x).join(" → ")}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="hint">
        接入数据来自 Globalping 社区探针。大陆以北京时间晚高峰的 TCP
        样本定档，海外使用全天样本。入口范围见表，去程显示实测 ASN。稳定性来自美国 Runner 日检。
      </p>

      <details className="nested-details">
        <summary>单次测量记录（{measurements.length}）</summary>
        {measurements.length === 0 ? (
          <p className="muted small">暂无单次测量记录。</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">时间</th>
                  <th scope="col">视角</th>
                  <th scope="col">目标</th>
                  <th scope="col">探针</th>
                  <th scope="col" className="num">
                    收到/发送
                  </th>
                  <th scope="col" className="num">
                    平均 RTT
                  </th>
                  <th scope="col">测量 ID</th>
                </tr>
              </thead>
              <tbody>
                {measurements.map((m, idx) => (
                  <tr key={`${m.measurement_id || idx}`}>
                    <td data-label="时间">{formatDate(m.measured_at)}</td>
                    <td data-label="视角">
                      {(m.purpose === "REACH" ? "大陆可达检查" : vantageName(m.vantage)) +
                        (m.peak ? "（晚高峰）" : "")}
                    </td>
                    <td data-label="目标">
                      {m.target === access.target ? "本入口" : "共享参考入口"}
                    </td>
                    <td data-label="探针">
                      {[m.probe_city, m.probe_asn ? `AS${m.probe_asn}` : null]
                        .filter(Boolean)
                        .join(" · ") || "—"}
                    </td>
                    <td className="num" data-label="收到/发送">
                      {m.received}/{m.sent}
                    </td>
                    <td className="num" data-label="平均 RTT">
                      {formatMs(m.rtt_avg)}
                    </td>
                    <td data-label="测量 ID">
                      {m.measurement_id ? (
                        <a
                          href={`https://api.globalping.io/v1/measurements/${encodeURIComponent(m.measurement_id)}`}
                          target="_blank"
                          rel="noreferrer"
                          className="mono small inline-link"
                        >
                          {m.measurement_id}
                          <ExternalLink size={11} />
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
    </div>
  );
}

export function NodeDetailPage({ params }: { params: URLSearchParams }) {
  const { toast, fail, testNodes, openShareNode } = useApp();
  const id = params.get("node") || "";
  const requestedVantage = params.get("vantage") || "";
  const [returnTo] = useState<NodeListReturnState | null>(() => resolveDetailReturnTo());

  const detailPath = `/nodes/${encodeURIComponent(id)}${requestedVantage ? `?vantage=${encodeURIComponent(requestedVantage)}` : ""}`;
  const { data: node, error, loading, refetch } = useApiQuery<NodeDetail>(detailPath, {
    cached: false,
    keepPrevious: false,
  });

  // Lazy sections
  const [accessState, setAccessState] = useState<{
    loaded: boolean;
    loading: boolean;
    data?: NodeAccessData;
    error?: string;
  }>({ loaded: false, loading: false });

  const [siblingsState, setSiblingsState] = useState<{
    loaded: boolean;
    loading: boolean;
    items?: NodeListItem[];
    error?: string;
  }>({ loaded: false, loading: false });

  const [aliases, setAliases] = useState<NodeAliasRow[] | null>(null);
  const [aliasesLoading, setAliasesLoading] = useState(false);

  // Action states
  const [toggling, setToggling] = useState(false);

  // Modals: Classification & Tags
  const [classModalOpen, setClassModalOpen] = useState(false);
  const [classGroup, setClassGroup] = useState<"" | NodeGroup>("");
  const [classNote, setClassNote] = useState("");
  const [classSaving, setClassSaving] = useState(false);

  const [tagModalOpen, setTagModalOpen] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [tagLoading, setTagLoading] = useState(false);
  const [tagSaving, setTagSaving] = useState(false);

  const backHref =
    returnTo?.href || pageHref("nodes", requestedVantage ? { vantage: requestedVantage } : {});

  const handleBackClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (
      !returnTo?.direct ||
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey
    ) {
      return;
    }
    e.preventDefault();
    window.history.back();
  };

  const loadAccess = async () => {
    setAccessState({ loaded: true, loading: true });
    try {
      const data = await api<NodeAccessData>(`/nodes/${encodeURIComponent(id)}/access`);
      setAccessState({ loaded: true, loading: false, data });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "OPERATION_FAILED";
      setAccessState({ loaded: true, loading: false, error: errorText(code) });
    }
  };

  const loadSiblings = async (exitIp: string, v: Vantage) => {
    setSiblingsState({ loaded: true, loading: true });
    try {
      const q = new URLSearchParams({
        exit_ip: exitIp,
        vantage: v,
        sort: "quality_grade:asc",
        limit: "50",
      });
      const res = await api<{ items: NodeListItem[] }>(`/nodes?${q.toString()}`);
      setSiblingsState({ loaded: true, loading: false, items: res.items });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "OPERATION_FAILED";
      setSiblingsState({ loaded: true, loading: false, error: errorText(code) });
    }
  };

  const loadAliases = async () => {
    setAliasesLoading(true);
    try {
      const rows = await api<NodeAliasRow[]>(`/nodes/${encodeURIComponent(id)}/aliases`);
      setAliases(rows);
    } catch (err) {
      fail(err);
    } finally {
      setAliasesLoading(false);
    }
  };

  const handleToggleEnabled = async () => {
    if (!node || toggling) return;
    setToggling(true);
    try {
      await api(`/nodes/${encodeURIComponent(node.id)}`, {
        method: "PATCH",
        body: { enabled: !node.enabled },
      });
      toast(node.enabled ? "已停用，不再检测和导出。" : "已启用。", "ok");
      invalidateNodeCaches();
      invalidateReads();
      refetch();
    } catch (err) {
      fail(err);
    } finally {
      setToggling(false);
    }
  };

  const openClassificationModal = () => {
    if (!node?.classification) return;
    setClassGroup(node.classification.classification_override || "");
    setClassNote(node.classification.classification_note || "");
    setClassModalOpen(true);
  };

  const saveClassification = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!node || classSaving) return;
    setClassSaving(true);
    try {
      await api(`/nodes/${encodeURIComponent(node.id)}/classification`, {
        method: "PATCH",
        body: {
          group: classGroup || null,
          note: classGroup ? classNote.trim() || null : null,
        },
      });
      invalidateNodeCaches();
      invalidateReads();
      setClassModalOpen(false);
      toast("归属已保存。", "ok");
      refetch();
    } catch (err) {
      fail(err);
    } finally {
      setClassSaving(false);
    }
  };

  const openTagModal = async () => {
    setTagModalOpen(true);
    setTagLoading(true);
    try {
      const data = await api<NodeAnnotation>(`/nodes/${encodeURIComponent(id)}/annotations`);
      setTagInput((data.tags || []).join(", "));
    } catch (err) {
      fail(err);
      setTagModalOpen(false);
    } finally {
      setTagLoading(false);
    }
  };

  const saveTags = async (e: React.FormEvent) => {
    e.preventDefault();
    if (tagSaving) return;
    setTagSaving(true);
    try {
      const tags = tagInput
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      await api(`/nodes/${encodeURIComponent(id)}/annotations`, {
        method: "PATCH",
        body: { tags },
      });
      invalidateNodeCaches();
      invalidateReads();
      setTagModalOpen(false);
      toast("标签已保存。", "ok");
      refetch();
    } catch (err) {
      fail(err);
    } finally {
      setTagSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="page">
        <a href={backHref} className="back-link" onClick={handleBackClick}>
          <ArrowLeft size={15} />
          <span>返回节点列表</span>
        </a>
        <section className="card">
          <SkeletonBlock lines={6} />
        </section>
      </div>
    );
  }

  if (error || !node) {
    return (
      <div className="page">
        <a href={backHref} className="back-link" onClick={handleBackClick}>
          <ArrowLeft size={15} />
          <span>返回节点列表</span>
        </a>
        <section className="card">
          <ErrorState
            message={errorText(error?.code || "OPERATION_FAILED")}
            onRetry={refetch}
          />
        </section>
      </div>
    );
  }

  const vantage: Vantage = node.vantage || "CN";
  const obs = node.published_observation;
  const flags = node.identity_flags || 0;
  const identityNotices = [
    flags & 1
      ? "入口唯一解析 IP 与已观测出口 IP 相同，名称统一采用落地国家；同 IP 不证明同一物理机房。"
      : null,
    flags & 2 ? "国家归属源有分歧，不能据此确认物理中转或机房位置。" : null,
    flags & 4 ? "ASN 来源有分歧，下方分别保留各来源的数值与组织文本。" : null,
    flags & 8 ? "当前展示的是历史落地资料；本轮没有重新确认出口。" : null,
    flags & 16 ? "入口国家未知，名称以 ? 标明。" : null,
  ].filter((x): x is string => Boolean(x));

  return (
    <div className="page">
      <a href={backHref} className="back-link" onClick={handleBackClick}>
        <ArrowLeft size={15} />
        <span>返回节点列表</span>
      </a>

      {/* Header & Quick Actions */}
      <section className="card detail-hero">
        <div className="detail-hero-top">
          <div className="stack-xs">
            <h1 className="page-title detail-title">{node.name}</h1>
            <div className="detail-meta-row">
              <StatusBadge status={node.status} />
              <RouteChip entry={node.entry_country} exit={node.exit_country} withFlags />
              <span className="meta-pill mono">{node.short_id}</span>
              <span className="meta-pill">{node.protocol}</span>
              <span className={`tag tag-${node.node_group === "AIRPORT" ? "air" : "own"}`}>
                {classificationLabel(node)}
              </span>
              <span className="muted small">最近检测 {formatAgo(node.last_checked_at)}</span>
            </div>
          </div>
          <CopyPageLinkButton href={nodeHref(node.id, vantage)} />
        </div>

        <div className="detail-hero-metrics">
          <div className="detail-metric">
            <span className="detail-metric-label">当前等级 · {vantageName(vantage)}</span>
            <div className="detail-metric-val">
              {node.quality_grade ? (
                <GradeBadge grade={node.quality_grade} vantage={vantage} withVantage={false} />
              ) : (
                <span className="muted">{node.exit_asn === 13335 ? "CF 不分级" : "暂无"}</span>
              )}
            </div>
          </div>
          <div className="detail-metric">
            <span className="detail-metric-label">近 7 天可用</span>
            <div className="detail-metric-val">
              {node.checked_7d ? `${node.avail_7d ?? 0}/${node.checked_7d} 天` : "—"}
            </div>
          </div>
          <div className="detail-metric">
            <span className="detail-metric-label">Runner 代理延迟</span>
            <div className="detail-metric-val">{formatMs(node.http_duration_ms)}</div>
          </div>
          <div className="detail-metric">
            <span className="detail-metric-label">UDP 转发</span>
            <div className="detail-metric-val">
              {node.udp_state === "SUCCESS"
                ? `通 · ${formatMs(node.udp_ms)}`
                : node.udp_state === "FAILED"
                  ? "不通"
                  : node.udp_state === "NOT_SUPPORTED"
                    ? "仅 TCP"
                    : "未测"}
            </div>
          </div>
        </div>

        <div className="row-wrap">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => openShareNode({ id: node.id, name: node.name })}
          >
            <QrCode size={14} />
            <span>二维码 / 分享</span>
          </button>
          <button
            type="button"
            className="btn"
            disabled={node.eligible === false}
            onClick={() => void testNodes([node.id])}
          >
            <Play size={14} />
            <span>检测此节点</span>
          </button>
          <button
            type="button"
            className="btn"
            disabled={toggling}
            onClick={() => void handleToggleEnabled()}
          >
            <Power size={14} />
            <span>{node.enabled ? "停用此节点" : "启用此节点"}</span>
          </button>
          <button type="button" className="btn" onClick={() => void openTagModal()}>
            <Tag size={14} />
            <span>编辑标签</span>
          </button>
        </div>
      </section>

      {/* Callouts */}
      {obs?.echo_source === "fallback" && (
        <div className="callout callout-warn">
          备用地址已确认代理连通，本轮未观测到出口 IP。已有落地资料来自历史检测，不能用本次检测时间判断其新鲜度。
        </div>
      )}
      {obs?.precheck_metadata?.direct_exit_match === true && (
        <div className="callout callout-warn">
          本轮代理出口与同地址族的 Runner 直连出口一致，建议复核代理链路。
        </div>
      )}

      {/* Quality Overview & Classification side by side on wide screens */}
      <div className="grid-2">
        <section className="card">
          <div className="card-head">
            <h2>质量概览</h2>
          </div>
          <div className="row-wrap">
            {node.quality_grade ? (
              <GradeBadge grade={node.quality_grade} vantage={vantage} />
            ) : (
              <span className="muted">
                {node.exit_asn === 13335 ? "CF 落地 · 不分级" : "当前暂无等级"}
              </span>
            )}
            {node.quality_grade && node.limiting_vantage && vantage === "CN" && (
              <span className="meta-pill">{vantageName(node.limiting_vantage)}短板</span>
            )}
            {node.quality_grade && (
              <span className="meta-pill">
                {node.unreachable
                  ? "入口重复失败"
                  : node.endpoint_verified
                    ? "端点已确认"
                    : node.access_evidence === "ENDPOINT"
                      ? "端点待补测"
                      : (node.access_evidence && ACCESS_EVIDENCE_LABEL[node.access_evidence]) ||
                        "接入待测"}
              </span>
            )}
            {(node.checked_7d || 0) > 0 && (
              <span className="muted small">
                近 7 天可用 {node.avail_7d}/{node.checked_7d} 个受检日
              </span>
            )}
          </div>
          <WeekTimeline days={node.observations?.days} />
        </section>

        {node.classification && (
          <section className="card">
            <div className="card-head">
              <h2>归属依据</h2>
              <button type="button" className="btn btn-sm" onClick={openClassificationModal}>
                编辑归属
              </button>
            </div>
            <div className="row-wrap">
              <strong>{classificationLabel(node.classification)}</strong>
              <span className="meta-pill">
                检测分组 · {KIND_LABEL[node.classification.node_group]}
              </span>
              <span className={`badge badge-${node.classification.eligible ? "ok" : "mute"}`}>
                {node.classification.eligible ? "具备检测资格" : "不参与检测或导出"}
              </span>
            </div>
            <p className="hint">{CLASSIFICATION_REASONS[node.classification.classification_basis]}</p>
            {node.classification.classification_note && (
              <p className="callout">{node.classification.classification_note}</p>
            )}
            {node.classification.classification_updated_at && (
              <p className="hint">
                归属更新于 {formatDate(node.classification.classification_updated_at)}
              </p>
            )}
          </section>
        )}
      </div>

      {/* Lazy: Access Measurements */}
      <FoldSection
        title="接入测量与分级依据"
        summary={node.quality_grade ? `${vantageName(vantage)} ${node.quality_grade} 档 · 7 视角明细` : "7 视角明细"}
        onOpen={() => {
          if (!accessState.loaded) void loadAccess();
        }}
      >
        {accessState.loading ? (
          <SkeletonBlock lines={4} />
        ) : accessState.error ? (
          <div className="row-wrap">
            <span className="bad-text">{accessState.error}</span>
            <button type="button" className="btn btn-sm" onClick={() => void loadAccess()}>
              <RefreshCw size={13} /> 重试
            </button>
          </div>
        ) : accessState.data ? (
          <AccessContent node={node} access={accessState.data} vantage={vantage} />
        ) : null}
      </FoldSection>

      {/* Sources & Subscriptions */}
      <FoldSection
        title="来源与订阅"
        summary={`${node.sources.length} 个来源 · ${node.exports?.length || 0} 个订阅`}
      >
        <div className="stack">
          <h3>直接来源</h3>
          {node.sources.length === 0 ? (
            <EmptyState title="没有保留来源记录" />
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">来源路径</th>
                    <th scope="col">关联</th>
                    <th scope="col">来源状态</th>
                    <th scope="col">首次收录</th>
                    <th scope="col">最近出现</th>
                  </tr>
                </thead>
                <tbody>
                  {node.sources.map((s, idx) => (
                    <tr key={idx}>
                      <td data-label="来源路径">
                        <SourcePathCrumbs chain={s.chain} />
                      </td>
                      <td data-label="关联">{s.is_present ? "上游仍包含" : "上游已移除"}</td>
                      <td data-label="来源状态">
                        {s.deleted ? "已删除" : s.enabled ? "启用" : "暂停"}
                      </td>
                      <td data-label="首次收录">{formatDate(s.first_seen_at)}</td>
                      <td data-label="最近出现">{formatDate(s.last_seen_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h3>包含此节点的订阅</h3>
          {node.exports && node.exports.length > 0 ? (
            <ul className="simple-list">
              {node.exports.map((ex) => (
                <li key={ex.id}>
                  <a href={exportHref(ex.id)}>{ex.name}</a>
                  <span className="muted small">
                    v{ex.version}
                    {ex.serving ? "" : " · 当前未提供下载"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">当前没有包含此节点的订阅</p>
          )}

          <div>
            <button
              type="button"
              className="btn"
              disabled={aliasesLoading}
              onClick={() => void loadAliases()}
            >
              {aliasesLoading ? "正在读取…" : "查看原始名称"}
            </button>
          </div>

          {aliases && (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">来源</th>
                    <th scope="col">原始名称</th>
                    <th scope="col">上游仍包含</th>
                  </tr>
                </thead>
                <tbody>
                  {aliases.map((a, idx) => (
                    <tr key={idx}>
                      <td data-label="来源">{a.source_name}</td>
                      <td data-label="原始名称">{a.aliases.join("、") || "—"}</td>
                      <td data-label="上游仍包含">{a.is_present ? "是" : "否"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </FoldSection>

      {/* Entry, Exit & Check Details */}
      <FoldSection
        title="入口、落地与检测参数"
        summary={[node.exit_asn ? `AS${node.exit_asn}` : null, node.exit_ip].filter(Boolean).join(" · ") || null}
      >
        <div className="grid-2">
          <dl className="kv-list">
            <dt>编号</dt>
            <dd className="mono">{node.short_id}</dd>
            <dt>协议</dt>
            <dd>{`${node.protocol} / ${node.transport || "—"} / ${node.security || "—"}`}</dd>
            <dt>入口</dt>
            <dd>
              <code className="mono">{`${node.server_host}:${node.server_port}`}</code>
            </dd>
            <dt>入口解析</dt>
            <dd className="mono">{obs?.entry_ips?.join("、") || "—"}</dd>
            <dt>入口地区 / ASN（GeoLite）</dt>
            <dd>{`${node.identity?.raw_entry_country || "未知"} / ${node.entry_asn ? "AS" + node.entry_asn : "—"}`}</dd>
            <dt>落地 IP</dt>
            <dd>
              {node.exit_ip ? (
                <span className="row-inline">
                  <code className="mono">{node.exit_ip}</code>
                  {(node.server_node_count || 0) > 1 && (
                    <span className="tag">同服务器 ×{node.server_node_count}</span>
                  )}
                </span>
              ) : (
                "—"
              )}
            </dd>
            <dt>落地国家（Echo / GeoLite）</dt>
            <dd>{node.exit_country || "—"}</dd>
            <dt>ip-api 位置</dt>
            <dd>
              {[node.identity?.ipapi_country, node.exit_region, node.exit_ip_city]
                .filter(Boolean)
                .join(" · ") || "—"}
            </dd>
            <dt>出口 IP 最后观测</dt>
            <dd>
              {node.exit_ip
                ? node.exit_observed_at
                  ? formatDate(node.exit_observed_at)
                  : "时间未知（历史明细已清理）"
                : "—"}
            </dd>
            <dt>近 7 天出口变动</dt>
            <dd>
              {node.observations?.exit?.observed_days ? (
                <>
                  {node.observations.exit.observed_days} 天有观测 ·{" "}
                  {node.observations.exit.ip_count} 个 IP · {node.observations.exit.country_count}{" "}
                  个地区 · {node.observations.exit.asn_count} 个 ASN
                  {node.observations.exit.last_change_at && (
                    <span className="muted small">
                      {" "}
                      · 最近换 IP {formatDate(node.observations.exit.last_change_at)}
                    </span>
                  )}
                </>
              ) : (
                "近 7 天无出口观测"
              )}
            </dd>
            <dt>IP 归属（org）</dt>
            <dd>{node.exit_org || "—"}</dd>
            <dt>ISP</dt>
            <dd>{node.exit_isp || "—"}</dd>
            <dt>IP 类型</dt>
            <dd>
              {node.exit_ip_type
                ? `${IP_TYPE_LABEL[node.exit_ip_type]}${node.exit_ip_proxy ? "，被标记为 VPN/代理" : ""}（ip-api 标记，非实测）`
                : "—"}
            </dd>
            <dt>落地 ASN</dt>
            <dd>{node.exit_asn ? `AS${node.exit_asn} ${node.exit_asn_org || ""}` : "—"}</dd>
            <dt>UDP</dt>
            <dd>
              <UdpSummary node={node} />
            </dd>
          </dl>

          <dl className="kv-list">
            <dt>美国 Runner 代理延迟</dt>
            <dd>{formatMs(node.http_duration_ms)}</dd>
            <dt>首次加入</dt>
            <dd>
              {formatDate(node.first_seen_at)}
              {node.age_days != null ? `（第 ${node.age_days} 天）` : ""}
            </dd>
            <dt>累计可用</dt>
            <dd>
              {`${node.available_days ?? 0} / ${node.checked_days ?? 0} 天，${formatPercent(node.lifetime_availability)}`}
            </dd>
            <dt>Runner 成功率 / P95</dt>
            <dd>{`${formatPercent(node.success_rate)} / ${formatMs(node.http_p95_ms)}`}</dd>
            <dt>检测方式</dt>
            <dd>{(node.measurement_kind && MEASURE_LABEL[node.measurement_kind]) || "—"}</dd>
            <dt>最近检测原因</dt>
            <dd>{node.last_error_code ? errorText(node.last_error_code) : "—"}</dd>
            <dt>同地址族直连对照</dt>
            <dd>
              {obs?.precheck_metadata?.direct_exit_match === true
                ? "出口一致"
                : obs?.precheck_metadata?.direct_exit_match === false
                  ? "出口不同"
                  : "无可比观测"}
            </dd>
            <dt>下次完整复查</dt>
            <dd>{node.next_full_check_at ? formatDate(node.next_full_check_at) : "按计划"}</dd>
          </dl>
        </div>

        {node.identity && (
          <div className="stack-sm divider-top">
            <h3>归属证据</h3>
            <p className="hint">
              国家、组织与 ISP 都是数据库元数据；只实测代理出口 IP，不据此推断回程或线路类型。运营商简称优先使用已核实或手动设置的 ASN 别名。
            </p>
            {identityNotices.map((m, i) => (
              <p key={i} className="callout">
                {m}
              </p>
            ))}
            <dl className="kv-list">
              <dt>出口国家来源</dt>
              <dd>
                {node.identity.exit_country_source === "echo"
                  ? "Echo / Cloudflare"
                  : node.identity.exit_country_source === "geolite"
                    ? "GeoLite"
                    : "Echo 优先，GeoLite 回退"}
              </dd>
              <dt>GeoLite 出口（本轮）</dt>
              <dd>
                {[
                  node.identity.geolite_exit_country,
                  node.identity.geolite_exit_asn ? `AS${node.identity.geolite_exit_asn}` : null,
                ]
                  .filter(Boolean)
                  .join(" / ") || "—"}
              </dd>
              <dt>检测保存的 ASN / 组织</dt>
              <dd>
                {[
                  node.identity.observed_exit_asn ? `AS${node.identity.observed_exit_asn}` : null,
                  node.identity.observed_exit_org,
                ]
                  .filter(Boolean)
                  .join(" · ") || "—"}
              </dd>
              <dt>ip-api ASN / AS 组织</dt>
              <dd>
                {[
                  node.identity.ipapi_asn ? `AS${node.identity.ipapi_asn}` : null,
                  node.identity.ipapi_as_org,
                ]
                  .filter(Boolean)
                  .join(" · ") || "—"}
              </dd>
              <dt>ip-api 查询时间</dt>
              <dd>{formatDate(node.identity.ipapi_queried_at)}</dd>
            </dl>
          </div>
        )}
      </FoldSection>

      {/* Lazy: Same Exit IP Siblings */}
      {node.exit_ip && (node.server_node_count || 0) > 1 && (
        <FoldSection
          title={`相同落地 IP（${node.server_node_count} 个节点）`}
          onOpen={() => {
            if (!siblingsState.loaded && node.exit_ip) {
              void loadSiblings(node.exit_ip, vantage);
            }
          }}
        >
          {siblingsState.loading ? (
            <SkeletonBlock lines={3} />
          ) : siblingsState.error ? (
            <p className="bad-text">{siblingsState.error}</p>
          ) : (
            <>
              <p className="hint">
                这些节点观测到的落地 IP 相同，共用一个序号；同 IP 也可能来自共享出口或任播，不证明同一台服务器。
              </p>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">节点</th>
                      <th scope="col">协议</th>
                      <th scope="col">状态</th>
                      <th scope="col">等级 · {vantageName(vantage)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(siblingsState.items || []).map((s) => (
                      <tr key={s.id}>
                        <td data-label="节点">
                          {s.id === node.id ? (
                            <strong>{s.name}</strong>
                          ) : (
                            <a href={nodeHref(s.id, vantage)}>{s.name}</a>
                          )}
                        </td>
                        <td data-label="协议">{s.protocol}</td>
                        <td data-label="状态">
                          <StatusBadge status={s.status} />
                        </td>
                        <td data-label="等级">
                          {s.quality_grade ? (
                            <GradeBadge grade={s.quality_grade} vantage={vantage} withVantage={false} />
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </FoldSection>
      )}

      {/* Check History */}
      <FoldSection
        title="检测历史"
        summary={node.history.length ? `${node.history.length} 条记录` : "暂无记录"}
      >
        {node.history.length === 0 ? (
          <EmptyState title="暂无检测历史" />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">时间</th>
                  <th scope="col">结果</th>
                  <th scope="col">落地</th>
                  <th scope="col" className="num">
                    延迟
                  </th>
                  <th scope="col">阶段</th>
                  <th scope="col">原因</th>
                </tr>
              </thead>
              <tbody>
                {node.history.map((r, idx) => (
                  <tr key={idx}>
                    <td data-label="时间">{formatDate(r.checked_at)}</td>
                    <td data-label="结果">
                      <StatusBadge status={r.status} />
                    </td>
                    <td data-label="落地">
                      {r.exit_country
                        ? `${r.exit_country} AS${r.exit_asn ?? "?"}`
                        : r.echo_source === "fallback"
                          ? "未知（Echo 不可达）"
                          : "—"}
                    </td>
                    <td className="num" data-label="延迟">
                      {formatMs(r.http_duration_ms)}
                    </td>
                    <td data-label="阶段" className="small muted">
                      DNS {r.dns_status} · TCP {r.tcp_status} · 代理 {r.proxy_status}
                    </td>
                    <td data-label="原因">
                      {r.error_code ? errorText(r.error_code) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </FoldSection>

      {/* Classification Edit Modal */}
      {classModalOpen && (
        <Modal title="编辑节点归属" onClose={() => setClassModalOpen(false)}>
          <form className="stack" onSubmit={saveClassification}>
            <label className="field">
              <span className="field-label">节点归属</span>
              <select
                className="select"
                value={classGroup}
                onChange={(e) => setClassGroup(e.target.value as "" | NodeGroup)}
              >
                <option value="">自动判断</option>
                <option value="SELF_HOSTED">确认自建</option>
                <option value="AIRPORT">确认机场</option>
              </select>
            </label>
            <label className="field">
              <span className="field-label">确认依据（选填）</span>
              <input
                className="input"
                maxLength={160}
                autoComplete="off"
                disabled={!classGroup}
                value={classNote}
                onChange={(e) => setClassNote(e.target.value)}
                placeholder="可填写管理或来源说明"
              />
            </label>
            <p className="hint">
              保存后会影响后续检测分组和导出筛选。选择「自动判断」可撤销人工确认。
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn"
                onClick={() => setClassModalOpen(false)}
              >
                取消
              </button>
              <button type="submit" className="btn btn-primary" disabled={classSaving}>
                {classSaving ? "保存中…" : "保存归属"}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Tags Edit Modal */}
      {tagModalOpen && (
        <Modal title="编辑标签" onClose={() => setTagModalOpen(false)}>
          {tagLoading ? (
            <SkeletonBlock lines={2} />
          ) : (
            <form className="stack" onSubmit={saveTags}>
              <p className="hint">标签只用于筛选和整理，不影响等级。</p>
              <label className="field">
                <span className="field-label">标签（逗号分隔）</span>
                <input
                  className="input"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  placeholder="例如：主力, 流媒体, 备用"
                  autoFocus
                />
              </label>
              <div className="modal-actions">
                <button type="button" className="btn" onClick={() => setTagModalOpen(false)}>
                  取消
                </button>
                <button type="submit" className="btn btn-primary" disabled={tagSaving}>
                  {tagSaving ? "保存中…" : "保存"}
                </button>
              </div>
            </form>
          )}
        </Modal>
      )}
    </div>
  );
}
