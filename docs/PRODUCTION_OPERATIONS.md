# 生产接管与操作手册

更新：2026-11-11。先读 AGENTS.md 与 HANDOFF.md；这是已有实例维护流程，不是新建资源教程。以下生产写操作仅在具体任务已授权、核对目标后执行；本文件自身不授权恢复、删库或轮换密钥。已有明确授权不必重复询问。

## 身份、环境与资料位置

本机根目录为 `/Users/sumi/19-nodema`，命令默认从仓库根运行。公开仓库 main 只有源码；生产数据在 Neon，不在 Git。private 被 Git 和 Docker build context 忽略。

- `private/README.md`：本机私密资料索引、资源与认证说明。
- `private/deployment-state.json`：资源 ID、部署 commit/版本与历史验收标记；不是实时状态。
- `private/cloud-deploy.env`：生产 owner/业务角色连接、HMAC/AES、管理员和调度凭据。只通过程序定向取值，不打印、source 整份文件或上传到日志。
- `private/api-worker-secrets.json`：发布 API 使用的两个秘密值，Wrangler secrets-file 可读取；不复制到 wrangler.jsonc。
- `private/production-inventory.json`：交接时只读盘点，只有表行数/schema/批次状态和时间，不含节点配置。不是备份。
- `private/nodema-login.txt`：用户登录资料，勿在聊天转贴。

先检查 `gh auth status`、Wrangler 当前登录账号和配置目标。GitHub/Cloudflare/Neon 的本机登录态不随 Git clone 搬家；不要重新开户建同名资源来解决授权缺失。Neon CLI 凭据在本机系统 keyring，不能假定存在可复制的 NEON_API_KEY。

## 接管时只读检查

```bash
git status --short
git log -5 --oneline
gh run list --repo Samiya321/nodema --limit 8
# 在对应目录运行，确保使用本项目 Wrangler
(cd cloudflare/api-worker && npx wrangler whoami)
```

生产健康接口 `/api/health` 可公开读取，管理接口应未授权返回 401。需要认证时，从 private 程序读取 ADMIN_PASSWORD，仅放 HTTP header，不放 URL、curl 参数或日志。`/api/readiness` 核对 schema 与调度配置，但不证明 token 真有 Actions write 权限。

以下模板只执行只读 doctor；它不会初始化密钥、迁移或扫描节点。避免把原始数据库异常打印出来：

```bash
uv run python - <<'PY'
import os, subprocess, sys
from dotenv import dotenv_values
v = dotenv_values('private/cloud-deploy.env')
env = os.environ.copy()
for key in ('PGOPTIONS', 'TEST_DATABASE_URL', 'TEST_PG_CONTAINER'):
    env.pop(key, None)
for key in ('DATABASE_URL', 'MIGRATION_DATABASE_URL', 'FINGERPRINT_KEY_B64',
            'ENCRYPTION_KEY_B64', 'ENCRYPTION_KEY_ID', 'ADMIN_PASSWORD', 'ECHO_URL'):
    if v.get(key):
        env[key] = v[key]
subprocess.run([sys.executable, '-m', 'app.cli', 'doctor'], env=env, check=True)
PY
```

需要数据库盘点时使用 `make_engine`，事务先 `SET TRANSACTION READ ONLY`，设置 statement_timeout，仅查询 migration revision、表行数、批次状态及时间。结果存权限 0600 的 private 文件；不输出 sources.url_data/payload_data、nodes.config_data、export payload/token 或 SELECT *。如果连接失败，记录脱敏错误码，不能用旧快照冒充实时结果。

## 修改、部署与回退

1. 核对 git diff，保持用户未提交修改。按 HANDOFF.md 在隔离 DB 验证；检查参数/错误信息不泄密。
2. 有 migration 时先做新鲜加密备份并在隔离 PG 恢复验证。考虑当前 Actions 也可能自动执行 upgrade head，必要时先协调/暂停写工作流，避免 main 上的新 migration 在人工维护窗口前执行。
3. 向 main 推送经过验证的代码，会自动触发 tests。推送不会自动发布 Pages/Worker，但会改变下一次 Actions 使用的 Python/工作流代码；因此它也是生产变更的一部分。
4. DB schema、Python/Actions、Worker readiness 有版本耦合。添加兼容迁移后先升级 DB，再更新 Worker/Pages，留意严格 head 检查的短暂影响；不要重写已执行的旧 migration。
5. API 发布先于依赖它的新 UI；Echo 仅在其代码有改动时更新。

本机当前 API 重新发布（不变更密钥内容）：

