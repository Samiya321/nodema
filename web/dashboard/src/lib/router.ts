import { useCallback, useEffect, useState } from "react";

export type PageName = "overview" | "nodes" | "sources" | "exports" | "ops" | "settings";

export const PAGE_TITLES: Record<PageName, string> = {
  overview: "总览",
  nodes: "节点",
  sources: "来源",
  exports: "导出",
  ops: "运维",
  settings: "设置",
};

export const ROUTE_ALIASES: Record<string, [PageName, string]> = {
  airports: ["sources", "airport"],
  substore: ["sources", "substore"],
  scans: ["ops", "scans"],
  usage: ["ops", "usage"],
};

export const LINEAGE_PAGE_SIZE = 50;

export interface RouteState {
  name: PageName;
  params: URLSearchParams;
  href: string;
}

export function pageHref(
  name: PageName | string,
  params?: URLSearchParams | Record<string, string | number | undefined | null>,
): string {
  let query = "";
  if (params instanceof URLSearchParams) {
    query = params.toString();
  } else if (params) {
    const clean = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") clean.set(k, String(v));
    }
    query = clean.toString();
  }
  return "#/" + name + (query ? "?" + query : "");
}

export function sourceHref(id: string, relation?: string | null): string {
  return pageHref("sources", { source: id, ...(relation ? { relation } : {}) });
}

export function nodeHref(id: string, vantage?: string | null): string {
  return pageHref("nodes", { node: id, ...(vantage ? { vantage } : {}) });
}

export function exportHref(id: string): string {
  return pageHref("exports", { subscription: id });
}

export function scanHref(id: string): string {
  return pageHref("ops", { scan: id });
}

export function normalizeRoute(rawName: string, params: URLSearchParams): RouteState {
  const next = new URLSearchParams(params);
  if (Object.hasOwn(ROUTE_ALIASES, rawName)) {
    const [target, tab] = ROUTE_ALIASES[rawName];
    if (!(rawName === "scans" && next.get("tab") === "probes")) {
      next.set("tab", tab);
    }
    return { name: target, params: next, href: pageHref(target, next) };
  }
  const name: PageName = Object.hasOwn(PAGE_TITLES, rawName) ? (rawName as PageName) : "overview";
  return { name, params: next, href: pageHref(name, next) };
}

export function parseHash(hash: string = window.location.hash): RouteState {
  const cleaned = hash.replace(/^#\/?/, "");
  const qIndex = cleaned.indexOf("?");
  const rawName = qIndex >= 0 ? cleaned.slice(0, qIndex) : cleaned;
  const query = qIndex >= 0 ? cleaned.slice(qIndex + 1) : "";
  const route = normalizeRoute(rawName, new URLSearchParams(query));
  if (Object.hasOwn(ROUTE_ALIASES, rawName)) {
    window.history.replaceState(window.history.state, "", route.href);
  }
  return route;
}

export function navigate(
  name: PageName | string,
  params?: URLSearchParams | Record<string, string | number | undefined | null>,
): void {
  let sp: URLSearchParams;
  if (params instanceof URLSearchParams) {
    sp = new URLSearchParams(params);
  } else {
    sp = new URLSearchParams();
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
      }
    }
  }
  const route = normalizeRoute(name, sp);
  window.location.hash = route.href;
}

export function readPageParam(params: URLSearchParams): number {
  const page = Number(params.get("page") || 0);
  return Number.isSafeInteger(page) &&
    page >= 0 &&
    page <= Math.floor(2147483647 / LINEAGE_PAGE_SIZE)
    ? page
    : 0;
}

export function useRouter() {
  const [route, setRoute] = useState<RouteState>(() => parseHash());

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = useCallback(
    (
      name: PageName | string,
      params?: URLSearchParams | Record<string, string | number | undefined | null>,
    ) => {
      navigate(name, params);
    },
    [],
  );

  return { route, go };
}
