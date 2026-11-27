import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Download,
  FolderGit2,
  Globe,
  RefreshCw,
  Server,
} from "lucide-react";
import { useApiQuery } from "../api/client";
import {
  FlexSegment,
  GradeBadge,
  GradeDistribution,
  SkeletonBlock,
  StatusBadge,
} from "../components/ui";
import { errorText } from "../lib/errors";
import {
  KIND_LABEL,
  SCAN_KIND_LABEL,
  countryFlag,
  daysUntil,
  formatAgo,
  formatBytes,
  formatDate,
  formatNumber,
  type Tone,
} from "../lib/format";
import { GRADES, VANTAGES, vantageName } from "../lib/grades";
import { pageHref, scanHref, sourceHref, type PageName } from "../lib/router";
import type {
  GroupSummary,
  OverviewAttention,
  OverviewCatalog,
  OverviewRecovery,
  OverviewStatus,
  ProbeStatus,
  QualityGrade,
  Vantage,
} from "../types/api";

const PROBE_ERRORS: Record<string, string> = {
  NETWORK: "无法连接 Globalping",
  TIMEOUT: "测量超时",
  INVALID_RESPONSE: "Globalping 返回异常",
};

const sourceProblemsHref = (extra: Record<string, string> = {}) =>
  pageHref("sources", { status: "FAILED", active: "1", ...extra });

const olderThan = (value: string | null | undefined, hours: number, observed: number) =>
  !value || observed - Date.parse(value) > hours * 3600000;

function KpiCard({
  label,
  value,
  sub,
  href,
  icon: Icon,
  tone = "default",
}: {
  label: string;
  value: number | null | undefined;
  sub: string;
  href: string;
  icon: React.ComponentType<{ size?: number }>;
  tone?: "default" | "ok" | "warn" | "bad";
}) {
  return (
    <a href={href} className={`kpi-card kpi-${tone}`}>
      <div className="kpi-head">
        <span className="kpi-label">{label}</span>
        <span className="kpi-icon" aria-hidden="true">
          <Icon size={16} />
        </span>
      </div>
      <div className="kpi-value">{value == null ? "—" : formatNumber(value)}</div>
      <div className="kpi-sub">
        <span>{sub}</span>
        <ArrowUpRight size={13} className="kpi-arrow" aria-hidden="true" />
      </div>
    </a>
  );
}

function HealthRow({
  label,
  tone,
  state,
  detail,
  href,
  external = false,
}: {
  label: string;
  tone: Tone;
  state: string;
  detail: React.ReactNode;
  href: string;
  external?: boolean;
}) {
  return (
    <li className="health-row">
      <a
        href={href}
        className="health-label"
        target={external ? "_blank" : undefined}
        rel={external ? "noreferrer noopener" : undefined}
      >
        <span className={`dot dot-${tone}`} aria-hidden="true" />
        <span>{label}</span>
      </a>
      <span className={`health-state tone-${tone}`}>{state}</span>
      <span className="health-detail">{detail}</span>
    </li>
  );
}

