import type { Rows } from "./catalog.js";

type Run = { id: number; conclusion: string | null; updated_at: string };
type Artifact = { name: string; created_at: string; expires_at: string; expired: boolean };

async function github<T>(env: Env, path: string): Promise<T> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY) || !env.GITHUB_DISPATCH_TOKEN)
    throw new Error("GITHUB_UNAVAILABLE");
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/${path}`, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "nodema",
    },
    signal: AbortSignal.timeout(3500),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("GITHUB_UNAVAILABLE");
  }
  return response.json<T>();
}

export async function latestBackup(env: Env) {
  const branch = encodeURIComponent(env.GITHUB_WORKFLOW_REF);
  const { workflow_runs } = await github<{ workflow_runs: Run[] }>(
    env, `workflows/backup.yml/runs?branch=${branch}&status=success&per_page=5`,
  );
  const artifacts = await Promise.all(workflow_runs.map(async ({ id }) => {
    const { artifacts } = await github<{ artifacts: Artifact[] }>(env, `runs/${id}/artifacts?per_page=5`);
    const artifact = artifacts.find((a) => a.name === `encrypted-database-${id}` && !a.expired);
    return artifact ? { ...artifact, run_id: id } : null;
  }));
  return artifacts.find((a) => a !== null) ?? null;
}

async function lastDrill(env: Env) {
  const branch = encodeURIComponent(env.GITHUB_WORKFLOW_REF);
  const { workflow_runs } = await github<{ workflow_runs: Run[] }>(
    env, `workflows/restore-drill.yml/runs?branch=${branch}&status=completed&per_page=1`,
  );
  const run = workflow_runs[0];
  return run ? { run_id: run.id, result: run.conclusion, finished_at: run.updated_at } : null;
}

export async function recoveryState(env: Env) {
  const [backup, drill] = await Promise.allSettled([latestBackup(env), lastDrill(env)]);
  return {
    backup: backup.status === "fulfilled" ? backup.value : null,
    drill: drill.status === "fulfilled" ? drill.value : null,
    backup_available: backup.status === "fulfilled",
    drill_available: drill.status === "fulfilled",
  };
}

export async function maintenance(rows: Rows, revision: string) {
  const [row] = await rows(
    "SELECT CASE WHEN version_num=$1 THEN nodema_maintenance_state() END AS state FROM alembic_version",
    [revision],
  );
  return row?.state ?? null;
}
