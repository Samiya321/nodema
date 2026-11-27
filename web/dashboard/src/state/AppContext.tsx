import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { X, CheckCircle2, AlertCircle, Info } from "lucide-react";
import { ApiError, api, invalidateReads, readAPI } from "../api/client";
import { errorText } from "../lib/errors";
import { KIND_LABEL } from "../lib/format";
import { invalidateNodeCaches } from "./nodeListStore";
import type { DispatchResponse, PipelineState } from "../types/api";

// ---- Theme ----
export type ThemeMode = "system" | "light" | "dark";
const THEME_KEY = "nodema.theme";

function readInitialTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // storage unavailable
  }
  return "system";
}

// ---- Toast ----
export type ToastTone = "info" | "ok" | "bad";
interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

// ---- Confirm Dialog ----
export interface ConfirmOptions {
  title: string;
  message: string;
  action?: string;
  danger?: boolean;
  checkboxLabel?: string;
}

export interface ConfirmResult {
  confirmed: boolean;
  checked: boolean;
}

interface PendingConfirm {
  options: ConfirmOptions;
  resolve: (res: ConfirmResult) => void;
}

// ---- Context Value ----
interface AppContextValue {
  theme: ThemeMode;
  setTheme: (mode: ThemeMode) => void;
  cycleTheme: () => void;
  toast: (message: string, tone?: ToastTone) => void;
  fail: (error: unknown) => void;
  confirm: (options: ConfirmOptions) => Promise<ConfirmResult>;
  pipeline: PipelineState | null;
  pipelineError: string | null;
  refreshPipeline: () => Promise<void>;
  syncSources: (ids?: string[] | null, opts?: { pendingOnly?: boolean }) => Promise<boolean>;
  startSyncAll: () => Promise<void>;
  testNodes: (ids: string[]) => Promise<boolean>;
  openTestDialog: () => void;
  retryScan: (scanId: string) => Promise<boolean>;
  openShareNode: (node: { id: string; name: string }) => void;
  shareNode: { id: string; name: string } | null;
  closeShareNode: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside AppProvider");
  return ctx;
}

const RUNNING_STATUSES = new Set(["PENDING", "RUNNING"]);
const WAKE_MS = 10 * 60 * 1000;

