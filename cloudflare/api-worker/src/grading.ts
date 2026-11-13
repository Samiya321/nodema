// Grading rules (mirrors app/grading.py validate_grading) and the read-only probe
// endpoints. Grades themselves are computed by Actions; the Worker only reads them.
import { SafeError } from "./crypto.js";
import type { Row, Rows } from "./catalog.js";

export const VANTAGES = ["CN-CT", "CN-CU", "CN-CM", "CN", "HK", "SG"];

export const DEFAULT_GRADING = {
  default_vantage: "CN",
  bands: {
    CN: {
      S: { rtt_ms: 80, loss_pct: 1, jitter_ms: 15, peak_rise_pct: 30 },
      A: { rtt_ms: 150, loss_pct: 3 },
      B: { rtt_ms: 250, loss_pct: 8 },
    },
    OVERSEAS: {
      S: { rtt_ms: 30, loss_pct: 0.5, jitter_ms: 10 },
      A: { rtt_ms: 80, loss_pct: 2 },
      B: { rtt_ms: 180, loss_pct: 5 },
    },
  },
  stability_pct: { S: 95, A: 80, B: 60 },
  min_checked_days: 3,
  min_probes: 2,
  s_requires_clean_exit: false,
  probe_enabled: true,
  peak_start: "19:30",
  peak_end: "23:30",
  coverage: "ALL",
};

const LIMITS: Record<string, [number, number]> = {
  rtt_ms: [1, 2000],
  loss_pct: [0, 100],
  jitter_ms: [0, 1000],
  peak_rise_pct: [0, 1000],
};
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const fail = (): never => {
  throw new SafeError("INVALID_GRADING_POLICY", 422);
};
const plain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, low: number, high: number) =>
  typeof v === "number" && Number.isFinite(v) && v >= low && v <= high;
const sameKeys = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => k in v);

export function validateGrading(value: unknown): typeof DEFAULT_GRADING {
  if (!plain(value)) fail();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((k) => !(k in DEFAULT_GRADING))) fail();
  const result = {
    ...structuredClone(DEFAULT_GRADING),
    ...structuredClone(input),
  } as Record<string, unknown>;
  if (!VANTAGES.includes(result.default_vantage as string)) fail();
  if (!["ALL", "EXPORTS"].includes(result.coverage as string)) fail();
  for (const key of ["s_requires_clean_exit", "probe_enabled"])
    if (typeof result[key] !== "boolean") fail();
  if (!Number.isInteger(result.min_checked_days) || !num(result.min_checked_days, 1, 7)) fail();
  if (!Number.isInteger(result.min_probes) || !num(result.min_probes, 1, 5)) fail();
  for (const key of ["peak_start", "peak_end"])
    if (typeof result[key] !== "string" || !TIME.test(result[key] as string)) fail();
  if (result.peak_start === result.peak_end) fail();
  const bands = result.bands;
  if (!plain(bands) || !sameKeys(bands, ["CN", "OVERSEAS"])) fail();
  for (const table of Object.values(bands as Record<string, unknown>)) {
    if (!plain(table) || !sameKeys(table, ["S", "A", "B"])) fail();
    let previous: Record<string, number> | undefined;
    for (const band of ["S", "A", "B"]) {
      const limits = (table as Record<string, unknown>)[band];
      if (!plain(limits)) fail();
      const keys = Object.keys(limits as object);
      const allowed = ["rtt_ms", "loss_pct", "jitter_ms", ...(band === "S" ? ["peak_rise_pct"] : [])];
      if (!("rtt_ms" in (limits as object)) || !("loss_pct" in (limits as object))) fail();
      for (const key of keys) {
        if (!allowed.includes(key)) fail();
        const [low, high] = LIMITS[key];
        if (!num((limits as Record<string, unknown>)[key], low, high)) fail();
      }
      const current = limits as Record<string, number>;
      if (previous && (current.rtt_ms < previous.rtt_ms || current.loss_pct < previous.loss_pct)) fail();
      previous = current;
    }
  }
  const stability = result.stability_pct;
  if (!plain(stability) || !sameKeys(stability, ["S", "A", "B"])) fail();
  const s = stability as Record<string, unknown>;
  if (!["S", "A", "B"].every((k) => num(s[k], 0, 100))) fail();
  if (!((s.S as number) >= (s.A as number) && (s.A as number) >= (s.B as number))) fail();
  return result as typeof DEFAULT_GRADING;
}

function storedPolicy(value: unknown) {
  try {
    return validateGrading(value ?? {});
  } catch {
    return validateGrading({});
  }
}

export async function gradingPolicy(rows: Rows) {
  const row = (await rows("SELECT version,policy,updated_at FROM grading_policy WHERE id=1"))[0];
  return {
    version: row.version,
    policy: storedPolicy(row.policy),
    defaults: DEFAULT_GRADING,
    updated_at: row.updated_at,
    history: await rows(
      "SELECT version,created_at FROM grading_policy_revisions ORDER BY version DESC LIMIT 20",
    ),
  };
}

export async function saveGradingPolicy(
  rows: Rows,
  transact: (sql: string) => Promise<unknown>,
  data: Row,
) {
  if (Object.keys(data).some((k) => !["policy", "expected_version"].includes(k))) fail();
  const policy = validateGrading(data.policy);
  await transact("BEGIN");
  try {
    const current = (await rows("SELECT version FROM grading_policy WHERE id=1 FOR UPDATE"))[0];
    if (
      data.expected_version !== undefined &&
      (!Number.isInteger(data.expected_version) || data.expected_version !== current.version)
    )
      throw new SafeError("GRADING_POLICY_CONFLICT", 409);
    const updated = (
      await rows(
        "UPDATE grading_policy SET policy=$1::jsonb,version=version+1,updated_at=NOW() WHERE id=1 RETURNING version",
        [JSON.stringify(policy)],
      )
    )[0];
    await rows("INSERT INTO grading_policy_revisions(version,policy) VALUES($1,$2::jsonb)", [
      updated.version,
      JSON.stringify(policy),
    ]);
    await transact("COMMIT");
  } catch (error) {
    await transact("ROLLBACK");
    throw error;
  }
  return gradingPolicy(rows);
}

export async function probeStatus(rows: Rows, vantage: string | null) {
  let chosen = vantage;
  if (!chosen) {
    const row = (await rows("SELECT policy FROM grading_policy WHERE id=1"))[0];
    chosen = storedPolicy(row?.policy).default_vantage;
  }
  if (!VANTAGES.includes(chosen)) throw new SafeError("INVALID_NODE_QUERY");
  return (await rows("SELECT nodema_probe_status($1) AS status", [chosen]))[0].status;
}

export async function nodeAccess(rows: Rows, id: string) {
  const result = (await rows("SELECT nodema_node_access($1) AS access", [id]))[0]?.access;
  if (!result) throw new SafeError("NODE_NOT_FOUND", 404);
  return result;
}
