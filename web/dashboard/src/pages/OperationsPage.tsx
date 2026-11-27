import { useState } from "react";
import { ArrowLeft, Play } from "lucide-react";
import { api, useApiQuery } from "../api/client";
import {
  BarColumn,
  CopyPageLinkButton,
  EmptyState,
  ErrorState,
  MeterBar,
  SkeletonBlock,
  StatusBadge,
  SubTabs,
} from "../components/ui";
import { errorText } from "../lib/errors";
import {
  KIND_LABEL,
  SCAN_KIND_LABEL,
  formatBytes,
  formatDate,
  formatDuration,
  formatGB,
  formatNumber,
  formatPercent,
} from "../lib/format";
import { pageHref, scanHref, type PageName } from "../lib/router";
import { useApp } from "../state/AppContext";
import type {
  OverviewStatus,
  ProbeStatus,
  ScanRunItem,
  UsageDatabaseSample,
  UsageResponse,
} from "../types/api";

const PROBE_ERRORS: Record<string, string> = {
  NETWORK: "无法连接 Globalping",
  TIMEOUT: "测量超时",
  INVALID_RESPONSE: "返回异常",
};

const USAGE_KINDS: Record<string, string> = {
  CHECK: "检测",
  SOURCE: "来源同步",
  SUBSCRIPTION: "订阅下载",
  JOB: "任务采样",
};

const WORKFLOW_NAMES: Record<string, string> = {
  "daily-check": "检测节点",
  "source-sync": "同步来源",
  "export-build": "生成订阅",
  backup: "数据库备份",
  "entry-probe": "接入测量",
  archive: "历史归档",
};

const CONCLUSIONS: Record<string, string> = {
  success: "SUCCESS",
  failure: "FAILED",
  cancelled: "CANCELLED",
  timed_out: "FAILED",
};

const DAY_MS = 86400000;

export function usageProjection(
  samples: UsageDatabaseSample[],
  transfer: UsageResponse["neon_transfer"],
  now = Date.now(),
) {
  if (!transfer?.transfer_period_end || !transfer.transfer_limit_bytes) return null;
  const end = new Date(transfer.transfer_period_end).getTime();
  const readings = samples
    .filter(
      (s) =>
        s.transfer_bytes != null &&
        s.transfer_period_end &&
        new Date(s.transfer_period_end).getTime() === end,
    )
    .map((s) => ({ at: new Date(s.taken_at).getTime(), used: Number(s.transfer_bytes) }))
    .filter((r) => now - r.at <= 7 * DAY_MS)
    .sort((a, b) => a.at - b.at);
  if (readings.length < 2) return null;
  const first = readings[0];
  const last = readings[readings.length - 1];
  const span = last.at - first.at;
  if (span < DAY_MS / 2 || last.used <= first.used) return null;
  const perDay = ((last.used - first.used) / span) * DAY_MS;
  const left = Number(transfer.transfer_limit_bytes) - last.used;
  const runsOut = last.at + (left / perDay) * DAY_MS;
  return { perDay, runsOut, enough: runsOut >= end, spanDays: span / DAY_MS };
}

