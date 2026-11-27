// Preserves node list progress (scroll, selection, expanded country ASN groups, compact cache)
// across Node List <-> Node Detail navigation without extra API requests.
import { api, getReadRevision, readAPI, subscribeReadRevision } from "../api/client";
import type { NodeListItem, NodesDashboardResult, RawNodesPage, Vantage } from "../types/api";

const FETCH_PAGE = 10000;
const COMPACT_CACHE_MS = 30000;

export function unpackPositionalNodes(page: RawNodesPage): NodeListItem[] {
  return page.items.map((row) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < page.fields.length; i++) {
      obj[page.fields[i]] = row[i];
    }
    return obj as unknown as NodeListItem;
  });
}

// ---- Compact full-collection cache for Country / ASN views ----
interface CompactCacheEntry {
  key: string;
  revision: number;
  at: number;
  items: NodeListItem[];
  vantage: Vantage;
}

let compactCache: CompactCacheEntry | null = null;

// ---- Selection state preserved across pagination of same filter+vantage ----
let selectionKey = "";
let selectedIds = new Set<string>();

// ---- Node list progress snapshot when navigating to Node Detail ----
export interface NodeListReturnState {
  href: string;
  direct: boolean;
}

interface SavedListProgress {
  href: string;
  revision: number;
  scrollX: number;
  scrollY: number;
  tableScrollLeft: number;
  openAsnGroups?: Record<string, boolean>;
}

let savedProgress: SavedListProgress | null = null;
let pendingReturnTo: NodeListReturnState | null = null;

// ---- Country view open ASN groups per country ----
const expandedAsnState = new Map<string, Record<string, boolean>>();

subscribeReadRevision(() => {
  compactCache = null;
  savedProgress = null;
});

export function invalidateNodeCaches(): void {
  compactCache = null;
  selectedIds = new Set();
  selectionKey = "";
  savedProgress = null;
  pendingReturnTo = null;
}

export function getSelectionForKey(key: string): Set<string> {
  if (selectionKey !== key) {
    selectionKey = key;
    selectedIds = new Set();
  }
  return new Set(selectedIds);
}

export function setSelectionForKey(key: string, ids: Set<string>): void {
  selectionKey = key;
  selectedIds = new Set(ids);
}

export function getCountryOpenGroups(countryKey: string): Record<string, boolean> | undefined {
  return expandedAsnState.get(countryKey);
}

export function setCountryOpenGroups(countryKey: string, map: Record<string, boolean>): void {
  expandedAsnState.set(countryKey, { ...map });
}

export function saveListProgress(href: string): void {
  const tableWrap = document.querySelector<HTMLElement>(".nodes-table-wrap");
  savedProgress = {
    href,
    revision: getReadRevision(),
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    tableScrollLeft: tableWrap?.scrollLeft ?? 0,
  };
  pendingReturnTo = { href, direct: true };
}

export function resolveDetailReturnTo(): NodeListReturnState | null {
  const fromHistory = window.history.state?.nodemaNodeListReturn as NodeListReturnState | undefined;
  if (fromHistory) {
    pendingReturnTo = null;
    return fromHistory;
  }
  if (pendingReturnTo) {
    const resolved = pendingReturnTo;
    pendingReturnTo = null;
    window.history.replaceState(
      { ...window.history.state, nodemaNodeListReturn: resolved },
      "",
    );
    return resolved;
  }
  return null;
}

export function consumeListProgress(href: string): SavedListProgress | null {
  if (!savedProgress) return null;
  if (savedProgress.href === href && savedProgress.revision === getReadRevision()) {
    const snap = savedProgress;
    savedProgress = null;
    return snap;
  }
  savedProgress = null;
  return null;
}

export async function fetchDashboardPage(
  filters: Record<string, string>,
  sort: string,
  page: number,
  size: number,
): Promise<NodesDashboardResult> {
  const args = new URLSearchParams({
    ...filters,
    sort,
    offset: String(page * size),
    limit: String(size),
    view: "dashboard",
  });
  const result = await readAPI<RawNodesPage>("/nodes?" + args.toString());
  if (page > 0 && page * size >= result.total) {
    const lastPage = Math.max(0, Math.ceil(result.total / size) - 1);
    return fetchDashboardPage(filters, sort, lastPage, size);
  }
  return {
    total: result.total,
    vantage: result.vantage,
    facets: result.facets,
    items: unpackPositionalNodes(result),
    page,
    at: Date.now(),
  };
}

export async function fetchCompactCollection(
  filters: Record<string, string>,
): Promise<{ items: NodeListItem[]; vantage: Vantage; at: number }> {
  const key = JSON.stringify(filters);
  const revision = getReadRevision();
  if (
    compactCache &&
    compactCache.key === key &&
    compactCache.revision === revision &&
    Date.now() - compactCache.at < COMPACT_CACHE_MS
  ) {
    return { items: compactCache.items, vantage: compactCache.vantage, at: compactCache.at };
  }

  const sort = filters.status === "AVAILABLE" ? "status:desc,short_id:asc" : "short_id:asc";
  const fetchPage = (offset: number, selected = filters) =>
    api<RawNodesPage>(
      "/nodes?" +
        new URLSearchParams({
          ...selected,
          sort,
          view: "compact",
          offset: String(offset),
          limit: String(FETCH_PAGE),
        }).toString(),
    );

  const first = await fetchPage(0);
  const offsets: number[] = [];
  for (let offset = FETCH_PAGE; offset < first.total; offset += FETCH_PAGE) {
    offsets.push(offset);
  }
  const rest = await Promise.all(
    offsets.map((offset) => fetchPage(offset, { ...filters, vantage: first.vantage })),
  );
  const items = [first, ...rest].flatMap(unpackPositionalNodes);
  const at = Date.now();
  if (revision === getReadRevision()) {
    compactCache = { key, revision, at, items, vantage: first.vantage };
  }
  return { items, vantage: first.vantage, at };
}

export async function fetchAllMatchingNodeIds(
  filters: Record<string, string>,
): Promise<string[]> {
  const limit = 10000;
  const request = (offset: number, vantage = filters.vantage) =>
    api<{ total: number; vantage: Vantage; items: string[][] }>(
      "/nodes?" +
        new URLSearchParams({
          ...filters,
          ...(vantage ? { vantage } : {}),
          view: "ids",
          offset: String(offset),
          limit: String(limit),
        }).toString(),
    );

  const first = await request(0);
  const ids = first.items.flat();
  for (let offset = limit; offset < first.total; offset += limit) {
    const next = await request(offset, first.vantage);
    ids.push(...next.items.flat());
  }
  return ids;
}
