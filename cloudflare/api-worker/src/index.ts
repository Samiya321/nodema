import { Client } from "pg";
import { SafeError, digest, equal, token } from "./crypto.js";
import { handleExports } from "./export-api.js";
import { usageSummary } from "./usage.js";
import { importLinks, subscriptionURL } from "./source-bulk.js";
import { handleManagement, providerName } from "./management.js";
import {
  catalogPage,
  catalogPageText,
  catalogOverview,
  filtersFromParams,
} from "./catalog.js";
import { withName } from "./share.js";
import {
  annotation,
  annotate,
  qualityPolicy,
  saveQualityPolicy,
} from "./quality.js";

type Row = Record<string, unknown>;
const uuid = (value: string) => {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new SafeError("INVALID_ID");
  return value.toLowerCase();
};
const number = (value: unknown, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const sourceColumns =
  "id,name,type,format_hint,enabled,sync_interval_seconds,content_hash,applied_hash,parser_version,last_checked_at,sync_requested_at,last_synced_at,last_sync_status,last_error_code,last_parse_summary,revision,deleted_at," +
  "kind,detected_kind,parent_source_id,origin_label,user_agent,provider_id,traffic_upload,traffic_download,traffic_total,expires_at,userinfo_at,profile_title,profile_url,last_success_at,created_at," +
  "substring(convert_from(url_data,'UTF8') from '^[A-Za-z]+://([^/:?#]+)') AS url_host";
// Imports and edits never start Actions; the dashboard asks the user to sync/test.
const MANUAL_PIPELINE = { dispatched: false, reason: "MANUAL_SYNC" };
function sourceKind(value: unknown): string {
  const s = value ?? "AUTO";
  if (!["AUTO", "AIRPORT", "SELF_HOSTED"].includes(String(s)))
    throw new SafeError("INVALID_SOURCE_KIND");
  return String(s);
}
function userAgent(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    /[^\x20-\x7e]/.test(value)
  )
    throw new SafeError("INVALID_SUBSCRIPTION_USER_AGENT");
  return value;
}
const securityHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};
function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: securityHeaders });
}
function blob(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array))
    throw new SafeError("DECRYPTION_FAILED", 500);
  return value;
}
function object(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SafeError("INVALID_REQUEST", 422);
  return value as Row;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new SafeError("INVALID_REQUEST", 422);
  return value;
}
function label(value: unknown): string {
  const s = text(value);
  if (!s || s.length > 80 || s.includes("://") || /[\x00-\x1f]/.test(s))
    throw new SafeError("INVALID_SOURCE_LABEL");
  return s;
}
function formatHint(value: unknown): string {
  const s = value ?? "AUTO";
  if (!["AUTO", "URI", "BASE64", "CLASH", "SINGBOX"].includes(String(s)))
    throw new SafeError("INVALID_FORMAT");
  return String(s);
}
export function nameFor(
  template: string,
  values: Record<string, string>,
): string {
  if (template.length > 200 || /[\x00-\x1f]/.test(template))
    throw new SafeError("INVALID_NAME_TEMPLATE");
  let result = "";
  for (let i = 0; i < template.length;) {
    if (template.slice(i, i + 2) === "{{") {
      result += "{";
      i += 2;
    } else if (template.slice(i, i + 2) === "}}") {
      result += "}";
      i += 2;
    } else if (template[i] === "{") {
      const end = template.indexOf("}", i),
        key = template.slice(i + 1, end);
      if (end < 0 || !Object.hasOwn(values, key))
        throw new SafeError("INVALID_NAME_TEMPLATE");
      result += values[key];
      i = end + 1;
    } else if (template[i] === "}")
      throw new SafeError("INVALID_NAME_TEMPLATE");
    else result += template[i++];
  }
  if (result.length > 500) throw new SafeError("INVALID_NAME_TEMPLATE");
  return result;
}
// optional: a missing or empty body reads as {}. A body-less POST forwarded through
// the Pages service binding arrives as an empty stream, not a null body.
async function body(request: Request, optional = false): Promise<Row> {
  if (!request.body) {
    if (optional) return {};
    throw new SafeError("INVALID_REQUEST", 422);
  }
  const reader = request.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 10551296) {
        await reader.cancel();
        throw new SafeError("INPUT_TOO_LARGE", 413);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    if (optional && !size) return {};
    return object(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          bytes,
        ),
      ),
    );
  } catch (error) {
    if (error instanceof SafeError) throw error;
    throw new SafeError("INVALID_REQUEST", 422);
  }
}
async function dispatch(
  env: Env,
  workflow: string,
  inputs: Record<string, string>,
) {
  if (!env.GITHUB_REPOSITORY || !env.GITHUB_DISPATCH_TOKEN)
    throw new SafeError("DISPATCH_NOT_CONFIGURED");
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY))
    throw new SafeError("INVALID_DISPATCH_CONFIGURATION");
  let response: Response;
  try {
    response = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${workflow}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "nodema",
      },
      body: JSON.stringify({ ref: env.GITHUB_WORKFLOW_REF, inputs }),
      signal: AbortSignal.timeout(10000),
    },
  );
  } catch {
    // Never surface network driver details; the persisted request can be retried.
    throw new SafeError("DISPATCH_FAILED", 502);
  }
  await response.body?.cancel();
  if (response.status !== 204) throw new SafeError("DISPATCH_FAILED", 502);
  return { status: "QUEUED", dispatched: true };
}

