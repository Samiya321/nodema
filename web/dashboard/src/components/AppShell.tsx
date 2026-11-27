import React, { useEffect, useRef, useState } from "react";
import {
  Activity,
  Download,
  FolderGit2,
  LayoutGrid,
  LogOut,
  Monitor,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  RefreshCw,
  Server,
  SlidersHorizontal,
  Sun,
} from "lucide-react";
import { KIND_LABEL, formatAgo, formatDate } from "../lib/format";
import type { PageName } from "../lib/router";
import { useApp, type ThemeMode } from "../state/AppContext";
import { MeterBar } from "./ui";
import { ShareQrModal } from "./ShareQrModal";

const RAIL_STORAGE_KEY = "nodema.sidebarCollapsed";
const RUNNING = new Set(["PENDING", "RUNNING"]);

const NAV_ITEMS: Array<{
  key: PageName;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  mobilePrimary?: boolean;
}> = [
  { key: "overview", label: "总览", icon: LayoutGrid, mobilePrimary: true },
  { key: "nodes", label: "节点", icon: Server, mobilePrimary: true },
  { key: "sources", label: "来源", icon: FolderGit2, mobilePrimary: true },
  { key: "exports", label: "导出", icon: Download, mobilePrimary: true },
  { key: "ops", label: "运维", icon: Activity, mobilePrimary: false },
];

const THEME_LABELS: Record<ThemeMode, string> = {
  system: "外观：跟随系统",
  light: "外观：浅色",
  dark: "外观：深色",
};

function ThemeIcon({ mode, size = 17 }: { mode: ThemeMode; size?: number }) {
  if (mode === "light") return <Sun size={size} />;
  if (mode === "dark") return <Moon size={size} />;
  return <Monitor size={size} />;
}

