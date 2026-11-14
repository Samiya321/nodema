// Airports, Sub-Store indexes, ASN labels, run settings and explicit pipeline
// triggers. Nothing here starts GitHub Actions implicitly: imports and edits only
// persist a request; the user starts "sync" or "test" deliberately.
import { SafeError } from "./crypto.js";

type Row = Record<string, unknown>;
type Rows = (sql: string, values?: unknown[], code?: string) => Promise<Row[]>;
export type ManagementContext = {
  rows: Rows;
  body: (request: Request, optional?: boolean) => Promise<Row>;
  json: (value: unknown, status?: number) => Response;
  dispatch: (workflow: string, inputs: Record<string, string>) => Promise<Row>;
};

export const SCOPES = ["ALL", "SELF_HOSTED", "AIRPORT"];
const SOURCE_ACTIONS = ["delete", "enable", "disable", "request_sync"];
const urlHost =
  "substring(convert_from(s.url_data,'UTF8') from '^[A-Za-z]+://([^/:?#]+)')";

export function uuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new SafeError("INVALID_ID");
  return value.toLowerCase();
}

function scope(value: unknown): string {
  const s = value ?? "ALL";
  if (typeof s !== "string" || !SCOPES.includes(s))
    throw new SafeError("INVALID_SCAN_SCOPE");
  return s;
}

const REQUEST_CHUNK = 5000; // scan_requests.node_ids holds at most this many

// Selections are bounded only by the request body size (10 MB), not by a count.
function idList(value: unknown, limit = 200000): string[] {
  if (!Array.isArray(value) || !value.length || value.length > limit)
    throw new SafeError("INVALID_SELECTION", 422);
  return [...new Set(value.map(uuid))];
}

export function providerName(value: unknown): string {
  if (typeof value !== "string") throw new SafeError("INVALID_PROVIDER_NAME");
  const s = value.trim();
  if (!s || s.length > 80 || s.includes("://") || /[\x00-\x1f]/.test(s))
    throw new SafeError("INVALID_PROVIDER_NAME");
  return s;
}

function website(value: unknown): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 300)
    throw new SafeError("INVALID_PROVIDER_WEBSITE");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SafeError("INVALID_PROVIDER_WEBSITE");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username)
    throw new SafeError("INVALID_PROVIDER_WEBSITE");
  return url.origin;
}

function asnLabel(value: unknown): string {
  if (typeof value !== "string") throw new SafeError("INVALID_ASN_LABEL");
  const s = value.trim();
  if (!s || s.length > 40 || /[|\x00-\x1f]/.test(s))
    throw new SafeError("INVALID_ASN_LABEL");
  return s;
}

async function transaction(rows: Rows, work: () => Promise<void>) {
  await rows("BEGIN");
  try {
    await work();
    await rows("COMMIT");
  } catch (error) {
    await rows("ROLLBACK");
    throw error;
  }
}

async function pipeline(rows: Rows) {
  const [state] = await rows(
    `SELECT
      (SELECT count(*)::int FROM sources WHERE deleted_at IS NULL AND enabled
        AND (sync_requested_at IS NOT NULL OR last_sync_status='NEVER')) AS pending_sources,
      (SELECT count(*)::int FROM sources WHERE deleted_at IS NULL AND last_sync_status='FAILED') AS failed_sources,
      -- Worked before and failed on the latest sync: the ones worth attention. Links that
      -- never worked (dead upstreams) are counted separately and shown quietly.
      (SELECT count(*)::int FROM sources WHERE deleted_at IS NULL AND enabled AND last_sync_status='FAILED'
        AND last_success_at IS NOT NULL) AS broken_sources,
      (SELECT count(*)::int FROM sources WHERE deleted_at IS NULL AND enabled) AS sources_total,
      (SELECT max(last_checked_at) FROM sources WHERE deleted_at IS NULL) AS last_synced_at,
      (SELECT jsonb_build_object('daily_scan_enabled',daily_scan_enabled,'daily_scan_scope',daily_scan_scope)
        FROM app_settings WHERE id=1) AS settings,
      (SELECT jsonb_object_agg(node_group,n) FROM (SELECT node_group,count(*) n FROM nodema_node_scope
        WHERE eligible GROUP BY node_group) g) AS testable,
      -- Latest Neon transfer reading (needs a Neon API key in the usage job).
      (SELECT jsonb_build_object('used',transfer_bytes,'limit',transfer_limit_bytes,'period_end',transfer_period_end)
        FROM database_samples WHERE transfer_bytes IS NOT NULL ORDER BY taken_at DESC LIMIT 1) AS neon_transfer`,
  );
  const active = await rows(
    `SELECT r.id,r.scan_date::text AS scan_date,r.kind,r.scope,r.status,r.node_count,r.started_at,
      (SELECT count(*)::int FROM scan_items i WHERE i.scan_run_id=r.id AND i.status='DONE') AS done
     FROM scan_runs r WHERE r.status<>'COMPLETED' AND r.archived_at IS NULL
     ORDER BY r.started_at DESC LIMIT 10`,
  );
  const requested = await rows(
    `SELECT CASE WHEN node_ids IS NULL THEN scope ELSE 'NODES' END AS scope,min(requested_at) AS requested_at,
      count(*)::int AS count,sum(coalesce(cardinality(node_ids),0))::int AS nodes
     FROM scan_requests WHERE consumed_at IS NULL GROUP BY 1 ORDER BY 1`,
  );
  return { ...state, active_scans: active, requested_scans: requested } as Row;
}

