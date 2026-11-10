import { SafeError } from "./crypto.js";
type Row = Record<string, unknown>;
type Rows = (sql: string, values?: unknown[]) => Promise<Row[]>;
export const counters = [
  "full_checks",
  "full_samples",
  "preflight_skips",
  "cooldown_skips",
  "dns_requests",
  "dns_cache_hits",
  "tcp_probes",
  "tcp_socket_attempts",
  "tcp_cache_hits",
  "runtime_starts",
  "runtime_reloads",

  "check_count",
  "check_duration_ms",
  "timeout_checks",
  "echo_requests",
  "echo_failures",
  "echo_response_bytes",
  "source_requests",
  "source_response_bytes",
  "subscription_downloads",
  "subscription_bytes",
  "network_samples",
  "network_rx_bytes",
  "network_tx_bytes",
];
const sums = counters
  .map((k) => `COALESCE(SUM(${k}),0)::bigint AS ${k}`)
  .join(",");
function numeric(row: Row, keys: string[]): Row {
  const result = { ...row };
  for (const key of keys) {
    const value = Number(row[key]);
    if (!Number.isSafeInteger(value) || value < 0)
      throw new SafeError("INVALID_USAGE_VALUE", 500);
    result[key] = value;
  }
  return result;
}
export async function usageSummary(rows: Rows, days: number) {
  if (!Number.isInteger(days) || days < 1 || days > 365)
    throw new SafeError("INVALID_USAGE_WINDOW", 422);
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - days + 1);
  const totals = numeric(
    (
      await rows(`SELECT ${sums} FROM usage_events WHERE started_at >= $1`, [
        since,
      ])
    )[0],
    counters,
  );
  const daily = (
    await rows(
      `SELECT (started_at AT TIME ZONE 'UTC')::date::text AS day,${sums} FROM usage_events WHERE started_at >= $1 GROUP BY day ORDER BY day`,
      [since],
    )
  ).map((r) => numeric(r, counters));
  const health = (
    await rows(
      `SELECT COUNT(*)::int AS attempts,COUNT(DISTINCT node_id)::int AS nodes,
   COUNT(*) FILTER(WHERE jsonb_array_length(timeout_stages)>0)::int AS timeout_attempts,
   COUNT(*) FILTER(WHERE status='ENVIRONMENT_ERROR')::int AS environment_attempts,
   ROUND(AVG(check_duration_ms),2) AS mean_check_ms FROM test_results WHERE checked_at >= $1`,
      [since],
    )
  )[0];
  health.mean_check_ms =
    health.mean_check_ms === null ? null : Number(health.mean_check_ms);
  health.timeout_ratio = Number(health.attempts)
    ? Number(health.timeout_attempts) / Number(health.attempts)
    : null;
  const executions = (
    await rows(
      `SELECT COUNT(*)::int AS executions,
   COUNT(*) FILTER(WHERE u.outcome='ENVIRONMENT_ERROR' OR (u.outcome='RUNNING' AND
     (s.lease_owner IS DISTINCT FROM u.id OR s.lease_until<NOW())))::int AS failed_executions,
   COUNT(*) FILTER(WHERE u.outcome='COMPLETED')::int AS completed_executions
   FROM usage_events u LEFT JOIN scan_shards s ON s.scan_run_id=u.scan_run_id AND s.shard_no=u.shard_no
   WHERE u.kind='CHECK' AND u.started_at >= $1`,
      [since],
    )
  )[0];
  const ended =
    Number(executions.completed_executions) +
    Number(executions.failed_executions);
  executions.failure_ratio = ended
    ? Number(executions.failed_executions) / ended
    : null;
  const actions = (
    await rows(
      "SELECT * FROM action_runs WHERE started_at >= $1 ORDER BY started_at DESC LIMIT 1000",
      [since],
    )
  ).map((r) =>
    numeric(r, [
      "run_id",
      "attempt",
      "runner_ms",
      "job_count",
      "failed_jobs",
      "unmeasured_jobs",
    ]),
  );
  const runner = (
    await rows(
      "SELECT COALESCE(SUM(runner_ms),0)/60000.0 AS minutes FROM action_runs WHERE started_at >= $1",
      [since],
    )
  )[0];
  const samples = (
    await rows(
      "SELECT * FROM database_samples WHERE taken_at >= $1 ORDER BY taken_at DESC LIMIT 1000",
      [since],
    )
  ).map((r) => numeric(r, ["database_bytes", "table_bytes", "connections"]));
  const first = (
    await rows(
      "SELECT table_bytes FROM database_samples WHERE taken_at >= $1 ORDER BY taken_at LIMIT 1",
      [since],
    )
  )[0];
  const recent = (
    await rows(
      `SELECT u.id,u.kind,u.started_at,u.updated_at,u.finished_at,
       CASE WHEN u.kind='CHECK' AND u.outcome='RUNNING' AND
        (s.lease_owner IS DISTINCT FROM u.id OR s.lease_until<NOW())
        THEN 'INTERRUPTED' ELSE u.outcome END AS outcome,
       u.scan_run_id,u.shard_no,${counters.map((k) => "u." + k).join(",")}
       FROM usage_events u LEFT JOIN scan_shards s
        ON s.scan_run_id=u.scan_run_id AND s.shard_no=u.shard_no
       WHERE u.started_at >= $1 ORDER BY u.started_at DESC LIMIT 100`,
      [since],
    )
  ).map((r) => numeric(r, counters));
  return {
    days,
    since,
    timezone: "UTC",
    totals,
    daily,
    health,
    executions,
    action_runs: actions,
    database_samples: samples,
    runner_minutes: Number(runner.minutes),
    database_growth_bytes:
      samples.length > 1
        ? Number(samples[0].table_bytes) - Number(first.table_bytes)
        : null,
    recent,
  };
}