function PipelineBar() {
  const {
    pipeline,
    pipelineError,
    startSyncAll,
    openTestDialog,
    retryScan,
  } = useApp();
  const [syncing, setSyncing] = useState(false);
  const [resumingId, setResumingId] = useState<string | null>(null);

  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      await startSyncAll();
    } finally {
      setSyncing(false);
    }
  };

  const handleResume = async (id: string) => {
    setResumingId(id);
    try {
      await retryScan(id);
    } finally {
      setResumingId(null);
    }
  };

  const requested = pipeline?.requested_scans || [];
  const activeScans = pipeline?.active_scans || [];
  const deadLinks = pipeline ? Math.max(0, pipeline.failed_sources - (pipeline.broken_sources || 0)) : 0;
  const hasActiveRun =
    requested.length > 0 || activeScans.some((r) => RUNNING.has(r.status));

  const transfer = pipeline?.neon_transfer;
  const transferRatio = transfer && transfer.limit ? transfer.used / transfer.limit : null;

  return (
    <header className="topbar" aria-label="同步与检测控制条">
      <div className="topbar-status">
        {!pipeline ? (
          <span className="topbar-chip muted" role="status">
            <span className="pulse-dot is-mute" aria-hidden="true" />
            <span>{pipelineError || "正在读取运行状态…"}</span>
          </span>
        ) : (
          <>
            <div className="topbar-sync-meta">
              <span
                className={`pulse-dot ${hasActiveRun ? "is-live" : "is-ok"}`}
                aria-hidden="true"
                title={hasActiveRun ? "有检测任务进行中" : "运行状态正常"}
              />
              <span className="topbar-sync-time">上次同步 {formatAgo(pipeline.last_synced_at)}</span>
              {pipeline.pending_sources > 0 && (
                <a
                  href="#/sources?status=NEVER"
                  className="status-pill pill-info"
                  title="有待同步的来源"
                >
                  {pipeline.pending_sources} 待同步
                </a>
              )}
              {pipeline.broken_sources > 0 && (
                <a
                  href="#/sources?status=FAILED&sort=recent"
                  className="status-pill pill-bad"
                  title="之前同步成功、最近一次失败的来源"
                >
                  {pipeline.broken_sources} 这次失败
                </a>
              )}
              {deadLinks > 0 && (
                <a
                  href="#/sources?status=FAILED"
                  className="status-pill pill-mute"
                  title="从未同步成功的链接（多为上游失效），节点不受影响"
                >
                  {deadLinks} 链接失效
                </a>
              )}
            </div>

            {transferRatio !== null && transferRatio >= 0.7 && transfer && (
              <a
                href="#/ops?tab=usage"
                className={`status-pill ${transferRatio >= 0.9 ? "pill-bad" : "pill-warn"}`}
                title={`${(transfer.used / 1e9).toFixed(2)} / ${(transfer.limit / 1e9).toFixed(2)} GB${transfer.period_end ? "，" + formatDate(transfer.period_end) + " 重置" : ""}`}
              >
                数据库流量 {Math.round(transferRatio * 100)}%
              </a>
            )}

            {(requested.length > 0 || activeScans.length > 0) && (
              <span className="topbar-sep" aria-hidden="true" />
            )}

            <div className="topbar-runs" aria-live="polite">
              {requested.map((r, i) => (
                <span key={i} className="status-pill pill-info" title="等待 GitHub Actions 开始">
                  已请求：{r.scope === "NODES" ? `所选 ${r.nodes} 个节点` : KIND_LABEL[r.scope] || r.scope}
                </span>
              ))}
              {activeScans.slice(0, 2).map((run) => {
                const done = Number(run.done || 0);
                const total = Number(run.node_count || 0);
                const everything =
                  (pipeline.testable?.SELF_HOSTED || 0) + (pipeline.testable?.AIRPORT || 0);
                const label =
                  run.scope === "ALL"
                    ? everything && total < everything
                      ? "所选节点"
                      : "全部"
                    : KIND_LABEL[run.scope] || "全部";
                if (RUNNING.has(run.status)) {
                  return (
                    <a
                      key={run.id}
                      href={`#/ops?scan=${encodeURIComponent(run.id)}`}
                      className="run-pill"
                      title="查看检测进度"
                    >
                      <span className="run-pill-label">
                        <span>检测中 · {label}</span>
                        <strong className="mono">
                          {done}/{total}
                        </strong>
                      </span>
                      <MeterBar ratio={total ? done / total : 0} tone="info" label="检测进度" />
                    </a>
                  );
                }
                return (
                  <span key={run.id} className="status-pill pill-warn">
                    <span>
                      检测中断（{label} {done}/{total}）
                    </span>
                    <button
                      type="button"
                      className="inline-action-btn"
                      disabled={resumingId === run.id}
                      onClick={() => void handleResume(run.id)}
                    >
                      继续
                    </button>
                  </span>
                );
              })}
              {!requested.length && !activeScans.length && (
                <span className="topbar-idle">无进行中检测</span>
              )}
            </div>
          </>
        )}
      </div>

      <div className="topbar-actions">
        <button type="button" className="btn" disabled={syncing} onClick={() => void handleSync()}>
          <RefreshCw size={14} className={syncing ? "spin" : undefined} />
          <span>同步来源</span>
        </button>
        <button type="button" className="btn btn-primary" onClick={openTestDialog}>
          <Play size={14} />
          <span>开始检测</span>
        </button>
      </div>
    </header>
  );
}

