import React, { useEffect, useMemo, useRef, useState } from "react";
import { Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { ApiError, api, useApiQuery } from "../../api/client";
import {
  EmptyState,
  ErrorState,
  Modal,
  Pagination,
  SkeletonBlock,
  StatusBadge,
} from "../../components/ui";
import { errorText } from "../../lib/errors";
import { KIND_LABEL, formatAgo, formatNumber, zhCollator, type Tone } from "../../lib/format";
import { sourceHref, type PageName } from "../../lib/router";
import { useApp } from "../../state/AppContext";
import type { SubStoreDetail, SubStoreItem } from "../../types/api";

const CHILD_PAGE = 50;

const STATES: ReadonlyArray<[string, string]> = [
  ["", "全部状态"],
  ["ok", "有效"],
  ["failed", "失效"],
  ["never", "未同步"],
  ["child_failed", "有子来源失败"],
];

const SORTS: ReadonlyArray<[string, string]> = [
  ["name", "按名称"],
  ["problems", "问题优先"],
  ["children", "子来源多→少"],
  ["nodes", "节点多→少"],
  ["recent", "最近有效"],
];

const RANK: Record<string, number> = { failed: 0, never: 1, ok: 2 };

function stateOf(s: SubStoreItem): "never" | "failed" | "ok" {
  if (s.last_sync_status === "NEVER" || !s.last_checked_at) return "never";
  if (s.last_sync_status === "FAILED") return "failed";
  return "ok";
}

function validityMeta(s: SubStoreItem): [string, Tone] {
  const st = stateOf(s);
  if (st === "never") return ["未同步", "mute"];
  if (st === "failed") return ["失效", "bad"];
  return ["有效", "ok"];
}

const COMPARATORS: Record<string, (a: SubStoreItem, b: SubStoreItem) => number> = {
  name: (a, b) => zhCollator.compare(a.name, b.name),
  problems: (a, b) =>
    RANK[stateOf(a)] - RANK[stateOf(b)] ||
    b.failed_children - a.failed_children ||
    zhCollator.compare(a.name, b.name),
  children: (a, b) => b.children - a.children || zhCollator.compare(a.name, b.name),
  nodes: (a, b) => b.node_count - a.node_count || zhCollator.compare(a.name, b.name),
  recent: (a, b) =>
    String(b.last_success_at || "").localeCompare(String(a.last_success_at || "")) ||
    zhCollator.compare(a.name, b.name),
};

function ChildrenModal({ store, onClose }: { store: SubStoreItem; onClose: () => void }) {
  const [detail, setDetail] = useState<SubStoreDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [onlyFailed, setOnlyFailed] = useState(false);
  const [page, setPage] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<SubStoreDetail>(`/substores/${encodeURIComponent(store.id)}`).then(
      (res) => {
        if (!cancelled) {
          setDetail(res);
          setLoading(false);
        }
      },
      (err) => {
        if (!cancelled) {
          setError(errorText(err instanceof ApiError ? err.code : "OPERATION_FAILED"));
          setLoading(false);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [store.id]);

  const missing = useMemo(
    () => new Set(store.last_parse_summary?.children?.missing_from_index || []),
    [store],
  );

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    return (detail?.children || []).filter(
      (c) =>
        (!onlyFailed || c.last_sync_status === "FAILED") &&
        (!query ||
          `${c.origin_label || ""} ${c.name} ${c.url_host || ""}`.toLowerCase().includes(query)),
    );
  }, [detail, q, onlyFailed]);

  const pages = Math.max(1, Math.ceil(filtered.length / CHILD_PAGE));
  const safePage = Math.min(page, pages - 1);
  const slice = filtered.slice(safePage * CHILD_PAGE, (safePage + 1) * CHILD_PAGE);

  return (
    <Modal
      title={`「${store.name}」的子来源（${detail ? detail.children.length : store.children}）`}
      wide
      onClose={onClose}
    >
      <div className="stack">
        <p className="hint">
          每个子来源独立拉取：Sub-Store 失效后，已生成的子来源和节点照常保留与同步。
        </p>

        <div className="toolbar">
          <div className="search-wrap">
            <Search size={15} className="search-icon" aria-hidden="true" />
            <input
              type="search"
              className="input search-input"
              placeholder="搜索子来源…"
              aria-label="搜索子来源"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(0);
              }}
            />
          </div>
          <label className="check-label">
            <input
              type="checkbox"
              checked={onlyFailed}
              onChange={(e) => {
                setOnlyFailed(e.target.checked);
                setPage(0);
              }}
            />
            <span>只看失败</span>
          </label>
        </div>

        {loading ? (
          <SkeletonBlock lines={5} />
        ) : error ? (
          <p className="bad-text">{error}</p>
        ) : slice.length === 0 ? (
          <EmptyState
            title={(detail?.children.length || 0) > 0 ? "没有符合条件的子来源" : "还没有子来源"}
            hint={
              (detail?.children.length || 0) > 0
                ? "请调整搜索词或取消勾选“只看失败”。"
                : "同步一次 Sub-Store 后自动生成。"
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">子来源</th>
                  <th scope="col">类别</th>
                  <th scope="col">同步</th>
                  <th scope="col" className="num">
                    全部关联
                  </th>
                  <th scope="col">Sub-Store 中</th>
                  <th scope="col">最近成功</th>
                </tr>
              </thead>
              <tbody>
                {slice.map((c) => {
                  const kindKey =
                    c.kind !== "AUTO"
                      ? c.kind
                      : c.detected_kind === "AIRPORT"
                        ? "AIRPORT"
                        : "SELF_HOSTED";
                  return (
                    <tr key={c.id}>
                      <td data-label="子来源">
                        <div className="cell-stack">
                          <a href={sourceHref(c.id)} className="row-title" onClick={onClose}>
                            {c.origin_label || c.name}
                          </a>
                          <span className="muted tiny">
                            {c.type === "RAW_TEXT" ? "本地节点" : c.url_host || "远程订阅"}
                          </span>
                        </div>
                      </td>
                      <td data-label="类别">{KIND_LABEL[kindKey] || kindKey}</td>
                      <td data-label="同步">
                        <div className="cell-stack">
                          <StatusBadge status={c.last_sync_status} />
                          {c.last_error_code && (
                            <span className="tiny bad-text">{errorText(c.last_error_code)}</span>
                          )}
                        </div>
                      </td>
                      <td className="num" data-label="全部关联">
                        <a href={sourceHref(c.id, "history")} onClick={onClose}>
                          {formatNumber(c.node_count)}
                        </a>
                      </td>
                      <td data-label="Sub-Store 中">
                        {missing.has(c.id) ? (
                          <span className="warn-text small">已移除，子来源保留</span>
                        ) : (
                          "存在"
                        )}
                      </td>
                      <td className="muted" data-label="最近成功">
                        {formatAgo(c.last_success_at)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <Pagination page={safePage} pages={pages} onPage={setPage} />
      </div>
    </Modal>
  );
}

export function SubStoreTab({
  params,
  go,
}: {
  params: URLSearchParams;
  go: (name: PageName, params?: URLSearchParams | Record<string, string>) => void;
}) {
  const { toast, fail, confirm, syncSources, refreshPipeline } = useApp();
  const { data: all, error, loading, refetch } = useApiQuery<SubStoreItem[]>("/substores");

  const q = (params.get("q") || "").toLowerCase();
  const state = params.get("state") || "";
  const sort = Object.hasOwn(COMPARATORS, params.get("sort") || "")
    ? (params.get("sort") as string)
    : "name";

  const [searchInput, setSearchInput] = useState(params.get("q") || "");
  const searchTimerRef = useRef<number | undefined>(undefined);
  const [name, setName] = useState("Sub-Store");
  const [payload, setPayload] = useState("");
  const [adding, setAdding] = useState(false);
  const [duplicate, setDuplicate] = useState<{ id: string; name: string } | null>(null);
  const [inspectStore, setInspectStore] = useState<SubStoreItem | null>(null);

  useEffect(() => {
    setSearchInput(params.get("q") || "");
  }, [params]);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    next.set("tab", "substore");
    if (value) next.set(key, value);
    else next.delete(key);
    go("sources", next);
  };

  const reload = () => {
    refetch();
    void refreshPipeline();
  };

  const stores = useMemo(() => {
    return (all || [])
      .filter(
        (s) =>
          (!q || `${s.name} ${s.url_host || ""}`.toLowerCase().includes(q)) &&
          (!state || (state === "child_failed" ? s.failed_children > 0 : stateOf(s) === state)),
      )
      .sort(COMPARATORS[sort]);
  }, [all, q, state, sort]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (adding) return;
    setAdding(true);
    setDuplicate(null);
    try {
      const saved = await api<{ id: string; name: string; duplicate?: boolean }>("/sources", {
        method: "POST",
        body: { name, payload, type: "SUBSCRIPTION_URL" },
      });
      if (saved.duplicate) {
        setDuplicate({ id: saved.id, name: saved.name });
        return;
      }
      setPayload("");
      toast("已添加。点击顶部“同步来源”读取订阅列表。", "ok");
      reload();
    } catch (err) {
      fail(err);
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (store: SubStoreItem) => {
    const res = await confirm({
      title: "删除 Sub-Store",
      message: `删除「${store.name}」？默认保留子来源，它们会继续独立同步。`,
      action: "删除",
      danger: true,
      checkboxLabel: "同时删除它生成的子来源（自建节点仍保留）",
    });
    if (!res.confirmed) return;
    try {
      await api("/sources/batch", {
        method: "POST",
        body: { ids: [store.id], action: "delete", include_children: res.checked },
      });
      toast("已删除 Sub-Store。", "ok");
      reload();
    } catch (err) {
      fail(err);
    }
  };

  if (loading && !all) {
    return (
      <section className="card">
        <SkeletonBlock lines={5} />
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

  const list = all || [];

  return (
    <div className="stack">
      <p className="hint">
        Nodema 只读取 Sub-Store 的订阅列表（/api/subs），把其中的远程订阅和本地节点拆成独立的子来源，不执行 Sub-Store 脚本。
      </p>

      {/* Quick Add Card */}
      <section className="card">
        <form className="substore-add-form" onSubmit={handleAdd}>
          <label className="field">
            <span className="field-label">名称</span>
            <input
              className="input"
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="field substore-url-field">
            <span className="field-label">API 地址</span>
            <input
              className="input mono"
              type="url"
              required
              placeholder="https://…/api/subs"
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={adding}>
            <Plus size={14} />
            {adding ? "添加中…" : "添加"}
          </button>
        </form>
        {duplicate && (
          <p className="callout callout-info" role="status">
            该链接已登记为{" "}
            <a href={sourceHref(duplicate.id, "children")}>{duplicate.name}</a>
          </p>
        )}
      </section>

      {/* Stats */}
      <dl className="stat-strip">
        <div>
          <dt>Sub-Store</dt>
          <dd>{formatNumber(list.length)}</dd>
        </div>
        <div>
          <dt>失效</dt>
          <dd>{formatNumber(list.filter((s) => stateOf(s) === "failed").length)}</dd>
        </div>
        <div>
          <dt>子来源</dt>
          <dd>{formatNumber(list.reduce((sum, s) => sum + s.children, 0))}</dd>
        </div>
        <div>
          <dt>子来源失败</dt>
          <dd>{formatNumber(list.reduce((sum, s) => sum + s.failed_children, 0))}</dd>
        </div>
      </dl>

      {/* Toolbar */}
      <div className="toolbar">
        <div className="search-wrap">
          <Search size={15} className="search-icon" aria-hidden="true" />
          <input
            type="search"
            className="input search-input"
            placeholder="搜索名称或域名…"
            aria-label="搜索 Sub-Store"
            value={searchInput}
            onChange={(e) => {
              const v = e.target.value;
              setSearchInput(v);
              window.clearTimeout(searchTimerRef.current);
              searchTimerRef.current = window.setTimeout(() => setParam("q", v.trim()), 300);
            }}
          />
        </div>
        <select
          className="select"
          aria-label="Sub-Store 状态"
          value={state}
          onChange={(e) => setParam("state", e.target.value)}
        >
          {STATES.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <select
          className="select"
          aria-label="Sub-Store 排序"
          value={sort}
          onChange={(e) => setParam("sort", e.target.value === "name" ? "" : e.target.value)}
        >
          {SORTS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </div>

      {/* Table */}
      {stores.length === 0 ? (
        <div className="card">
          {list.length > 0 ? (
            <EmptyState title="没有符合条件的 Sub-Store" hint="请调整搜索或筛选。" />
          ) : (
            <EmptyState
              title="还没有 Sub-Store"
              hint="在上方填入 Sub-Store 后端的 /api/subs 地址。"
            />
          )}
        </div>
      ) : (
        <div className="table-card">
          <div className="table-wrap table-wrap-flush">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Sub-Store</th>
                  <th scope="col">API 状态</th>
                  <th scope="col">最近有效</th>
                  <th scope="col">子来源</th>
                  <th scope="col" className="num">
                    节点
                  </th>
                  <th scope="col" className="num">
                    操作
                  </th>
                </tr>
              </thead>
              <tbody>
                {stores.map((s) => {
                  const [label, tone] = validityMeta(s);
                  return (
                    <tr key={s.id}>
                      <td data-label="Sub-Store">
                        <div className="cell-stack">
                          <a href={sourceHref(s.id, "children")} className="row-title">
                            {s.name}
                          </a>
                          <span className="muted tiny">{s.url_host || "—"}</span>
                        </div>
                      </td>
                      <td data-label="API 状态">
                        <div className="cell-stack">
                          <StatusBadge label={label} tone={tone} />
                          {s.last_error_code && (
                            <span className="tiny bad-text">{errorText(s.last_error_code)}</span>
                          )}
                        </div>
                      </td>
                      <td className="muted" data-label="最近有效">
                        {formatAgo(s.last_success_at)}
                      </td>
                      <td data-label="子来源">
                        <button
                          type="button"
                          className="inline-link-btn"
                          onClick={() => setInspectStore(s)}
                        >
                          <span>{s.healthy_children} 正常</span>
                          {s.failed_children > 0 && (
                            <span className="bad-text"> · {s.failed_children} 失败</span>
                          )}
                          <span className="muted"> / {s.children}</span>
                        </button>
                      </td>
                      <td className="num" data-label="节点">
                        {formatNumber(s.node_count)}
                      </td>
                      <td className="num" data-label="操作">
                        <div className="row-actions">
                          <button
                            type="button"
                            className="btn btn-quiet btn-sm"
                            onClick={() => void syncSources([s.id])}
                          >
                            <RefreshCw size={13} />
                            同步
                          </button>
                          <button
                            type="button"
                            className="btn btn-quiet btn-sm bad-text"
                            onClick={() => void handleRemove(s)}
                          >
                            <Trash2 size={13} />
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {inspectStore && (
        <ChildrenModal store={inspectStore} onClose={() => setInspectStore(null)} />
      )}
    </div>
  );
}
