import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { Client } from "pg";
import { handle, nameFor } from "../dist/index.js";
import { Cipher } from "../dist/crypto.js";
import { render } from "../dist/formats.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const rawUrl = process.env.TEST_DATABASE_URL;
if (!rawUrl)
  throw new Error(
    "TEST_DATABASE_URL required; Worker integration tests are never silently skipped",
  );
const connectionString = rawUrl.replace("postgresql+psycopg:", "postgresql:");
const schema = "worker_test_" + crypto.randomUUID().replaceAll("-", "");
const env = {
  ENCRYPTION_KEY_ID: "test-v1",
  ENCRYPTION_KEY_B64: Buffer.alloc(32, "E").toString("base64"),
  ADMIN_PASSWORD: "synthetic-worker-admin-password-long-enough",
  NAME_TEMPLATE: "{FLAG}{ROUTE}|{ASN} {SEQ}",
  FRESHNESS_HOURS: "36",
  EXPORT_TTL_HOURS: "24",
  GITHUB_REPOSITORY: "",
  GITHUB_DISPATCH_TOKEN: "",
  GITHUB_WORKFLOW_REF: "main",
};
const python = process.env.PYTHON_BIN || root + ".venv/bin/python";
const childEnv = {
  ...process.env,
  DATABASE_URL: rawUrl,
  PGOPTIONS: `-csearch_path=${schema}`,
};
function py(source) {
  return execFileSync(python, ["-c", source], {
    cwd: root,
    env: childEnv,
    encoding: "utf8",
  }).trim();
}
async function connect() {
  const client = new Client({
    connectionString,
    options: `-csearch_path=${schema}`,
  });
  await client.connect();
  return client;
}
async function request(
  path,
  { method = "GET", data, authenticated = true } = {},
) {
  return handle(
    new Request("https://assets.example" + path, {
      method,
      headers: authenticated
        ? {
            Authorization: "Bearer " + env.ADMIN_PASSWORD,
            "Content-Type": "application/json",
          }
        : {},
      body: data ? JSON.stringify(data) : undefined,
    }),
    env,
    connect,
  );
}
function buildExports() {
  return JSON.parse(
    py(`import json,os
from app.config import Settings
from app.database.session import make_engine,session_factory
from app.ingestion.service import AssetService
from app.exports import ExportService
e=make_engine(os.environ['DATABASE_URL'])
a=AssetService(session_factory(e),b'H'*32)
print(json.dumps(ExportService(a,Settings(_env_file=None,fingerprint_key_b64='SEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEg=')).build_pending()))
e.dispose()`),
  );
}
async function publish(response) {
  assert.equal(response.status, 202);
  const queued = await response.json();
  const pending = await request(
    `/subscriptions/${queued.id}?token=${queued.token}`,
    { authenticated: false },
  );
  assert.equal(pending.status, 503);
  assert.equal(pending.headers.get("Retry-After"), "60");
  assert.ok(buildExports().ready > 0);
  const current = await (await request(`/api/exports/${queued.id}`)).json();
  assert.equal(current.serving, true);
  return { ...current, token: queued.token };
}
before(async () => {
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.end();
  py(`import os
from alembic import command
from alembic.config import Config
from app.database.session import make_engine
e=make_engine(os.environ['DATABASE_URL'])
with e.begin() as c:
 config=Config('alembic.ini');config.attributes['connection']=c;command.upgrade(config,'head')
e.dispose()`);
});
after(async () => {
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
});

