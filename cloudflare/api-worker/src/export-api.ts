import { SafeError, digest, equal, token } from "./crypto.js";
import type { Rows, Row } from "./catalog.js";

export const exportFormats: Record<string, [string, string]> = {
  mihomo: ["text/yaml", "yaml"],
  singbox: ["application/json", "json"],
  uri: ["text/plain", "txt"],
  json: ["application/json", "json"],
  csv: ["text/csv", "csv"],
};
const idValue = (value: string) => {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new SafeError("INVALID_ID");
  return value;
};
const object = (value: unknown): Row => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SafeError("INVALID_EXPORT_FILTER");
  return value as Row;
};
const nameValue = (value: unknown) => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 80 ||
    /[\x00-\x1f]/.test(value)
  )
    throw new SafeError("INVALID_EXPORT_NAME");
  return value.trim();
};
const expiry = (value: unknown) => {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 8760)
    throw new SafeError("INVALID_EXPORT_EXPIRY");
  return new Date(Date.now() + Number(value) * 3600000).toISOString();
};
export type ExportContext = {
  rows: Rows;
  transact: (sql: string) => Promise<unknown>;
  body: (request: Request) => Promise<Row>;
  queue: () => Promise<Row>;
  headers: Record<string, string>;
};

export async function handleExports(
  request: Request,
  ctx: ExportContext,
): Promise<Response | null> {
  const url = new URL(request.url),
    path = url.pathname,
    method = request.method;
  if (
    path !== "/api/exports" &&
    !path.startsWith("/api/exports/") &&
    !path.startsWith("/subscriptions/")
  )
    return null;
  const { rows, transact } = ctx;
  const json = (value: unknown, status = 200) =>
    Response.json(value, { status, headers: ctx.headers });
  const metadata = async (id?: string) =>
    (
      await rows("SELECT nodema_export_metadata($1::uuid) AS metadata", [
        id ?? null,
      ])
    ).map((row) => row.metadata as Row);
  const get = async (id: string) => {
    const result = (await metadata(id))[0];
    if (!result) throw new SafeError("EXPORT_NOT_AVAILABLE", 404);
    return result;
  };
  const validate = async (format: unknown, filters: unknown) => {
    if (typeof format !== "string" || !Object.hasOwn(exportFormats, format))
      throw new SafeError("INVALID_EXPORT_FORMAT");
    return (
      await rows(
        "SELECT nodema_validate_export($1,$2::jsonb) AS filters",
        [format, JSON.stringify(object(filters))],
        "INVALID_EXPORT_FILTER",
      )
    )[0].filters;
  };
  const transaction = async <T>(action: () => Promise<T>): Promise<T> => {
    await transact("BEGIN");
    try {
      const result = await action();
      await transact("COMMIT");
      return result;
    } catch (e) {
      await transact("ROLLBACK");
      throw e;
    }
  };
  if (path.startsWith("/subscriptions/")) {
    if (method !== "GET") throw new SafeError("NOT_FOUND", 404);
    const id = idValue(path.slice("/subscriptions/".length));
    const saved = (
      await rows(
        "SELECT token_hash,revoked_at,expires_at,current_version,request_revision,payload_hash,built_at,nodema_export_serving(e) AS serving FROM export_artifacts e WHERE id=$1",
        [id],
      )
    )[0];
    const supplied = Buffer.from(
      await digest(url.searchParams.get("token") ?? ""),
    ).toString("hex");
    if (
      !saved ||
      saved.revoked_at ||
      (saved.expires_at &&
        new Date(String(saved.expires_at)).getTime() <= Date.now()) ||
      !(await equal(
        Buffer.from(saved.token_hash as Uint8Array).toString("hex"),
        supplied,
      ))
    )
      throw new SafeError("EXPORT_NOT_AVAILABLE", 404);
    if (!saved.serving) throw new SafeError("EXPORT_PENDING", 503);
    const etag = '"' + saved.payload_hash + '"';
    const headers = {
      ...ctx.headers,
      ETag: etag,
      "X-Export-Version": String(saved.current_version),
      "Last-Modified": new Date(String(saved.built_at)).toUTCString(),
    };
    if (
      (request.headers.get("If-None-Match") ?? "")
        .split(",")
        .some(
          (item) =>
            item.trim().replace(/^W\//, "") === etag || item.trim() === "*",
        )
    )
      return new Response(null, { status: 304, headers });
    const version = (
      await rows(
        "SELECT format,convert_from(payload_data,'UTF8') AS payload_text,payload_bytes FROM export_artifacts e WHERE id=$1 AND current_version=$2 AND request_revision=$3 AND token_hash=$4 AND payload_bytes BETWEEN 0 AND 10485760 AND octet_length(payload_data)=payload_bytes AND nodema_export_serving(e)",
        [id, saved.current_version, saved.request_revision, saved.token_hash],
      )
    )[0];
    if (!version) throw new SafeError("EXPORT_PENDING", 503);
    const data = version.payload_text;
    if (
      typeof data !== "string" ||
      Buffer.byteLength(data, "utf8") !== Number(version.payload_bytes) ||
      Number(version.payload_bytes) > 10485760
    )
      throw new SafeError("STORED_DATA_INVALID", 500);
    try {
      await rows(
        "INSERT INTO usage_events(id,kind,entity_id,outcome,finished_at,subscription_downloads,subscription_bytes) VALUES($1,'SUBSCRIPTION',$2,'COMPLETED',NOW(),1,$3)",
        [crypto.randomUUID(), id, Number(version.payload_bytes)],
      );
    } catch {
      /* Optional telemetry never blocks delivery. */
    }
    const [mime, suffix] = exportFormats[String(version.format)];
    return new Response(data, {
      headers: {
        ...headers,
        "Content-Type": mime,
        "Content-Disposition": `attachment; filename="nodes.${suffix}"`,
      },
    });
  }
  if (path === "/api/exports") {
    if (method === "GET") return json(await metadata());
    if (method === "POST") {
      const input = await ctx.body(request);
      if (
        Object.keys(input).some(
          (key) =>
            !["name", "format", "filters", "expires_in_hours"].includes(key),
        )
      )
        throw new SafeError("INVALID_EXPORT_FILTER");
      const id = crypto.randomUUID(),
        secret = token(),
        name = nameValue(input.name ?? "Subscription"),
        expires = expiry(input.expires_in_hours);
      await transaction(async () => {
        const filters = await validate(input.format, input.filters ?? {});
        await rows("SELECT nodema_export_lock()");
        await rows(
          "DELETE FROM export_artifacts WHERE revoked_at IS NOT NULL OR expires_at<=NOW()",
        );
        const limits = (
          await rows(
            "SELECT max_profiles,(SELECT count(*)::int FROM export_artifacts) AS count FROM catalog_state WHERE id=1",
          )
        )[0];
        if (Number(limits.count) >= Number(limits.max_profiles))
          throw new SafeError("EXPORT_PROFILE_LIMIT");
        await rows(
          "INSERT INTO export_artifacts(id,name,format,filter_spec,expires_at,token_hash,token_value) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7)",
          [
            id,
            name,
            input.format,
            JSON.stringify(filters),
            expires,
            Buffer.from(await digest(secret)),
            secret,
          ],
        );
      });
      return json(
        { ...(await get(id)), token: secret, pipeline: await ctx.queue() },
        202,
      );
    }
  }
  const match =
    /^\/api\/exports\/([^/]+)(?:\/(retry|link|token|versions))?$/.exec(path);
  if (!match) throw new SafeError("NOT_FOUND", 404);
  const id = idValue(match[1]),
    action = match[2];
  if (!action && method === "GET") return json(await get(id));
  if (!action && method === "DELETE") {
    if (
      !(
        await rows(
          "UPDATE export_artifacts SET revoked_at=NOW(),lease_owner=NULL,lease_until=NULL WHERE id=$1 RETURNING id",
          [id],
        )
      ).length
    )
      throw new SafeError("EXPORT_NOT_AVAILABLE", 404);
    return json({ status: "REVOKED" });
  }
  if (!action && method === "PATCH") {
    const input = await ctx.body(request);
    if (
      Object.keys(input).some(
        (key) =>
          ![
            "name",
            "format",
            "filters",
            "expires_in_hours",
            "expected_revision",
          ].includes(key),
      )
    )
      throw new SafeError("INVALID_EXPORT_FILTER");
    await transaction(async () => {
      const old = (
        await rows(
          "SELECT format,filter_spec,request_revision,revoked_at FROM export_artifacts WHERE id=$1 FOR UPDATE",
          [id],
        )
      )[0];
      if (!old || old.revoked_at)
        throw new SafeError("EXPORT_NOT_AVAILABLE", 404);
      if (
        input.expected_revision !== undefined &&
        (!Number.isSafeInteger(input.expected_revision) ||
          input.expected_revision !== Number(old.request_revision))
      )
        throw new SafeError("EXPORT_REVISION_CONFLICT", 409);
      const sets: string[] = [],
        values: unknown[] = [id];
      const set = (key: string, value: unknown) => {
        values.push(value);
        sets.push(`${key}=$${values.length}`);
      };
      if ("name" in input) set("name", nameValue(input.name));
      if ("expires_in_hours" in input)
        set("expires_at", expiry(input.expires_in_hours));
      if ("format" in input || "filters" in input) {
        const format = input.format ?? old.format,
          filters = await validate(format, input.filters ?? old.filter_spec);
        set("format", format);
        set("filter_spec", JSON.stringify(filters));
      }
      if (sets.length)
        await rows(
          `UPDATE export_artifacts SET ${sets.join(",")} WHERE id=$1`,
          values,
        );
    });
    return json({ ...(await get(id)), pipeline: await ctx.queue() }, 202);
  }
  if (action === "retry" && method === "POST") {
    const current = await get(id);
    if (["REVOKED", "EXPIRED"].includes(String(current.status)))
      throw new SafeError("EXPORT_NOT_AVAILABLE", 404);
    await rows(
      "UPDATE export_artifacts SET status='PENDING',requested_at=NOW(),error_code=NULL WHERE id=$1 AND (status<>'BUILDING' OR lease_until IS NULL OR lease_until<=NOW())",
      [id],
    );
    return json({ ...(await get(id)), pipeline: await ctx.queue() }, 202);
  }
  if (action === "versions" && method === "GET") {
    await get(id);
    return json(
      await rows(
        "SELECT version_no,request_revision,catalog_revision,created_at,valid_until,node_count,payload_bytes,payload_hash,format,filter_spec FROM export_versions WHERE export_id=$1 ORDER BY version_no DESC LIMIT 20",
        [id],
      ),
    );
  }
  if (
    (action === "link" && method === "GET") ||
    (action === "token" && method === "POST")
  ) {
    if (action === "token") {
      const secret = token();
      await rows(
        "UPDATE export_artifacts SET token_value=$2,token_hash=$3 WHERE id=$1 AND revoked_at IS NULL",
        [id, secret, Buffer.from(await digest(secret))],
      );
    }
    const saved = (
      await rows(
        "SELECT token_value,revoked_at FROM export_artifacts WHERE id=$1",
        [id],
      )
    )[0];
    if (!saved || saved.revoked_at)
      throw new SafeError("EXPORT_NOT_AVAILABLE", 404);
    if (!saved.token_value) throw new SafeError("EXPORT_TOKEN_LEGACY", 409);
    return json({ id, token: saved.token_value });
  }
  throw new SafeError("NOT_FOUND", 404);
}
