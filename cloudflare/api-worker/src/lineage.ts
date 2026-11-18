import type { Rows } from "./catalog.js";
import { SafeError } from "./crypto.js";

const RELATIONS = new Set(["history", "present", "current", "stale", "children", "references"]);

export function lineagePage(params: URLSearchParams) {
  const offset = Number(params.get("offset") ?? 0);
  const limit = Number(params.get("limit") ?? 50);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 2147483647 ||
    !Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new SafeError("INVALID_PAGINATION", 422);
  return { offset, limit };
}

export async function sourceLineage(
  rows: Rows, id: string, freshness: number, template: string, params: URLSearchParams,
) {
  const relation = params.get("relation") ?? "present";
  if (!RELATIONS.has(relation)) throw new SafeError("INVALID_NODE_QUERY");
  const { offset, limit } = lineagePage(params);
  const [result] = await rows("SELECT nodema_source_lineage($1,$2,$3,$4,$5,$6) AS detail",
    [id, freshness, template, relation, offset, limit]);
  if (!result.detail) throw new SafeError("SOURCE_NOT_FOUND", 404);
  return result.detail;
}