test("Worker/Python/PostgreSQL round trip", async (t) => {
  await t.test(
    "auth fails before DB and validation never echoes secrets",
    async () => {
      const response = await request("/api/sources", { authenticated: false });
      assert.equal(response.status, 401);
      assert.equal(
        (
          await request("/api/sources", {
            method: "POST",
            data: { type: "bad", payload: "synthetic-secret" },
          })
        ).status,
        400,
      );
      assert.throws(() => nameFor("{constructor}", {}));
    },
  );
  let sourceId, nodeId;
  await t.test("Worker stores plaintext Python can import", async () => {
    const response = await request("/api/sources", {
      method: "POST",
      data: {
        name: "Synthetic Worker source",
        type: "RAW_TEXT",
        payload:
          "vless://00000000-0000-4000-8000-000000000001@edge.example:443?type=ws&security=tls&sni=sni.example&host=ws.example&path=%2Fdemo#Synthetic",
      },
    });
    assert.equal(response.status, 201);
    const value = await response.json();
    sourceId = value.id;
    assert.ok(value.sync_requested_at);
    assert.equal(value.pipeline.dispatched, false);
    assert.equal(value.pipeline.reason, "MANUAL_SYNC");
    assert.ok(!JSON.stringify(value).includes("vless://"));
    const readiness = await (await request("/api/readiness")).json();
    assert.equal(readiness.checks.storage, "PLAINTEXT");
    const result = JSON.parse(
      py(`import json,os
from app.database.session import make_engine,session_factory
from app.ingestion.service import AssetService
from app.security.crypto import Cipher
from uuid import UUID
s=AssetService(session_factory(make_engine(os.environ['DATABASE_URL'])),b'H'*32)
print(json.dumps(s.sync_source(UUID('${sourceId}')),default=str))`),
    );
    assert.equal(result.status, "SUCCESS");
    nodeId = (await (await request("/api/nodes")).json()).items[0].id;
  });
  await t.test(
    "imports, edits and per-source sync only record requests; sync and tests start explicitly",
    async () => {
      const original = globalThis.fetch;
      env.GITHUB_REPOSITORY = "synthetic-owner/synthetic-repo";
      env.GITHUB_DISPATCH_TOKEN = "synthetic-actions-token";
      const calls = [];
      try {
        globalThis.fetch = async (url, options) => {
          calls.push({ url: String(url), body: JSON.parse(options.body) });
          return new Response(null, { status: 204 });
        };
        const marked = await request(`/api/sources/${sourceId}/sync`, {
          method: "POST",
        });
        assert.equal(marked.status, 202);
        assert.equal((await marked.json()).status, "REQUESTED");
        const created = await request("/api/sources", {
          method: "POST",
          data: {
            name: "queued batch",
            type: "RAW_TEXT",
            kind: "SELF_HOSTED",
            payload:
              "vless://00000000-0000-4000-8000-000000000001@batch.example:443",
          },
        });
        assert.equal(created.status, 201);
        const saved = await created.json();
        assert.equal(saved.pipeline.dispatched, false);
        assert.equal(saved.kind, "SELF_HOSTED");
        const updated = await (
          await request(`/api/sources/${saved.id}`, {
            method: "PATCH",
            data: { format_hint: "AUTO", user_agent: "custom-agent/1" },
          })
        ).json();
        assert.equal(updated.pipeline.dispatched, false);
        assert.equal(updated.user_agent, "custom-agent/1");
        await request(`/api/sources/${saved.id}`, { method: "DELETE" });
        assert.equal(calls.length, 0);
        const pipeline = await (await request("/api/pipeline")).json();
        assert.ok(pipeline.pending_sources >= 1);
        assert.equal(pipeline.settings.daily_scan_scope, "SELF_HOSTED");
        const synced = await request("/api/pipeline/sync", { method: "POST" });
        assert.equal(synced.status, 202);
        assert.ok((await synced.json()).sources >= 1);
        assert.ok(
          (await (await request(`/api/sources/${sourceId}`)).json()).sync_requested_at,
        );
        assert.equal(
          (
            await request("/api/scans", {
              method: "POST",
              data: { scope: "AIRPORT" },
            })
          ).status,
          202,
        );
        assert.equal(
          (
            await request("/api/scans", {
              method: "POST",
              data: { scope: "EVERYTHING" },
            })
          ).status,
          400,
        );
        assert.deepEqual(
          calls.map((c) => [c.url.split("/").at(-2), c.body.inputs]),
          [
            ["source-sync.yml", {}],
            ["daily-check.yml", { run_id: "", scope: "AIRPORT" }],
          ],
        );
        const nodeIds = (await (await request("/api/nodes?limit=2")).json()).items.map((n) => n.id);
        assert.equal(
          (await request("/api/scans", { method: "POST", data: { node_ids: nodeIds } })).status,
          202,
        );
        const queued = await (await request("/api/pipeline")).json();
        assert.deepEqual(
          queued.requested_scans.map((r) => [r.scope, r.count, r.nodes]),
          [["AIRPORT", 1, 0], ["NODES", 1, nodeIds.length]],
        );
        assert.ok(queued.sources_total >= 1 && queued.last_synced_at);
        globalThis.fetch = async () => {
          throw new Error("synthetic-private-network-error");
        };
        const kept = await request("/api/scans", {
          method: "POST",
          data: { scope: "SELF_HOSTED" },
        });
        assert.equal(kept.status, 202);
        assert.equal((await kept.json()).status, "REQUESTED");
        const failed = await request("/api/pipeline/sync", { method: "POST" });
        assert.equal(failed.status, 502);
        assert.ok(
          !(await failed.text()).includes("synthetic-private-network-error"),
        );
      } finally {
        globalThis.fetch = original;
        env.GITHUB_REPOSITORY = "";
        env.GITHUB_DISPATCH_TOKEN = "";
      }
    },
  );
  await t.test(
    "authenticated readiness distinguishes incomplete deployment",
    async () => {
      assert.equal(
        (await request("/api/readiness", { authenticated: false })).status,
        401,
      );
      const result = await (await request("/api/readiness")).json();
      assert.equal(result.checks.schema, true);
      assert.equal(result.checks.storage, "PLAINTEXT");
      assert.equal(result.checks.dispatch, false);
      assert.equal(result.ready, false);
      const originalKey = env.ENCRYPTION_KEY_B64;
      try {
        env.ENCRYPTION_KEY_B64 = Buffer.alloc(32, "Z").toString("base64");
        const wrong = await (await request("/api/readiness")).json();
        assert.equal(wrong.checks.storage, "PLAINTEXT");
      } finally {
        env.ENCRYPTION_KEY_B64 = originalKey;
      }
      const db = await connect();
      try {
        await db.query(
          "UPDATE alembic_version SET version_num='0002_monitoring'",
        );
        const outdated = await (await request("/api/readiness")).json();
        assert.equal(outdated.ready, false);
        assert.equal(outdated.checks.schema, false);
      } finally {
        await db.query(
          "UPDATE alembic_version SET version_num='0008_export_projection'",
        );
        await db.end();
      }
    },
  );
  await t.test("Python observations are visible to Worker", async () => {
    py(`import os,base64
from app.config import Settings
from app.database.session import make_engine,session_factory
from app.ingestion.service import AssetService
from app.security.crypto import Cipher
from app.scans import ScanService
from app.checker.health import Observation
s=AssetService(session_factory(make_engine(os.environ['DATABASE_URL'])),b'H'*32)
settings=Settings(_env_file=None,database_url=os.environ['DATABASE_URL'],encryption_key_b64=base64.b64encode(b'E'*32).decode(),fingerprint_key_b64=base64.b64encode(b'H'*32).decode(),retry_delay_seconds=0)
class Fake:
 def preflight(self):pass
 def check(self,*args):return Observation(status='UP',entry_country='SG',exit_country='JP',exit_ip='8.8.8.8',http_duration_ms=42)
 def close(self):pass
scans=ScanService(s,settings,checker_factory=Fake);run=scans.create()
for shard in scans.get(run['id'])['shards']:scans.run_shard(run['id'],shard['shard_no'])
scans.finalize(run['id'])`);
    const node = await (await request(`/api/nodes/${nodeId}`)).json();
    assert.equal(node.status, "UP");
    assert.equal(node.name, "🇯🇵SG->JP|Unknown 01");
    assert.equal(node.node_group, "SELF_HOSTED");
    assert.equal(node.history.length, 1);
    const aliases = await (
      await request(`/api/nodes/${nodeId}/aliases`)
    ).json();
    assert.deepEqual(aliases[0].aliases, ["Synthetic"]);
    const runs = await (await request("/api/scans")).json();
    assert.equal(
      (await (await request(`/api/scans/${runs[0].id}`)).json()).shards.length,
      1,
    );
  });
  await t.test(
    "five export formats, live eligibility and revocation",
    async () => {
      for (const format of ["mihomo", "singbox", "uri", "json", "csv"]) {
        const response = await request("/api/exports", {
          method: "POST",
          data: { format },
        });
        const value = await publish(response);
        assert.equal(value.node_count, 1);
        const url = `/subscriptions/${value.id}?token=${value.token}`;
        const payload = await (
          await request(url, { authenticated: false })
        ).text();
        assert.ok(payload.includes("edge.example"));
        if (["json", "csv"].includes(format))
          assert.ok(!payload.includes("00000000-0000-4000-8000"));
        await request(`/api/nodes/${nodeId}`, {
          method: "PATCH",
          data: { enabled: false },
        });
        assert.ok(
          !(
            await (await request(url, { authenticated: false })).text()
          ).includes("edge.example"),
        );
        await request(`/api/nodes/${nodeId}`, {
          method: "PATCH",
          data: { enabled: true },
        });
        await request(`/api/exports/${value.id}`, { method: "DELETE" });
        assert.equal(
          (await request(url, { authenticated: false })).status,
          404,
        );
      }
    },
  );
  await t.test(
    "naming persists and Python decrypts Worker export snapshots",
    async () => {
      assert.equal(
        (
          await request("/api/naming-rules", {
            method: "PUT",
            data: { template: "{SHORT_ID} | {EXIT_COUNTRY}" },
          })
        ).status,
        200,
      );
      assert.ok(
        (await (await request("/api/naming-rules")).json()).history.length,
      );
      const artifact = await publish(
        await request("/api/exports", {
          method: "POST",
          data: { format: "mihomo" },
        }),
      );
      const output = py(`import os
from uuid import UUID
from app.database.models import ExportArtifact
from app.database.session import make_engine,session_factory
from app.security.crypto import Cipher
with session_factory(make_engine(os.environ['DATABASE_URL']))() as s:
 a=s.get(ExportArtifact,UUID('${artifact.id}'))
 assert b'proxies:' in bytes(a.payload_data)
 print('interop-ok')`);
      assert.equal(output, "interop-ok");
      assert.equal(
        (await request(`/api/sources/${sourceId}`, { method: "DELETE" }))
          .status,
        200,
      );
      assert.equal((await (await request("/api/sources")).json()).length, 0);
    },
  );
});