```bash
(cd cloudflare/api-worker && npm ci && npm run predeploy && \
  npx wrangler deploy --secrets-file ../../private/api-worker-secrets.json)
(cd web/dashboard && npm ci && npm run check && npm run build && \
  npx wrangler pages deploy dist --project-name nodema-dashboard --branch main)
```

没有本机 secrets 文件时，按 DEPLOYMENT.md 使用交互式 secret prompt；不要把真实值放 argv。发布前核对本项目 Cloudflare 账号、Hyperdrive ID、Pages API 服务绑定和仓库。当前实例的有效 ID 已在配置中，不应改成教程占位符。

完成后验证健康/401、认证 readiness、列表、改动相关流程；生产测试尽量只读，无效批量输入可以验证端点但不证明有效导入成功。有效导入/删除会改变来源关系与订阅资格，须使用明确授权的测试来源，不借用用户真实来源做回归。登录浏览器自动化时，不输出含密码的脚本源或工具回显。

回退优先回到先前已验证的 Worker/Pages 版本或重新发布兼容 commit；确认与现有 DB schema 兼容。不要把应用回退等同数据库 downgrade。`0011` 已归档的明细无法降级还原；恢复和破坏性迁移需要数据方案。

## 日常任务与故障排查

| 现象 | 排查与恢复 |
| --- | --- |
| 保存来源后等待 | 看 sync_requested_at、来源结果、source-sync/daily-check；调度失败请求仍在 DB，点击一次同步即可处理所有待同步来源，不用重复导入 |
| Actions 没触发 | 核对 Worker 调度 token 对本仓库 Actions write 权限/有效期、main ref、工作流文件。readiness 有配置不等于权限通过；不要把自动 GITHUB_WORKFLOW_REF 当分支 |
| 扫描没完成 | 看现有 run/shard 租约及错误分类；用 UI 重试或 daily-check 的已有 run_id。不能删扫描项、重开归档日期或把环境错误批量改 DOWN |
| 订阅返回 503 | 常见为待生成、失效或新鲜度到期；看方案状态/成员资格，再 retry 或运行 export-build，不手改 invalidated/revision/成品字段 |
| 订阅 404/鉴权失败 | 检查 token、撤销、到期；不要将完整私有 URL 贴到公开 issue。旧 token hash 不能还原原 token，确需更换由用户触发 |
| 入口国家/ASN 未知 | 看 geoip-pack 输出；缺记录/校验失败/未安装 MMDB 都可能，不代表节点 DOWN。GitHub 源无需新建 MaxMind 账号，确认 GeoIP provider 即可 |
| DB/TLS 连接失败 | Neon 可能休眠、网络可能暂时不通；核对连接角色、TLS、CA、Hyperdrive。保留 verify-full，不关闭 TLS、不重建库 |
| Neon 公网传输快用完 | Free 每月 5 GB，用完后实例暂停到下个计费周期（数据保留）。所有从 Neon 读出的数据都计入：Hyperdrive 给 Worker 的查询、Actions 的读、本机脚本和每次 `pg_dump`。先停每周备份（`gh workflow disable backup.yml`，有新鲜本地备份时）、避免本机整库备份和对生产的大查询（节点页“全部状态”约 13 MB/次），周期重置后再 `gh workflow enable backup.yml`。用量以 Neon 控制台项目概览为准 |
| 容量或分钟数增长 | 查运行与用量、活跃任务和保留设置；cleanup 会归档并删除过期明细，应了解其影响后执行，不为验收随意运行 |

每日主流程默认北京时间 04:17，备份默认周日 05:41。GitHub 定时可能延迟；手工执行固定工作流前确认本次任务允许生产写入/检测：

```bash
# 只同步来源（不检测）
gh workflow run source-sync.yml --repo Samiya321/nodema --ref main
# 检测某一范围（SELF_HOSTED / AIRPORT / ALL）
gh workflow run daily-check.yml --repo Samiya321/nodema --ref main -f scope=SELF_HOSTED
gh workflow run export-build.yml --repo Samiya321/nodema --ref main
# 恢复指定 run 使用 daily-check.yml 的 run_id 输入，不把示例 ID 当真实 ID
```

接入测量 `entry-probe.yml` 没有 GitHub 定时：API Worker 的 Cron Trigger（`wrangler.jsonc` 的 `triggers.crons`，UTC 每小时 :30）用 `GITHUB_DISPATCH_TOKEN` 调用 workflow dispatch 启动它。调度令牌过期或失去 Actions 写权限时测量会停止：总览“接入测量”的最近一次时间不再更新；Worker 只记录失败代码。想暂停测量用设置 → 质量分级规则 → 接入测量，不要删除 cron。

