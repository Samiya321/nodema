import { SafeError } from "./crypto.js";
import type { Row, Rows } from "./catalog.js";

const preferences = [
  "preferred_entry_countries",
  "preferred_exit_countries",
  "preferred_entry_asns",
  "preferred_exit_asns",
  "preferred_protocols",
];
const operators = ["GENERAL", "CT", "CU", "CM"];
const protocols = [
  "shadowsocks",
  "trojan",
  "anytls",
  "hysteria2",
  "vmess",
  "vless",
];
const invalid = (code: string): never => {
  throw new SafeError(code);
};
const object = (value: unknown): value is Row =>
  !!value && typeof value === "object" && !Array.isArray(value);
const label = (value: unknown, max = 40): value is string =>
  typeof value === "string" &&
  [...value].length > 0 &&
  [...value].length <= max &&
  !value.includes("://") &&
  !/[\x00-\x1f\x7f]/.test(value);

export function validatePolicy(value: unknown): Row {
  const code = "INVALID_QUALITY_POLICY";
  if (
    !object(value) ||
    Object.keys(value).some(
      (k) =>
        ![
          ...preferences,
          "min_samples",
          "poor_success_rate",
          "evidence_max_age_days",
          "operator_preferences",
        ].includes(k),
    )
  )
    return invalid(code);
  const policy: Row = {
    min_samples: 3,
    poor_success_rate: 0.8,
    evidence_max_age_days: 90,
    ...Object.fromEntries(preferences.map((k) => [k, []])),
    operator_preferences: {},
    ...structuredClone(value),
  };
  for (const [key, low, high] of [
    ["min_samples", 1, 7],
    ["evidence_max_age_days", 1, 365],
  ] as const)
    if (
      !Number.isInteger(policy[key]) ||
      Number(policy[key]) < low ||
      Number(policy[key]) > high
    )
      return invalid(code);
  const rate = policy.poor_success_rate;
  if (
    typeof rate !== "number" ||
    !Number.isFinite(rate) ||
    rate < 0 ||
    rate > 1
  )
    return invalid(code);
  const ops = policy.operator_preferences;
  if (!object(ops) || Object.keys(ops).some((k) => !operators.includes(k)))
    return invalid(code);
  for (const pref of [policy, ...Object.values(ops)]) {
    if (
      !object(pref) ||
      (pref !== policy &&
        Object.keys(pref).some((k) => !preferences.includes(k)))
    )
      return invalid(code);
    for (const key of preferences) {
      const values = Object.hasOwn(pref, key) ? pref[key] : [];
      if (!Array.isArray(values) || values.length > 100) return invalid(code);
      for (const item of values) {
        const valid = key.endsWith("countries")
          ? typeof item === "string" && /^[A-Z]{2}$/.test(item)
          : key.endsWith("asns")
            ? Number.isInteger(item) &&
              typeof item === "number" &&
              item >= 0 &&
              item <= 4294967295
            : typeof item === "string" && protocols.includes(item);
        if (!valid) return invalid(code);
      }
      if (Object.hasOwn(pref, key))
        pref[key] = [...new Set(values)].sort((a, b) =>
          typeof a === "number" ? a - b : a.localeCompare(b),
        );
    }
  }
  return policy;
}

export function validateAnnotation(value: unknown): Row {
  const code = "INVALID_NODE_ANNOTATION";
  if (
    !object(value) ||
    Object.keys(value).some(
      (k) =>
        ![
          "tags",
          "line_claim",
          "evidence_level",
          "manual_priority",
          "operators",
          "reference",
        ].includes(k),
    )
  )
    return invalid(code);
  const data = structuredClone(value);
  for (const [key, allowed] of Object.entries({
    line_claim: ["UNKNOWN", "IPLC", "IEPL", "CN2", "OTHER"],
    evidence_level: ["NONE", "DECLARED", "DOCUMENTED"],
    manual_priority: ["NONE", "P1", "P2", "P3"],
  }))
    if (
      key in data &&
      (typeof data[key] !== "string" || !allowed.includes(data[key]))
    )
      return invalid(code);
  for (const key of ["tags", "operators"])
    if (key in data) {
      const items = data[key];
      if (
        !Array.isArray(items) ||
        items.length > 16 ||
        items.some((v) => !label(v))
      )
        return invalid(code);
      if (
        key === "operators" &&
        (!items.length || items.some((v) => !operators.includes(v)))
      )
        return invalid(code);
      data[key] = [...new Set(items)].sort();
    }
  if (
    "reference" in data &&
    data.reference !== null &&
    (typeof data.reference !== "string" ||
      !data.reference.length ||
      [...data.reference].length > 2000 ||
      /[\x00-\x1f\x7f]/.test(data.reference))
  )
    return invalid(code);
  return data;
}

