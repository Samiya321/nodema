import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  RefreshCw,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { ApiError, api, getReadRevision, invalidateReads, readAPI, subscribeReadRevision } from "../api/client";
import {
  EmptyState,
  ErrorState,
  FlexSegment,
  Pagination,
  SkeletonBlock,
} from "../components/ui";
import { errorText } from "../lib/errors";
import {
  ALL,
  API_NODE_KEYS,
  AVAILABLE,
  NODE_COLUMNS,
  NODE_SQL_SORT,
  PERCENT_KEYS,
  displayFilterValue,
  filterLabel,
  legacyBucketsFromParams,
  sortNodeItems,
  type NodeSortKey,
  type SortDir,
} from "../lib/filters";
import { formatNumber } from "../lib/format";
import { BUCKETS, BUCKET_HINT, BUCKET_TEXT, VANTAGES, bucketOfNode } from "../lib/grades";
import { pageHref, type PageName } from "../lib/router";
import { useApp } from "../state/AppContext";
import {
  consumeListProgress,
  fetchAllMatchingNodeIds,
  fetchCompactCollection,
  fetchDashboardPage,
  getSelectionForKey,
  invalidateNodeCaches,
  saveListProgress,
  setSelectionForKey,
} from "../state/nodeListStore";
import type {
  NodeDashboardFacets,
  NodeListItem,
  ProviderItem,
  QualityBucket,
  Vantage,
} from "../types/api";
import { NodeAsnView } from "./nodes/NodeAsnView";
import { NodeCountriesView } from "./nodes/NodeCountriesView";
import { NodeFilterDrawer } from "./nodes/NodeFilterDrawer";
import { NodeTable } from "./nodes/NodeTable";

const PAGE_SIZES = [50, 100, 200] as const;
const VIEWS: ReadonlyArray<["" | "country" | "asn", string]> = [
  ["", "列表"],
  ["country", "按国家"],
  ["asn", "ASN 排行"],
];

const QUICK_TOGGLES: ReadonlyArray<{
  key: "udp" | "home";
  label: string;
  hint: string;
  test: (n: NodeListItem) => boolean;
}> = [
  {
    key: "udp",
    label: "UDP 有回包",
    hint: "经节点向公共 STUN/DNS 发送 UDP 并收到回包",
    test: (n) => n.udp === "SUCCESS",
  },
  {
    key: "home",
    label: "家宽 IP",
    hint: "落地 IP 被 ip-api 标为家宽（不是机房）",
    test: (n) => n.exit_ip_type === "RESIDENTIAL",
  },
];

function stripStatusForApi(filters: Record<string, string>): Record<string, string> {
  const { status = AVAILABLE, ...rest } = filters;
  return status === ALL ? rest : { ...rest, status };
}

interface LoadedNodesState {
  items: NodeListItem[];
  total: number;
  page: number;
  vantage: Vantage;
  facets?: NodeDashboardFacets;
  at: number;
  mode: "" | "country" | "asn";
}

