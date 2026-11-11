import { SafeError } from "./crypto.js";

type Row = Record<string, unknown>;
type Rows = (sql: string, values?: unknown[]) => Promise<Row[]>;
type Item = {
  line: number;
  status?: string;
  id?: string;
  name?: string;
  error_code?: string;
  url?: string;
};

export function subscriptionURL(value: string): string {
  // No network requests here. Actions revalidates DNS and each redirect at connection time.
  const text = value.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new SafeError("UNSAFE_SUBSCRIPTION_URL");
  }
  const host = url.hostname;
  const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(host)
    ? host.split(".").map(Number)
    : null;
  const first = host.startsWith("[")
    ? parseInt(host.slice(1).split(":")[0], 16)
    : null;
  if (
    !/^https?:\/\//i.test(text) ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    /[\x00-\x20\x7f\\]/.test(text) ||
    host.includes("%") ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    url.port === "0" ||
    (ipv4 &&
      (ipv4[0] === 0 ||
        ipv4[0] === 10 ||
        ipv4[0] === 127 ||
        ipv4[0] >= 224 ||
        (ipv4[0] === 100 && ipv4[1] >= 64 && ipv4[1] <= 127) ||
        (ipv4[0] === 169 && ipv4[1] === 254) ||
        (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31) ||
        (ipv4[0] === 192 && (ipv4[1] === 168 || ipv4[1] === 0)) ||
        (ipv4[0] === 198 &&
          (ipv4[1] === 18 ||
            ipv4[1] === 19 ||
            (ipv4[1] === 51 && ipv4[2] === 100))) ||
        (ipv4[0] === 203 && ipv4[1] === 0 && ipv4[2] === 113))) ||
    (first !== null &&
      (!(first >= 0x2000 && first < 0x4000) ||
        first === 0x2002 ||
        /^\[2001:(?:[01]?[0-9a-f]{0,2}|db8):/i.test(host) ||
        /^\[3fff:[0-9a-f]{0,3}:/i.test(host)))
  )
    throw new SafeError("UNSAFE_SUBSCRIPTION_URL");
  url.hash = "";
  return url.href;
}

export async function importLinks(rows: Rows, data: Row) {
  if (typeof data.urls !== "string")
    throw new SafeError("INVALID_REQUEST", 422);
  if (Buffer.byteLength(data.urls) > 131072)
    throw new SafeError("INPUT_TOO_LARGE", 413);
  // The dashboard sends long lists in 100-line parts; start_line keeps line numbers
  // (and the names derived from them) continuous across parts.
  const start = data.start_line === undefined ? 1 : data.start_line;
  if (typeof start !== "number" || !Number.isInteger(start) || start < 1 || start > 1e7)
    throw new SafeError("INVALID_REQUEST", 422);
  const lines = data.urls
    .split("\n")
    .map((line, i) => ({ line: start + i, value: line.trim() }))
    .filter((i) => i.value);
  if (!lines.length) throw new SafeError("EMPTY_INPUT");
  if (lines.length > 100) throw new SafeError("TOO_MANY_SUBSCRIPTION_LINKS");
  const prefix = data.name_prefix ?? "批量订阅";
  if (
    typeof prefix !== "string" ||
    !prefix.trim() ||
    prefix.trim().length > 60 ||
    prefix.includes("://") ||
    /[\x00-\x1f]/.test(prefix)
  )
    throw new SafeError("INVALID_SOURCE_LABEL");
  const items: Item[] = lines.map(({ line, value }) => {
    try {
      if (Buffer.byteLength(value) > 8192)
        throw new SafeError("SUBSCRIPTION_URL_TOO_LONG");
      return {
        line,
        url: subscriptionURL(value),
        name: `${prefix.trim()} ${String(line).padStart(3, "0")}`,
      };
    } catch (error) {
      if (!(error instanceof SafeError)) throw error;
      return { line, status: "INVALID", error_code: error.code };
    }
  });
  const valid = items.filter((i) => i.url);
  if (valid.length) {
    await rows("BEGIN");
    try {
      await rows(
        "SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':nodema:source-bulk', 0))",
      );
      const existing = new Map(
        (
          await rows(
            "SELECT id,name,url_data FROM sources WHERE deleted_at IS NULL AND type='SUBSCRIPTION_URL' AND url_data=ANY($1::bytea[]) ORDER BY created_at DESC,id DESC",
            [valid.map((i) => Buffer.from(i.url!))],
          )
        ).map((r) => [Buffer.from(r.url_data as Uint8Array).toString(), r]),
      );
      const pending: Item[] = [];
      for (const item of valid) {
        const old = existing.get(item.url!);
        if (old)
          Object.assign(item, {
            status: "DUPLICATE",
            id: String(old.id),
            name: String(old.name),
          });
        else {
          Object.assign(item, { status: "CREATED", id: crypto.randomUUID() });
          existing.set(item.url!, { id: item.id, name: item.name });
          pending.push(item);
        }
      }
      if (pending.length)
        await rows(
          `INSERT INTO sources(id,name,type,format_hint,url_data,sync_requested_at)
         SELECT x.id::uuid,x.name,'SUBSCRIPTION_URL','AUTO',convert_to(x.url,'UTF8'),NOW()
         FROM jsonb_to_recordset($1::jsonb) AS x(id text,name text,url text)`,
          [
            JSON.stringify(
              pending.map(({ id, name, url }) => ({ id, name, url })),
            ),
          ],
        );
      await rows("COMMIT");
    } catch (error) {
      await rows("ROLLBACK");
      throw error;
    }
  }
  return {
    created: items.filter((i) => i.status === "CREATED").length,
    duplicates: items.filter((i) => i.status === "DUPLICATE").length,
    invalid: items.filter((i) => i.status === "INVALID").length,
    items: items.map(({ url: _url, ...item }) => item),
  };
}