test("AES envelope authenticates record context", async () => {
  const cipher = new Cipher(env.ENCRYPTION_KEY_B64, "test-v1"),
    a = await cipher.encrypt("synthetic-private", "sources:one:payload"),
    b = await cipher.encrypt("synthetic-private", "sources:one:payload");
  assert.notDeepEqual(a, b);
  assert.equal(
    await cipher.decrypt(a, "sources:one:payload"),
    "synthetic-private",
  );
  await assert.rejects(cipher.decrypt(a, "sources:other:payload"));
});

test("six-protocol Python and Worker conversion parity", () => {
  const vectors = JSON.parse(
    py(`import json,copy,base64
from pathlib import Path
from app.parsers import parse_document,parse_password_uri,parse_shadowsocks
from app.conversion import to_mihomo,to_singbox,to_uri
from app.domain import AssetError
nodes=[n.identity for n in parse_document(Path('tests/fixtures/protocols_all.txt').read_bytes()).nodes]
nodes.append(parse_shadowsocks('ss://aes-128-gcm:synthetic@ss.example:443/?plugin=obfs-local%3Bobfs%3Dtls%3Bobfs-host%3Dcdn.example').identity)
nodes.append(parse_shadowsocks('ss://2022-blake3-aes-128-gcm:'+base64.b64encode(b'S'*16).decode()+'@ss.example:443').identity)
nodes.append(parse_password_uri('hy2://synthetic@[2001:db8::2]:443,1000-1010?obfs=salamander&obfs-password=synthetic').identity)
tuned=copy.deepcopy(nodes[2]);tuned['protocol_options']={'idle_check_seconds':30,'idle_timeout_seconds':60,'min_idle_session':2};nodes.append(tuned)
grpc=copy.deepcopy(nodes[1]);grpc['transport']='grpc';grpc['transport_options']={'service_name':'synthetic'};nodes.append(grpc)
bandwidth=copy.deepcopy(nodes[3]);bandwidth['protocol_options'].update(up_mbps=10,down_mbps=20,hop_seconds=30);nodes.append(bandwidth)
vectors=[]
for d in nodes:
 v={'identity':d,'mihomo':to_mihomo(d,'synthetic-vector'),'singbox':to_singbox(d,'synthetic-vector')}
 try:v['uri']=to_uri(d,'synthetic-vector')
 except AssetError:v['uri']=None
 vectors.append(v)
print(json.dumps(vectors))`),
  );
  for (const vector of vectors) {
    const item = {
      identity: vector.identity,
      node: { id: "synthetic", short_id: "N000001", name: "synthetic-vector" },
    };
    assert.deepEqual(
      YAML.parse(render("mihomo", [item])).proxies[0],
      vector.mihomo,
    );
    assert.deepEqual(
      JSON.parse(render("singbox", [item])).outbounds[0],
      vector.singbox,
    );
    if (vector.uri === null)
      assert.throws(() => render("uri", [item]), /RUNTIME_UNSUPPORTED/);
    else {
      const encoded = Buffer.from(render("uri", [item])).toString("base64");
      const parsed = JSON.parse(
        py(`import json,base64
from app.parsers import parse_document
r=parse_document(base64.b64decode('${encoded}'));assert r.complete
print(json.dumps(r.nodes[0].identity))`),
      );
      assert.deepEqual(parsed, vector.identity);
    }
    for (const format of ["mihomo", "singbox", "uri"]) {
      const bad = {
        ...item,
        identity: {
          ...vector.identity,
          extensions: { unknown: { secret: "synthetic" } },
        },
      };
      assert.throws(() => render(format, [bad]), /RUNTIME_UNSUPPORTED/);
    }
  }
});

test("Worker import to Python scan to private six-protocol subscription", async () => {
  const response = await request("/api/sources", {
    method: "POST",
    data: {
      name: "six synthetic protocols",
      type: "RAW_TEXT",
      payload: readFileSync(root + "tests/fixtures/protocols_all.txt", "utf8"),
    },
  });
  assert.equal(response.status, 201);
  const source = await response.json();
  py(`import os,base64
from uuid import UUID
from app.database.session import make_engine,session_factory
from app.ingestion.service import AssetService
from app.config import Settings
from app.security.crypto import Cipher
from app.scans import ScanService
from app.checker.health import Observation
assets=AssetService(session_factory(make_engine(os.environ['DATABASE_URL'])),b'H'*32)
assert assets.sync_source(UUID('${source.id}'))['status']=='SUCCESS'
settings=Settings(_env_file=None,database_url=os.environ['DATABASE_URL'],encryption_key_b64=base64.b64encode(b'E'*32).decode(),fingerprint_key_b64=base64.b64encode(b'H'*32).decode(),retry_delay_seconds=0)
class Fake:
 def preflight(self):pass
 def check(self,d,name):return Observation(status='UP',entry_country='SG',exit_country='JP',exit_ip='8.8.8.8',http_duration_ms=3)
 def close(self):pass
scans=ScanService(assets,settings,checker_factory=Fake)
for r in scans.plan()['runs']:
 for s in r['shards']:scans.run_shard(r['id'],s['shard_no'])
 assert scans.finalize(r['id'])['status']=='COMPLETED'`);
  const protocols = [
    "shadowsocks",
    "trojan",
    "anytls",
    "hysteria2",
    "vmess",
    "vless",
  ];
  for (const protocol of protocols) {
    const nodes = await (
      await request(`/api/nodes?protocol=${protocol}&source_id=${source.id}`)
    ).json();
    assert.ok(
      nodes.items.some(
        (n) => n.protocol === protocol && n.eligible && n.status === "UP",
      ),
    );
    assert.ok(nodes.items.every((n) => n.protocol === protocol));
    const node = nodes.items.find((n) => n.eligible && n.status === "UP");
    assert.ok(node.present_source_count >= 1);
    assert.ok(node.source_count >= node.present_source_count);
    const detail = await (await request(`/api/nodes/${node.id}`)).json();
    assert.equal(detail.published_observation.status, "UP");
    assert.ok(
      detail.sources.some((s) => s.source_id === source.id && !s.deleted),
    );
  }
  const sourceDetail = await (
    await request(`/api/sources/${source.id}`)
  ).json();
  assert.equal(Number(sourceDetail.present_nodes), 6);
  for (const format of ["mihomo", "singbox", "uri", "json", "csv"]) {
    // Nodes of earlier, deleted test sources are retained; scope to this source.
    const created = await request("/api/exports", {
      method: "POST",
      data: { format, filters: { source_id: source.id } },
    });
    const artifact = await publish(created);
    assert.equal(artifact.node_count, 6);
    const downloaded = await request(
      `/subscriptions/${artifact.id}?token=${artifact.token}`,
      { authenticated: false },
    );
    assert.equal(downloaded.status, 200);
    const payload = await downloaded.text();
    if (["json", "csv"].includes(format)) {
      for (const value of [
        "synthetic-anytls",
        "synthetic:trojan@secret",
        "00000000-0000-4000-8000",
      ])
        assert.ok(!payload.includes(value));
    } else {
      const encoded = Buffer.from(payload).toString("base64");
      const exported = JSON.parse(
        py(`import json,base64
from app.parsers import parse_document
r=parse_document(base64.b64decode('${encoded}'));assert r.complete,r.summary()
print(json.dumps(sorted(n.identity['protocol'] for n in r.nodes)))`),
      );
      assert.deepEqual(exported, [...protocols].sort());
    }
  }
  await request(`/api/sources/${source.id}`, { method: "DELETE" });
});