async function queueExportBuild(env: Env) {
  try {
    return await dispatch(env, "export-build.yml", {});
  } catch (error) {
    return {
      status: "PENDING",
      dispatched: false,
      reason: error instanceof SafeError ? error.code : "DISPATCH_FAILED",
    };
  }
}

export async function handle(
  request: Request,
  env: Env,
  connect?: () => Promise<Client>,
): Promise<Response> {
  let catalogChanged = false;
  let wakeExports: (() => Promise<unknown>) | undefined;
  let db: Client | undefined;
  try {
    const url = new URL(request.url),
      path = url.pathname,
      method = request.method;
    if (path === "/api/health" && method === "GET")
      return json({ status: "ok" });
    const subscription = /^\/subscriptions\/([^/]+)$/.exec(path);
    if (!subscription) {
      const provided =
        request.headers.get("Authorization")?.replace(/^Bearer /i, "") ?? "";
      if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 24)
        throw new SafeError("ADMIN_TOKEN_REQUIRED", 503);
      if (!(await equal(provided, env.ADMIN_PASSWORD)))
        throw new SafeError("AUTHENTICATION_REQUIRED", 401);
    }
    if (connect) db = await connect();
    else {
      db = new Client({
        connectionString: env.HYPERDRIVE.connectionString,
        connectionTimeoutMillis: 10000,
        query_timeout: 15000,
      });
      try {
        await db.connect();
      } catch {
        throw new SafeError("DATABASE_UNAVAILABLE", 503);
      }
    }
    const rows = async (
      sql: string,
      values: unknown[] = [],
      errorCode = "DATABASE_QUERY_FAILED",
    ): Promise<Row[]> => {
      let result: Row[];
      try {
        result = (await db!.query<Row>(sql, values)).rows;
      } catch (error) {
        const code =
          errorCode === "INVALID_NODE_QUERY" &&
          error &&
          typeof error === "object" &&
          "message" in error &&
          error.message === "INVALID_NODE_SORT"
            ? "INVALID_NODE_SORT"
            : errorCode;
        throw new SafeError(code, code === "DATABASE_QUERY_FAILED" ? 503 : 400);
      }
      if (
        /^(UPDATE|DELETE FROM|INSERT INTO) (nodes|sources|quality_policies|naming_rules|node_annotations)\b/i.test(
          sql.trim(),
        )
      )
        catalogChanged = true;
      for (const row of result)
        for (const key of [
          "entry_asn",
          "exit_asn",
          "last_exit_asn",
          "revision",
          "asn",
          "traffic_upload",
          "traffic_download",
          "traffic_total",
        ]) {
          if (
            typeof row[key] === "string" &&
            Number.isSafeInteger(Number(row[key]))
          )
            row[key] = Number(row[key]);
        }
      return result;
    };
    wakeExports = async () => {
      const pending = (
        await rows(
          // Only links that stopped serving need an immediate rebuild; merely stale
          // files keep serving until the next sync/test pipeline publishes them.
          "SELECT EXISTS(SELECT 1 FROM export_artifacts e WHERE e.revoked_at IS NULL AND (e.expires_at IS NULL OR e.expires_at>NOW()) AND e.invalidated AND e.current_version>0) AS pending",
        )
      )[0];
      if (pending.pending) await queueExportBuild(env);
    };
    if (path === "/api/readiness" && method === "GET") {
      let version: unknown;
      try {
        version = (await rows("SELECT version_num FROM alembic_version"))[0]
          ?.version_num;
      } catch {
        throw new SafeError("DATABASE_OR_SCHEMA_UNAVAILABLE", 503);
      }
      const dispatchReady =
        /^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY) &&
        Boolean(env.GITHUB_DISPATCH_TOKEN) &&
        Boolean(env.GITHUB_WORKFLOW_REF);
      if (version !== "0017_scale_ip_type")
        return json({
          ready: false,
          checks: { schema: false, dispatch: dispatchReady },
        });
      const checks = {
        database: true,
        schema: version === "0017_scale_ip_type",
        storage: "PLAINTEXT",
        dispatch: dispatchReady,
      };
      return json({
        ready: checks.database && checks.schema && checks.dispatch,
        checks,
      });
    }
    const template = async () =>
      String(
        (await rows("SELECT template FROM naming_rules WHERE id=1"))[0]
          ?.template ?? env.NAME_TEMPLATE,
      );
    const page = async (
      filters: Row = {},
      sort = "short_id:asc",
      offset = 0,
      limit = 100,
    ) =>
      catalogPage(
        rows,
        await template(),
        number(env.FRESHNESS_HOURS, 36),
        filters,
        sort,
        offset,
        limit,
      );
    const source = async (id: string) => {
      const result = (
        await rows(
          `SELECT ${sourceColumns} FROM sources WHERE id=$1 AND deleted_at IS NULL`,
          [uuid(id)],
        )
      )[0];
      if (!result) throw new SafeError("SOURCE_NOT_FOUND", 404);
      return result;
    };
    const exported = await handleExports(request, {
      rows,
      transact: (sql) => db!.query(sql),
      body,
      queue: () => queueExportBuild(env),
      headers: securityHeaders,
    });
    if (exported) return exported;
    const managed = await handleManagement(request, path, method, {
      rows,
      body,
      json,
      dispatch: (workflow, inputs) => dispatch(env, workflow, inputs),
    });
    if (managed) return managed;
    if (path === "/api/usage" && method === "GET")
      return json(
        await usageSummary(rows, Number(url.searchParams.get("days") ?? 30)),
      );
    if (path === "/api/overview" && method === "GET") {
      const aggregate = await catalogOverview(
        rows,
        await template(),
        number(env.FRESHNESS_HOURS, 36),
      );
      const latest =
        (
          await rows(
            "SELECT id,scan_date::text AS scan_date,kind,scope,status,node_count,shard_count,started_at,finished_at,error_summary,archived_at,archive_summary FROM scan_runs ORDER BY scan_date DESC,started_at DESC LIMIT 1",
          )
        )[0] ?? null;
      if (latest) {
        latest.shards = await rows(
          "SELECT shard_no,status,planned_count,completed_count,failed_count,started_at,finished_at,error_summary FROM scan_shards WHERE scan_run_id=$1 ORDER BY shard_no",
          [latest.id],
        );
        const items = await rows(
          "SELECT status,count(*)::int AS count FROM scan_items WHERE scan_run_id=$1 GROUP BY status",
          [latest.id],
        );
        latest.items = Object.fromEntries(
          items.map((r) => [String(r.status), r.count]),
        );
      }
      return json({
        ...aggregate,
        latest_scan: latest,
        latest_completed_scan:
          (
            await rows(
              "SELECT id,scan_date::text AS scan_date,kind,scope,status,node_count,shard_count,started_at,finished_at,error_summary,archived_at,archive_summary FROM scan_runs WHERE kind='DAILY' AND status='COMPLETED' ORDER BY finished_at DESC LIMIT 1",
            )
          )[0] ?? null,
      });
    }
    if (path === "/api/nodes" && method === "GET") {
      // view=compact: only the list fields, so a whole filtered set fits one request.
      const view = url.searchParams.get("view") ?? "full";
      if (view !== "full" && view !== "compact")
        throw new SafeError("INVALID_NODE_QUERY");
      const offset = Number(url.searchParams.get("offset") ?? 0),
        limit = Number(url.searchParams.get("limit") ?? 100);
      if (
        !Number.isInteger(offset) ||
        offset < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > (view === "compact" ? 20000 : 500)
      )
        throw new SafeError("INVALID_PAGINATION", 422);
      const filters = filtersFromParams(url.searchParams),
        sort = url.searchParams.get("sort") ?? "short_id:asc";
      if (view === "compact")
        return new Response(
          await catalogPageText(
            rows,
            await template(),
            number(env.FRESHNESS_HOURS, 36),
            filters,
            sort,
            offset,
            limit,
          ),
          {
            headers: {
              ...securityHeaders,
              "Content-Type": "application/json; charset=utf-8",
            },
          },
        );
      return json(await page(filters, sort, offset, limit));
    }
    if (path === "/api/quality-policy" && method === "GET")
      return json(await qualityPolicy(rows));
    if (path === "/api/quality-policy" && method === "PUT")
      return json(
        await saveQualityPolicy(
          rows,
          (sql) => db!.query(sql),
          await body(request),
        ),
      );
    const annotationMatch =
      /^\/api\/nodes\/([^/]+)\/(annotations|evidence)$/.exec(path);
    if (annotationMatch) {
      const id = uuid(annotationMatch[1]);
      if (annotationMatch[2] === "annotations" && method === "GET")
        return json(await annotation(rows, id));
      if (annotationMatch[2] === "annotations" && method === "PATCH") {
        return json(
          await annotate(
            rows,
            (sql) => db!.query(sql),
            id,
            await body(request),
          ),
        );
      }
      if (annotationMatch[2] === "evidence" && method === "GET") {
        await annotation(rows, id);
        const saved = (
          await rows(
            "SELECT reference_data FROM node_annotations WHERE node_id=$1",
            [id],
          )
        )[0];
        return json({
          reference: saved?.reference_data
            ? Buffer.from(blob(saved.reference_data)).toString("utf8")
            : null,
        });
      }
    }
    const shareMatch = /^\/api\/nodes\/([^/]+)\/share$/.exec(path);
    if (shareMatch && method === "GET") {
      // Credentials: fetched only on an explicit click, never cached (no-store).
      const id = uuid(shareMatch[1]);
      const node = (await page({ id }, "short_id:asc", 0, 1)).items[0];
      if (!node) throw new SafeError("NODE_NOT_FOUND", 404);
      const link = (
        await rows(
          "SELECT uri,error_code,omitted FROM node_share_links WHERE node_id=$1",
          [id],
        )
      )[0];
      const name = String(node.name);
      if (!link) return json({ name, uri: null, error_code: "SHARE_PENDING" });
      return json({
        name,
        uri: link.uri ? withName(String(link.uri), name) : null,
        error_code: link.uri ? null : link.error_code,
        omitted: link.omitted ? String(link.omitted).split(",") : [],
      });
    }
    const aliasMatch = /^\/api\/nodes\/([^/]+)\/aliases$/.exec(path);
    if (aliasMatch && method === "GET") {
      const id = uuid(aliasMatch[1]);
      if (!(await rows("SELECT id FROM nodes WHERE id=$1", [id])).length)
        throw new SafeError("NODE_NOT_FOUND", 404);
      const result = [];
      for (const row of await rows(
        "SELECT ns.source_id,ns.aliases_data,ns.is_present,s.name FROM node_sources ns JOIN sources s ON ns.source_id=s.id WHERE ns.node_id=$1",
        [id],
      )) {
        result.push({
          source_name: row.name,
          is_present: row.is_present,
          aliases: JSON.parse(
            Buffer.from(blob(row.aliases_data)).toString("utf8"),
          ),
        });
      }
      return json(result);
    }
    const nodeMatch = /^\/api\/nodes\/([^/]+)$/.exec(path);
    if (nodeMatch) {
      const id = uuid(nodeMatch[1]);
      if (method === "PATCH") {
        const data = await body(request);
        if (typeof data.enabled !== "boolean")
          throw new SafeError("INVALID_REQUEST", 422);
        const changed = await rows(
          "UPDATE nodes SET enabled=$2 WHERE id=$1 RETURNING id",
          [id, data.enabled],
        );
        if (!changed.length) throw new SafeError("NODE_NOT_FOUND", 404);
        return json({ status: "UPDATED" });
      }
      if (method === "GET") {
        const node = (await page({ id }, "short_id:asc", 0, 1)).items[0];
        if (!node) throw new SafeError("NODE_NOT_FOUND", 404);
        return json({
          ...node,
          sources: await rows(
            "SELECT ns.source_id,ns.is_present,ns.first_seen_at,ns.last_seen_at,s.name,s.enabled,(s.deleted_at IS NOT NULL) AS deleted FROM node_sources ns JOIN sources s ON s.id=ns.source_id WHERE ns.node_id=$1 ORDER BY s.name",
            [id],
          ),
          published_observation:
            (
              await rows(
                "SELECT r.* FROM node_current_status c JOIN test_results r ON r.id=c.last_result_id WHERE c.node_id=$1",
                [id],
              )
            )[0] ?? null,
          history: await rows(
            "SELECT * FROM test_results WHERE node_id=$1 ORDER BY checked_at DESC,id DESC LIMIT 100",
            [id],
          ),
        });
      }
    }
    if (path === "/api/sources" && method === "GET")
      return json(
        await rows(
          `SELECT ${sourceColumns},CASE WHEN detected_kind='UNKNOWN' AND type='SUBSCRIPTION_URL'
              AND convert_from(url_data,'UTF8') ~ '/api/subs/?([?#].*)?$' THEN 'SUBSTORE'
              ELSE nodema_source_kind(kind,detected_kind) END AS effective_kind,
            (SELECT count(*)::int FROM node_sources ns WHERE ns.source_id=sources.id) AS node_count,
            (SELECT count(*)::int FROM node_sources ns WHERE ns.source_id=sources.id AND ns.is_present) AS present_count,
            (SELECT count(*)::int FROM node_sources ns JOIN node_current_status c ON c.node_id=ns.node_id
              WHERE ns.source_id=sources.id AND c.status IN ('UP','DEGRADED')) AS up_count
           FROM sources WHERE deleted_at IS NULL ORDER BY created_at,id`,
        ),
      );
    const sourceInput = async (id: string, type: string, data: string) => {
      if (!data.trim()) throw new SafeError("EMPTY_INPUT");
      if (new TextEncoder().encode(data).length > 10485760)
        throw new SafeError("INPUT_TOO_LARGE", 413);
      if (type === "SUBSCRIPTION_URL") {
        return [Buffer.from(subscriptionURL(data), "utf8"), null];
      }
      return [null, Buffer.from(data, "utf8")];
    };
    if (path === "/api/sources" && method === "POST") {
      const data = await body(request),
        type = text(data.type);
      if (
        ![
          "SUBSCRIPTION_URL",
          "SINGLE_URI",
          "UPLOADED_FILE",
          "RAW_TEXT",
        ].includes(type)
      )
        throw new SafeError("INVALID_SOURCE_TYPE_OR_FORMAT");
      const id = crypto.randomUUID(),
        [url, payload] = await sourceInput(id, type, text(data.payload));
      const saved = (
        await rows(
          `INSERT INTO sources(id,name,type,format_hint,url_data,payload_data,kind,user_agent,sync_requested_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW()) RETURNING ${sourceColumns}`,
          [
            id,
            label(data.name),
            type,
            formatHint(data.format_hint),
            url,
            payload,
            sourceKind(data.kind),
            userAgent(data.user_agent),
          ],
        )
      )[0];
      return json({ ...saved, pipeline: MANUAL_PIPELINE }, 201);
    }
    if (path === "/api/sources/bulk" && method === "POST") {
      const result = await importLinks(rows, await body(request));
      return json({
        ...result,
        pipeline: result.created
          ? MANUAL_PIPELINE
          : { dispatched: false, reason: "NO_NEW_SOURCES" },
      });
    }
    const sourceMatch = /^\/api\/sources\/([^/]+)(\/sync)?$/.exec(path);
    if (sourceMatch) {
      if (sourceMatch[2] && method !== "POST")
        throw new SafeError("NOT_FOUND", 404);
      const id = uuid(sourceMatch[1]),
        existing = await source(id);
      if (sourceMatch[2] && method === "POST") {
        if (!existing.enabled) throw new SafeError("SOURCE_DISABLED");
        await rows(
          "UPDATE sources SET sync_requested_at=NOW(),updated_at=NOW(),revision=revision+1 WHERE id=$1 AND enabled AND deleted_at IS NULL",
          [id],
        );
        return json({ status: "REQUESTED", ...MANUAL_PIPELINE }, 202);
      }
      if (method === "GET")
        return json({
          ...existing,
          ...(
            await rows(
              "SELECT count(*)::int AS linked_nodes,count(*) FILTER(WHERE ns.is_present)::int AS present_nodes,count(*) FILTER(WHERE ns.is_present AND n.enabled)::int AS enabled_nodes FROM node_sources ns JOIN nodes n ON n.id=ns.node_id WHERE ns.source_id=$1",
              [id],
            )
          )[0],
        });
      if (method === "DELETE") {
        await rows(
          "UPDATE sources SET deleted_at=NOW(),updated_at=NOW(),enabled=false,revision=revision+1 WHERE id=$1",
          [id],
        );
        return json({ status: "DELETED" });
      }
      if (method === "PATCH") {
        const data = await body(request),
          sets = ["revision=revision+1", "updated_at=NOW()"],
          values: unknown[] = [id];
        const set = (key: string, value: unknown) => {
          values.push(value);
          sets.push(`${key}=$${values.length}`);
        };
        if ("name" in data) set("name", label(data.name));
        if ("enabled" in data) {
          if (typeof data.enabled !== "boolean")
            throw new SafeError("INVALID_REQUEST", 422);
          set("enabled", data.enabled);
        }
        if ("sync_interval_seconds" in data) {
          if (
            !Number.isInteger(data.sync_interval_seconds) ||
            Number(data.sync_interval_seconds) <= 0
          )
            throw new SafeError("INVALID_SYNC_INTERVAL");
          set("sync_interval_seconds", data.sync_interval_seconds);
        }
        if ("format_hint" in data)
          set("format_hint", formatHint(data.format_hint));
        if ("kind" in data) set("kind", sourceKind(data.kind));
        if ("user_agent" in data) set("user_agent", userAgent(data.user_agent));
        if ("provider_id" in data) {
          if (data.provider_id === null) set("provider_id", null);
          else if (typeof data.provider_name === "string") {
            // Move this link to a new airport group in one step.
            const created = await rows(
              "INSERT INTO providers(id,name) VALUES($1,$2) RETURNING id",
              [crypto.randomUUID(), providerName(data.provider_name)],
            );
            set("provider_id", created[0].id);
          } else {
            const target = uuid(String(data.provider_id));
            if (!(await rows("SELECT id FROM providers WHERE id=$1", [target])).length)
              throw new SafeError("PROVIDER_NOT_FOUND", 404);
            set("provider_id", target);
          }
        }
        if ("payload" in data) {
          const [url, payload] = await sourceInput(
            id,
            String(existing.type),
            text(data.payload),
          );
          set("url_data", url);
          set("payload_data", payload);
          sets.push("content_hash=NULL");
        }
        if ("payload" in data || "format_hint" in data)
          sets.push(
            "applied_hash=NULL",
            "parser_version=NULL",
            "last_sync_status='NEVER'",
            "last_error_code=NULL",
            "last_parse_summary='{}'::jsonb",
          );
        const needsSync =
          "payload" in data || "format_hint" in data || data.enabled === true;
        if (needsSync) sets.push("sync_requested_at=NOW()");
        const saved = (
          await rows(
            `UPDATE sources SET ${sets.join(",")} WHERE id=$1 AND deleted_at IS NULL RETURNING ${sourceColumns}`,
            values,
          )
        )[0];
        return json({
          ...saved,
          ...(needsSync && saved.enabled ? { pipeline: MANUAL_PIPELINE } : {}),
        });
      }
    }
    if (path === "/api/scans") {
      if (method === "GET")
        return json(
          await rows(
            "SELECT id,scan_date::text AS scan_date,kind,scope,status,node_count,shard_count,started_at,finished_at,error_summary,archived_at,archive_summary FROM scan_runs ORDER BY scan_date DESC,started_at DESC LIMIT 100",
          ),
        );

    }
    const scanMatch = /^\/api\/scans\/([^/]+)(\/retry)?$/.exec(path);
    if (scanMatch) {
      if (scanMatch[2] && method !== "POST")
        throw new SafeError("NOT_FOUND", 404);
      const id = uuid(scanMatch[1]),
        run = (
          await rows(
            "SELECT id,scan_date::text AS scan_date,kind,scope,status,node_count,shard_count,started_at,finished_at,error_summary,archived_at,archive_summary FROM scan_runs WHERE id=$1",
            [id],
          )
        )[0];
      if (!run) throw new SafeError("SCAN_NOT_FOUND", 404);
      if (scanMatch[2] && run.archived_at)
        throw new SafeError("SCAN_ARCHIVED", 410);
      if (scanMatch[2] && method === "POST")
        return json(
          run.status === "COMPLETED"
            ? { dispatched: false, reason: "ALREADY_COMPLETED" }
            : await dispatch(env, "daily-check.yml", {
                run_id: id,
                scope: String(run.scope ?? "ALL"),
              }),
        );
      if (method === "GET") {
        const items = await rows(
          "SELECT status,count(*)::int AS count FROM scan_items WHERE scan_run_id=$1 GROUP BY status",
          [id],
        );
        return json({
          ...run,
          shards: await rows(
            "SELECT shard_no,status,planned_count,completed_count,failed_count,last_heartbeat_at,started_at,finished_at,error_summary FROM scan_shards WHERE scan_run_id=$1 ORDER BY shard_no",
            [id],
          ),
          items: run.archived_at
            ? ((run.archive_summary as Row)?.items ?? {})
            : Object.fromEntries(items.map((r) => [String(r.status), r.count])),
        });
      }
    }
    if (path === "/api/naming-rules" && method === "GET")
      return json({
        template: await template(),
        history: await rows(
          "SELECT * FROM naming_revisions ORDER BY created_at DESC LIMIT 50",
        ),
      });
    if (
      path.startsWith("/api/naming-rules") &&
      ["POST", "PUT"].includes(method)
    ) {
      const data = await body(request),
        tpl = text(data.template);
      // PostgreSQL renders every production name; validate with the same function.
      await rows(
        "SELECT nodema_validate_template($1)",
        [tpl],
        "INVALID_NAME_TEMPLATE",
      );
      if (path.endsWith("/preview"))
        return json(
          (
            await catalogPage(
              rows,
              tpl,
              number(env.FRESHNESS_HOURS, 36),
              {},
              "short_id:asc",
              0,
              20,
            )
          ).items.map((n) => ({ id: n.id, name: n.name })),
        );
      await db.query("BEGIN");
      try {
        await rows(
          "INSERT INTO naming_rules(id,template) VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET template=excluded.template,updated_at=NOW()",
          [tpl],
        );
        await rows("INSERT INTO naming_revisions(id,template) VALUES($1,$2)", [
          crypto.randomUUID(),
          tpl,
        ]);
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }
      return json({ template: tpl });
    }

    throw new SafeError("NOT_FOUND", 404);
  } catch (error) {
    return error instanceof SafeError
      ? Response.json(
          { error_code: error.code },
          {
            status: error.status,
            headers: {
              ...securityHeaders,
              ...(error.code === "EXPORT_PENDING"
                ? { "Retry-After": "60" }
                : {}),
            },
          },
        )
      : json({ error_code: "OPERATION_FAILED" }, 500);
  } finally {
    if (catalogChanged && wakeExports) {
      try {
        await wakeExports();
      } catch {
        /* Requests remain persisted for retry/daily recovery. */
      }
    }
    if (db)
      try {
        await db.end();
      } catch {
        /* never emit credential-bearing driver errors */
      }
  }
}
export default {
  fetch(request: Request, env: Env) {
    return handle(request, env);
  },
} satisfies ExportedHandler<Env>;
