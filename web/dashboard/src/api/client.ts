import { useCallback, useEffect, useRef, useState } from "react";

let sessionVersion = 0;
let readRevision = 0;

interface CacheEntry {
  expires: number;
  request: Promise<unknown>;
  data?: unknown;
}

const reads = new Map<string, CacheEntry>();
const revisionListeners = new Set<() => void>();

export class ApiError extends Error {
  code: string;
  status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export function getReadRevision(): number {
  return readRevision;
}

export function subscribeReadRevision(listener: () => void): () => void {
  revisionListeners.add(listener);
  return () => {
    revisionListeners.delete(listener);
  };
}

export function invalidateReads(): void {
  readRevision++;
  reads.clear();
  for (const listener of revisionListeners) listener();
}

export function invalidateSession(): void {
  sessionVersion++;
  invalidateReads();
}

export interface ApiOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  body?: unknown;
  authorization?: string;
}

export async function api<T = unknown>(
  path: string,
  { method = "GET", body, authorization }: ApiOptions = {},
): Promise<T> {
  const version = sessionVersion;
  const sessionRequest = path === "/session";
  let response: Response;
  try {
    response = await fetch("/api" + path, {
      method,
      headers: {
        ...(authorization === undefined ? {} : { Authorization: "Bearer " + authorization }),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      signal: sessionRequest ? AbortSignal.timeout(12000) : undefined,
    });
  } catch {
    if (version !== sessionVersion) throw new ApiError("SESSION_ENDED", 0);
    throw new ApiError("NETWORK_ERROR", 0);
  }

  let data: Record<string, unknown> | null = null;
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    data = null;
  }

  if (version !== sessionVersion) throw new ApiError("SESSION_ENDED", 0);

  if (!response.ok) {
    const code =
      (typeof data?.error_code === "string" && data.error_code) ||
      (typeof data?.detail === "string" && data.detail) ||
      "OPERATION_FAILED";
    if (!sessionRequest && response.status === 401) {
      window.dispatchEvent(new CustomEvent("nodema:session-expired"));
    }
    throw new ApiError(code, response.status);
  }

  if (
    !sessionRequest &&
    !["GET", "HEAD"].includes(method) &&
    !["/exports/preview", "/naming-rules/preview"].includes(path)
  ) {
    invalidateReads();
  }

  return data as T;
}

/**
 * Cached GET for lists and metadata.
 * Private links (/link, /share) and credentials always call api() directly.
 */
export function readAPI<T = unknown>(path: string, maxAge = 30000): Promise<T> {
  const existing = reads.get(path);
  if (existing && (!existing.expires || existing.expires > Date.now())) {
    return existing.request as Promise<T>;
  }
  const entry: CacheEntry = { expires: 0, request: Promise.resolve() };
  entry.request = api<T>(path).then(
    (data) => {
      entry.expires = Date.now() + maxAge;
      entry.data = data;
      return data;
    },
    (error) => {
      if (reads.get(path) === entry) reads.delete(path);
      throw error;
    },
  );
  reads.delete(path);
  reads.set(path, entry);
  if (reads.size > 40) {
    const oldest = reads.keys().next().value;
    if (oldest) reads.delete(oldest);
  }
  return entry.request as Promise<T>;
}

export function getCachedRead<T>(path: string): T | undefined {
  const existing = reads.get(path);
  if (existing && existing.data !== undefined && existing.expires > Date.now()) {
    return existing.data as T;
  }
  return undefined;
}

export interface QueryResult<T> {
  data: T | undefined;
  error: ApiError | null;
  loading: boolean;
  refreshing: boolean;
  refetch: () => void;
}

export function useApiQuery<T>(
  path: string | null,
  options: { cached?: boolean; maxAge?: number; keepPrevious?: boolean } = {},
): QueryResult<T> {
  const { cached = true, maxAge = 30000, keepPrevious = true } = options;
  const [data, setData] = useState<T | undefined>(() =>
    path && cached ? getCachedRead<T>(path) : undefined,
  );
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState<boolean>(() => Boolean(path) && !(path && cached && getCachedRead<T>(path) !== undefined));
  const [refreshing, setRefreshing] = useState(false);
  const [revision, setRevision] = useState(getReadRevision);
  const [manualTick, setManualTick] = useState(0);
  const reqIdRef = useRef(0);
  const lastPathRef = useRef(path);

  useEffect(() => {
    return subscribeReadRevision(() => setRevision(getReadRevision()));
  }, []);

  const refetch = useCallback(() => {
    invalidateReads();
    setManualTick((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!path) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    const reqId = ++reqIdRef.current;
    const pathChanged = lastPathRef.current !== path;
    lastPathRef.current = path;

    const existing = cached ? getCachedRead<T>(path) : undefined;
    if (existing !== undefined) {
      setData(existing);
      setError(null);
      setLoading(false);
      setRefreshing(false);
      return;
    }

    if (pathChanged && !keepPrevious) {
      setData(undefined);
      setLoading(true);
    } else if (data !== undefined) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);

    const fetcher = cached ? readAPI<T>(path, maxAge) : api<T>(path);
    fetcher.then(
      (result) => {
        if (reqId !== reqIdRef.current) return;
        setData(result);
        setError(null);
        setLoading(false);
        setRefreshing(false);
      },
      (err: unknown) => {
        if (reqId !== reqIdRef.current) return;
        const apiErr = err instanceof ApiError ? err : new ApiError("OPERATION_FAILED", 0);
        if (apiErr.status === 401 || apiErr.code === "SESSION_ENDED") return;
        setError(apiErr);
        setLoading(false);
        setRefreshing(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, cached, maxAge, revision, manualTick]);

  return { data, error, loading, refreshing, refetch };
}