test("authenticated numeric usage agrees with Python aggregation", async () => {
  assert.equal(
    (await request("/api/usage", { authenticated: false })).status,
    401,
  );
  assert.equal((await request("/api/usage?days=0")).status, 422);
  const value = await (await request("/api/usage?days=30")).json();
  const expected = JSON.parse(
    py(`import os,json
from app.database.session import make_engine,session_factory
from app.usage import Usage
print(json.dumps(Usage(session_factory(make_engine(os.environ['DATABASE_URL']))).summary(),default=str))`),
  );
  for (const key of ["totals", "health", "executions", "daily"])
    assert.deepEqual(value[key], expected[key]);
  assert.equal(value.runner_minutes, expected.runner_minutes);
  assert.equal(value.database_growth_bytes, expected.database_growth_bytes);
  assert.ok(value.totals.subscription_downloads > 0);
  const overview = await (await request("/api/overview")).json();
  assert.equal(overview.latest_completed_scan.kind, "DAILY");
  assert.ok(overview.latest_scan.shards);
  for (const key of ["UUID", "password", "token_hash", "config_data"])
    assert.ok(!JSON.stringify(value).includes(key));
});

test("HTTP Sub-Store URL passes Worker encryption and Python aggregate import", async () => {
  const endpoint =
    "http://store.example:3000/api/subs?token=synthetic-api-secret";
  const response = await request("/api/sources", {
    method: "POST",
    data: {
      name: "Synthetic Sub-Store",
      type: "SUBSCRIPTION_URL",
      payload: endpoint,
    },
  });
  assert.equal(response.status, 201);
  const source = await response.json();
  assert.ok(!JSON.stringify(source).includes("synthetic-api-secret"));
  const imported = JSON.parse(
    py(`import json,os
from app.database.session import make_engine,session_factory
from app.ingestion.service import AssetService
from app.security.crypto import Cipher
from uuid import UUID
class Fetcher:
 def fetch(self,url):
  assert url == '${endpoint}'
  return json.dumps({'status':'success','data':[{'name':'mine','source':'local','content':'trojan://synthetic-substore@substore.example:443'}]}).encode()
assets=AssetService(session_factory(make_engine(os.environ['DATABASE_URL'])),b'H'*32,fetcher=Fetcher())
parent=assets.sync_source(UUID('${source.id}'))
child=[s for s in assets.list_sources() if s['parent_source_id']==UUID('${source.id}')][0]
print(json.dumps({'parent':parent,'child':assets.sync_source(child['id'])},default=str))`),
  );
  assert.equal(imported.parent.status, "SUCCESS");
  assert.equal(imported.parent.children.created, 1);
  assert.equal(imported.child.unique_nodes, 1);
  const detail = await (await request(`/api/sources/${source.id}`)).json();
  assert.equal(detail.detected_kind, "SUBSTORE");
  assert.equal(detail.url_host, "store.example");
  assert.ok(!JSON.stringify(detail).includes("synthetic-substore"));
  const stores = await (await request("/api/substores")).json();
  assert.equal(stores.length, 1);
  assert.deepEqual(
    [stores[0].children, stores[0].healthy_children, stores[0].node_count],
    [1, 1, 1],
  );
  const one = await (await request(`/api/substores/${source.id}`)).json();
  assert.equal(one.children[0].origin_label, "mine · 本地");
  assert.ok(!JSON.stringify(stores).includes("synthetic-api-secret"));
  const removed = await (
    await request("/api/sources/batch", {
      method: "POST",
      data: { ids: [source.id], action: "delete", include_children: true },
    })
  ).json();
  assert.equal(removed.changed, 2);
});