function SystemHealthCard({
  ops,
  recovery,
  recoveryFailed,
}: {
  ops: OverviewStatus;
  recovery: OverviewRecovery | undefined;
  recoveryFailed: boolean;
}) {
  const observed = Date.parse(ops.observed_at) || Date.now();
  const usageHref = pageHref("ops", { tab: "usage" });
  const probesHref = pageHref("ops", { tab: "probes" });
  const settingsHref = pageHref("settings");

  const scan = ops.last_daily;
  const complete = ops.last_complete;
  const behind = olderThan(complete?.finished_at, 30, observed);
  const inProgress = scan?.status === "RUNNING" && Boolean(scan.lease_active);
  const incomplete = Boolean(scan && scan.status !== "COMPLETED");
  const lastCompleteDetail = complete ? (
    <>
      上次完整 <time dateTime={complete.finished_at} title={formatDate(complete.finished_at)}>{formatAgo(complete.finished_at)}</time>
    </>
  ) : (
    "还没有完整日检"
  );
  const daily: [Tone, string, React.ReactNode] = !ops.daily_enabled
    ? ["mute", "已暂停", "定时检测已关闭"]
    : inProgress
      ? ["info", "运行中", lastCompleteDetail]
      : incomplete || behind
        ? ["warn", incomplete ? "未完成" : "待检查", lastCompleteDetail]
        : ["ok", "正常", lastCompleteDetail];

  const probe = ops.probe;
  const probeState: [Tone, string, React.ReactNode] = !ops.probe_enabled
    ? ["mute", "已暂停", "定时测量已关闭"]
    : olderThan(probe?.finished_at, 3, observed)
      ? [
          "warn",
          "待检查",
          probe?.finished_at ? `最近完成 ${formatAgo(probe.finished_at)}` : "暂无记录",
        ]
      : probe?.error_code
        ? ["warn", "有异常", PROBE_ERRORS[probe.error_code] || "上次测量有错误"]
        : [
            "ok",
            "正常",
            `${formatAgo(probe?.finished_at)} · ${formatNumber(probe?.measurements ?? 0)} 个样本`,
          ];

  const host = ops.host;
  const sampled = !olderThan(host?.taken_at, 0.5, observed);
  const disk = sampled && host ? Math.round((100 * host.disk_free) / host.disk_total) : null;
  const certDays =
    sampled && host ? Math.ceil((Date.parse(host.tls_expires_at) - observed) / 86400000) : null;
  const hostState: [Tone, string, React.ReactNode] =
    sampled && disk !== null && certDays !== null
      ? [
          disk < 20 || certDays <= 30 ? "warn" : "ok",
          disk < 20 ? "磁盘偏低" : certDays <= 30 ? "证书将到期" : "正常",
          `剩余磁盘 ${disk}% · TLS 剩余 ${certDays} 天`,
        ]
      : ["mute", "采样待更新", host ? formatAgo(host.taken_at) : "暂无容量样本"];

  const backup = recovery?.backup;
  const backupState: [Tone, string, React.ReactNode] = !recovery && !recoveryFailed
    ? ["mute", "查询中", "正在读取备份记录"]
    : recoveryFailed || !recovery?.backup_available
      ? ["warn", "记录不可用", "无法读取云端备份记录"]
      : !backup
        ? ["warn", "无可用备份", "没有发现有效备份包"]
        : olderThan(backup.created_at, 36, observed)
          ? ["warn", "备份较旧", formatAgo(backup.created_at)]
          : ["ok", "已备份", formatAgo(backup.created_at)];

  const drill = recovery?.drill;
  const drillOld = drill ? olderThan(drill.finished_at, 38 * 24, observed) : false;
  const drillState: [Tone, string, React.ReactNode] = !recovery && !recoveryFailed
    ? ["mute", "查询中", "正在读取演练记录"]
    : recoveryFailed || !recovery?.drill_available
      ? ["mute", "记录不可用", "无法读取云端演练记录"]
      : !drill
        ? ["mute", "待演练", "暂无自动恢复记录"]
        : drill.result === "success"
          ? [drillOld ? "warn" : "ok", drillOld ? "演练较旧" : "通过", formatAgo(drill.finished_at)]
          : ["warn", "未通过", formatAgo(drill.finished_at)];

  const ex = ops.exports;
  const exportsState: [Tone, string, React.ReactNode] = !ex.active
    ? ["mute", "未配置", "尚无生效中的订阅方案"]
    : [
        ex.unavailable ? "warn" : ex.serving === ex.active ? "ok" : "info",
        ex.unavailable ? "需检查" : ex.serving === ex.active ? "可下载" : "构建中",
        `${formatNumber(ex.serving)} / ${formatNumber(ex.active)} 可下载${ex.pending ? ` · ${formatNumber(ex.pending)} 待构建` : ""}`,
      ];

  return (
    <ul className="health-list">
      <HealthRow label="服务与数据库" tone="ok" state="可用" detail="API 已连到 PostgreSQL" href={usageHref} />
      <HealthRow
        label="每日检测"
        tone={daily[0]}
        state={daily[1]}
        detail={daily[2]}
        href={scan ? scanHref(scan.id) : settingsHref}
      />
      <HealthRow label="接入测量" tone={probeState[0]} state={probeState[1]} detail={probeState[2]} href={probesHref} />
      <HealthRow label="主机容量" tone={hostState[0]} state={hostState[1]} detail={hostState[2]} href={usageHref} />
      <HealthRow label="加密备份" tone={backupState[0]} state={backupState[1]} detail={backupState[2]} href={usageHref} />
      <HealthRow
        label="恢复演练"
        tone={drillState[0]}
        state={drillState[1]}
        detail={drillState[2]}
        href={drill?.run_id ? `https://github.com/Samiya321/nodema/actions/runs/${drill.run_id}` : usageHref}
        external={Boolean(drill?.run_id)}
      />
      <HealthRow label="成品订阅" tone={exportsState[0]} state={exportsState[1]} detail={exportsState[2]} href="#/exports" />
    </ul>
  );
}