export async function qualityPolicy(rows: Rows) {
  return {
    ...(
      await rows(
        "SELECT version,policy,updated_at FROM quality_policies WHERE id=1",
      )
    )[0],
    history: await rows(
      "SELECT version,policy,created_at FROM quality_policy_revisions ORDER BY version DESC LIMIT 50",
    ),
  };
}

export async function saveQualityPolicy(
  rows: Rows,
  transact: (sql: string) => Promise<unknown>,
  data: Row,
) {
  if (
    Object.keys(data).some((k) => !["policy", "expected_version"].includes(k))
  )
    return invalid("INVALID_QUALITY_POLICY");
  const policy = validatePolicy(data.policy);
  await transact("BEGIN");
  try {
    const current = (
      await rows("SELECT version FROM quality_policies WHERE id=1 FOR UPDATE")
    )[0];
    if (
      data.expected_version !== undefined &&
      (!Number.isInteger(data.expected_version) ||
        data.expected_version !== current.version)
    )
      throw new SafeError("QUALITY_POLICY_CONFLICT", 409);
    const updated = (
      await rows(
        "UPDATE quality_policies SET policy=$1::jsonb,version=version+1,updated_at=NOW() WHERE id=1 RETURNING version",
        [JSON.stringify(policy)],
      )
    )[0];
    await rows(
      "INSERT INTO quality_policy_revisions(version,policy) VALUES($1,$2::jsonb)",
      [updated.version, JSON.stringify(policy)],
    );
    await transact("COMMIT");
  } catch (error) {
    await transact("ROLLBACK");
    throw error;
  }
  return qualityPolicy(rows);
}

export async function annotation(rows: Rows, id: string) {
  const row = (
    await rows(
      `SELECT coalesce(a.tags,'[]') AS tags,coalesce(a.line_claim,'UNKNOWN') AS line_claim,
    coalesce(a.evidence_level,'NONE') AS evidence_level,coalesce(a.manual_priority,'NONE') AS manual_priority,
    coalesce(a.operators,'["GENERAL"]') AS operators,(a.reference_data IS NOT NULL) AS has_evidence,
    a.evidence_updated_at,a.updated_at FROM nodes n LEFT JOIN node_annotations a ON a.node_id=n.id WHERE n.id=$1`,
      [id],
    )
  )[0];
  if (!row) throw new SafeError("NODE_NOT_FOUND", 404);
  return row;
}

export async function annotate(
  rows: Rows,
  transact: (sql: string) => Promise<unknown>,
  id: string,
  value: Row,
) {
  const data = validateAnnotation(value);
  await transact("BEGIN");
  try {
    if (
      !(await rows("SELECT id FROM nodes WHERE id=$1 FOR UPDATE", [id])).length
    )
      throw new SafeError("NODE_NOT_FOUND", 404);
    await rows(
      "INSERT INTO node_annotations(node_id) VALUES($1) ON CONFLICT DO NOTHING",
      [id],
    );
    const sets: string[] = ["updated_at=NOW()"],
      values: unknown[] = [id];
    for (const [key, val] of Object.entries(data)) {
      if (key === "reference") {
        values.push(
          val
            ? Buffer.from(
                String(val), "utf8",
              )
            : null,
        );
        sets.push(
          `reference_data=$${values.length}`,
          `evidence_updated_at=${val ? "NOW()" : "NULL"}`,
        );
      } else {
        values.push(
          ["tags", "operators"].includes(key) ? JSON.stringify(val) : val,
        );
        sets.push(
          `${key}=$${values.length}${["tags", "operators"].includes(key) ? "::jsonb" : ""}`,
        );
      }
    }
    await rows(
      `UPDATE node_annotations SET ${sets.join(",")} WHERE node_id=$1`,
      values,
    );
    const saved = await annotation(rows, id);
    if (saved.evidence_level === "DOCUMENTED" && !saved.has_evidence)
      throw new SafeError("EVIDENCE_REFERENCE_REQUIRED");
    await transact("COMMIT");
  } catch (error) {
    await transact("ROLLBACK");
    throw error;
  }
  return annotation(rows, id);
}