test("shared SQL filtering, Runner summaries, reference policy and annotations agree across runtimes", async () => {
  const response = await request("/api/sources", {
    method: "POST",
    data: {
      name: "Synthetic quality candidates",
      type: "RAW_TEXT",
      payload:
        "vless://00000000-0000-4000-8000-000000009001@quality-one.example:443?type=tcp&security=none\n" +
        "vless://00000000-0000-4000-8000-000000009002@quality-two.example:443?type=tcp&security=none",
    },
  });
  assert.equal(response.status, 201);
  const source = await response.json();
  py(`import json,os
from datetime import timedelta
from uuid import UUID
from app.database.session import make_engine,session_factory
from app.ingestion.service import AssetService
from app.security.crypto import Cipher
from app.scans import ScanService,now
from app.config import Settings
from app.checker.health import Observation
assets=AssetService(session_factory(make_engine(os.environ['DATABASE_URL'])),b'H'*32)
assets.sync_source(UUID('${source.id}'))
class Checker:
 def preflight(self):pass
 def close(self):pass
 def check(self,identity,short_id):
  return Observation(status='UP',entry_country='SG',entry_asn=64510,entry_ips=['198.51.100.1'],exit_country='JP',exit_asn=64520,exit_ip='203.0.113.1',http_duration_ms=10 if identity.get('uuid','').endswith('9001') else 50,probe_key='synthetic-JP-echo-v1')
settings=Settings(_env_file=None,database_url=os.environ['DATABASE_URL'],encryption_key_b64='${env.ENCRYPTION_KEY_B64}',fingerprint_key_b64='${Buffer.alloc(32, "H").toString("base64")}',retry_delay_seconds=0)
scans=ScanService(assets,settings,checker_factory=Checker)
for i in range(3):
 run=scans.create(now().date()-timedelta(days=i))
 for shard in scans.get(run['id'])['shards']:scans.run_shard(run['id'],shard['shard_no'])
 scans.finalize(run['id'])`);
  const query = `source_id=${source.id}&entry_asn=64510&exit_asn=64520&entry_ip=198.51.100.1&sort=http_p95_ms:desc,short_id:asc`;
  const first = await (await request("/api/nodes?" + query)).json();
  assert.equal(first.total, 2);
  assert.deepEqual(
    first.items.map((n) => n.http_p95_ms),
    [50, 10],
  );
  assert.ok(
    first.items.every(
      (n) =>
        n.grade === "P2" &&
        n.sample_count === 3 &&
        n.mainland_reachability === "UNKNOWN",
    ),
  );
  const policy = await (await request("/api/quality-policy")).json();
  const saved = await request("/api/quality-policy", {
    method: "PUT",
    data: {
      expected_version: policy.version,
      policy: { preferred_entry_countries: ["SG"] },
    },
  });
  assert.equal(saved.status, 200);
  const updated = await saved.json();
  assert.equal(updated.version, policy.version + 1);
  const conflict = await request("/api/quality-policy", {
    method: "PUT",
    data: { expected_version: policy.version, policy: {} },
  });
  assert.equal(conflict.status, 409);
  const ranked = await (
    await request(`/api/nodes?source_id=${source.id}&grade=P1`)
  ).json();
  assert.equal(ranked.total, 2);
  assert.ok(ranked.items.every((n) => n.confidence === "LOW"));
  const nodeId = first.items[0].id;
  const reference =
    "https://reference.example/private?token=synthetic-evidence-secret";
  const annotationResponse = await request(`/api/nodes/${nodeId}/annotations`, {
    method: "PATCH",
    data: {
      tags: ["personal"],
      line_claim: "IPLC",
      evidence_level: "DOCUMENTED",
      operators: ["CT"],
      reference,
    },
  });
  assert.equal(annotationResponse.status, 200);
  assert.ok(
    !(await annotationResponse.text()).includes("synthetic-evidence-secret"),
  );
  const decoded = JSON.parse(
    py(`import json,os
from uuid import UUID
from app.quality import QualityService
from app.database.session import make_engine,session_factory
from app.ingestion.service import AssetService
from app.security.crypto import Cipher
assets=AssetService(session_factory(make_engine(os.environ['DATABASE_URL'])),b'H'*32)
print(json.dumps(QualityService(assets).reveal_reference(UUID('${nodeId}'))))`),
  );
  assert.equal(decoded.reference, reference);
  assert.equal(
    (await (await request(`/api/nodes/${nodeId}`)).json()).line_type,
    "UNKNOWN",
  );
  await request("/api/quality-policy", {
    method: "PUT",
    data: { expected_version: updated.version, policy: {} },
  });
  const scoped = await (
    await request(
      `/api/nodes?source_id=${source.id}&operator=CT&tags=personal&grade=P1`,
    )
  ).json();
  assert.equal(scoped.total, 1);
  assert.equal(scoped.items[0].confidence, "MEDIUM");
  for (const format of ["json", "csv", "mihomo", "singbox", "uri"]) {
    const artifactResponse = await request("/api/exports", {
      method: "POST",
      data: {
        format,
        filters: {
          source_id: source.id,
          operator: "CT",
          tags: ["personal"],
          grade: "P1",
          sort: "http_p95_ms:asc",
          limit: 1,
        },
      },
    });
    const artifact = await publish(artifactResponse);
    assert.equal(artifact.node_count, 1);
    assert.equal(
      (
        await request(`/subscriptions/${artifact.id}?token=${artifact.token}`, {
          authenticated: false,
        })
      ).status,
      200,
    );
  }
  const bad = await request(
    "/api/nodes?sort=short_id;DROP%20TABLE%20nodes:asc",
  );
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error_code, "INVALID_NODE_SORT");
  assert.equal(
    (await request("/api/nodes?unknown=synthetic-secret")).status,
    400,
  );
  await request(`/api/sources/${source.id}`, { method: "DELETE" });
});