export function AppShell({
  currentPage,
  onLogout,
  loggingOut,
  children,
}: {
  currentPage: PageName;
  onLogout: () => void;
  loggingOut: boolean;
  children: React.ReactNode;
}) {
  const { theme, cycleTheme, pipeline, shareNode, closeShareNode } = useApp();
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(RAIL_STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(RAIL_STORAGE_KEY, String(next));
      } catch {
        // ignore
      }
      return next;
    });
  };

  useEffect(() => {
    setMoreOpen(false);
  }, [currentPage]);

  useEffect(() => {
    if (!moreOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMoreOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

  const moreActive = currentPage === "ops" || currentPage === "settings";
  const opsRunning = Boolean(
    pipeline &&
      ((pipeline.requested_scans?.length ?? 0) > 0 ||
        pipeline.active_scans.some((r) => RUNNING.has(r.status))),
  );
  const sourcesAlertCount = pipeline
    ? pipeline.broken_sources > 0
      ? pipeline.broken_sources
      : pipeline.pending_sources > 0
        ? pipeline.pending_sources
        : 0
    : 0;
  const sourcesAlertTone = pipeline && pipeline.broken_sources > 0 ? "bad" : "info";

  return (
    <div className={`shell${collapsed ? " is-collapsed" : ""}`}>
      <a
        className="skip-link"
        href="#page"
        onClick={(e) => {
          e.preventDefault();
          mainRef.current?.focus();
        }}
      >
        跳到主要内容
      </a>

      <aside className="sidebar" aria-label="主导航">
        <div className="sidebar-top">
          <a className="brand-link" href="#/overview" title="Nodema 节点台">
            <span className="brand-mark" aria-hidden="true">
              N
            </span>
            <span className="brand-name">Nodema</span>
          </a>
          <button
            type="button"
            className="rail-toggle"
            aria-expanded={!collapsed}
            aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
            title={collapsed ? "展开侧栏" : "收起侧栏"}
            onClick={toggleCollapsed}
          >
            {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          </button>

          {/* Mobile "More" menu button */}
          <div className="mobile-more" ref={moreRef}>
            <button
              type="button"
              className={`mobile-more-btn${moreActive ? " is-active" : ""}`}
              aria-expanded={moreOpen}
              aria-haspopup="menu"
              onClick={() => setMoreOpen((v) => !v)}
            >
              <MoreHorizontal size={18} />
              <span>更多</span>
            </button>
            {moreOpen && (
              <div className="mobile-more-menu" role="menu">
                <a
                  href="#/ops"
                  role="menuitem"
                  className={currentPage === "ops" ? "is-active" : undefined}
                  aria-current={currentPage === "ops" ? "page" : undefined}
                  onClick={() => setMoreOpen(false)}
                >
                  <Activity size={16} />
                  <span>运维</span>
                </a>
                <a
                  href="#/settings"
                  role="menuitem"
                  className={currentPage === "settings" ? "is-active" : undefined}
                  aria-current={currentPage === "settings" ? "page" : undefined}
                  onClick={() => setMoreOpen(false)}
                >
                  <SlidersHorizontal size={16} />
                  <span>设置</span>
                </a>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    cycleTheme();
                  }}
                >
                  <ThemeIcon mode={theme} size={16} />
                  <span>{THEME_LABELS[theme]}</span>
                </button>
                <div className="menu-divider" />
                <button
                  type="button"
                  role="menuitem"
                  className="is-danger"
                  disabled={loggingOut}
                  onClick={() => {
                    setMoreOpen(false);
                    onLogout();
                  }}
                >
                  <LogOut size={16} />
                  <span>退出登录</span>
                </button>
              </div>
            )}
          </div>
        </div>

        <nav className="sidebar-nav" aria-label="页面导航">
          <div className="nav-section-label">工作区</div>
          <ul>
            {NAV_ITEMS.map(({ key, label, icon: Icon, mobilePrimary }) => {
              const active = currentPage === key;
              return (
                <li key={key} className={!mobilePrimary ? "desktop-only" : undefined}>
                  <a
                    href={`#/${key}`}
                    className={`nav-link${active ? " is-active" : ""}`}
                    aria-current={active ? "page" : undefined}
                    title={label}
                  >
                    <Icon size={18} className="nav-icon" />
                    <span className="nav-label">{label}</span>
                    {key === "sources" && sourcesAlertCount > 0 && (
                      <span
                        className={`nav-badge nav-badge-${sourcesAlertTone}`}
                        aria-hidden="true"
                      >
                        {sourcesAlertCount > 99 ? "99+" : sourcesAlertCount}
                      </span>
                    )}
                    {key === "ops" && opsRunning && (
                      <span className="nav-live-dot" aria-hidden="true" title="检测进行中" />
                    )}
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="sidebar-footer">
          <button
            type="button"
            className="nav-link"
            title={THEME_LABELS[theme]}
            aria-label={THEME_LABELS[theme]}
            onClick={cycleTheme}
          >
            <ThemeIcon mode={theme} size={17} />
            <span className="nav-label">{THEME_LABELS[theme].replace("外观：", "")}</span>
          </button>
          <a
            href="#/settings"
            className={`nav-link${currentPage === "settings" ? " is-active" : ""}`}
            aria-current={currentPage === "settings" ? "page" : undefined}
            title="设置"
          >
            <SlidersHorizontal size={18} className="nav-icon" />
            <span className="nav-label">设置</span>
          </a>
          <button
            type="button"
            className="nav-link nav-logout"
            disabled={loggingOut}
            title="退出登录"
            onClick={onLogout}
          >
            <LogOut size={18} className="nav-icon" />
            <span className="nav-label">退出</span>
          </button>
        </div>
      </aside>

      <div className="workspace">
        <PipelineBar />
        <main id="page" ref={mainRef} className="page-container" tabIndex={-1}>
          {children}
        </main>
        <footer className="app-footer">
          地区与 ASN 来自 Cloudflare Echo 与 MaxMind GeoLite；接入质量为 Globalping 社区探针 TCP
          实测；不判断线路类型。
        </footer>
      </div>

      {shareNode && <ShareQrModal node={shareNode} onClose={closeShareNode} />}
    </div>
  );
}