等级重算（`nodema grade refresh`）每次重写约 4 万行，只在 Actions 内运行（`daily-check.yml` 收尾、`entry-probe.yml` 到期时）。从国内本机对 Neon 执行会因上传慢而持续数十分钟并长期持有事务，2026-11-14 实测超过 40 分钟后中止。

## 备份、恢复与数据库搬家

数据库明文不表示备份可公开。每周加密 artifact 仅保留 7 天；GeoIP 密文包保留 1 天。GitHub artifact 不是无限期灾备；如果需要长期恢复点，应另行私下保存加密备份与对应密钥，分开保管。失去 AES 密钥就无法解密对应备份。

`private/cloud-backup-smoke.nma` 是最初云端备份验收文件，不是最新生产快照；不能拿它覆盖用户后来导入的数据。恢复前核对文件时间、来源、AES key ID、目标 DB 与最近一次隔离恢复证据。

- 新备份：用上面的安全 env 模板，将命令改为 `python -m app.cli backup --output-file private/<新文件名>.nma --docker-client`；DATABASE_URL 优先选本机 MIGRATION_DATABASE_URL 的直连 owner 地址。输出文件拒绝覆盖已有路径。
- 自动备份：已授权时触发 `backup.yml`，记录 run ID、artifact 保留期和下载校验；不把 key 与 artifact 打包保存。
- 恢复演练：新建隔离 PostgreSQL 17，显式让 DATABASE_URL 指向测试目标，再用 `nodema restore --input-file <私密文件> --confirm-restore --docker-client`。该命令内部 pg_restore --clean，会覆盖目标对象，绝不能指向在线库当作演练。
- **Neon 专有列选项**：2026-11-14 起，Neon 给 0018 新建的表（如 `entry_probe_results`）写了 `ALTER TABLE ... ALTER COLUMN ... SET (pg_attver=...)` 列选项，标准 PostgreSQL 17 不认识，`pg_restore` 会报 `unrecognized parameter "pg_attver"` 并整体回滚（`nodema restore` 显示 DATABASE_RESTORE_FAILED）。恢复到非 Neon 的 PostgreSQL 时，先用 `pg_restore -f -` 解密转成 SQL，删除这些 `SET (pg_attver=…)` 语句（2026-11-14 的备份有 67 条），再用 `psql -v ON_ERROR_STOP=1 --single-transaction` 导入；这是隔离恢复 `backup-2026-11-14-pre-0019.nma` 时验证过的做法。恢复回 Neon 时不受影响。
- 验证 schema、函数/触发器/索引、行数、HMAC 一致性、读写和订阅失效语义。备份不包含 owner/ACL，目标需重新授予业务角色权限。
- **搬到新的 Neon 项目（2026-11-14 做过一次）**：在 GitHub Runner 上复制，避免跨洋上传和本机超时：停用写数据库的工作流；新项目建 `nodema_owner`/`nodema_api` 与默认权限；临时 Secrets `MOVE_SOURCE_DATABASE_URL`/`MOVE_TARGET_DATABASE_URL` 加一个调用 `scripts/move_database.py --mode full|reduced` 的一次性 workflow_dispatch 工作流（参考 git 历史 `240a695` 的 `.github/workflows/db-move.yml`）；脚本拒绝非空目标，最后逐表核对行数。之后切换 Secrets、Hyperdrive origin 和本机 env，验证后再删旧项目。`reduced` 只复制被引用的 `test_results`。
- 迁移到另一完整 PostgreSQL：协调暂停 Actions/其他写入口，最终备份，隔离恢复与验证，建立 API 角色，更新 Actions 的数据库 Secrets 和 Hyperdrive origin（继续禁用查询缓存），核对 TLS/CA，再恢复任务。保留 HMAC/AES、资产 ID、订阅 ID/token、日期水位与累计计数；保留原库用于回退。

没有执行过生产恢复或跨云搬家时，明确标记“未验收”，不要引用本地合成测试替代生产结果。

## 换机器或换维护者

只 clone 仓库不足以操作生产。新维护者需要：仓库/Actions、Cloudflare 账号资源、Neon 项目的授权；对应生产配置与密钥；如需恢复则要加密备份及匹配密钥。通过用户认可的安全渠道转移，不在聊天、issue 或 Git 中传递。

本机 private 也不是数据库本体，复制目录不能复制当前 Neon 数据。OS keyring 登录态需新机器重新授权。转移后先只读核对目标/版本/新鲜度与 HMAC，再做具体任务。不要因为缺少 private 而初始化新密钥覆盖现网；如果权限或必要密钥确实缺失，列出缺什么及用途，交由用户补充。
