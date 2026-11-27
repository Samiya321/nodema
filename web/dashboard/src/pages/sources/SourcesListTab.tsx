import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Link2,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { ApiError, api, useApiQuery } from "../../api/client";
import {
  EmptyState,
  ErrorState,
  Pagination,
  SkeletonBlock,
  StatusBadge,
} from "../../components/ui";
import { errorText } from "../../lib/errors";
import {
  KIND_LABEL,
  SOURCE_TYPE_LABEL,
  formatAgo,
  formatDate,
  formatNumber,
  zhCollator,
} from "../../lib/format";
import { pageHref, sourceHref, type PageName } from "../../lib/router";
import { useApp } from "../../state/AppContext";
import type { BulkSourceResult, SourceItem } from "../../types/api";
import { EditSourceModal, SourceLinkModal } from "./SourceModals";

const PAGE_SIZE = 50;
const IMPORT_CHUNK = 100;

const CATEGORY_TABS: ReadonlyArray<[string, string]> = [
  ["", "全部"],
  ["SELF_HOSTED", "自建"],
  ["AIRPORT", "机场"],
  ["SUBSTORE", "Sub-Store"],
  ["CHILD", "来自 Sub-Store"],
];

const SORT_OPTIONS: ReadonlyArray<[string, string]> = [
  ["name", "按名称"],
  ["problems", "失败优先"],
  ["nodes", "节点多→少"],
  ["recent", "最近成功"],
];

const STATUS_RANK: Record<string, number> = { FAILED: 0, PARTIAL: 1, NEVER: 2, SUCCESS: 3 };

const COMPARATORS: Record<string, (a: SourceItem, b: SourceItem) => number> = {
  name: (a, b) => zhCollator.compare(a.name, b.name),
  problems: (a, b) =>
    (STATUS_RANK[a.last_sync_status] ?? 9) - (STATUS_RANK[b.last_sync_status] ?? 9) ||
    zhCollator.compare(a.name, b.name),
  nodes: (a, b) => (b.node_count || 0) - (a.node_count || 0) || zhCollator.compare(a.name, b.name),
  recent: (a, b) =>
    String(b.last_success_at || "").localeCompare(String(a.last_success_at || "")) ||
    zhCollator.compare(a.name, b.name),
};