test("paged exports use one snapshot and telemetry failures never break downloads", async () => {
  const created = await request("/api/sources", {
    method: "POST",
    data: {
      name: "synthetic-export-pages",
      type: "RAW_TEXT",
      payload: Array.from(
        { length: 1250 },
        () => `vless://${crypto.randomUUID()}@pages.example:443?security=tls`,
      ).join("\n"),
    },
  });
  const source = await created.json();
  py(`from uuid import UUID
from datetime import UTC,datetime
import os, sqlalchemy as sa
from app.ingestion.service import AssetService
from app.database.session import make_engine,session_factory
from app.database.models import NodeSource,NodeCurrentStatus
from app.security.crypto import Cipher
e=make_engine(os.environ['DATABASE_URL']);s=session_factory(e)
a=AssetService(s,b'H'*32);a.sync_source(UUID('${source.id}'))
with s.begin() as db:
 ids=list(db.scalars(sa.select(NodeSource.node_id).where(NodeSource.source_id==UUID('${source.id}'))))
 db.execute(sa.insert(NodeCurrentStatus),[dict(node_id=i,status='UP',last_checked_at=datetime.now(UTC),last_success_at=datetime.now(UTC)) for i in ids])
e.dispose()`);
  const admin = await connect();
  const ordered = (
    await admin.query(
      "SELECT n.id,n.short_id FROM nodes n JOIN node_sources ns ON ns.node_id=n.id WHERE ns.source_id=$1 ORDER BY n.short_id DESC",
      [source.id],
    )
  ).rows;
  let catalogReads = 0;
  const wrapped = async () => {
    const client = await connect(),
      query = client.query.bind(client);
    client.query = async (sql, ...args) => {
      if (
        typeof sql === "string" &&
        /nodema_node_page|config_data FROM nodes/.test(sql)
      )
        catalogReads++;
      return query(sql, ...args);
    };
    return client;
  };
  try {
    const first = await handle(
      new Request("https://assets.example/api/exports", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + env.ADMIN_PASSWORD,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          format: "mihomo",
          filters: { source_id: source.id, sort: "short_id:desc", limit: 1225 },
        }),
      }),
      env,
      wrapped,
    );
    const artifact = await publish(first);
    assert.equal(artifact.node_count, 1225);
    assert.equal(catalogReads, 0);
    const stored = (
      await admin.query(
        "SELECT payload_data FROM export_artifacts WHERE id=$1",
        [artifact.id],
      )
    ).rows[0];
    const snapshot = YAML.parse(
      Buffer.from(stored.payload_data).toString("utf8"),
    ).proxies;
    assert.equal(snapshot.length, 1225);
    assert.equal(new Set(snapshot.map((p) => p.name)).size, 1225);
    assert.ok(snapshot.some((p) => p.name.includes(ordered[1100].short_id)));
    const failingUsage = async () => {
      const client = await connect(),
        query = client.query.bind(client);
      client.query = (sql, ...args) =>
        typeof sql === "string" && sql.startsWith("INSERT INTO usage_events")
          ? Promise.reject(new Error("synthetic private driver detail"))
          : query(sql, ...args);
      return client;
    };
    const downloaded = await handle(
      new Request(
        `https://assets.example/subscriptions/${artifact.id}?token=${artifact.token}`,
      ),
      env,
      failingUsage,
    );
    assert.equal(downloaded.status, 200);
    const live = YAML.parse(await downloaded.text()).proxies;
    assert.equal(live.length, 1225);
    assert.ok(live.some((p) => p.name.includes(ordered[1100].short_id)));
    assert.equal(catalogReads, 0);
    for (const format of ["singbox", "uri", "json", "csv"]) {
      const response = await request("/api/exports", {
        method: "POST",
        data: {
          format,
          filters: { source_id: source.id, limit: 1225, sort: "short_id:desc" },
        },
      });
      const value = await publish(response);
      const payload = await (
        await request(`/subscriptions/${value.id}?token=${value.token}`, {
          authenticated: false,
        })
      ).text();
      assert.equal(value.node_count, 1225);
      if (format === "json") assert.equal(JSON.parse(payload).length, 1225);
      else if (format === "singbox")
        assert.equal(JSON.parse(payload).outbounds.length, 1225);
      else
        assert.equal(
          payload.trim().split(/\r?\n/).length,
          format === "csv" ? 1226 : 1225,
        );
    }
  } finally {
    await admin.end();
  }
});

test("plaintext storage and lifetime availability agree across Worker, Python and reports", async () => {
  const sourceResponse = await request("/api/sources", {
    method: "POST",
    data: {
      name: "Synthetic lifetime",
      type: "RAW_TEXT",
      payload:
        "vless://00000000-0000-4000-8000-eeeeee000001@lifetime.example:443?security=tls",
    },
  });
  assert.equal(sourceResponse.status, 201);
  const source = await sourceResponse.json();
  const nodeId = py(`import os
from uuid import UUID
from datetime import UTC,datetime,timedelta
import sqlalchemy as sa
from app.database.session import make_engine,session_factory
from app.ingestion.service import AssetService
from app.database.models import Node,NodeCurrentStatus,NodeDailyStats
sessions=session_factory(make_engine(os.environ['DATABASE_URL']))
a=AssetService(sessions,b'H'*32);a.sync_source(UUID('${source.id}'))
with sessions.begin() as s:
 n=s.scalar(sa.select(Node).where(Node.server_host=='lifetime.example'))
 assert bytes(n.config_data).startswith(b'{')
 s.execute(sa.text("UPDATE nodes SET first_seen_at=((now() AT TIME ZONE 'Asia/Shanghai')::date-30) AT TIME ZONE 'Asia/Shanghai' WHERE id=:id"),{'id':n.id})
 s.add(NodeCurrentStatus(node_id=n.id,status='UP',last_checked_at=datetime.now(UTC),last_success_at=datetime.now(UTC)))
 for i,status in enumerate(['UP','DOWN','SKIPPED']):
  s.add(NodeDailyStats(node_id=n.id,stat_date=datetime.now(UTC).date()-timedelta(days=i),scheduled_count=1,successful_count=int(status=='UP'),failed_count=int(status=='DOWN')))
 print(n.id)`);
  const response = await request(
    `/api/nodes?id=${nodeId}&min_age_days=30&min_checked_days=2&min_lifetime_availability=0.5&sort=lifetime_availability:desc,age_days:desc`,
  );
  assert.equal(response.status, 200);
  const page = await response.json();
  assert.equal(page.total, 1);
  const node = page.items[0];
  assert.equal(node.age_days, 31);
  assert.equal(node.checked_days, 2);
  assert.equal(node.available_days, 1);
  assert.equal(node.lifetime_availability, 0.5);
  assert.ok(node.first_seen_at);
  const artifactResponse = await request("/api/exports", {
    method: "POST",
    data: { format: "json", filters: { id: nodeId, min_age_days: 30 } },
  });
  const artifact = await publish(artifactResponse);
  const download = await request(
    `/subscriptions/${artifact.id}?token=${artifact.token}`,
    { authenticated: false },
  );
  assert.equal(download.status, 200);
  const report = await download.json();
  assert.equal(report[0].lifetime_availability, 0.5);
  assert.equal(report[0].age_days, 31);
  assert.equal(report[0].first_seen_at, node.first_seen_at);
  assert.equal(
    (await request("/api/nodes?min_lifetime_availability=1.1")).status,
    400,
  );
  const db = await connect();
  try {
    const stored = (
      await db.query("SELECT payload_data FROM export_artifacts WHERE id=$1", [
        artifact.id,
      ])
    ).rows[0];
    assert.ok(
      Buffer.from(stored.payload_data).toString("utf8").startsWith("["),
    );
    const originalConfig = (
      await db.query("SELECT config_data FROM nodes WHERE id=$1", [nodeId])
    ).rows[0].config_data;
    await db.query("UPDATE nodes SET config_data=$2 WHERE id=$1", [
      nodeId,
      Buffer.from("synthetic-invalid-config"),
    ]);
    const invalid = await request("/api/exports", {
      method: "POST",
      data: { format: "mihomo", filters: { id: nodeId } },
    });
    assert.equal(invalid.status, 202);
    const failed = await invalid.json();
    assert.ok(buildExports().failed > 0);
    const failure = await (await request(`/api/exports/${failed.id}`)).json();
    assert.equal(failure.error_code, "STORED_DATA_INVALID");
    assert.equal(failure.serving, false);
    await db.query("UPDATE nodes SET config_data=$2 WHERE id=$1", [
      nodeId,
      originalConfig,
    ]);
    await db.query("DELETE FROM node_daily_stats WHERE node_id=$1", [nodeId]);
  } finally {
    await db.end();
  }
  const retained = await (await request(`/api/nodes/${nodeId}`)).json();
  assert.equal(retained.checked_days, 2);
  assert.equal(retained.lifetime_availability, 0.5);
});

