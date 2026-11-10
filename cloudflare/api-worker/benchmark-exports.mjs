/** Synthetic PostgreSQL + actual Worker handler; Node CPU is not Cloudflare CPU. */
import { Client } from "pg";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { handle } from "./dist/index.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const rawUrl = process.env.TEST_DATABASE_URL;
if (!rawUrl) throw new Error("TEST_DATABASE_URL_REQUIRED");
const connectionString = rawUrl.replace("postgresql+psycopg:", "postgresql:");
const sizes = process.argv.slice(2).map(Number);
if (!sizes.length) sizes.push(1000, 5000, 15000);
if (sizes.some((n) => !Number.isInteger(n) || n < 1 || n > 15000))
  throw new Error("INVALID_BENCHMARK_SIZE");
const report = [];
for (const count of sizes) {
  const schema = "export_benchmark_" + crypto.randomUUID().replaceAll("-", "");
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.query(`SET search_path TO "${schema}"`);
  try {
    execFileSync(
      root + ".venv/bin/python",
      [
        "-c",
        `
import os
from uuid import uuid4
from datetime import UTC,datetime
import sqlalchemy as sa
from alembic.config import Config
from alembic import command
from app.database.session import make_engine,session_factory
from app.database.models import Node,NodeCurrentStatus
from app.ingestion.service import AssetService
from app.security.crypto import Cipher
from app.domain import SourceType
e=make_engine(os.environ['DATABASE_URL']);sessions=session_factory(e)
with e.begin() as c:
 config=Config('alembic.ini');config.attributes['connection']=c;command.upgrade(config,'head')
a=AssetService(sessions,b'H'*32)
for offset in range(0,${count},5000):
 payload='\\n'.join('vless://'+str(uuid4())+'@entry-'+str(i//5)+'.example:443?security=tls' for i in range(offset,min(offset+5000,${count}))).encode()
 source=a.create_source(name='synthetic-'+str(offset),source_type=SourceType.RAW_TEXT,payload=payload)
 a.sync_source(source['id'])
with sessions.begin() as s:
 ids=list(s.scalars(sa.select(Node.id)))
 s.execute(sa.insert(NodeCurrentStatus),[dict(node_id=i,status='UP',last_checked_at=datetime.now(UTC),last_success_at=datetime.now(UTC)) for i in ids])
e.dispose()
`,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          DATABASE_URL: rawUrl,
          PGOPTIONS: `-csearch_path=${schema}`,
        },
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    const env = {
      ENCRYPTION_KEY_ID: "benchmark",
      ENCRYPTION_KEY_B64: Buffer.alloc(32, "E").toString("base64"),
      ADMIN_PASSWORD: "synthetic-benchmark-at-least-32-characters",
      NAME_TEMPLATE: "{PROTOCOL} | {SHORT_ID}",
      FRESHNESS_HOURS: "36",
      EXPORT_TTL_HOURS: "24",
      GITHUB_REPOSITORY: "",
      GITHUB_DISPATCH_TOKEN: "",
      GITHUB_WORKFLOW_REF: "main",
    };
    let queries = 0;
    const connect = async () => {
      const client = new Client({
        connectionString,
        options: `-csearch_path=${schema}`,
      });
      await client.connect();
      const original = client.query.bind(client);
      client.query = (...args) => {
        queries++;
        return original(...args);
      };
      return client;
    };
    for (const format of ["mihomo", "singbox", "uri", "json", "csv"]) {
      const createStart = performance.now(),
        createCpu = process.cpuUsage(),
        before = queries;
      const response = await handle(
        new Request("https://synthetic.example/api/exports", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + env.ADMIN_PASSWORD,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ format }),
        }),
        env,
        connect,
      );
      const artifact = await response.json();
      if (response.status !== 202) throw new Error("BENCHMARK_QUEUE_FAILED");
      const createMs = performance.now() - createStart,
        createConsumed = process.cpuUsage(createCpu);
      const buildStart = performance.now();
      const build = JSON.parse(
        execFileSync(
          root + ".venv/bin/python",
          [
            "-c",
            `
import json,os
from app.database.session import make_engine,session_factory
from app.ingestion.service import AssetService
from app.exports import ExportService
from app.config import Settings
e=make_engine(os.environ['DATABASE_URL']);a=AssetService(session_factory(e),b'H'*32)
s=Settings(_env_file=None,fingerprint_key_b64='SEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEg=')
print(json.dumps(ExportService(a,s).build_pending()))
e.dispose()
`,
          ],
          {
            cwd: root,
            env: {
              ...process.env,
              DATABASE_URL: rawUrl,
              PGOPTIONS: `-csearch_path=${schema}`,
            },
            encoding: "utf8",
          },
        ),
      );
      const buildMs = performance.now() - buildStart;
      const downloadStart = performance.now(),
        downloadCpu = process.cpuUsage(),
        downloadQueries = queries;
      const download = await handle(
        new Request(
          `https://synthetic.example/subscriptions/${artifact.id}?token=${artifact.token}`,
        ),
        env,
        connect,
      );
      if (build.ready !== 1 || download.status !== 200)
        throw new Error("BENCHMARK_BUILD_FAILED");
      const bytes = (await download.arrayBuffer()).byteLength,
        downloadConsumed = process.cpuUsage(downloadCpu),
        memory = process.memoryUsage();
      const metadata = (
        await admin.query(
          "SELECT node_count,current_version FROM export_artifacts WHERE id=$1",
          [artifact.id],
        )
      ).rows[0];
      if (metadata.node_count !== count)
        throw new Error("BENCHMARK_COUNT_FAILED");
      report.push({
        nodes: count,
        format,
        status: 202,
        bytes,
        create_ms: Math.round(createMs),
        build_ms: Math.round(buildMs),
        download_ms: Math.round(performance.now() - downloadStart),
        api_node_cpu_ms: Math.round(
          (createConsumed.user +
            createConsumed.system +
            downloadConsumed.user +
            downloadConsumed.system) /
            1000,
        ),
        api_database_queries: queries - before,
        download_database_queries: queries - downloadQueries,
        sampled_node_heap_bytes: memory.heapUsed,
        sampled_array_buffer_bytes: memory.arrayBuffers,
      });
    }
  } finally {
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
}
console.log(
  JSON.stringify(
    {
      benchmark: "synthetic-async-subscription-build-and-delivery",
      runtime:
        "Node + actual Worker handle + PostgreSQL; not Cloudflare isolate, CPU or quota validation",
      synthetic_metadata: true,
      results: report,
    },
    null,
    2,
  ),
);