function ImportSection({ onImported }: { onImported: () => void }) {
  const { syncSources, fail } = useApp();
  const [mode, setMode] = useState<"links" | "text">("links");
  const [urls, setUrls] = useState("");
  const [prefix, setPrefix] = useState("订阅");
  const [textName, setTextName] = useState("");
  const [textPayload, setTextPayload] = useState("");
  const [textKind, setTextKind] = useState("SELF_HOSTED");
  const [submitting, setSubmitting] = useState(false);
  const [progressText, setProgressText] = useState("");
  const [bulkReport, setBulkReport] = useState<{
    result: BulkSourceResult;
    stoppedError?: string;
  } | null>(null);
  const [textSavedId, setTextSavedId] = useState<string | null>(null);

  const submitLinks = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setBulkReport(null);
    setTextSavedId(null);

    const raw = urls.split("\n");
    const parts: Array<{ urls: string; start_line: number }> = [];
    let start = 0;
    let count = 0;
    raw.forEach((line, i) => {
      if (line.trim()) count += 1;
      if (count === IMPORT_CHUNK || i === raw.length - 1) {
        parts.push({ urls: raw.slice(start, i + 1).join("\n"), start_line: start + 1 });
        start = i + 1;
        count = 0;
      }
    });

    const agg: BulkSourceResult = { created: 0, duplicates: 0, invalid: 0, items: [] };
    let stoppedError: string | undefined;
    try {
      for (const [idx, part] of parts.entries()) {
        if (!part.urls.trim()) continue;
        if (parts.length > 1) setProgressText(`保存中 ${idx + 1}/${parts.length}…`);
        const saved = await api<BulkSourceResult>("/sources/bulk", {
          method: "POST",
          body: { urls: part.urls, start_line: part.start_line, name_prefix: prefix },
        });
        agg.created += saved.created;
        agg.duplicates += saved.duplicates;
        agg.invalid += saved.invalid;
        agg.items.push(...saved.items);
      }
    } catch (err) {
      stoppedError = errorText(err instanceof ApiError ? err.code : "OPERATION_FAILED");
    } finally {
      setSubmitting(false);
      setProgressText("");
    }

    setBulkReport({ result: agg, stoppedError });
    if (agg.created > 0) {
      setUrls("");
      onImported();
    }
  };

  const submitRawText = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setBulkReport(null);
    setTextSavedId(null);
    try {
      const saved = await api<{ id: string }>("/sources", {
        method: "POST",
        body: { name: textName, payload: textPayload, kind: textKind, type: "RAW_TEXT" },
      });
      setTextSavedId(saved.id);
      setTextName("");
      setTextPayload("");
      onImported();
    } catch (err) {
      fail(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="card import-card">
      <div className="card-head">
        <h2>添加来源</h2>
        <div className="segmented segmented-sm" role="tablist" aria-label="导入方式">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "links"}
            className={`seg-btn${mode === "links" ? " is-active" : ""}`}
            onClick={() => setMode("links")}
          >
            订阅链接 / Sub-Store API
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "text"}
            className={`seg-btn${mode === "text" ? " is-active" : ""}`}
            onClick={() => setMode("text")}
          >
            节点文本
          </button>
        </div>
      </div>

      {mode === "links" ? (
        <form className="stack" onSubmit={submitLinks}>
          <label className="field">
            <span className="field-label">订阅链接或 Sub-Store API（每行一个，数量不限）</span>
            <textarea
              className="textarea mono"
              rows={5}
              required
              placeholder={"https://example.com/sub?token=…\nhttps://substore.example.com/api/subs"}
              value={urls}
              onChange={(e) => setUrls(e.target.value)}
            />
            <span className="hint">
              保存后不会立即拉取；准备好后点击顶部“同步来源”。带流量信息的订阅会自动识别为机场。
            </span>
          </label>
          <div className="row-end-bar">
            <label className="field field-inline-sm">
              <span className="field-label">名称前缀</span>
              <input
                className="input"
                maxLength={60}
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
              />
            </label>
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {progressText || (submitting ? "保存中…" : "保存链接")}
            </button>
          </div>
        </form>
      ) : (
        <form className="stack" onSubmit={submitRawText}>
          <div className="form-grid-2">
            <label className="field">
              <span className="field-label">名称</span>
              <input
                className="input"
                required
                maxLength={80}
                placeholder="例如：我的自建节点"
                value={textName}
                onChange={(e) => setTextName(e.target.value)}
              />
            </label>
            <label className="field">
              <span className="field-label">类别</span>
              <select
                className="select"
                value={textKind}
                onChange={(e) => setTextKind(e.target.value)}
              >
                <option value="SELF_HOSTED">自建</option>
                <option value="AUTO">自动识别</option>
                <option value="AIRPORT">机场</option>
              </select>
            </label>
          </div>
          <label className="field">
            <span className="field-label">节点内容</span>
            <textarea
              className="textarea mono"
              rows={6}
              required
              placeholder="vless://…、trojan://… 每行一个，或粘贴 Clash / sing-box 配置"
              value={textPayload}
              onChange={(e) => setTextPayload(e.target.value)}
            />
            <span className="hint">适合自建节点。内容以明文保存在你的数据库中。</span>
          </label>
          <div className="row-end">
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? "保存中…" : "保存节点"}
            </button>
          </div>
        </form>
      )}

      {bulkReport && (
        <div className="stack-sm" aria-live="polite">
          {bulkReport.stoppedError && (
            <div className="callout callout-bad">
              保存到一半出错（{bulkReport.stoppedError}），之前的部分已保存，可重新提交剩余行。
            </div>
          )}
          <div className="callout callout-info row-between">
            <span>
              新增 <strong>{bulkReport.result.created}</strong> 个，已存在{" "}
              {bulkReport.result.duplicates} 个，无效 {bulkReport.result.invalid} 个。
            </span>
            {bulkReport.result.created > 0 && (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() =>
                  void syncSources(
                    bulkReport.result.items
                      .filter((i) => i.status === "CREATED" && i.id)
                      .map((i) => i.id as string),
                  )
                }
              >
                立即同步这些来源
              </button>
            )}
          </div>
          {bulkReport.result.invalid > 0 && (
            <ul className="reason-list bad-text">
              {bulkReport.result.items
                .filter((i) => i.status === "INVALID")
                .map((i) => (
                  <li key={i.line}>
                    第 {i.line} 行：{errorText(i.error_code)}
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}

      {textSavedId && (
        <div className="callout callout-info row-between" aria-live="polite">
          <span>节点文本已保存。</span>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void syncSources([textSavedId])}
          >
            立即同步并解析
          </button>
        </div>
      )}
    </section>
  );
}

export function SourcesListTab({
  params,
  go,
}: {
  params: URLSearchParams;
  go: (name: PageName, params?: URLSearchParams | Record<string, string>) => void;
}) {
  const { toast, fail, confirm, syncSources, refreshPipeline } = useApp();
  const { data: all, error, loading, refetch } = useApiQuery<SourceItem[]>(
    "/sources?view=dashboard",
  );

  const view = params.get("view") || "";
  const status = params.get("status") || "";
  const history = params.get("history") || "";
  const sort = Object.hasOwn(COMPARATORS, params.get("sort") || "")
    ? (params.get("sort") as string)
    : "name";
  const q = (params.get("q") || "").toLowerCase();
  const rootId = params.get("root") || "";

  const [searchInput, setSearchInput] = useState(params.get("q") || "");
  const searchTimerRef = useRef<number | undefined>(undefined);
  const [importOpen, setImportOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [linkSource, setLinkSource] = useState<SourceItem | null>(null);
  const [editTarget, setEditTarget] = useState<SourceItem | null>(null);

  useEffect(() => {
    setSearchInput(params.get("q") || "");
  }, [params]);

  useEffect(() => {
    if (all && all.length === 0) setImportOpen(true);
  }, [all]);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== "page") next.delete("page");
    go("sources", next);
  };

  const reload = () => {
    refetch();
    void refreshPipeline();
  };

  const derived = useMemo(() => {
    const items = all || [];
    const names = new Map(items.map((s) => [s.id, s.name]));
    const parentById = new Map(items.map((s) => [s.id, s.parent_source_id]));

    const inRoot = (s: SourceItem) => {
      const seen = new Set<string>();
      for (let cur: string | null | undefined = s.id; cur && !seen.has(cur); cur = parentById.get(cur)) {
        if (cur === rootId) return true;
        seen.add(cur);
      }
      return false;
    };

    const filtered = items
      .filter((s) => {
        if (view === "CHILD" ? !s.parent_source_id : view && s.effective_kind !== view) return false;
        if (rootId && !inRoot(s)) return false;
        if (status && s.last_sync_status !== status) return false;
        if (params.has("active") && !s.enabled) return false;
        if (history === "worked" && !s.last_success_at) return false;
        if (history === "never" && s.last_success_at) return false;
        return !q || s.name.toLowerCase().includes(q) || (s.url_host || "").toLowerCase().includes(q);
      })
      .sort(COMPARATORS[sort]);

    const nested = !q && !status && !history && (view === "" || view === "SUBSTORE");
    const inFiltered = new Set(filtered.map((s) => s.id));
    const childrenMap = new Map<string, SourceItem[]>();

    if (nested) {
      for (const s of filtered) {
        if (s.parent_source_id && names.has(s.parent_source_id)) {
          const list = childrenMap.get(s.parent_source_id) || [];
          list.push(s);
          childrenMap.set(s.parent_source_id, list);
        }
      }
      if (view === "SUBSTORE") {
        for (const s of items) {
          if (s.parent_source_id && inFiltered.has(s.parent_source_id) && !inFiltered.has(s.id)) {
            const list = childrenMap.get(s.parent_source_id) || [];
            list.push(s);
            childrenMap.set(s.parent_source_id, list);
          }
        }
      }
      for (const list of childrenMap.values()) list.sort(COMPARATORS[sort]);
    }

    const top = nested
      ? filtered.filter((s) => !(s.parent_source_id && names.has(s.parent_source_id)))
      : filtered;
    const selectable = nested ? [...top, ...[...childrenMap.values()].flat()] : filtered;
    const failedCount = items.filter((s) => s.last_sync_status === "FAILED").length;

    return { names, filtered, nested, childrenMap, top, selectable, failedCount };
  }, [all, view, status, history, sort, q, rootId, params]);

  const pages = Math.max(1, Math.ceil(derived.top.length / PAGE_SIZE));
  const page = Math.min(Math.max(0, Number(params.get("page") || 0) || 0), pages - 1);

  const visibleRows = useMemo(() => {
    const rows: SourceItem[] = [];
    for (const s of derived.top.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) {
      rows.push(s);
      if (expanded.has(s.id)) rows.push(...(derived.childrenMap.get(s.id) || []));
    }
    return rows;
  }, [derived.top, derived.childrenMap, page, expanded]);

  const allSelected =
    derived.selectable.length > 0 &&
    derived.selectable.every((s) => selectedIds.has(s.id));

  const toggleSelectAll = (checked: boolean) => {
    if (checked) setSelectedIds(new Set(derived.selectable.map((s) => s.id)));
    else setSelectedIds(new Set());
  };

  const toggleOne = (id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const runBatch = async (
    action: "enable" | "disable" | "delete",
    doneText: (n: number) => string,
  ) => {
    if (!all || selectedIds.size === 0 || bulkBusy) return;
    let ids = [...selectedIds];
    let includeChildren = false;

    if (action === "delete") {
      const hasParents = all.some((s) => ids.includes(s.id) && s.effective_kind === "SUBSTORE");
      const res = await confirm({
        title: "删除来源",
        message: `删除 ${ids.length} 个来源？自建节点会保留并继续检测；机场节点随订阅停止检测。`,
        action: "删除",
        danger: true,
        checkboxLabel: hasParents ? "同时删除这些 Sub-Store 生成的子来源" : undefined,
      });
      if (!res.confirmed) return;
      includeChildren = res.checked;
      if (!includeChildren) {
        const chosen = new Set(ids);
        const parentOf = new Map(all.map((s) => [s.id, s.parent_source_id]));
        ids = ids.filter((id) => {
          const pid = parentOf.get(id);
          return !pid || !chosen.has(pid);
        });
      }
      if (!ids.length) return;
    }

    setBulkBusy(true);
    try {
      const res = await api<{ changed: number }>("/sources/batch", {
        method: "POST",
        body: { ids, action, include_children: includeChildren },
      });
      toast(doneText(res.changed), "ok");
      setSelectedIds(new Set());
      reload();
    } catch (err) {
      fail(err);
    } finally {
      setBulkBusy(false);
    }
  };

  const syncSelected = async () => {
    if (selectedIds.size === 0 || bulkBusy) return;
    setBulkBusy(true);
    try {
      const ok = await syncSources([...selectedIds]);
      if (ok) {
        setSelectedIds(new Set());
        reload();
      }
    } finally {
      setBulkBusy(false);
    }
  };

  if (loading && !all) {
    return (
      <section className="card">
        <SkeletonBlock lines={7} />
      </section>
    );
  }

  if (error && !all) {
    return (
      <section className="card">
        <ErrorState message={errorText(error.code)} onRetry={refetch} />
      </section>
    );
  }

  return (
    <div className="stack">
      <div className="section-bar">
        <p className="muted small">
          共 {formatNumber(all?.length || 0)} 个来源
          {derived.failedCount > 0
            ? ` · ${formatNumber(derived.failedCount)} 个最近同步失败`
            : " · 全部同步正常"}
        </p>
        <button
          type="button"
          className={importOpen ? "btn" : "btn btn-primary"}
          aria-expanded={importOpen}
          onClick={() => setImportOpen((v) => !v)}
        >
          {importOpen ? <X size={14} /> : <Plus size={14} />}
          <span>{importOpen ? "收起导入" : "添加来源"}</span>
        </button>
      </div>

      {rootId && (
        <div className="callout callout-info row-between">
          <span>
            当前限定上游范围：
            <a href={sourceHref(rootId)}>{derived.names.get(rootId) || "查看根来源"}</a>
          </span>
          <a href={pageHref("sources", { status, history })} className="btn btn-sm">
            清除范围
          </a>
        </div>
      )}

      {importOpen && <ImportSection onImported={reload} />}

      {/* Filter Toolbar */}
      <div className="toolbar">
        <div className="search-wrap">
          <Search size={15} className="search-icon" aria-hidden="true" />
          <input
            type="search"
            className="input search-input"
            placeholder="搜索名称或域名…"
            aria-label="搜索来源"
            value={searchInput}
            onChange={(e) => {
              const v = e.target.value;
              setSearchInput(v);
              window.clearTimeout(searchTimerRef.current);
              searchTimerRef.current = window.setTimeout(() => setParam("q", v.trim()), 300);
            }}
          />
        </div>

        <div className="segmented" role="group" aria-label="来源类别">
          {CATEGORY_TABS.map(([key, text]) => (
            <button
              key={key || "all"}
              type="button"
              className={`seg-btn${view === key ? " is-active" : ""}`}
              aria-pressed={view === key}
              onClick={() => setParam("view", key)}
            >
              {text}
            </button>
          ))}
        </div>

        <select
          className="select"
          aria-label="同步状态"
          value={status}
          onChange={(e) => setParam("status", e.target.value)}
        >
          <option value="">全部状态</option>
          <option value="SUCCESS">成功</option>
          <option value="PARTIAL">部分成功</option>
          <option value="FAILED">失败</option>
          <option value="NEVER">未同步</option>
        </select>

        <select
          className="select"
          aria-label="成功历史"
          value={history}
          onChange={(e) => setParam("history", e.target.value)}
        >
          <option value="">全部成功历史</option>
          <option value="worked">曾同步成功</option>
          <option value="never">从未同步成功</option>
        </select>

        <select
          className="select"
          aria-label="来源排序"
          value={sort}
          onChange={(e) => setParam("sort", e.target.value === "name" ? "" : e.target.value)}
        >
          {SORT_OPTIONS.map(([k, text]) => (
            <option key={k} value={k}>
              {text}
            </option>
          ))}
        </select>
      </div>

      {/* Inline Bulk Action Strip */}
      <div className={`bulk-strip${selectedIds.size > 0 ? " is-active" : ""}`}>
        <label
          className="check-label"
          title="选择当前筛选条件下的全部来源（含其他页和折叠的子来源）"
        >
          <input
            type="checkbox"
            checked={allSelected}
            onChange={(e) => toggleSelectAll(e.target.checked)}
          />
          <span>全选</span>
        </label>
        <span className="bulk-strip-count">
          {selectedIds.size > 0
            ? `已选 ${formatNumber(selectedIds.size)} 个`
            : `共 ${formatNumber(derived.selectable.length)} 个来源`}
        </span>
        <div className="bulk-strip-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={selectedIds.size === 0 || bulkBusy}
            onClick={() => void syncSelected()}
          >
            同步所选
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={selectedIds.size === 0 || bulkBusy}
            onClick={() => void runBatch("enable", (n) => `已启用 ${n} 个。`)}
          >
            启用
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={selectedIds.size === 0 || bulkBusy}
            onClick={() => void runBatch("disable", (n) => `已暂停 ${n} 个。`)}
          >
            暂停
          </button>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            disabled={selectedIds.size === 0 || bulkBusy}
            onClick={() => void runBatch("delete", (n) => `已删除 ${n} 个。`)}
          >
            <Trash2 size={13} />
            删除
          </button>
        </div>
      </div>

      {/* Table */}
      {visibleRows.length === 0 ? (
        <div className="card">
          <EmptyState
            title={(all?.length || 0) > 0 ? "没有符合条件的来源" : "还没有来源"}
            hint={
              (all?.length || 0) > 0
                ? "尝试调整搜索词或筛选条件。"
                : "点击上方“添加来源”，粘贴订阅链接、Sub-Store API 或节点文本。"
            }
          />
        </div>
      ) : (
        <div className="table-card">
          <div className="table-wrap table-wrap-flush">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="col-pick" scope="col">
                    <span className="sr-only">选择</span>
                  </th>
                  <th scope="col">来源</th>
                  <th scope="col">类别</th>
                  <th scope="col">同步</th>
                  <th scope="col" className="num">
                    节点 / 子来源
                  </th>
                  <th scope="col">最近成功</th>
                  <th scope="col" className="num">
                    操作
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((s) => {
                  const isChild = derived.nested && Boolean(s.parent_source_id);
                  const kids = derived.childrenMap.get(s.id) || [];
                  const failedKids = kids.filter((k) => k.last_sync_status === "FAILED").length;
                  const isExpanded = expanded.has(s.id);
                  const pendingKind =
                    s.kind === "AUTO" &&
                    s.detected_kind === "UNKNOWN" &&
                    s.effective_kind !== "SUBSTORE";

                  return (
                    <tr
                      key={s.id}
                      className={`${!s.enabled ? "is-dim " : ""}${isChild ? "is-child-row" : ""}`.trim() || undefined}
                    >
                      <td className="col-pick">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(s.id)}
                          aria-label={`选择 ${s.name}`}
                          onChange={(e) => toggleOne(s.id, e.target.checked)}
                        />
                      </td>
                      <td data-label="来源">
                        <div className={`cell-stack${isChild ? " is-indented" : ""}`}>
                          <div className="row-inline">
                            <a
                              className="row-title"
                              href={sourceHref(
                                s.id,
                                s.effective_kind === "SUBSTORE" ? "children" : null,
                              )}
                            >
                              {s.name}
                            </a>
                            {!s.enabled && <span className="tag">已暂停</span>}
                          </div>
                          <span className="muted tiny">
                            {[SOURCE_TYPE_LABEL[s.type], s.url_host].filter(Boolean).join(" · ")}
                          </span>
                          {s.parent_source_id && (
                            <a
                              className="tiny muted-link"
                              href={sourceHref(s.parent_source_id, "children")}
                            >
                              上级来源 {derived.names.get(s.parent_source_id) || "查看记录"}
                            </a>
                          )}
                        </div>
                      </td>
                      <td data-label="类别">
                        {pendingKind ? (
                          <span className="tag" title="同步后根据响应自动识别为自建或机场">
                            待识别
                          </span>
                        ) : (
                          <span
                            className={`tag tag-${s.effective_kind === "AIRPORT" ? "air" : s.effective_kind === "SUBSTORE" ? "store" : "own"}`}
                          >
                            {KIND_LABEL[s.effective_kind] || s.effective_kind}
                          </span>
                        )}
                      </td>
                      <td data-label="同步">
                        <div className="cell-stack">
                          <StatusBadge status={s.last_sync_status} />
                          {s.last_error_code && (
                            <span className="tiny bad-text">{errorText(s.last_error_code)}</span>
                          )}
                          {s.sync_requested_at && <span className="tiny muted">待同步</span>}
                          {s.last_sync_status === "FAILED" && s.next_attempt && (
                            <span className="tiny muted">预计重试 {formatDate(s.next_attempt)}</span>
                          )}
                        </div>
                      </td>
                      <td className="num" data-label="节点 / 子来源">
                        {s.effective_kind === "SUBSTORE" ? (
                          derived.nested ? (
                            kids.length === 0 ? (
                              <span className="muted tiny">同步后生成子来源</span>
                            ) : (
                              <button
                                type="button"
                                className="inline-expand-btn"
                                aria-expanded={isExpanded}
                                onClick={() =>
                                  setExpanded((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(s.id)) next.delete(s.id);
                                    else next.add(s.id);
                                    return next;
                                  })
                                }
                              >
                                {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                <span>{kids.length} 个子来源</span>
                                {failedKids > 0 && (
                                  <span className="bad-text">· {failedKids} 失败</span>
                                )}
                              </button>
                            )
                          ) : (
                            <a href={sourceHref(s.id, "children")}>查看子来源</a>
                          )
                        ) : (
                          <div className="cell-stack align-end">
                            <a href={sourceHref(s.id, "current")} className="strong">
                              {formatNumber(s.up_count)} 可用
                            </a>
                            {(s.stale_up_count || 0) > 0 && (
                              <a href={sourceHref(s.id, "stale")} className="tiny muted-link">
                                {formatNumber(s.stale_up_count)} 已过期
                              </a>
                            )}
                            <a href={sourceHref(s.id, "history")} className="tiny muted-link">
                              {formatNumber(s.node_count)} 全部关联
                            </a>
                          </div>
                        )}
                      </td>
                      <td className="muted" data-label="最近成功">
                        {formatAgo(s.last_success_at)}
                      </td>
                      <td className="num" data-label="操作">
                        <div className="row-actions">
                          {s.type === "SUBSCRIPTION_URL" && (
                            <button
                              type="button"
                              className="btn btn-quiet btn-sm"
                              onClick={() =>
                                setLinkSource({
                                  ...s,
                                  parent_name: s.parent_source_id
                                    ? derived.names.get(s.parent_source_id) || null
                                    : null,
                                })
                              }
                            >
                              <Link2 size={13} />
                              链接
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn-quiet btn-sm"
                            onClick={() => setEditTarget(s)}
                          >
                            <Pencil size={13} />
                            编辑
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <footer className="table-footer">
              <span className="table-range">
                第 {page + 1} / {pages} 页，共 {formatNumber(derived.top.length)} 条主记录
              </span>
              <Pagination
                page={page}
                pages={pages}
                onPage={(t) => setParam("page", t ? String(t) : "")}
              />
            </footer>
          )}
        </div>
      )}

      {linkSource && (
        <SourceLinkModal source={linkSource} onClose={() => setLinkSource(null)} />
      )}
      {editTarget && (
        <EditSourceModal
          source={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={reload}
        />
      )}
    </div>
  );
}
