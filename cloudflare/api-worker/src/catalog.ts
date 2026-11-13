import { SafeError } from "./crypto.js";

export type Row = Record<string, unknown>;
export type Rows = (
  sql: string,
  values?: unknown[],
  errorCode?: string,
) => Promise<Row[]>;
export const filterKeys = new Set([
  "id",
  "node_group",
  "provider_id",
  "asn_label",
  "exit_ip_type",
  "exit_ip_proxy",
  "q",
  "status",
  "protocol",
  "entry_country",
  "exit_country",
  "transport",
  "security",
  "server_host",
  "server_port",
  "entry_ip",
  "exit_ip",
  "exit_city",
  "entry_asn",
  "exit_asn",
  "asn",
  "source_id",
  "enabled",
  "eligible",
  "probe_key",
  "grade",
  "confidence",
  "line_type",
  "line_claim",
  "evidence_level",
  "tags",
  "operator",
  "min_success_rate",
  "max_timeout_rate",
  "max_http_ms",
  "max_http_p95_ms",
  "min_samples",
  "min_age_days",
  "min_checked_days",
  "min_available_days",
  "min_lifetime_availability",
  "last_checked_after",
  "last_success_after",
  // Grades (node_grades) for one vantage.
  "vantage",
  "quality_grade",
  "min_quality_grade",
  "max_peak_rtt_ms",
  "max_peak_loss",
  "min_avail_7d",
  "route_asn",
  "cross_border",
  "unreachable",
  "best_per_server",
]);
const booleanKeys = [
  "eligible",
  "enabled",
  "exit_ip_proxy",
  "cross_border",
  "unreachable",
  "best_per_server",
];

export function filtersFromParams(params: URLSearchParams): Row {
  const result: Row = {};
  for (const [key, value] of params) {
    if (["offset", "limit", "sort", "view"].includes(key)) continue;
    if (!filterKeys.has(key)) throw new SafeError("INVALID_NODE_QUERY");
    if (!value) continue;
    if (booleanKeys.includes(key)) {
      if (!["true", "false"].includes(value))
        throw new SafeError("INVALID_NODE_QUERY");
      result[key] = value === "true";
    } else if (key === "tags")
      result[key] = value
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
    else result[key] = value;
  }
  return result;
}

export async function catalogPage(
  rows: Rows,
  template: string,
  freshness: number,
  filters: Row = {},
  sort = "short_id:asc",
  offset = 0,
  limit = 100,
  projection: "full" | "identity" | "report" = "full",
) {
  if (Object.keys(filters).some((key) => !filterKeys.has(key)))
    throw new SafeError("INVALID_NODE_QUERY");
  if (typeof sort !== "string") throw new SafeError("INVALID_NODE_SORT");
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100000
  )
    throw new SafeError("INVALID_PAGINATION", 422);
  return (
    await rows(
      "SELECT nodema_node_page($1::jsonb,$2,$3,$4,$5,$6,$7) AS page",
      [
        JSON.stringify(filters),
        sort,
        offset,
        limit,
        freshness,
        template,
        projection,
      ],
      "INVALID_NODE_QUERY",
    )
  )[0].page as { total: number; items: import("./formats.js").PublicNode[] };
}

// The compact list is passed through as PostgreSQL's JSON text: the Worker neither
// parses nor re-serializes megabytes of rows (free-plan CPU budget).
export async function catalogPageText(
  rows: Rows,
  template: string,
  freshness: number,
  filters: Row,
  sort: string,
  offset: number,
  limit: number,
): Promise<string> {
  if (Object.keys(filters).some((key) => !filterKeys.has(key)))
    throw new SafeError("INVALID_NODE_QUERY");
  return String(
    (
      await rows(
        "SELECT nodema_node_page($1::jsonb,$2,$3,$4,$5,$6,'compact')::text AS page",
        [JSON.stringify(filters), sort, offset, limit, freshness, template],
        "INVALID_NODE_QUERY",
      )
    )[0].page,
  );
}

export async function catalogOverview(
  rows: Rows,
  template: string,
  freshness: number,
) {
  return (
    await rows(
      `WITH data AS (SELECT status,eligible,exit_country,node_group FROM nodema_catalog($1,$2,'GENERAL'))
    SELECT jsonb_build_object('total',(SELECT count(*) FROM data),
      'groups',coalesce((SELECT jsonb_object_agg(node_group,jsonb_build_object('total',total,'eligible',eligible,'statuses',statuses))
        FROM (SELECT node_group,sum(n)::int total,sum(e)::int eligible,jsonb_object_agg(status,n) statuses
          FROM (SELECT node_group,status,count(*) n,count(*) FILTER(WHERE eligible) e FROM data GROUP BY 1,2) s
          GROUP BY node_group) g),'{}'),
      'statuses',coalesce((SELECT jsonb_object_agg(status,n) FROM (SELECT status,count(*) n FROM data GROUP BY status) s),'{}'),
      'countries',coalesce((SELECT jsonb_object_agg(country,n) FROM (SELECT coalesce(exit_country,'UNK') country,count(*) n FROM data GROUP BY 1) s),'{}')) AS summary`,
      [freshness, template],
    )
  )[0].summary as Row;
}