test("fixed profiles publish in Actions, preserve versions and reject invalid ETags", async () => {
  const node = (
    await (await request("/api/nodes?status=UP&eligible=true&limit=1")).json()
  ).items[0];
  assert.ok(node);
  const original = globalThis.fetch;
  let dispatches = 0;
  env.GITHUB_REPOSITORY = "synthetic-owner/synthetic-repo";
  env.GITHUB_DISPATCH_TOKEN = "synthetic-token";
  globalThis.fetch = async (url) => {
    assert.ok(String(url).endsWith("/export-build.yml/dispatches"));
    dispatches++;
    return new Response(null, { status: 204 });
  };
  try {
    const created = await request("/api/exports", {
      method: "POST",
      data: {
        name: "Stable profile",
        format: "json",
        filters: { id: node.id },
      },
    });
    const artifact = await publish(created),
      url = `/subscriptions/${artifact.id}?token=${artifact.token}`;
    assert.equal(dispatches, 1);
    assert.equal(artifact.expires_at, null);
    assert.equal(
      (await (await request(`/api/exports/${artifact.id}/link`)).json()).token,
      artifact.token,
    );
    const first = await request(url, { authenticated: false }),
      etag = first.headers.get("ETag");
    assert.equal(first.status, 200);
    assert.ok(etag);
    const conditional = () =>
      handle(
        new Request("https://assets.example" + url, {
          headers: { "If-None-Match": etag },
        }),
        env,
        connect,
      );
    assert.equal((await conditional()).status, 304);
    assert.equal(dispatches, 1);
    const edit = await request(`/api/exports/${artifact.id}`, {
      method: "PATCH",
      data: { format: "uri", expected_revision: 1 },
    });
    assert.equal(edit.status, 202);
    assert.equal(dispatches, 2);
    assert.equal((await conditional()).status, 503);
    const conflict = await request(`/api/exports/${artifact.id}`, {
      method: "PATCH",
      data: { format: "json", expected_revision: 1 },
    });
    assert.equal(conflict.status, 409);
    assert.equal(dispatches, 2);
    assert.ok(buildExports().ready > 0);
    assert.equal((await request(url, { authenticated: false })).status, 200);
    const versions = await (
      await request(`/api/exports/${artifact.id}/versions`)
    ).json();
    assert.equal(versions.length, 2);
    assert.equal(versions[0].version_no, 2);
    assert.ok(!JSON.stringify(versions).includes(artifact.token));
    const rotated = await (
      await request(`/api/exports/${artifact.id}/token`, { method: "POST" })
    ).json();
    assert.equal((await request(url, { authenticated: false })).status, 404);
    assert.equal(
      (
        await request(`/subscriptions/${artifact.id}?token=${rotated.token}`, {
          authenticated: false,
        })
      ).status,
      200,
    );
    assert.equal(dispatches, 2);
    await request(`/api/exports/${artifact.id}`, { method: "DELETE" });
    assert.equal(
      (
        await request(`/subscriptions/${artifact.id}?token=${rotated.token}`, {
          authenticated: false,
        })
      ).status,
      404,
    );
  } finally {
    globalThis.fetch = original;
    env.GITHUB_REPOSITORY = "";
    env.GITHUB_DISPATCH_TOKEN = "";
  }
});

test("archived scans expose their summary and cannot dispatch retries", async () => {
  const id = crypto.randomUUID(),
    db = await connect();
  try {
    await db.query(
      "INSERT INTO scan_runs(id,scan_date,kind,status,node_count,shard_count,error_summary,archived_at,archive_summary) VALUES($1,'2020-01-01','DAILY','ENVIRONMENT_ERROR',5,1,'{}',NOW(),$2::jsonb)",
      [
        id,
        JSON.stringify({
          items: { DONE: 3, PENDING: 2 },
          shards: { ENVIRONMENT_ERROR: 1 },
        }),
      ],
    );
    const detail = await (await request(`/api/scans/${id}`)).json();
    assert.deepEqual(detail.items, { DONE: 3, PENDING: 2 });
    assert.deepEqual(detail.shards, []);
    assert.ok(detail.archived_at);
    assert.equal(
      (await request(`/api/scans/${id}/retry`, { method: "POST" })).status,
      410,
    );
  } finally {
    await db.end();
  }
});