async function airports(rows: Rows) {
  const providers = await rows(
    "SELECT id,name,website,created_at,updated_at FROM providers ORDER BY name,id",
  );
  const sources = await rows(
    `SELECT s.id,s.name,s.type,s.user_agent,s.enabled,s.kind,s.detected_kind,s.provider_id,s.parent_source_id,
      s.origin_label,(SELECT p.name FROM sources p WHERE p.id=s.parent_source_id) AS parent_name,
      s.traffic_upload,s.traffic_download,s.traffic_total,s.expires_at,s.userinfo_at,
      s.profile_title,s.profile_url,s.last_sync_status,s.last_error_code,s.last_checked_at,
      s.last_success_at,s.created_at,${urlHost} AS url_host,
      nodema_source_usable(s.enabled,s.deleted_at,s.expires_at,s.traffic_upload,
        s.traffic_download,s.traffic_total) AS usable,
      (SELECT count(*)::int FROM node_sources ns WHERE ns.source_id=s.id) AS node_count,
      (SELECT count(*)::int FROM node_sources ns JOIN node_current_status c ON c.node_id=ns.node_id
        WHERE ns.source_id=s.id AND c.status IN ('UP','DEGRADED')) AS up_count
     FROM sources s
     WHERE s.deleted_at IS NULL AND nodema_source_kind(s.kind,s.detected_kind)='AIRPORT'
     ORDER BY s.name,s.id`,
  );
  return { providers, sources };
}

async function substores(rows: Rows, id?: string) {
  const list = await rows(
    `SELECT s.id,s.name,s.enabled,s.detected_kind,s.last_sync_status,s.last_error_code,
      s.last_checked_at,s.last_success_at,s.last_parse_summary,s.created_at,${urlHost} AS url_host,
      (SELECT count(*)::int FROM sources c WHERE c.parent_source_id=s.id AND c.deleted_at IS NULL) AS children,
      (SELECT count(*)::int FROM sources c WHERE c.parent_source_id=s.id AND c.deleted_at IS NULL
        AND c.last_sync_status IN ('SUCCESS','PARTIAL')) AS healthy_children,
      (SELECT count(*)::int FROM sources c WHERE c.parent_source_id=s.id AND c.deleted_at IS NULL
        AND c.last_sync_status='FAILED') AS failed_children,
      (SELECT count(DISTINCT ns.node_id)::int FROM sources c JOIN node_sources ns ON ns.source_id=c.id
        WHERE c.parent_source_id=s.id) AS node_count
     FROM sources s
     WHERE s.deleted_at IS NULL AND s.type='SUBSCRIPTION_URL' AND (s.detected_kind='SUBSTORE'
       OR (s.detected_kind='UNKNOWN' AND convert_from(s.url_data,'UTF8') ~ '/api/subs/?([?#].*)?$'))
       AND ($1::uuid IS NULL OR s.id=$1::uuid)
     ORDER BY s.name,s.id`,
    [id ?? null],
  );
  if (!id) return list;
  if (!list.length) throw new SafeError("SOURCE_NOT_FOUND", 404);
  return {
    ...list[0],
    children: await rows(
      `SELECT s.id,s.name,s.type,s.enabled,s.kind,s.detected_kind,s.origin_label,
        s.last_sync_status,s.last_error_code,s.last_checked_at,s.last_success_at,${urlHost} AS url_host,
        (SELECT count(*)::int FROM node_sources ns WHERE ns.source_id=s.id) AS node_count
       FROM sources s WHERE s.parent_source_id=$1 AND s.deleted_at IS NULL ORDER BY s.origin_label,s.id`,
      [id],
    ),
  };
}