function ScanDetailView({ scanId }: { scanId: string }) {
  const { data: run, error, loading, refetch } = useApiQuery<ScanRunItem>(
    `/scans/${encodeURIComponent(scanId)}`,
    { cached: false, keepPrevious: false },
  );

  if (loading) {
    return (
      <div className="page">
        <a href="#/ops" className="back-link">
          <ArrowLeft size={15} /> 返回检测记录
        </a>
        <section className="card">
          <SkeletonBlock lines={5} />
        </section>
      </div>
    );
  }

  if (error || !run) {
    return (
      <div className="page">
        <a href="#/ops" className="back-link">
          <ArrowLeft size={15} /> 返回检测记录
        </a>
        <section className="card">
          <ErrorState message={errorText(error?.code)} onRetry={refetch} />
        </section>
      </div>
    );
  }

  const completed = run.items?.DONE || 0;

  return (
    <div className="page">
      <a href="#/ops" className="back-link">
        <ArrowLeft size={15} />
        <span>返回检测记录</span>
      </a>

      <header className="page-header">
        <div>
          <h1 className="page-title">
            {run.scan_date} {SCAN_KIND_LABEL[run.kind] || run.kind}检测
          </h1>
        </div>
        <CopyPageLinkButton href={scanHref(scanId)} />
      </header>

      <section className="card">
        <dl className="kv-list">
          <dt>范围</dt>
          <dd>{KIND_LABEL[run.scope] || "全部"}</dd>
          <dt>状态</dt>
          <dd>
            <StatusBadge status={run.status} />
          </dd>
          <dt>完成 / 待完成</dt>
          <dd>
            {formatNumber(completed)} / {formatNumber(Math.max(0, run.node_count - completed))}
          </dd>
          <dt>问题</dt>
          <dd>
            {run.error_summary?.incomplete_shards?.length
              ? `未完成分片 ${run.error_summary.incomplete_shards.join("、")}`
              : "—"}
          </dd>
        </dl>
      </section>

      <div className="table-card">
        <div className="table-wrap table-wrap-flush">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">分片</th>
                <th scope="col">状态</th>
                <th scope="col" className="num">
                  完成 / 计划
                </th>
                <th scope="col" className="num">
                  失败
                </th>
                <th scope="col">原因</th>
              </tr>
            </thead>
            <tbody>
              {(run.shards || []).map((s) => (
                <tr key={s.shard_no}>
                  <td data-label="分片">#{s.shard_no}</td>
                  <td data-label="状态">
                    <StatusBadge status={s.status} />
                  </td>
                  <td className="num" data-label="完成 / 计划">
                    {formatNumber(s.completed_count)} / {formatNumber(s.planned_count)}
                  </td>
                  <td className="num" data-label="失败">
                    {formatNumber(s.failed_count)}
                  </td>
                  <td data-label="原因">
                    {s.error_summary?.code ? errorText(s.error_summary.code) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="hint">
        未完成的批次里，已确认可用的节点会先发布；失败结果要等批次完整后才发布，避免环境故障把节点误判为不可用。
      </p>
    </div>
  );
}

function ScansTab() {
  const { toast, fail, refreshPipeline } = useApp();
  const { data: runs, error, loading, refetch } = useApiQuery<ScanRunItem[]>("/scans");
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const handleRetry = async (run: ScanRunItem) => {
    setRetryingId(run.id);
    try {
      const res = await api<{ dispatched?: boolean }>(`/scans/${encodeURIComponent(run.id)}/retry`, {
        method: "POST",
      });
      toast(res.dispatched ? "已提交继续执行。" : "该批次已完成。", "ok");
      void refreshPipeline();
      refetch();
    } catch (err) {
      fail(err);
    } finally {
      setRetryingId(null);
    }
  };

  if (loading && !runs) {
    return (
      <section className="card">
        <SkeletonBlock lines={6} />
      </section>
    );
  }
  if (error && !runs) {
    return (
      <section className="card">
        <ErrorState message={errorText(error.code)} onRetry={refetch} />
      </section>
    );
  }

  const list = runs || [];
  const latestComplete = list.find((r) => r.kind === "DAILY" && r.status === "COMPLETED");

  return (
    <div className="stack">
      {latestComplete && (
        <p className="muted small">
          最近完整日检：{latestComplete.scan_date} · 完成于 {formatDate(latestComplete.finished_at)}
        </p>
      )}

      {list.length === 0 ? (
        <section className="card">
          <EmptyState
            title="还没有检测记录"
            hint="点击顶部“开始检测”选择范围启动一次检测。"
          />
        </section>
      ) : (
        <div className="table-card">
          <div className="table-wrap table-wrap-flush">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">日期</th>
                  <th scope="col">类型</th>
                  <th scope="col">范围</th>
                  <th scope="col">状态</th>
                  <th scope="col" className="num">
                    节点
                  </th>
                  <th scope="col">开始时间</th>
                  <th scope="col">耗时</th>
                  <th scope="col" className="num">
                    操作
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.id}>
                    <td data-label="日期">
                      <a href={scanHref(r.id)} className="row-title">
                        {r.scan_date}
                      </a>
                    </td>
                    <td data-label="类型">{SCAN_KIND_LABEL[r.kind] || r.kind}</td>
                    <td data-label="范围">{KIND_LABEL[r.scope] || "全部"}</td>
                    <td data-label="状态">
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="num" data-label="节点">
                      {formatNumber(r.node_count)}
                    </td>
                    <td className="muted small" data-label="开始时间">
                      {formatDate(r.started_at)}
                    </td>
                    <td className="muted small" data-label="耗时">
                      {formatDuration(r.started_at, r.finished_at)}
                    </td>
                    <td className="num" data-label="操作">
                      {r.status !== "COMPLETED" && !r.archived_at ? (
                        <button
                          type="button"
                          className="btn btn-quiet btn-sm"
                          disabled={retryingId === r.id}
                          onClick={() => void handleRetry(r)}
                        >
                          <Play size={12} /> 继续执行
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function ProbesTab() {
  const { data: status, error, loading, refetch } = useApiQuery<ProbeStatus>("/probe-status");

  if (loading && !status) {
    return (
      <section className="card">
        <SkeletonBlock lines={5} />
      </section>
    );
  }
  if (error || !status) {
    return (
      <section className="card">
        <ErrorState message={errorText(error?.code)} onRetry={refetch} />
      </section>
    );
  }

  const daily = status.daily || [];
  const runs = status.runs || [];
  const maxDailyTests = daily.reduce((m, d) => Math.max(m, d.tests || 0), 0);

  return (
    <div className="stack">
      <dl className="stat-strip">
        <div>
          <dt>今天已用测试</dt>
          <dd>{formatNumber(status.tests_today)}</dd>
        </div>
        <div>
          <dt>7 天测试</dt>
          <dd>{formatNumber(status.tests_7d)}</dd>
        </div>
        <div>
          <dt>已覆盖网段（7 天）</dt>
          <dd>{formatNumber(status.prefixes_graded)}</dd>
        </div>
        <div>
          <dt>三网晚高峰覆盖</dt>
          <dd>{formatNumber(status.prefixes_peak)}</dd>
        </div>
        <div>
          <dt>去程路由</dt>
          <dd>{formatNumber(status.traces)}</dd>
        </div>
      </dl>

      {daily.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2>每日测试量</h2>
            <span className="muted small">近 {daily.length} 天</span>
          </div>
          <div className="mini-bar-chart" role="list" aria-label="每日测试量">
            {daily.map((d) => (
              <div key={d.date} className="mini-bar-item" role="listitem">
                <span className="mini-bar-value">{formatNumber(d.tests)}</span>
                <div className="mini-bar-track">
                  <BarColumn
                    ratio={maxDailyTests > 0 ? d.tests / maxDailyTests : 0}
                    title={`${d.date} · ${formatNumber(d.tests)} 次测试`}
                  />
                </div>
                <span className="mini-bar-date">{d.date.slice(5)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {runs.length === 0 ? (
        <section className="card">
          <EmptyState title="还没有接入测量" hint="部署后每小时自动运行一次。" />
        </section>
      ) : (
        <div className="table-card">
          <div className="table-wrap table-wrap-flush">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">开始时间</th>
                  <th scope="col">时段</th>
                  <th scope="col" className="num">
                    测量 / 测试
                  </th>
                  <th scope="col" className="num">
                    写入
                  </th>
                  <th scope="col" className="num">
                    失败
                  </th>
                  <th scope="col" className="num">
                    额度用尽
                  </th>
                  <th scope="col">问题</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r, idx) => (
                  <tr key={idx}>
                    <td data-label="开始时间">{formatDate(r.started_at)}</td>
                    <td data-label="时段">{r.peak ? "晚高峰（三网）" : "其他时段"}</td>
                    <td className="num" data-label="测量 / 测试">
                      {formatNumber(r.measurements)} / {formatNumber(r.tests)}
                    </td>
                    <td className="num" data-label="写入">
                      {formatNumber(r.stored)}
                    </td>
                    <td className="num" data-label="失败">
                      {formatNumber(r.failed)}
                    </td>
                    <td className="num" data-label="额度用尽">
                      {formatNumber(r.rate_limited)}
                    </td>
                    <td data-label="问题">
                      {r.error_code
                        ? PROBE_ERRORS[r.error_code] || r.error_code
                        : r.failed
                          ? "部分请求失败（见运行日志）"
                          : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="hint">
        Globalping 免费额度按小时计算（账号 500 次、匿名 250 次）；每个探针执行一次测量算 1
        次测试。只记录计数，不记录目标。
      </p>
    </div>
  );
}

function UsageTab({
  params,
  go,
}: {
  params: URLSearchParams;
  go: (name: PageName, params?: Record<string, string>) => void;
}) {
  const days = params.get("days") || "30";
  const usageQ = useApiQuery<UsageResponse>(`/usage?days=${encodeURIComponent(days)}`, {
    cached: false,
  });
  const probeQ = useApiQuery<ProbeStatus>("/probe-status");
  const opsQ = useApiQuery<OverviewStatus>("/overview/status");

  const [showAllActions, setShowAllActions] = useState(false);
  const [showAllRecent, setShowAllRecent] = useState(false);

  if (usageQ.loading && !usageQ.data) {
    return (
      <section className="card">
        <SkeletonBlock lines={6} />
      </section>
    );
  }
  if (usageQ.error || !usageQ.data) {
    return (
      <section className="card">
        <ErrorState message={errorText(usageQ.error?.code)} onRetry={usageQ.refetch} />
      </section>
    );
  }

  const data = usageQ.data;
  const probe = probeQ.data;
  const ops = opsQ.data;
  const dbSamples = data.database_samples || [];
  const actionRuns = data.action_runs || [];
  const recentRuns = data.recent || [];
  const dailyRows = data.daily || [];
  const latest = dbSamples[0];
  const transfer = data.neon_transfer;
  const selfHosted = data.database_provider === "self_hosted";
  const ratio =
    transfer && transfer.transfer_limit_bytes
      ? transfer.transfer_bytes / transfer.transfer_limit_bytes
      : null;
  const pace = selfHosted ? null : usageProjection(dbSamples, transfer);

  const visibleActions = showAllActions ? actionRuns : actionRuns.slice(0, 10);
  const visibleRecent = showAllRecent ? recentRuns : recentRuns.slice(0, 10);

  return (
    <div className="stack">
      <div className="section-bar">
        <p className="muted small">按 UTC 日期汇总运行指标、数据库容量与备份状态</p>
        <select
          className="select"
          aria-label="用量时间范围"
          value={days}
          onChange={(e) => go("ops", { tab: "usage", days: e.target.value })}
        >
          <option value="7">近 7 天</option>
          <option value="30">近 30 天</option>
          <option value="90">近 90 天</option>
          <option value="365">近 365 天</option>
        </select>
      </div>

      {/* Neon Transfer Card (only when on Neon) */}
      {!selfHosted && (
        <section className="card">
          <div className="card-head">
            <h2>数据库流量（Neon 公网传输）</h2>
          </div>
          {transfer && ratio !== null ? (
            <div className="stack-sm">
              <div className="big-stat">
                <span className="big-stat-num">{formatPercent(ratio)}</span>
                <span className="big-stat-of">
                  {formatGB(transfer.transfer_bytes)} / {formatGB(transfer.transfer_limit_bytes)}
                </span>
              </div>
              <MeterBar
                ratio={ratio}
                tone={ratio >= 0.9 ? "bad" : ratio >= 0.7 ? "warn" : "ok"}
              />
              {pace && (
                <p className={pace.enough ? "small" : "bad-text strong small"}>
                  {pace.enough
                    ? `按最近 ${pace.spanDays.toFixed(1)} 天的速度（每天约 ${formatGB(pace.perDay)}），本周期够用。`
                    : `按最近 ${pace.spanDays.toFixed(1)} 天的速度（每天约 ${formatGB(pace.perDay)}），约 ${formatDate(new Date(pace.runsOut).toISOString()).slice(0, 10)} 用完。`}
                </p>
              )}
              <p className="hint">
                {transfer.transfer_period_end
                  ? `${formatDate(transfer.transfer_period_end)} 重置`
                  : "按月重置"}
                ；用满后数据库会暂停到重置日（数据不丢）。{formatDate(transfer.taken_at)} 读取。
              </p>
            </div>
          ) : (
            <p className="muted">还没有 Neon 流量读数。</p>
          )}
        </section>
      )}

      {/* Key Metrics */}
      <dl className="stat-strip">
        <div>
          <dt>Actions 分钟</dt>
          <dd>{formatNumber(Math.round(Number(data.runner_minutes)))}</dd>
        </div>
        <div title="检测尝试次数，包含复测和预检">
          <dt>节点检测</dt>
          <dd>{formatNumber(data.health.attempts)}</dd>
        </div>
        <div>
          <dt>平均每次</dt>
          <dd>
            {data.health.mean_check_ms == null
              ? "—"
              : (data.health.mean_check_ms / 1000).toFixed(1) + " 秒"}
          </dd>
        </div>
        <div>
          <dt>超时占比</dt>
          <dd>{formatPercent(data.health.timeout_ratio)}</dd>
        </div>
        <div>
          <dt>任务失败率</dt>
          <dd>{formatPercent(data.executions.failure_ratio)}</dd>
        </div>
        <div
          title={`入口连不上 ${formatNumber(data.totals.preflight_skips)} 次，连续失败冷却中 ${formatNumber(data.totals.cooldown_skips)} 次`}
        >
          <dt>跳过</dt>
          <dd>
            {formatNumber(Number(data.totals.preflight_skips) + Number(data.totals.cooldown_skips))}
          </dd>
        </div>
        {probe && (
          <div
            title={`Globalping 近 7 天测试次数；今天 ${formatNumber(probe.tests_today)} 次，存储 ${formatBytes(probe.storage_bytes)}`}
          >
            <dt>接入测量</dt>
            <dd>{formatNumber(probe.tests_7d)}</dd>
          </div>
        )}
      </dl>

      <div className="stack-xs">
        <p className="hint">
          各阶段超时 · DNS {formatNumber(data.health.dns_timeouts)} · 入口 TCP{" "}
          {formatNumber(data.health.tcp_timeouts)} · 代理 HTTPS{" "}
          {formatNumber(data.health.https_timeouts)} · UDP{" "}
          {formatNumber(data.health.udp_timeouts)}。一次检测可命中多个阶段。
        </p>
        <p className="hint">
          按 UTC 日期统计。字节数为应用层载荷，不是运营商流量账单；Actions 分钟来自已完成的 Job
          时长，不等同于计费分钟。
        </p>
      </div>

      {/* Database & Backup Card */}
      <section className="card">
        <div className="card-head">
          <h2>数据库与备份</h2>
          {latest && <span className="muted tiny">采样于 {formatDate(latest.taken_at)}</span>}
        </div>
        <dl className="kv-list">
          <dt>数据库体积</dt>
          <dd>
            {latest ? (
              <>
                项目数据 <strong>{formatBytes(latest.table_bytes)}</strong> · 数据库共{" "}
                <strong>{formatBytes(latest.database_bytes)}</strong> · 窗口内增长{" "}
                {formatBytes(data.database_growth_bytes)}
              </>
            ) : (
              <span className="muted">还没有容量采样。</span>
            )}
          </dd>
          {ops?.host && (
            <>
              <dt>主机资源</dt>
              <dd>
                剩余磁盘 {formatBytes(ops.host.disk_free)} / {formatBytes(ops.host.disk_total)} ·
                可用内存 {formatBytes(ops.host.mem_available)} · 证书有效至{" "}
                {formatDate(ops.host.tls_expires_at)}
              </dd>
            </>
          )}
          {ops?.capacity_24h?.samples ? (
            <>
              <dt>过去 24 小时</dt>
              <dd>
                {ops.capacity_24h.samples} 次采样 · 连接峰值 {ops.capacity_24h.connections_peak} ·
                数据库峰值 {formatBytes(ops.capacity_24h.db_peak_bytes)}
              </dd>
            </>
          ) : null}
          {ops?.last_daily_capacity?.samples ? (
            <>
              <dt>{ops.last_daily_capacity.scan_date} 日检</dt>
              <dd>
                {ops.last_daily_capacity.samples} 次采样 · 连接峰值{" "}
                {ops.last_daily_capacity.connections_peak} · 最低可用内存{" "}
                {formatBytes(ops.last_daily_capacity.mem_min_bytes)}
              </dd>
            </>
          ) : selfHosted ? (
            <>
              <dt>日检容量</dt>
              <dd className="muted">等待采集下一次完整日检期间的容量。</dd>
            </>
          ) : null}
          <dt>加密备份</dt>
          <dd className={data.latest_backup?.expired ? "bad-text" : undefined}>
            {data.latest_backup ? (
              <>
                最近 {formatDate(data.latest_backup.created_at)} ·{" "}
                {data.latest_backup.expired
                  ? "已过期"
                  : `有效至 ${formatDate(data.latest_backup.expires_at)}`}
              </>
            ) : (
              <span className="muted">暂时无法确认加密备份产物。</span>
            )}
          </dd>
        </dl>
      </section>

      {/* Actions Runs */}
      <section className="stack-sm">
        <h2>Actions 执行</h2>
        {actionRuns.length === 0 ? (
          <div className="card">
            <EmptyState title="还没有 Actions 记录" />
          </div>
        ) : (
          <div className="table-card">
            <div className="table-wrap table-wrap-flush">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">工作流</th>
                    <th scope="col">结果</th>
                    <th scope="col">开始时间</th>
                    <th scope="col" className="num">
                      分钟
                    </th>
                    <th scope="col" className="num">
                      Job / 失败
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visibleActions.map((r, idx) => (
                    <tr key={idx}>
                      <td data-label="工作流">{WORKFLOW_NAMES[r.workflow] || r.workflow}</td>
                      <td data-label="结果">
                        <StatusBadge status={CONCLUSIONS[r.conclusion] || r.conclusion} />
                      </td>
                      <td className="muted small" data-label="开始时间">
                        {formatDate(r.started_at)}
                      </td>
                      <td className="num" data-label="分钟">
                        {(r.runner_ms / 60000).toFixed(1)}
                      </td>
                      <td className="num" data-label="Job / 失败">
                        {r.job_count} / {r.failed_jobs}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!showAllActions && actionRuns.length > 10 && (
              <button
                type="button"
                className="btn-more-rows"
                onClick={() => setShowAllActions(true)}
              >
                显示全部 {actionRuns.length} 条
              </button>
            )}
          </div>
        )}
      </section>

      {/* Recent Executions */}
      <section className="stack-sm">
        <h2>最近执行</h2>
        {recentRuns.length === 0 ? (
          <div className="card">
            <EmptyState title="暂无记录" />
          </div>
        ) : (
          <div className="table-card">
            <div className="table-wrap table-wrap-flush">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">类型</th>
                    <th scope="col">开始时间</th>
                    <th scope="col">结果</th>
                    <th scope="col" className="num">
                      检测 / 超时
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRecent.map((r, idx) => (
                    <tr key={idx}>
                      <td data-label="类型">{USAGE_KINDS[r.kind] || r.kind}</td>
                      <td className="muted small" data-label="开始时间">
                        {formatDate(r.started_at)}
                      </td>
                      <td data-label="结果">
                        <StatusBadge status={r.outcome} />
                      </td>
                      <td className="num" data-label="检测 / 超时">
                        {formatNumber(r.check_count)} / {formatNumber(r.timeout_checks)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!showAllRecent && recentRuns.length > 10 && (
              <button
                type="button"
                className="btn-more-rows"
                onClick={() => setShowAllRecent(true)}
              >
                显示全部 {recentRuns.length} 条
              </button>
            )}
          </div>
        )}
      </section>

      {/* Daily Summary */}
      <section className="stack-sm">
        <h2>每日明细</h2>
        {dailyRows.length === 0 ? (
          <div className="card">
            <EmptyState title="暂无每日明细" />
          </div>
        ) : (
          <div className="table-card">
            <div className="table-wrap table-wrap-flush">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">日期</th>
                    <th scope="col" className="num">
                      检测
                    </th>
                    <th scope="col" className="num">
                      回显请求 / 失败
                    </th>
                    <th scope="col" className="num">
                      来源请求
                    </th>
                    <th scope="col" className="num">
                      订阅下载
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {dailyRows.map((d) => (
                    <tr key={d.day}>
                      <td className="mono" data-label="日期">
                        {d.day}
                      </td>
                      <td className="num" data-label="检测">
                        {formatNumber(d.check_count)}
                      </td>
                      <td className="num" data-label="回显请求 / 失败">
                        {formatNumber(d.echo_requests)} / {formatNumber(d.echo_failures)}
                      </td>
                      <td className="num" data-label="来源请求">
                        {formatNumber(d.source_requests)}（{formatBytes(d.source_response_bytes)}）
                      </td>
                      <td className="num" data-label="订阅下载">
                        {formatNumber(d.subscription_downloads)}（
                        {formatBytes(d.subscription_bytes)}）
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {selfHosted && transfer && (
        <details className="card fold-card">
          <summary className="fold-trigger">
            <h2>Neon 历史流量</h2>
          </summary>
          <div className="fold-body">
            <p className="muted small">
              最后一条读数 {formatGB(transfer.transfer_bytes)}，采于 {formatDate(transfer.taken_at)}。
            </p>
          </div>
        </details>
      )}
    </div>
  );
}

const OPS_TABS: ReadonlyArray<{ key: "scans" | "probes" | "usage"; text: string }> = [
  { key: "scans", text: "节点检测" },
  { key: "probes", text: "接入测量" },
  { key: "usage", text: "用量与备份" },
];

export function OperationsPage({
  params,
  go,
}: {
  params: URLSearchParams;
  go: (name: PageName, params?: Record<string, string>) => void;
}) {
  if (params.has("scan")) {
    return <ScanDetailView scanId={params.get("scan") || ""} />;
  }

  const rawTab = params.get("tab");
  const activeTab: "scans" | "probes" | "usage" =
    rawTab === "probes" || rawTab === "usage" ? rawTab : "scans";

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">运维</h1>
          <p className="page-subtitle">检测批次、Globalping 接入测量、主机容量与云端备份</p>
        </div>
        <SubTabs
          label="运维类别"
          current={activeTab}
          items={OPS_TABS.map((t) => ({
            key: t.key,
            text: t.text,
            href: pageHref("ops", t.key === "scans" ? {} : { tab: t.key }),
          }))}
        />
      </header>

      {activeTab === "probes" ? (
        <ProbesTab />
      ) : activeTab === "usage" ? (
        <UsageTab params={params} go={go} />
      ) : (
        <ScansTab />
      )}
    </div>
  );
}