export function NodesPage({
  params,
  href,
  go,
}: {
  params: URLSearchParams;
  href: string;
  go: (name: PageName, params?: URLSearchParams | Record<string, string>) => void;
}) {
  const { toast, fail, testNodes, openShareNode } = useApp();

  // Parse URL state cleanly
  const rawBy = params.get("by") || "";
  const view: "" | "country" | "asn" =
    rawBy === "country" || rawBy === "asn" ? rawBy : "";

  const chosenBuckets = useMemo(() => {
    const raw = params.get("g");
    const list = raw ? raw.split(",") : legacyBucketsFromParams(params);
    return new Set(list.filter((b): b is QualityBucket => BUCKETS.includes(b as QualityBucket)));
  }, [params]);

  const quickSet = useMemo(() => {
    const set = new Set<"udp" | "home">();
    for (const q of QUICK_TOGGLES) {
      if (params.get(q.key) === "1") set.add(q.key);
    }
    return set;
  }, [params]);

  const [reqSort, reqDir] = (params.get("sort") || "grade:asc").split(":");
  const sortKey: NodeSortKey = Object.hasOwn(NODE_SQL_SORT, reqSort)
    ? (reqSort as NodeSortKey)
    : "grade";
  const sortDir: SortDir = reqDir === "desc" ? "desc" : "asc";
  const sqlSort = NODE_SQL_SORT[sortKey].map((col) => `${col}:${sortDir}`).join(",");

  const rawSize = Number(params.get("size"));
  const size = (PAGE_SIZES as readonly number[]).includes(rawSize) ? rawSize : PAGE_SIZES[0];

  const filters = useMemo(() => {
    const out: Record<string, string> = {};
    for (const k of API_NODE_KEYS) {
      const v = params.get(k);
      if (v) out[k] = v;
    }
    return out;
  }, [params]);

  const apiFilters = useMemo(() => {
    const out: Record<string, string> = { ...filters };
    const v = params.get("vantage");
    if (v) out.vantage = v;
    for (const k of PERCENT_KEYS) {
      if (out[k]) out[k] = String(Number(out[k]) / 100);
    }
    return out;
  }, [filters, params]);

  const listQuery = useMemo(() => {
    const q = stripStatusForApi(apiFilters);
    if (quickSet.has("udp")) q.udp = "true";
    if (quickSet.has("home")) q.exit_ip_type = "RESIDENTIAL";
    if (chosenBuckets.size) q.quality_buckets = [...chosenBuckets].join(",");
    return q;
  }, [apiFilters, quickSet, chosenBuckets]);

  const requestedPage = Number(params.get("page") || 0);
  const pageIndex =
    Number.isSafeInteger(requestedPage) &&
    requestedPage >= 0 &&
    requestedPage * size <= 2147483647
      ? requestedPage
      : 0;

  // Data loading
  const [data, setData] = useState<LoadedNodesState | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(getReadRevision);
  const reqIdRef = useRef(0);

  // Search box synced with URL (debounced)
  const [searchInput, setSearchInput] = useState(filters.q || "");
  const searchTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    setSearchInput(filters.q || "");
  }, [filters.q]);

  useEffect(() => {
    return () => window.clearTimeout(searchTimerRef.current);
  }, []);

  // Providers (loaded on demand for filter drawer or provider_id chip)
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerLoading, setDrawerLoading] = useState(false);

  useEffect(() => {
    if (filters.provider_id && providers.length === 0) {
      void readAPI<ProviderItem[]>("/providers")
        .then(setProviders)
        .catch(() => {});
    }
  }, [filters.provider_id, providers.length]);

  useEffect(() => subscribeReadRevision(() => setRevision(getReadRevision())), []);

  const queryKey = JSON.stringify({
    view,
    listQuery,
    apiFilters,
    sqlSort,
    pageIndex,
    size,
    revision,
  });

  useEffect(() => {
    const reqId = ++reqIdRef.current;
    if (data) setRefreshing(true);
    else setLoading(true);
    setError(null);

    const work = view
      ? fetchCompactCollection(stripStatusForApi(apiFilters)).then((res) => ({
          items: res.items,
          total: res.items.length,
          page: 0,
          vantage: res.vantage,
          at: res.at,
          mode: view,
        }))
      : fetchDashboardPage(listQuery, sqlSort, pageIndex, size).then((res) => ({
          items: res.items,
          total: res.total,
          page: res.page,
          vantage: res.vantage,
          facets: res.facets,
          at: res.at,
          mode: "" as const,
        }));

    work.then(
      (result) => {
        if (reqId !== reqIdRef.current) return;
        setData(result);
        setLoading(false);
        setRefreshing(false);
        setError(null);
      },
      (err: unknown) => {
        if (reqId !== reqIdRef.current) return;
        if (err instanceof ApiError && (err.status === 401 || err.code === "SESSION_ENDED")) return;
        const msg = errorText(err instanceof ApiError ? err.code : "OPERATION_FAILED");
        setLoading(false);
        setRefreshing(false);
        if (data) {
          toast(msg, "bad");
        } else {
          setError(msg);
        }
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey]);

  // Restore scroll progress when coming back from Node Detail
  useEffect(() => {
    if (!data || loading) return;
    const saved = consumeListProgress(href);
    if (!saved) return;
    requestAnimationFrame(() => {
      const wrap = document.querySelector<HTMLElement>(".nodes-table-wrap");
      if (wrap) wrap.scrollLeft = saved.tableScrollLeft;
      window.scrollTo(saved.scrollX, saved.scrollY);
    });
  }, [data, loading, href]);

  const vantage: Vantage = data?.vantage || (params.get("vantage") as Vantage) || "CN";

  // Selection persisted per filter+vantage
  const selKey = JSON.stringify([listQuery, vantage]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => getSelectionForKey(selKey));
  const [widening, setWidening] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  useEffect(() => {
    setSelectedIds(getSelectionForKey(selKey));
  }, [selKey]);

  const toggleIds = useCallback(
    (ids: string[], on: boolean) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of ids) {
          if (on) next.add(id);
          else next.delete(id);
        }
        setSelectionForKey(selKey, next);
        return next;
      });
    },
    [selKey],
  );

  const clearSelection = useCallback(() => {
    const empty = new Set<string>();
    setSelectedIds(empty);
    setSelectionForKey(selKey, empty);
  }, [selKey]);

  // URL navigation helper
  const updateParams = useCallback(
    (changes: Record<string, string | null | undefined>, { keepPage = false } = {}) => {
      const next = new URLSearchParams(params);
      for (const legacy of ["view", "min_quality_grade", "quality_grade", "unreachable"]) {
        next.delete(legacy);
      }
      if (!next.has("g") && chosenBuckets.size) {
        next.set("g", [...chosenBuckets].join(","));
      }
      for (const [k, v] of Object.entries(changes)) {
        if (v === "" || v == null) next.delete(k);
        else next.set(k, v);
      }
      if (!keepPage) next.delete("page");
      go("nodes", next);
    },
    [params, chosenBuckets, go],
  );

  const resetAll = () => {
    go("nodes", new URLSearchParams({ vantage, ...(view ? { by: view } : {}) }));
  };

  const handleRefresh = () => {
    invalidateNodeCaches();
    invalidateReads();
  };

  // Derived items, counts, totals
  const loadedItems = data?.items || [];
  const facets = data?.mode === "" ? data.facets : undefined;

  const quickFiltered = useMemo(() => {
    if (!view) return null;
    return loadedItems.filter((n) =>
      QUICK_TOGGLES.every((q) => !quickSet.has(q.key) || q.test(n)),
    );
  }, [view, loadedItems, quickSet]);

  const bucketCounts = useMemo(() => {
    const map: Record<QualityBucket, number> = {
      S: 0,
      A: 0,
      B: 0,
      C: 0,
      D: 0,
      PENDING: 0,
      NONE: 0,
      OFF: 0,
    };
    if (facets?.buckets) {
      for (const b of BUCKETS) map[b] = facets.buckets[b] || 0;
    } else if (quickFiltered) {
      for (const n of quickFiltered) map[bucketOfNode(n)]++;
    }
    return map;
  }, [facets, quickFiltered]);

  const displayedNodes = useMemo(() => {
    if (!view) return loadedItems;
    const base = quickFiltered || [];
    const filtered = chosenBuckets.size
      ? base.filter((n) => chosenBuckets.has(bucketOfNode(n)))
      : base;
    return sortNodeItems(filtered, sortKey, sortDir);
  }, [view, loadedItems, quickFiltered, chosenBuckets, sortKey, sortDir]);

  const total = view ? displayedNodes.length : (data?.total ?? 0);
  const currentPage = data?.page ?? pageIndex;
  const totalPages = Math.max(1, Math.ceil(total / size));

  const shownBuckets = BUCKETS.filter(
    (b) => bucketCounts[b] > 0 || chosenBuckets.has(b) || ["S", "A", "B", "C", "D"].includes(b),
  );

  const toggleBucket = (b: QualityBucket) => {
    const next = new Set(chosenBuckets);
    if (next.has(b)) next.delete(b);
    else next.add(b);
    updateParams({ g: [...next].join(",") });
  };

  const countriesList = useMemo(() => {
    const base = facets
      ? [...(facets.countries || [])]
      : [...new Set(loadedItems.map((n) => n.exit_country).filter((c): c is string => Boolean(c)))].sort();
    if (filters.exit_country && !base.includes(filters.exit_country)) {
      base.unshift(filters.exit_country);
    }
    return base;
  }, [facets, loadedItems, filters.exit_country]);

  const panelActiveCount = Object.keys(filters).filter(
    (k) => k !== "q" && k !== "source_id",
  ).length;

  const openFilterDrawer = async () => {
    setDrawerLoading(true);
    try {
      const list = await readAPI<ProviderItem[]>("/providers");
      setProviders(list);
      setDrawerOpen(true);
    } catch (err) {
      fail(err);
    } finally {
      setDrawerLoading(false);
    }
  };

  const handleWidenSelection = async () => {
    setWidening(true);
    try {
      const ids = view
        ? displayedNodes.map((n) => n.id)
        : await fetchAllMatchingNodeIds({ ...listQuery, vantage });
      toggleIds(ids, true);
    } catch (err) {
      fail(err);
    } finally {
      setWidening(false);
    }
  };

  const handleBulkEnabled = async (enabled: boolean) => {
    setBulkBusy(true);
    try {
      const ids = [...selectedIds];
      let changed = 0;
      for (let i = 0; i < ids.length; i += 1000) {
        const res = await api<{ changed: number }>("/nodes/batch", {
          method: "POST",
          body: { ids: ids.slice(i, i + 1000), enabled },
        });
        changed += res.changed;
      }
      toast(`${enabled ? "已启用" : "已停用"} ${changed} 个节点。`, "ok");
      clearSelection();
      invalidateNodeCaches();
      invalidateReads();
    } catch (err) {
      fail(err);
    } finally {
      setBulkBusy(false);
    }
  };

  const handleTestSelected = async () => {
    const ok = await testNodes([...selectedIds]);
    if (ok) clearSelection();
  };

  const handleSort = (key: NodeSortKey) => {
    const dir = key === sortKey ? (sortDir === "asc" ? "desc" : "asc") : NODE_COLUMNS[key].defaultDir;
    updateParams({ sort: `${key}:${dir}` }, { keepPage: view === "country" });
  };

  const handleNavigateDetail = () => {
    saveListProgress(href);
  };

  // Header metadata
  const availableCount =
    facets?.available ??
    loadedItems.filter((n) => n.status === "UP" || n.status === "DEGRADED").length;
  const candidateTotal = facets?.total ?? loadedItems.length;
  const subtitle = filters.status
    ? `${formatNumber(candidateTotal)} 个节点，其中可用 ${formatNumber(availableCount)} 个`
    : `${formatNumber(candidateTotal)} 个可用节点`;

  const exportable =
    (facets ? facets.exportable > 0 : displayedNodes.some((n) => n.status === "UP" && n.enabled)) &&
    filters.eligible !== "false";

  const exportHrefUrl = useMemo(() => {
    const ep = new URLSearchParams({ ...filters, new: "1", vantage });
    ep.delete("status");
    ep.delete("eligible");
    if (chosenBuckets.size) ep.set("g", [...chosenBuckets].join(","));
    if (quickSet.has("udp")) ep.set("udp", "true");
    if (quickSet.has("home")) ep.set("exit_ip_type", "RESIDENTIAL");
    return pageHref("exports", ep);
  }, [filters, vantage, chosenBuckets, quickSet]);

  const filterChips = Object.entries(filters).filter(([k]) => k !== "q");
  const isFiltered = filterChips.length > 0 || Boolean(filters.q) || chosenBuckets.size > 0 || quickSet.size > 0;

  if (loading && !data) {
    return (
      <div className="page">
        <header className="page-header">
          <div>
            <h1 className="page-title">节点</h1>
            <p className="page-subtitle">正在读取节点目录…</p>
          </div>
        </header>
        <section className="card">
          <SkeletonBlock lines={4} />
        </section>
        <section className="card">
          <SkeletonBlock lines={8} />
        </section>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="page">
        <header className="page-header">
          <h1 className="page-title">节点</h1>
        </header>
        <section className="card">
          <ErrorState message={error} onRetry={handleRefresh} />
        </section>
      </div>
    );
  }

  const spectrumSegments = BUCKETS.filter((b) => b !== "OFF" && bucketCounts[b] > 0);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">节点</h1>
          <p className="page-subtitle">
            <span>{subtitle}</span>
            {!filters.status && (
              <button
                type="button"
                className="inline-link-btn"
                title="包括不可用、未检测和结果过期的节点"
                onClick={() => updateParams({ status: ALL })}
              >
                查看全部状态
              </button>
            )}
          </p>
        </div>

        <div className="page-actions">
          {exportable && (
            <a className="btn" href={exportHrefUrl}>
              <Download size={14} />
              <span>用当前筛选创建订阅</span>
            </a>
          )}
          {data?.at && (
            <time
              className="loaded-time"
              dateTime={new Date(data.at).toISOString()}
              title={new Date(data.at).toLocaleString("zh-CN")}
            >
              载入于 {new Date(data.at).toLocaleTimeString("zh-CN", { hour12: false })}
            </time>
          )}
          <button
            type="button"
            className="btn"
            disabled={refreshing}
            onClick={handleRefresh}
          >
            <RefreshCw size={14} className={refreshing ? "spin" : undefined} />
            <span>{refreshing ? "更新中…" : "刷新"}</span>
          </button>
        </div>
      </header>

      {/* Hero Grade Distribution & Multi-Select Filter */}
      <section className="card spectrum-card" aria-label="等级分布（点选筛选）">
        <div className="spectrum-head">
          <div className="spectrum-vantage">
            <label htmlFor="vantage-pick" className="spectrum-label">
              等级视角
            </label>
            <select
              id="vantage-pick"
              className="select select-sm vantage-select"
              value={vantage}
              onChange={(e) => updateParams({ vantage: e.target.value })}
            >
              {VANTAGES.map(([k, text]) => (
                <option key={k} value={k}>
                  {text}
                </option>
              ))}
            </select>
          </div>
          {chosenBuckets.size > 0 && (
            <button
              type="button"
              className="btn btn-quiet btn-sm"
              onClick={() => updateParams({ g: "" })}
            >
              取消等级筛选
            </button>
          )}
        </div>

        <div className="grade-tiles" role="group" aria-label="按等级筛选（可多选）">
          {shownBuckets.map((b) => {
            const active = chosenBuckets.has(b);
            const dimmed = chosenBuckets.size > 0 && !active;
            const disabled = bucketCounts[b] === 0 && !active;
            return (
              <button
                key={b}
                type="button"
                className={`grade-filter-tile tile-${b}${active ? " is-active" : ""}${dimmed ? " is-dimmed" : ""}`}
                aria-pressed={active}
                disabled={disabled}
                title={BUCKET_HINT[b]}
                onClick={() => toggleBucket(b)}
              >
                <span className="tile-count">{formatNumber(bucketCounts[b])}</span>
                <span className="tile-label">
                  <span className={`swatch seg-${b}`} aria-hidden="true" />
                  <span>{BUCKET_TEXT[b]}</span>
                </span>
              </button>
            );
          })}
        </div>

        {spectrumSegments.length > 0 && (
          <div className="spectrum-track" aria-hidden="true">
            {spectrumSegments.map((b) => (
              <FlexSegment
                key={b}
                grow={bucketCounts[b]}
                className={`seg-${b}${chosenBuckets.size > 0 && !chosenBuckets.has(b) ? " is-off" : ""}`}
              />
            ))}
          </div>
        )}
      </section>

      {/* Single Control Row */}
      <div className="nodes-controls" role="search">
        <div className="search-wrap">
          <Search size={15} className="search-icon" aria-hidden="true" />
          <input
            type="search"
            name="q"
            className="input search-input"
            placeholder="搜索名称、编号或主机…"
            aria-label="搜索节点"
            value={searchInput}
            onChange={(e) => {
              const val = e.target.value;
              setSearchInput(val);
              window.clearTimeout(searchTimerRef.current);
              searchTimerRef.current = window.setTimeout(() => {
                updateParams({ q: val.trim() });
              }, 350);
            }}
          />
        </div>

        <div className="segmented" role="group" aria-label="显示方式">
          {VIEWS.map(([val, text]) => (
            <button
              key={val || "list"}
              type="button"
              className={`seg-btn${view === val ? " is-active" : ""}`}
              aria-pressed={view === val}
              onClick={() => updateParams({ by: val, c: "", page: "", asort: "" })}
            >
              {text}
            </button>
          ))}
        </div>

        <div className="quick-controls">
          {QUICK_TOGGLES.map((q) => {
            const active = quickSet.has(q.key);
            const cnt = facets ? facets[q.key] : loadedItems.filter(q.test).length;
            return (
              <button
                key={q.key}
                type="button"
                className={`pill-toggle${active ? " is-active" : ""}`}
                aria-pressed={active}
                title={q.hint}
                onClick={() => updateParams({ [q.key]: active ? "" : "1" })}
              >
                <span>{q.label}</span>
                <span className="pill-toggle-count">{formatNumber(cnt)}</span>
              </button>
            );
          })}

          <button
            type="button"
            className={`pill-toggle${panelActiveCount > 0 ? " has-filters" : ""}`}
            disabled={drawerLoading}
            onClick={() => void openFilterDrawer()}
          >
            <SlidersHorizontal size={14} />
            <span>筛选</span>
            {panelActiveCount > 0 && <span className="count-pill">{panelActiveCount}</span>}
          </button>
        </div>
      </div>

      {/* Active Filter Chips */}
      {filterChips.length > 0 && (
        <div className="chip-bar">
          {filterChips.map(([key, value]) => {
            const shown =
              key === "provider_id"
                ? providers.find((p) => p.id === value)?.name || "已选"
                : key === "source_id"
                  ? "已选来源"
                  : displayFilterValue(key, value);
            return (
              <button
                key={key}
                type="button"
                className="filter-chip"
                title="移除此条件"
                onClick={() => updateParams({ [key]: "" })}
              >
                <span className="chip-key">{filterLabel(key)}</span>
                <span className="chip-val">{shown}</span>
                <X size={12} className="chip-x" aria-hidden="true" />
              </button>
            );
          })}
          <button type="button" className="btn btn-quiet btn-sm" onClick={resetAll}>
            清除全部条件
          </button>
        </div>
      )}

      {/* Main Content Body */}
      <div className={refreshing ? "content-refreshing" : undefined}>
        {displayedNodes.length === 0 ? (
          <div className="card">
            <EmptyState
              title={isFiltered ? "没有符合条件的节点" : "现在没有可用节点"}
              hint={
                isFiltered
                  ? "放宽或清除部分筛选条件后再查看。"
                  : "在“筛选”里把状态改成“全部状态”，可以查看不可用和未检测的节点。"
              }
              action={
                isFiltered ? (
                  <button type="button" className="btn" onClick={resetAll}>
                    清除全部条件
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => updateParams({ status: ALL })}
                  >
                    查看全部状态
                  </button>
                )
              }
            />
          </div>
        ) : view === "country" ? (
          <NodeCountriesView
            items={displayedNodes}
            vantage={vantage}
            country={params.get("c")}
            onCountry={(code) => updateParams({ c: code })}
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={handleSort}
            selectedIds={selectedIds}
            onToggleIds={toggleIds}
            onShare={(n) => openShareNode(n)}
            onNavigateDetail={handleNavigateDetail}
          />
        ) : view === "asn" ? (
          <NodeAsnView
            items={displayedNodes}
            vantage={vantage}
            sort={params.get("asort")}
            onSort={(val) => updateParams({ asort: val })}
            onOpenAsn={(asn) =>
              updateParams({ by: "", exit_asn: asn ? String(asn) : "", asort: "" })
            }
          />
        ) : (
          <div className="table-card">
            <NodeTable
              nodes={displayedNodes}
              vantage={vantage}
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
              selectedIds={selectedIds}
              onToggleIds={toggleIds}
              onShare={(n) => openShareNode(n)}
              onNavigateDetail={handleNavigateDetail}
              wrapClassName="table-wrap table-wrap-flush nodes-table-wrap"
            />
            <footer className="table-footer">
              <span className="table-range">
                第 {formatNumber(currentPage * size + 1)}–
                {formatNumber(Math.min(total, (currentPage + 1) * size))} 个，共{" "}
                {formatNumber(total)} 个
              </span>
              <label className="page-size-picker">
                <span>每页</span>
                <select
                  name="size"
                  className="select select-sm"
                  value={size}
                  onChange={(e) =>
                    updateParams({
                      size: e.target.value === String(PAGE_SIZES[0]) ? "" : e.target.value,
                    })
                  }
                >
                  {PAGE_SIZES.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <Pagination
                page={currentPage}
                pages={totalPages}
                onPage={(target) =>
                  updateParams({ page: target ? String(target) : "" }, { keepPage: true })
                }
              />
            </footer>
          </div>
        )}
      </div>

      {/* Floating Selection Bar */}
      {selectedIds.size > 0 && (
        <div className="selection-bar" role="region" aria-label="批量操作">
          <strong className="selection-count">已选 {formatNumber(selectedIds.size)} 个</strong>
          {selectedIds.size < total && (
            <button
              type="button"
              className="sel-btn sel-btn-ghost"
              disabled={widening}
              onClick={() => void handleWidenSelection()}
            >
              {widening ? "读取中…" : `选中全部 ${formatNumber(total)} 个结果`}
            </button>
          )}
          <span className="sel-divider" aria-hidden="true" />
          <button
            type="button"
            className="sel-btn sel-btn-primary"
            disabled={bulkBusy}
            onClick={() => void handleTestSelected()}
          >
            检测所选
          </button>
          <button
            type="button"
            className="sel-btn"
            disabled={bulkBusy}
            onClick={() => void handleBulkEnabled(true)}
          >
            启用
          </button>
          <button
            type="button"
            className="sel-btn"
            disabled={bulkBusy}
            title="停用后不再检测和导出"
            onClick={() => void handleBulkEnabled(false)}
          >
            停用
          </button>
          <button
            type="button"
            className="sel-btn sel-btn-ghost"
            disabled={bulkBusy}
            onClick={clearSelection}
          >
            取消选择
          </button>
        </div>
      )}

      {drawerOpen && (
        <NodeFilterDrawer
          filters={filters}
          providers={providers}
          countries={countriesList}
          onApply={(changes) => updateParams(changes)}
          onClose={() => setDrawerOpen(false)}
        />
      )}
    </div>
  );
}