async function asnLabels(rows: Rows) {
  return {
    labels: await rows(
      "SELECT asn,label,origin,updated_at FROM asn_labels ORDER BY origin DESC,asn",
    ),
    observed: await rows(
      `SELECT c.last_exit_asn AS asn,max(coalesce(c.last_exit_asn_org,i.as_org)) AS organization,
        nodema_asn_label(c.last_exit_asn,max(coalesce(c.last_exit_asn_org,i.as_org))) AS label,
        bool_or(l.asn IS NOT NULL) AS overridden,count(*)::int AS nodes
       FROM node_current_status c LEFT JOIN asn_labels l ON l.asn=c.last_exit_asn
       LEFT JOIN ip_info i ON i.ip=c.last_exit_ip AND i.status='SUCCESS'
       WHERE c.last_exit_asn IS NOT NULL GROUP BY c.last_exit_asn ORDER BY nodes DESC,asn`,
    ),
  };
}

export async function handleManagement(
  request: Request,
  path: string,
  method: string,
  ctx: ManagementContext,
): Promise<Response | undefined> {
  const { rows, json } = ctx;
  if (path === "/api/pipeline" && method === "GET")
    return json(await pipeline(rows));
  if (path === "/api/pipeline/sync" && method === "POST") {
    // "Sync now" refreshes every enabled source (or the chosen ones), not only due ones.
    const data = await ctx.body(request, true);
    const chosen = data.source_ids === undefined ? null : idList(data.source_ids);
    const marked = await rows(
      // A chosen Sub-Store also refreshes the child sources it produced.
      "UPDATE sources SET sync_requested_at=NOW() WHERE deleted_at IS NULL AND enabled AND ($1::uuid[] IS NULL OR id=ANY($1::uuid[]) OR parent_source_id=ANY($1::uuid[])) RETURNING id",
      [chosen],
    );
    if (!marked.length) throw new SafeError("NO_ENABLED_SOURCES", 422);
    return json(
      { ...(await ctx.dispatch("source-sync.yml", {})), sources: marked.length },
      202,
    );
  }
  if (path === "/api/settings" && method === "GET")
    return json((await pipeline(rows)).settings ?? null);
  if (path === "/api/settings" && method === "PUT") {
    const data = await ctx.body(request);
    if (typeof data.daily_scan_enabled !== "boolean")
      throw new SafeError("INVALID_REQUEST", 422);
    const saved = await rows(
      "UPDATE app_settings SET daily_scan_enabled=$1,daily_scan_scope=$2,updated_at=NOW() WHERE id=1 RETURNING daily_scan_enabled,daily_scan_scope",
      [data.daily_scan_enabled, scope(data.daily_scan_scope)],
    );
    return json(saved[0]);
  }
  if (path === "/api/scans" && method === "POST") {
    const data = await ctx.body(request, true);
    const requested = scope(data.scope);
    const nodes = data.node_ids === undefined ? null : idList(data.node_ids);
    // Persist first: GitHub may replace a pending run, the request is never lost.
    // Large selections are stored as several rows; the next run merges them.
    const chunks: (string[] | null)[] = [];
    if (nodes)
      for (let i = 0; i < nodes.length; i += REQUEST_CHUNK)
        chunks.push(nodes.slice(i, i + REQUEST_CHUNK));
    else chunks.push(null);
    const placeholders = chunks.map((_, i) => {
      const n = i * 3;
      return "($" + (n + 1) + ",$" + (n + 2) + ",$" + (n + 3) + "::uuid[])";
    });
    await rows(
      "INSERT INTO scan_requests(id,scope,node_ids) VALUES " +
        placeholders.join(","),
      chunks.flatMap((chunk) => [
        crypto.randomUUID(),
        chunk ? "ALL" : requested,
        chunk,
      ]),
    );
    try {
      return json(
        await ctx.dispatch("daily-check.yml", { run_id: "", scope: requested }),
        202,
      );
    } catch (error) {
      if (!(error instanceof SafeError)) throw error;
      return json(
        { status: "REQUESTED", dispatched: false, reason: error.code },
        202,
      );
    }
  }
  if (path === "/api/airports" && method === "GET")
    return json(await airports(rows));
  const linkMatch = /^\/api\/sources\/([^/]+)\/link$/.exec(path);
  if (linkMatch && method === "GET") {
    // The subscription URL carries its token: only on an explicit click, never cached.
    const link = (
      await rows(
        "SELECT convert_from(url_data,'UTF8') AS url FROM sources WHERE id=$1 AND deleted_at IS NULL AND type='SUBSCRIPTION_URL'",
        [uuid(linkMatch[1])],
      )
    )[0];
    if (!link) throw new SafeError("SOURCE_NOT_FOUND", 404);
    return json({ url: link.url });
  }
  if (path === "/api/providers" && method === "POST") {
    const data = await ctx.body(request);
    const saved = await rows(
      "INSERT INTO providers(id,name,website) VALUES($1,$2,$3) RETURNING id,name,website,created_at,updated_at",
      [crypto.randomUUID(), providerName(data.name), website(data.website)],
    );
    return json(saved[0], 201);
  }
  const provider = /^\/api\/providers\/([^/]+)$/.exec(path);
  if (provider) {
    const id = uuid(provider[1]);
    if (method === "PATCH") {
      const data = await ctx.body(request);
      const sets = ["updated_at=NOW()"],
        values: unknown[] = [id];
      if ("name" in data) {
        values.push(providerName(data.name));
        sets.push(`name=$${values.length}`);
      }
      if ("website" in data) {
        values.push(website(data.website));
        sets.push(`website=$${values.length}`);
      }
      const saved = await rows(
        `UPDATE providers SET ${sets.join(",")} WHERE id=$1 RETURNING id,name,website,created_at,updated_at`,
        values,
      );
      if (!saved.length) throw new SafeError("PROVIDER_NOT_FOUND", 404);
      return json(saved[0]);
    }
    if (method === "DELETE") {
      // Sources stay; their airport grouping is cleared and may be re-detected.
      const removed = await rows(
        "DELETE FROM providers WHERE id=$1 RETURNING id",
        [id],
      );
      if (!removed.length) throw new SafeError("PROVIDER_NOT_FOUND", 404);
      return json({ status: "DELETED" });
    }
  }
  if (path === "/api/substores" && method === "GET")
    return json(await substores(rows));
  const substore = /^\/api\/substores\/([^/]+)$/.exec(path);
  if (substore && method === "GET")
    return json(await substores(rows, uuid(substore[1])));
  if (path === "/api/asn-labels" && method === "GET")
    return json(await asnLabels(rows));
  const asn = /^\/api\/asn-labels\/(\d{1,10})$/.exec(path);
  if (asn && ["PUT", "DELETE"].includes(method)) {
    const number = Number(asn[1]);
    if (number > 4294967295) throw new SafeError("INVALID_ASN", 422);
    const label =
      method === "PUT" ? asnLabel((await ctx.body(request)).label) : null;
    await transaction(rows, async () => {
      if (label === null)
        await rows("DELETE FROM asn_labels WHERE asn=$1", [number]);
      else
        await rows(
          "INSERT INTO asn_labels(asn,label,origin) VALUES($1,$2,'USER') ON CONFLICT(asn) DO UPDATE SET label=excluded.label,origin='USER',updated_at=NOW()",
          [number, label],
        );
      await rows("SELECT nodema_assign_names()");
    });
    return json({ asn: number, label });
  }
  if (path === "/api/sources/batch" && method === "POST") {
    const data = await ctx.body(request),
      ids = idList(data.ids),
      action = String(data.action);
    if (!SOURCE_ACTIONS.includes(action))
      throw new SafeError("INVALID_REQUEST", 422);
    const withChildren = data.include_children === true;
    const target = withChildren
      ? "(id=ANY($1::uuid[]) OR parent_source_id=ANY($1::uuid[]))"
      : "id=ANY($1::uuid[])";
    const update = {
      delete: "deleted_at=NOW(),enabled=false",
      enable: "enabled=true,sync_requested_at=NOW()",
      disable: "enabled=false",
      request_sync: "sync_requested_at=NOW()",
    }[action];
    const changed = await rows(
      `UPDATE sources SET ${update},updated_at=NOW(),revision=revision+1 WHERE ${target} AND deleted_at IS NULL${action === "request_sync" ? " AND enabled" : ""} RETURNING id`,
      [ids],
    );
    return json({ action, changed: changed.length });
  }
  if (path === "/api/nodes/batch" && method === "POST") {
    const data = await ctx.body(request),
      ids = idList(data.ids);
    if (typeof data.enabled !== "boolean")
      throw new SafeError("INVALID_REQUEST", 422);
    const changed = await rows(
      "UPDATE nodes SET enabled=$2 WHERE id=ANY($1::uuid[]) RETURNING id",
      [ids, data.enabled],
    );
    return json({ changed: changed.length });
  }
  return undefined;
}