function AttentionCard({
  issues,
  ops,
}: {
  issues: OverviewAttention;
  ops: OverviewStatus | undefined;
}) {
  const workedGroups = issues.groups.filter((g) => g.worked).slice(0, 3);
  const airportRisks: Array<["expired" | "exhausted" | "soon" | "low", string]> = [
    ["expired", "已过期"],
    ["exhausted", "流量已用完"],
    ["soon", "7 天内到期"],
    ["low", "流量不足"],
  ];

  const items: Array<{ key: string; title: string; href: string; desc: string }> = [];
  for (const g of workedGroups) {
    items.push({
      key: `src-${g.id}`,
      title: g.total > 1 ? `${g.name} · ${formatNumber(g.total)} 个异常` : g.name,
      href: g.total > 1 ? sourceProblemsHref({ root: g.id, sort: "problems" }) : sourceHref(g.example_id),
      desc: [
        `${formatNumber(g.worked)} 个曾同步成功`,
        ...g.errors.map(errorText),
        g.next_attempt ? `预计重试 ${formatDate(g.next_attempt)}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }
  for (const [risk, label] of airportRisks) {
    const match = issues.airports.find((a) => a.risk === risk);
    if (!match) continue;
    const extra =
      risk === "low" && match.traffic_total != null
        ? ` · 剩余 ${formatBytes(Number(match.traffic_total) - Number(match.used || 0))}`
        : risk === "soon" && daysUntil(match.expires_at) !== null
          ? ` · ${daysUntil(match.expires_at)} 天后到期`
          : "";
    items.push({
      key: `air-${risk}`,
      title: `${formatNumber(match.total)} 个机场${label}`,
      href: pageHref("sources", { tab: "airport", state: risk }),
      desc: `${match.name}${extra}`,
    });
  }

  return (
    <div className="attention-body">
      {items.length > 0 ? (
        <ul className="attention-list">
          {items.map((item) => (
            <li key={item.key}>
              <a href={item.href} className="attention-title">
                {item.title}
              </a>
              <p className="attention-desc">{item.desc}</p>
            </li>
          ))}
        </ul>
      ) : (
        <div className="all-clear">
          <CheckCircle2 size={18} className="ok-text" />
          <span>当前没有曾正常的来源失效或机场异常。</span>
        </div>
      )}

      <div className="attention-footer">
        {issues.broken > 0 && (
          <a href={sourceProblemsHref({ history: "worked", sort: "problems" })} className="tag-link is-bad">
            曾成功失败 · {formatNumber(issues.broken)}
          </a>
        )}
        {issues.never_worked > 0 && (
          <a href={sourceProblemsHref({ history: "never", sort: "problems" })} className="tag-link">
            从未成功 · {formatNumber(issues.never_worked)}
          </a>
        )}
        {(ops?.sources.pending ?? 0) > 0 && (
          <a href={pageHref("sources", { status: "NEVER" })} className="tag-link is-info">
            待同步 · {formatNumber(ops?.sources.pending)}
          </a>
        )}
      </div>
    </div>
  );
}

function GroupAssetCard({ groupKey, data }: { groupKey: "SELF_HOSTED" | "AIRPORT"; data?: GroupSummary }) {
  const statuses = data?.statuses || {};
  const up = (statuses.UP || 0) + (statuses.DEGRADED || 0);
  const total = data?.total || 0;
  const rows: Array<[string, number, Tone, string]> = [
    ["可用", up, "ok", "AVAILABLE"],
    ["不可用", statuses.DOWN || 0, "bad", "DOWN"],
    ["未检测", statuses.UNKNOWN || 0, "mute", "UNKNOWN"],
    ["结果过期", statuses.STALE || 0, "mute", "STALE"],
    ["不支持", statuses.UNSUPPORTED || 0, "mute", "UNSUPPORTED"],
  ];

  return (
    <section className="card">
      <div className="card-head">
        <h2>{KIND_LABEL[groupKey]}节点</h2>
        <a href={`#/nodes?node_group=${groupKey}&status=ALL`} className="card-action">
          查看全部
        </a>
      </div>
      <div className="big-stat">
        <span className="big-stat-num">{formatNumber(up)}</span>
        <span className="big-stat-of">/ {formatNumber(total)} 可用</span>
      </div>
      {total > 0 && (
        <div className="mini-stack-bar" aria-hidden="true">
          {up > 0 && <FlexSegment grow={up} className="bar-ok" />}
          {(statuses.DOWN || 0) > 0 && <FlexSegment grow={statuses.DOWN || 0} className="bar-bad" />}
          {Math.max(0, total - up - (statuses.DOWN || 0)) > 0 && (
            <FlexSegment grow={Math.max(0, total - up - (statuses.DOWN || 0))} className="bar-mute" />
          )}
        </div>
      )}
      <ul className="tally-list">
        {rows.map(([label, n, tone, status]) => (
          <li key={status}>
            <a href={`#/nodes?node_group=${groupKey}&status=${status}`}>
              <span className={`dot dot-${tone}`} aria-hidden="true" />
              <span>{label}</span>
            </a>
            <strong>{formatNumber(n)}</strong>
          </li>
        ))}
      </ul>
      <p className="hint">具备检测资格 {formatNumber(data?.eligible || 0)} 个</p>
    </section>
  );
}

export function OverviewPage({
  params,
  go,
}: {
  params: URLSearchParams;
  go: (name: PageName, params?: Record<string, string>) => void;
}) {
  const requestedVantage = (params.get("vantage") as Vantage | null) || "";
  const statusQ = useApiQuery<OverviewStatus>("/overview/status");
  const recoveryQ = useApiQuery<OverviewRecovery>("/overview/recovery", { maxAge: 60000 });
  const attentionQ = useApiQuery<OverviewAttention>("/overview/attention");
  const catalogQ = useApiQuery<OverviewCatalog>("/overview/catalog");
  const probeQ = useApiQuery<ProbeStatus>(
    requestedVantage ? `/probe-status?vantage=${encodeURIComponent(requestedVantage)}` : "/probe-status",
  );

  const ops = statusQ.data;
  const catalog = catalogQ.data;
  const issues = attentionQ.data;
  const probe = probeQ.data;

  const activeVantage: Vantage = probe?.vantage || (requestedVantage as Vantage) || "CN";
  const availableNodes = catalog
    ? (catalog.statuses.UP || 0) + (catalog.statuses.DEGRADED || 0)
    : null;

  const countries = catalog
    ? Object.entries(catalog.countries || {})
        .filter(([code]) => code !== "UNK")
        .sort((a, b) => b[1] - a[1])
        .slice(0, 14)
    : [];

  const handleRefresh = () => {
    statusQ.refetch();
  };

  const gradeCounts = probe?.grades || {};
  const gradeTotal = Object.values(gradeCounts).reduce((a, b) => a + (b || 0), 0);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">总览</h1>
          <p className="page-subtitle" role="status">
            {ops
              ? `状态更新于 ${formatDate(ops.observed_at)}`
              : statusQ.error
                ? "系统状态暂时无法读取"
                : "正在检查系统状态…"}
          </p>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="btn"
            disabled={statusQ.refreshing}
            onClick={handleRefresh}
          >
            <RefreshCw size={14} className={statusQ.refreshing ? "spin" : undefined} />
            <span>刷新</span>
          </button>
        </div>
      </header>

      {/* Row 1: KPI Metrics */}
      <section className="kpi-grid" aria-label="关键指标">
        <KpiCard
          label="当前可用节点"
          value={availableNodes}
          sub={catalog ? `共 ${formatNumber(catalog.total)} 个入库节点` : "查看节点目录"}
          href="#/nodes"
          icon={Server}
          tone="ok"
        />
        <KpiCard
          label="已登记来源"
          value={ops?.sources.total}
          sub={
            ops
              ? `${formatNumber(ops.sources.roots)} 根来源 · ${formatNumber(ops.sources.children)} 子来源`
              : "查看全部来源"
          }
          href="#/sources"
          icon={FolderGit2}
        />
        <KpiCard
          label="待检查来源"
          value={issues?.broken}
          sub={
            issues
              ? `${formatNumber(issues.never_worked)} 个从未成功`
              : "查看同步异常"
          }
          href={sourceProblemsHref({ history: "worked" })}
          icon={AlertTriangle}
          tone={(issues?.broken ?? 0) > 0 ? "warn" : "default"}
        />
        <KpiCard
          label="成品订阅"
          value={ops?.exports.active}
          sub={ops ? `${formatNumber(ops.exports.serving)} 个可下载` : "管理订阅方案"}
          href="#/exports"
          icon={Download}
        />
      </section>

      {/* Row 2: System Health & Attention */}
      <div className="overview-grid-primary">
        <section className="card">
          <div className="card-head">
            <h2>系统状态</h2>
            <a href="#/ops" className="card-action">
              运行记录
            </a>
          </div>
          {ops ? (
            <SystemHealthCard ops={ops} recovery={recoveryQ.data} recoveryFailed={Boolean(recoveryQ.error)} />
          ) : statusQ.error ? (
            <p className="muted">暂时无法读取，请刷新重试。</p>
          ) : (
            <SkeletonBlock lines={5} />
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h2>待处理事项</h2>
            <a href={sourceProblemsHref()} className="card-action">
              来源异常
            </a>
          </div>
          {issues ? (
            <AttentionCard issues={issues} ops={ops} />
          ) : attentionQ.error ? (
            <p className="muted">暂时无法读取，请刷新重试。</p>
          ) : (
            <SkeletonBlock lines={4} />
          )}
        </section>
      </div>

      {/* Row 3: Scan Activity & Quality Distribution */}
      <div className="overview-grid-secondary">
        <section className="card">
          <div className="card-head">
            <h2>
              <Activity size={15} className="head-icon" aria-hidden="true" /> 检测动态
            </h2>
            <a href="#/ops" className="card-action">
              全部检测
            </a>
          </div>
          {ops ? (
            <div className="stack">
              {ops.latest_scan ? (
                <div className="scan-highlight">
                  <div className="scan-highlight-top">
                    <a href={scanHref(ops.latest_scan.id)} className="scan-highlight-title">
                      {ops.latest_scan.scan_date} · {SCAN_KIND_LABEL[ops.latest_scan.kind] || "检测"}
                    </a>
                    <StatusBadge status={ops.latest_scan.status} />
                  </div>
                  <p className="muted small">
                    {formatNumber(ops.latest_scan.done)} / {formatNumber(ops.latest_scan.node_count)} 已完成 ·{" "}
                    {ops.latest_scan.scope === "ALL" ? "全部" : KIND_LABEL[ops.latest_scan.scope]}
                  </p>
                </div>
              ) : (
                <p className="muted">暂无检测批次。</p>
              )}

              {ops.daily_history.length > 0 && (
                <div className="stack-sm">
                  <h3>最近 7 个日检批次</h3>
                  <ol className="daily-history-grid">
                    {ops.daily_history.map((run) => (
                      <li key={run.id}>
                        <a
                          href={scanHref(run.id)}
                          className="history-cell"
                          title={`${run.scan_date} · ${formatNumber(run.node_count)} 个节点`}
                        >
                          <span className="history-date">{run.scan_date.slice(5)}</span>
                          <StatusBadge status={run.status} />
                        </a>
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              {ops.queued_scan_at && (
                <p className="callout callout-info">
                  有检测请求正在排队 · {formatAgo(ops.queued_scan_at)}
                </p>
              )}
            </div>
          ) : statusQ.error ? (
            <p className="muted">检测记录随系统状态更新。</p>
          ) : (
            <SkeletonBlock lines={4} />
          )}
        </section>

        <section className="card">
          <div className="card-head card-head-wrap">
            <h2>质量分布 · {vantageName(activeVantage)}</h2>
            <div className="segmented segmented-sm" role="group" aria-label="等级视角">
              {VANTAGES.map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={`seg-btn${activeVantage === key ? " is-active" : ""}`}
                  aria-pressed={activeVantage === key}
                  onClick={() => go("overview", { vantage: key })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {probe ? (
            gradeTotal > 0 ? (
              <div className="stack">
                <GradeDistribution
                  counts={gradeCounts}
                  link={(g: QualityGrade) => `#/nodes?vantage=${activeVantage}&g=${g}`}
                  fullWidth
                />
                <ul className="tally-list">
                  {GRADES.map((g) => (
                    <li key={g}>
                      <a href={`#/nodes?vantage=${activeVantage}&g=${g}`}>
                        <GradeBadge grade={g} vantage={activeVantage} withVantage={false} />
                      </a>
                      <strong>{formatNumber(gradeCounts[g] || 0)}</strong>
                    </li>
                  ))}
                </ul>
                <div className="stack-xs">
                  <p className="hint">
                    只统计当前可用的节点；定档于 {formatAgo(probe.graded_at)}。
                  </p>
                  {probe.coverage_total != null && (
                    <p className="hint">
                      当前可用 {formatNumber(probe.coverage_total)} · 有接入样本{" "}
                      {formatNumber(probe.coverage_measured)} · 端点已确认{" "}
                      {formatNumber(probe.coverage_endpoint_verified)} · CF 落地排除{" "}
                      {formatNumber(probe.coverage_excluded)}
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <p className="muted">
                还没有定档。完成至少 3 天检测后出现等级；接入测量每小时运行一次。
              </p>
            )
          ) : probeQ.error ? (
            <p className="muted">暂时无法读取质量分布。</p>
          ) : (
            <SkeletonBlock lines={5} />
          )}
        </section>
      </div>

      {/* Row 4: Self-Hosted vs Airport Asset Groups */}
      {catalog ? (
        <>
          <div className="grid-2">
            <GroupAssetCard groupKey="SELF_HOSTED" data={catalog.groups?.SELF_HOSTED} />
            <GroupAssetCard groupKey="AIRPORT" data={catalog.groups?.AIRPORT} />
          </div>

          {countries.length > 0 && (
            <section className="card">
              <div className="card-head">
                <h2>
                  <Globe size={15} className="head-icon" aria-hidden="true" /> 可用节点落地
                </h2>
                <a href="#/nodes?by=country" className="card-action">
                  按国家查看
                </a>
              </div>
              <ul className="country-pills">
                {countries.map(([code, n]) => (
                  <li key={code}>
                    <a href={pageHref("nodes", { exit_country: code })} className="country-pill">
                      <span aria-hidden="true">{countryFlag(code)}</span>
                      <span>{code}</span>
                      <strong>{formatNumber(n)}</strong>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      ) : catalogQ.error ? null : (
        <div className="grid-2">
          <section className="card">
            <SkeletonBlock lines={4} />
          </section>
          <section className="card">
            <SkeletonBlock lines={4} />
          </section>
        </div>
      )}
    </div>
  );
}