export function AppProvider({
  authenticated,
  children,
}: {
  authenticated: boolean;
  children: React.ReactNode;
}) {
  // Theme
  const [theme, setThemeState] = useState<ThemeMode>(readInitialTheme);

  const setTheme = useCallback((mode: ThemeMode) => {
    setThemeState(mode);
    try {
      localStorage.setItem(THEME_KEY, mode);
    } catch {
      // ignore
    }
  }, []);

  const cycleTheme = useCallback(() => {
    setThemeState((prev) => {
      const next: ThemeMode = prev === "system" ? "light" : prev === "light" ? "dark" : "system";
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const el = document.documentElement;
    if (theme === "system") el.removeAttribute("data-theme");
    else el.setAttribute("data-theme", theme);
  }, [theme]);

  // Toasts
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastSeqRef = useRef(0);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((message: string, tone: ToastTone = "info") => {
    const id = ++toastSeqRef.current;
    setToasts((prev) => [...prev.slice(-2), { id, message, tone }]);
    const duration = tone === "bad" ? 8000 : 4500;
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, duration);
  }, []);

  const fail = useCallback(
    (error: unknown) => {
      if (error instanceof ApiError && (error.status === 401 || error.code === "SESSION_ENDED")) {
        return;
      }
      const code =
        error instanceof ApiError
          ? error.code
          : error instanceof Error
            ? error.message
            : "OPERATION_FAILED";
      toast(errorText(code), "bad");
    },
    [toast],
  );

  // Confirm Dialog
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [confirmChecked, setConfirmChecked] = useState(false);

  const confirm = useCallback((options: ConfirmOptions): Promise<ConfirmResult> => {
    setConfirmChecked(false);
    return new Promise((resolve) => {
      setPendingConfirm({ options, resolve });
    });
  }, []);

  const resolveConfirm = useCallback(
    (confirmed: boolean) => {
      if (!pendingConfirm) return;
      pendingConfirm.resolve({ confirmed, checked: confirmChecked });
      setPendingConfirm(null);
      setConfirmChecked(false);
    },
    [pendingConfirm, confirmChecked],
  );

  // Share QR modal state (global so list & detail can open it cleanly)
  const [shareNode, setShareNode] = useState<{ id: string; name: string } | null>(null);
  const openShareNode = useCallback((node: { id: string; name: string }) => {
    setShareNode({ id: node.id, name: node.name });
  }, []);
  const closeShareNode = useCallback(() => setShareNode(null), []);

  // Close transient modals on route change
  useEffect(() => {
    const onHash = () => setShareNode(null);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Pipeline status & polling
  const [pipeline, setPipeline] = useState<PipelineState | null>(null);
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  const [testModalOpen, setTestModalOpen] = useState(false);
  const [testScope, setTestScope] = useState<"SELF_HOSTED" | "AIRPORT" | "ALL">("SELF_HOSTED");
  const [testTotals, setTestTotals] = useState<{ own: number; airport: number } | null>(null);
  const [testSubmitting, setTestSubmitting] = useState(false);

  const timerRef = useRef<number | undefined>(undefined);
  const wakeUntilRef = useRef(0);
  const lastReadRef = useRef(0);
  const wasWorkingRef = useRef(false);
  const inflightRef = useRef<Promise<PipelineState> | null>(null);
  const authRef = useRef(authenticated);
  authRef.current = authenticated;

  const schedulePoll = useCallback((busyNow: boolean, runFn: () => void) => {
    window.clearTimeout(timerRef.current);
    if (!authRef.current) return;
    if (!busyNow && Date.now() > wakeUntilRef.current) return;
    timerRef.current = window.setTimeout(() => {
      if (!authRef.current) return;
      if (!document.hidden) runFn();
      else schedulePoll(busyNow, runFn);
    }, 15000);
  }, []);

  const refreshPipeline = useCallback(async () => {
    if (!authRef.current) return;
    lastReadRef.current = Date.now();
    try {
      if (!inflightRef.current) {
        inflightRef.current = api<PipelineState>("/pipeline?view=toolbar").finally(() => {
          inflightRef.current = null;
        });
      }
      const state = await inflightRef.current;
      if (!authRef.current) return;
      setPipeline(state);
      setPipelineError(null);

      const running = state.active_scans.some((r) => RUNNING_STATUSES.has(r.status));
      const work = running || state.pending_sources > 0;
      if (wasWorkingRef.current && !work) {
        invalidateReads();
        invalidateNodeCaches();
      }
      wasWorkingRef.current = work;
      schedulePoll(running || (state.requested_scans?.length ?? 0) > 0, () => {
        void refreshPipeline();
      });
    } catch {
      if (!authRef.current) return;
      setPipelineError("运行状态暂时不可用");
      schedulePoll(wasWorkingRef.current, () => {
        void refreshPipeline();
      });
    }
  }, [schedulePoll]);

  useEffect(() => {
    if (!authenticated) {
      window.clearTimeout(timerRef.current);
      setPipeline(null);
      setPipelineError(null);
      setTestModalOpen(false);
      setShareNode(null);
      setPendingConfirm(null);
      wakeUntilRef.current = 0;
      lastReadRef.current = 0;
      wasWorkingRef.current = false;
      return;
    }
    const initTimer = window.setTimeout(() => {
      void refreshPipeline();
    }, 300);

    const onVisibility = () => {
      if (!document.hidden && authRef.current && Date.now() - lastReadRef.current >= 30000) {
        void refreshPipeline();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearTimeout(initTimer);
      window.clearTimeout(timerRef.current);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [authenticated, refreshPipeline]);

  const notifySubmitted = useCallback(
    (result: DispatchResponse | null | undefined, what: string) => {
      wakeUntilRef.current = Date.now() + WAKE_MS;
      window.setTimeout(() => {
        void refreshPipeline();
      }, 3500);
      if (result?.dispatched === false) {
        toast(`${what}请求已保存，提交到 GitHub 失败。可重新提交，或等待对应的定时任务。`, "bad");
      } else {
        toast(`${what}已提交到 GitHub Actions，通常 1 分钟内开始。`, "ok");
      }
    },
    [refreshPipeline, toast],
  );

  const syncSources = useCallback(
    async (ids?: string[] | null, opts: { pendingOnly?: boolean } = {}) => {
      try {
        const body = ids
          ? { source_ids: ids }
          : opts.pendingOnly
            ? { pending_only: true }
            : {};
        const res = await api<DispatchResponse>("/pipeline/sync", { method: "POST", body });
        notifySubmitted(res, "同步");
        return true;
      } catch (err) {
        fail(err);
        return false;
      }
    },
    [fail, notifySubmitted],
  );

  const startSyncAll = useCallback(async () => {
    const count = pipeline?.sources_total ?? "全部";
    const { confirmed } = await confirm({
      title: "同步来源",
      message: `重新拉取 ${count} 个启用的来源：更新节点、机场流量与 Sub-Store 子来源。只同步，不检测节点。`,
      action: "开始同步",
    });
    if (!confirmed) return;
    await syncSources(null);
  }, [confirm, pipeline?.sources_total, syncSources]);

  const testNodes = useCallback(
    async (ids: string[]) => {
      if (!ids.length) return false;
      const detail =
        ids.length <= 50 ? "本次做完整复测，跳过失败冷却。" : "本次按常规规则检测。";
      const { confirmed } = await confirm({
        title: "检测所选节点",
        message: `检测已选的 ${ids.length} 个节点。${detail}正在其他未完成批次中的节点会跳过。`,
        action: "开始检测",
      });
      if (!confirmed) return false;
      try {
        const res = await api<DispatchResponse>("/scans", {
          method: "POST",
          body: { node_ids: ids },
        });
        notifySubmitted(res, "检测");
        return true;
      } catch (err) {
        fail(err);
        return false;
      }
    },
    [confirm, fail, notifySubmitted],
  );

  const retryScan = useCallback(
    async (scanId: string) => {
      try {
        const res = await api<DispatchResponse>(`/scans/${encodeURIComponent(scanId)}/retry`, {
          method: "POST",
        });
        notifySubmitted(res, "继续检测");
        return true;
      } catch (err) {
        fail(err);
        return false;
      }
    },
    [fail, notifySubmitted],
  );

  const openTestDialog = useCallback(() => {
    setTestScope("SELF_HOSTED");
    setTestTotals(null);
    setTestModalOpen(true);
    void readAPI<PipelineState>("/pipeline")
      .then((res) => {
        setTestTotals({
          own: res.testable?.SELF_HOSTED || 0,
          airport: res.testable?.AIRPORT || 0,
        });
      })
      .catch(() => {});
  }, []);

  const submitTestDialog = async (e: React.FormEvent) => {
    e.preventDefault();
    if (testSubmitting) return;
    setTestSubmitting(true);
    try {
      const res = await api<DispatchResponse>("/scans", {
        method: "POST",
        body: { scope: testScope },
      });
      notifySubmitted(res, "检测");
      setTestModalOpen(false);
    } catch (err) {
      fail(err);
    } finally {
      setTestSubmitting(false);
    }
  };

  return (
    <AppContext.Provider
      value={{
        theme,
        setTheme,
        cycleTheme,
        toast,
        fail,
        confirm,
        pipeline,
        pipelineError,
        refreshPipeline,
        syncSources,
        startSyncAll,
        testNodes,
        openTestDialog,
        retryScan,
        openShareNode,
        shareNode,
        closeShareNode,
      }}
    >
      {children}

      {/* Global Confirm Dialog */}
      {pendingConfirm && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) resolveConfirm(false);
          }}
        >
          <div
            className="modal-card modal-sm"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
          >
            <div className="modal-header">
              <h2 id="confirm-dialog-title">{pendingConfirm.options.title}</h2>
              <button
                type="button"
                className="btn-icon"
                aria-label="关闭"
                onClick={() => resolveConfirm(false)}
              >
                <X size={16} />
              </button>
            </div>
            <div className="modal-body stack">
              <p className="confirm-message">{pendingConfirm.options.message}</p>
              {pendingConfirm.options.checkboxLabel && (
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={confirmChecked}
                    onChange={(e) => setConfirmChecked(e.target.checked)}
                  />
                  <span>{pendingConfirm.options.checkboxLabel}</span>
                </label>
              )}
            </div>
            <div className="modal-footer">
              <button type="button" className="btn" onClick={() => resolveConfirm(false)}>
                取消
              </button>
              <button
                type="button"
                className={pendingConfirm.options.danger ? "btn btn-danger" : "btn btn-primary"}
                onClick={() => resolveConfirm(true)}
                autoFocus
              >
                {pendingConfirm.options.action || "确认"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Global Start Scan Dialog */}
      {testModalOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget && !testSubmitting) setTestModalOpen(false);
          }}
        >
          <div className="modal-card modal-sm" role="dialog" aria-modal="true" aria-labelledby="test-dialog-title">
            <div className="modal-header">
              <h2 id="test-dialog-title">开始检测</h2>
              <button
                type="button"
                className="btn-icon"
                aria-label="关闭"
                onClick={() => setTestModalOpen(false)}
              >
                <X size={16} />
              </button>
            </div>
            <form onSubmit={submitTestDialog}>
              <div className="modal-body stack">
                <fieldset className="choice-group">
                  <legend className="sr-only">检测范围</legend>
                  {(
                    [
                      [
                        "SELF_HOSTED",
                        "自建节点",
                        "你自己的服务器节点。",
                        testTotals ? `${testTotals.own.toLocaleString("zh-CN")} 个` : null,
                      ],
                      [
                        "AIRPORT",
                        "机场节点",
                        "只含未过期、流量未用完、未暂停的机场订阅。",
                        testTotals ? `${testTotals.airport.toLocaleString("zh-CN")} 个` : null,
                      ],
                      [
                        "ALL",
                        "全部",
                        "自建与机场一起检测。",
                        testTotals
                          ? `${(testTotals.own + testTotals.airport).toLocaleString("zh-CN")} 个`
                          : null,
                      ],
                    ] as const
                  ).map(([val, title, hint, countText]) => (
                    <label
                      key={val}
                      className={"choice-card" + (testScope === val ? " is-selected" : "")}
                    >
                      <input
                        type="radio"
                        name="scope"
                        value={val}
                        checked={testScope === val}
                        onChange={() => setTestScope(val)}
                      />
                      <div className="choice-card-text">
                        <div className="choice-card-head">
                          <span className="choice-card-title">{title}</span>
                          {countText && <span className="choice-card-count">{countText}</span>}
                        </div>
                        <span className="hint">{hint}</span>
                      </div>
                    </label>
                  ))}
                </fieldset>
                {pipeline && pipeline.pending_sources > 0 && (
                  <p className="callout callout-info">
                    还有 {pipeline.pending_sources} 个来源待同步。本次检测使用当前已入库的节点。
                  </p>
                )}
                <p className="hint">想只测部分节点：在“节点”页勾选后点击底部“检测所选”。</p>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn" onClick={() => setTestModalOpen(false)}>
                  取消
                </button>
                <button type="submit" className="btn btn-primary" disabled={testSubmitting}>
                  {testSubmitting ? "正在提交…" : `开始检测（${KIND_LABEL[testScope]}）`}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Toast Region */}
      <div className="toast-region" role="status" aria-live="polite">
        {toasts.map((item) => (
          <div key={item.id} className={`toast toast-${item.tone}`}>
            <span className="toast-icon" aria-hidden="true">
              {item.tone === "ok" ? (
                <CheckCircle2 size={16} />
              ) : item.tone === "bad" ? (
                <AlertCircle size={16} />
              ) : (
                <Info size={16} />
              )}
            </span>
            <span className="toast-msg">{item.message}</span>
            <button
              type="button"
              className="toast-close"
              aria-label="关闭通知"
              onClick={() => dismissToast(item.id)}
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </AppContext.Provider>
  );
}