test("bulk subscription import is atomic, deduplicated and never dispatches", async () => {
  const original = globalThis.fetch;
  env.GITHUB_REPOSITORY = "synthetic-owner/synthetic-repo";
  env.GITHUB_DISPATCH_TOKEN = "synthetic-actions-token";
  const ids = new Set();
  const calls = [];
  const data = {
    urls: "\nhttps://bulk.example/sub?token=synthetic-bulk-secret\nhttp://store.example:3000/api/subs\nhttps://BULK.example:443/sub?token=synthetic-bulk-secret\nhttp://169.254.169.254/private\nnot-a-url",
  };
  try {
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return new Response(null, { status: 204 });
    };
    assert.equal(
      (
        await request("/api/sources/bulk", {
          method: "POST",
          data,
          authenticated: false,
        })
      ).status,
      401,
    );
    const response = await request("/api/sources/bulk", {
      method: "POST",
      data,
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    result.items.filter((i) => i.id).forEach((i) => ids.add(i.id));
    assert.deepEqual(
      [result.created, result.duplicates, result.invalid],
      [2, 1, 2],
    );
    assert.deepEqual(
      result.items.map((i) => i.line),
      [2, 3, 4, 5, 6],
    );
    assert.equal(result.items[0].id, result.items[2].id);
    assert.ok(!JSON.stringify(result).includes("synthetic-bulk-secret"));
    assert.equal(calls.length, 0);
    assert.equal(result.pipeline.reason, "MANUAL_SYNC");
    for (const id of ids)
      assert.ok(
        (await (await request(`/api/sources/${id}`)).json()).sync_requested_at,
      );
    const repeat = await (
      await request("/api/sources/bulk", { method: "POST", data })
    ).json();
    assert.equal(repeat.created, 0);
    assert.equal(repeat.duplicates, 3);
    assert.equal(calls.length, 0);
    for (const urls of [
      "https://limits.example/\n".repeat(101),
      "x".repeat(131073),
      " ",
    ]) {
      assert.ok(
        (await request("/api/sources/bulk", { method: "POST", data: { urls } }))
          .status >= 400,
      );
    }
    globalThis.fetch = async () => {
      throw new Error("synthetic-private-failure");
    };
    const failed = await (
      await request("/api/sources/bulk", {
        method: "POST",
        data: { urls: "https://bulk-retry.example/api/subs" },
      })
    ).json();
    assert.equal(failed.created, 1);
    ids.add(failed.items[0].id);
    assert.equal(failed.pipeline.reason, "MANUAL_SYNC");
    assert.ok(
      (await (await request(`/api/sources/${failed.items[0].id}`)).json())
        .sync_requested_at,
    );
  } finally {
    env.GITHUB_REPOSITORY = "";
    env.GITHUB_DISPATCH_TOKEN = "";
    globalThis.fetch = original;
    for (const id of ids)
      await request(`/api/sources/${id}`, { method: "DELETE" });
  }
});

test("concurrent bulk imports share one source", async () => {
  const data = { urls: "https://bulk-concurrent.example/api/subs" };
  const results = await Promise.all(
    [1, 2].map(async () =>
      (await request("/api/sources/bulk", { method: "POST", data })).json(),
    ),
  );
  try {
    assert.equal(
      results.reduce((n, r) => n + r.created, 0),
      1,
    );
    assert.equal(
      results.reduce((n, r) => n + r.duplicates, 0),
      1,
    );
    assert.equal(results[0].items[0].id, results[1].items[0].id);
  } finally {
    for (const id of new Set(results.flatMap((r) => r.items.map((i) => i.id))))
      await request(`/api/sources/${id}`, { method: "DELETE" });
  }
});

test("bulk URL validation matches shared Python fixtures", async () => {
  const { subscriptionURL } = await import("../dist/source-bulk.js");
  const cases = JSON.parse(
    readFileSync(root + "tests/fixtures/bulk_links.json", "utf8"),
  );
  for (const c of cases) {
    if (c.url) assert.equal(subscriptionURL(c.value), c.url);
    else assert.throws(() => subscriptionURL(c.value));
  }
});

test("airports, providers, ASN labels, settings and batch actions", async () => {
  await request("/api/naming-rules", {
    method: "PUT",
    data: { template: "{FLAG}{ROUTE}|{ASN} {SEQ}" },
  });
  const created = await (
    await request("/api/sources", {
      method: "POST",
      data: {
        name: "Synthetic airport",
        type: "SUBSCRIPTION_URL",
        payload: "https://air.example/sub?token=synthetic-air-secret",
      },
    })
  ).json();
  const synced = JSON.parse(
    py(`import json,os,base64
from uuid import UUID
from app.config import Settings
from app.database.session import make_engine,session_factory
from app.ingestion.service import AssetService
from app.scans import ScanService
from app.checker.health import Observation
class Fetcher:
 def fetch_meta(self,url,user_agent=None):
  return b'trojan://synthetic-air@air-node.example:443#HK', {'subscription-userinfo':'upload=1; download=99; total=1000; expire=4102444800','profile-title':'Synthetic Air'}
assets=AssetService(session_factory(make_engine(os.environ['DATABASE_URL'])),b'H'*32,fetcher=Fetcher())
result=assets.sync_source(UUID('${created.id}'))
settings=Settings(_env_file=None,database_url=os.environ['DATABASE_URL'],encryption_key_b64=base64.b64encode(b'E'*32).decode(),fingerprint_key_b64=base64.b64encode(b'H'*32).decode(),retry_delay_seconds=0)
class Fake:
 def preflight(self):pass
 def check(self,d,name):return Observation(status='UP',entry_country='HK',exit_country='SG',exit_asn=64999,exit_asn_org='WEBBING HONG KONG LIMITED',exit_ip='8.8.8.8',http_duration_ms=3)
 def close(self):pass
scans=ScanService(assets,settings,checker_factory=Fake)
run=scans.create(scope='AIRPORT',manual=True)
for s in scans.get(run['id'])['shards']:scans.run_shard(run['id'],s['shard_no'])
scans.finalize(run['id'])
print(json.dumps({'status':result['status'],'count':run['node_count']}))`),
  );
  assert.deepEqual(synced, { status: "SUCCESS", count: 1 });
  const airports = await (await request("/api/airports")).json();
  const air = airports.sources.find((s) => s.id === created.id);
  assert.equal(air.traffic_total, 1000);
  assert.equal(air.usable, true);
  assert.equal(air.up_count, 1);
  assert.equal(air.url_host, "air.example");
  assert.ok(!JSON.stringify(airports).includes("synthetic-air-secret"));
  const provider = airports.providers.find((p) => p.id === air.provider_id);
  assert.equal(provider.name, "Synthetic Air");
  const renamed = await (
    await request(`/api/providers/${provider.id}`, {
      method: "PATCH",
      data: { name: "Renamed Air", website: "https://air.example/path?t=1" },
    })
  ).json();
  assert.deepEqual(
    [renamed.name, renamed.website],
    ["Renamed Air", "https://air.example"],
  );
  const moved = await (
    await request(`/api/sources/${created.id}`, {
      method: "PATCH",
      data: { provider_id: "new", provider_name: "Second Air" },
    })
  ).json();
  assert.notEqual(moved.provider_id, provider.id);
  const nodes = await (await request("/api/nodes?node_group=AIRPORT")).json();
  assert.equal(nodes.total, 1);
  assert.equal(nodes.items[0].name, "🇸🇬HK->SG|Webbing 01");
  const labels = await (await request("/api/asn-labels")).json();
  assert.equal(labels.observed.find((o) => o.asn === 64999).label, "Webbing");
  assert.equal(
    (
      await request("/api/asn-labels/64999", {
        method: "PUT",
        data: { label: "WBG" },
      })
    ).status,
    200,
  );
  const relabelled = await (
    await request("/api/nodes?node_group=AIRPORT")
  ).json();
  assert.equal(relabelled.items[0].name, "🇸🇬HK->SG|WBG 01");
  assert.equal(
    (
      await request("/api/asn-labels/64999", {
        method: "PUT",
        data: { label: "bad|label" },
      })
    ).status,
    400,
  );
  await request("/api/asn-labels/64999", { method: "DELETE" });
  const settings = await (
    await request("/api/settings", {
      method: "PUT",
      data: { daily_scan_enabled: false, daily_scan_scope: "ALL" },
    })
  ).json();
  assert.deepEqual(settings, {
    daily_scan_enabled: false,
    daily_scan_scope: "ALL",
  });
  const disabled = await (
    await request("/api/nodes/batch", {
      method: "POST",
      data: { ids: [nodes.items[0].id], enabled: false },
    })
  ).json();
  assert.equal(disabled.changed, 1);
  const paused = await (
    await request("/api/sources/batch", {
      method: "POST",
      data: { ids: [created.id], action: "disable" },
    })
  ).json();
  assert.equal(paused.changed, 1);
  assert.equal(
    (
      await request("/api/sources/batch", {
        method: "POST",
        data: { ids: ["not-a-uuid"], action: "delete" },
      })
    ).status,
    400,
  );
  await request("/api/sources/batch", {
    method: "POST",
    data: { ids: [created.id], action: "delete" },
  });
});
