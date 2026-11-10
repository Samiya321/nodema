# 部署：Pages + Worker API + Python Actions

当前生产组合为 Pages + Worker + PostgreSQL + Python Actions；订阅转换也在 Actions 执行，不使用自有服务器。架构背景见 [ARCHITECTURE_REVIEW.md](ARCHITECTURE_REVIEW.md)。Python FastAPI 与 Dockerfile 仅为可选本地调试入口，生产 Worker 不调用它，也不需要部署 Python 常驻服务。

明文存储、累计可用率和旧密文升级步骤见 [DATA_STORAGE_AND_LIFETIME.md](DATA_STORAGE_AND_LIFETIME.md)。普通操作无需 AES，旧库请先完成一次性转换。

## 1. 数据库与密钥

创建 Neon PostgreSQL 数据库，使用服务方要求的 TLS。通过私下的 `.env` 设置 `DATABASE_URL`；迁移若需直连，设置 `MIGRATION_DATABASE_URL`。运行 `uv run alembic upgrade head`。

在本地 `uv run nodema keys init` 生成 HMAC、管理员以及可选备份 AES 密钥。数据库明文存储，Worker 不需要 AES。旧密文迁移、加密备份和 MMDB 密文包才使用 AES；HMAC 密钥只提供给 Python/Actions。数据库备份与密钥分别私下备份，密钥不进入 Git、GitHub artifacts、Docker build context 或公开配置。

## 2. Echo Worker

在 `cloudflare/echo-worker`：

```bash
npm ci
npm run types
npm run check
npm test
npx wrangler deploy --dry-run
# 配置并登录你自己的 Cloudflare 账号后发布：
npm run deploy
```

用返回的 HTTPS 根地址配置 Python `ECHO_URL` 与 GitHub 仓库变量 `ECHO_URL`。Echo 只接受根路径 GET，不接收转发 URL，不写调用者 IP，不缓存响应。部署后必须验证 `CF-Connecting-IP`、`request.cf.country`、`request.cf.asn` 实际可用；本地缺少平台 metadata 时返回 503，不能伪造平台字段。

## 3. Hyperdrive 与 Worker API

在 Cloudflare 控制台创建连接 Neon 的 Hyperdrive。**禁用查询结果缓存**，保留连接池能力；停用、撤销与新鲜度校验依赖即时读取数据库。不要把数据库密码作为 CLI 参数或提交到 wrangler 配置。

将实际 Hyperdrive ID 写入 `cloudflare/api-worker/wrangler.jsonc`；仓库中的全零 ID 仅为占位符。配置非敏感 vars：

| 变量 | 用途 |
| --- | --- |
| `FRESHNESS_HOURS` | 默认 36 |
| 订阅有效期 | 新方案默认长期有效，Dashboard 可逐个设置；旧 `EXPORT_TTL_HOURS` 不再控制新链接 |
| `NAME_TEMPLATE` | 尚未保存数据库模板时的默认模板 |
| `GITHUB_REPOSITORY` | 你的 `owner/repository` |
| `GITHUB_WORKFLOW_REF` | 受信任默认分支，默认 main |

使用交互式 secret prompt，不把值写在命令行：

```bash
cd cloudflare/api-worker
npm ci
npm run types
npm run check
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put GITHUB_DISPATCH_TOKEN
npx wrangler deploy --dry-run
npm run deploy
```

GitHub fine-grained token 仅授予目标仓库 Actions 写权限，以调用预设的 workflow_dispatch。Worker 不使用该 token 读取节点配置，也不接受任意工作流文件或任意仓库参数。

Worker 每次请求创建并关闭一个 pg Client，连接池由 Hyperdrive 管理。API 未授权请求在连库前拒绝；AES 密钥和数据不写日志；禁用 Worker observability。管理员 token 仅由浏览器当前页面会话持有，退出后清除，不写 localStorage。

## 4. Pages

`web/dashboard/wrangler.jsonc` 的 `API` 服务绑定指向 `nodema-api`。若修改 Worker 名称，必须同步更新绑定。

```bash
cd web/dashboard
npm ci
npm run types
npm run check
npm run build
npx wrangler pages functions build --outdir dist/functions
npm run deploy
```

Pages Functions 将 `/api/*` 和 `/subscriptions/*` 转发给 Worker 服务绑定，前端无需公开跨域 API 地址，不在前端构建中注入任何密钥。静态资源与 API 均设置 no-store、no-referrer 和安全响应头。可另用 Cloudflare Access 限制 Dashboard 访问；订阅客户端若需要访问订阅链接，配置相应 Access 策略。

订阅 token 是凭据。不要为 Pages、Worker、反向代理或自建接入层启用包含完整订阅 URL/Authorization 的请求日志、分析采集或错误追踪。Wrangler 本地脚本使用 `--log-level error`，避免成功请求日志记录 token。

## 5. GitHub Actions

将源码推送到你自己的仓库；本次工作没有创建或推送 Git 仓库。配置：

| Secret | 用途 |
| --- | --- |
| `DATABASE_URL` | 同一数据库，启用 TLS |
| `MIGRATION_DATABASE_URL` | 可选迁移直连地址，缺省使用 DATABASE_URL |
| `ENCRYPTION_KEY_B64` | 可选；旧密文迁移、加密备份或 MMDB 密文包使用，普通数据库读写无需配置 |
| `FINGERPRINT_KEY_B64` | 独立 HMAC 密钥 |
| `ECHO_TOKEN` | 仅用于另行保护的 Echo，可留空 |
| `BACKUP_DATABASE_URL` | 可选备份直连地址，缺省使用 DATABASE_URL |

仓库 vars：`ENCRYPTION_KEY_ID`（缺省 local-v1）、`ECHO_URL`。可选 Secrets `MAXMIND_ACCOUNT_ID` 和 `MAXMIND_LICENSE_KEY` 必须同时配置，才能启用自动入口 GeoIP/ASN；不配置时该部分保持未知。

- `export-build.yml`：保存、编辑或重试订阅方案时调用；Actions 生成并发布当前成品，独立于长时间健康检测任务。
- `source-sync.yml`：保存、修改输入、重新启用来源或点击同步时自动调用，复用完整 daily-check 工作流；一次处理所有已排队或到期来源，再检测并发布。
- `daily-check.yml`：北京时间每天 04:17，也可复用或手动调用。每天一份 DAILY 完整快照，同日新节点进入 SUPPLEMENTAL 不可变补测批次，恢复保留期内的未完成批次。动态 matrix 最多 4 个并行 Job，每个批次独立完整发布。可传入已有 run UUID 单独恢复。
- `backup.yml`：北京时间每周日 05:41，配置备份 AES 后，加密备份并上传仅含密文的 artifact，保留 7 天；未配置则明确跳过，不上传明文备份。
- `tests.yml`：可在 PR 执行，但只使用合成数据和本地 PostgreSQL，不使用生产 Secrets。
- `usage.yml`：同仓库默认分支的每日、来源、订阅构建、备份工作流完成后读取安全的 jobs 起止时间和计数，并采样数据库容量。自动 `GITHUB_TOKEN` 只需 `actions: read` / `contents: read`，无需新增长期 token。

生产工作流只接受默认分支；Actions SHA 已固定。GitHub schedule 可能延迟，必须保留手动入口。Runner 异常、Echo 异常和未完成分片不会发布整批 DOWN。Source 的 sync_requested_at 在调度前写库，一次同步尝试完成后清除；并发修改以 revision 检查保护。导入与检测流水线串行调度，订阅构建使用独立并发组；即便连续点击导致旧的 pending 工作流被替换，后一个仍会处理全部数据库待同步请求。同步失败显示 FAILED，可重试；部分解析的有效节点仍会检测。

启用自动 GeoIP 时，除了两个 MaxMind Secrets，还必须配置 `ENCRYPTION_KEY_B64`，供临时 MMDB 包加密传递使用；这不改变数据库明文存储。准备任务每次有待检测工作时自动下载并验证两个 MMDB，只下载一次。以现有 AES 密钥加密打包，artifact 保留 1 天；各分片下载密文并解密安装。明文只存在临时 Runner，未上传或缓存。两个 Secrets 均为空时明确跳过，只配置一个、授权失败或损坏数据库会中止准备；修复后可点击同步继续。出口信息优先来自 Echo。遵守 MaxMind 许可并控制账户下载次数。

## 6. 部署后操作与升级

1. 已有安装保持原 AES/HMAC 密钥不变，执行 `uv run alembic upgrade head` 到 `0011_scan_archives`（协议扩展为 `0004_password_protocols`，流程迁移为 `0003_import_pipeline`）；来源、节点、旧扫描历史均保留。先迁移数据库，再更新 Worker。
2. 本地填好生产数据库和 Echo 配置后运行 `uv run nodema doctor --network`。只检查数据库/已有数据密钥、Mihomo 和直连 Echo，不连接代理节点，不输出任何凭据。
3. `npm run deploy` 会拒绝全零 Hyperdrive ID 和空仓库配置；预检支持标准 JSONC 注释与尾逗号。Wrangler 检查所需 Secrets。Pages 登录后 `/api/readiness` 进一步检查数据库迁移与调度配置，缺失项显示在界面。
4. 添加一个小批量来源，保存后自动排队；界面每 15 秒刷新，不刷新正在填写的表单或弹窗。查看来源结果和检测记录，UP 节点可生成订阅。提交失败时来源 ID 和 pending 请求仍保留，点击“同步”即可重试，无需重复添加。
5. 再导入一批节点，确认同日产生补测批次，原批次的节点数不变；重新同步相同内容不会重复检测原节点。订阅由 Actions 更新同一固定链接指向的成品；下载检查即时失效标记、撤销和到期时间，首次生成或失效重建期间返回 503。新链接默认长期有效，旧链接保留原到期时间。

readiness 检查配置存在，不会冒充 GitHub 授权测试或真实代理握手。只有真实工作流完成、实际节点显示 UP 并成功导出，才算部署验收完成。

## 7. 上线验收与费用

先导入 50–100 个你有权测试的真实配置，验证实际使用的 Shadowsocks、Trojan、AnyTLS、Hysteria2、VMess 和 VLESS 配置，包括 TLS、Reality、WS/gRPC 及 QUIC 可达性。确认回显走目标代理、出口不串号、环境错误分类正确。之后逐步验证 1,000、5,000 节点。

监控 Actions 总分钟数、分片耗时、超时率、数据库连接与存储、Echo 次数、出口流量、Worker CPU。订阅转换在 Actions 完成，Worker 只校验并读取已发布文件；单份成品上限 10 MiB。较大文件的数据库传输和响应仍会消耗 CPU/内存，本地测试不代替实际账户的额度验收，详见 [异步订阅](ASYNC_SUBSCRIPTIONS.md)。默认 Job 超时 60 分钟，应按实测调整分片大小/超时，不保证所有故障场景在一次 Job 内完成。

部署时重新检查 GitHub、Neon、Cloudflare 的官方额度和账户计划，按 [COSTS.md](COSTS.md) 的时间窗核对实际用量。不在业务代码中固定“永久免费”额度，也不承诺零费用。实际云端发布、真实节点握手、MaxMind 下载和 GitHub 执行用量尚需你的生产配置验证。


## 异步订阅与归档升级

部署代码须包含 `export-build.yml`。Worker 的调度 token 需要目标仓库 Actions write 权限，使用仓库受信任默认分支；无需额外 R2、Redis 或常驻服务。`FRESHNESS_HOURS` 在 Worker vars、GitHub repository vars 与本地配置保持一致，默认 36。

已有安装先私下备份并保存原密钥，再迁移到 `0011_scan_archives`，更新工作流及 API/Pages。`0010` 保留旧链接 ID、token hash 和到期时间，将成品置为待生成；执行一次 `uv run nodema export build-pending` 或手动运行 Build private subscriptions。转换完成前旧链接会返回待更新。旧 token 不能从 hash 恢复；原链接仍可用，确需恢复地址时通过管理员“更换密钥”生成新地址。

检查创建返回 202、Actions 执行、列表变为就绪、固定链接下载、停用阻断、重建与撤销后，再开始批量导入。生成任务按 PostgreSQL 中的持久请求恢复，调度失败可在页面重试，也会由每日流水线补处理。没有每次下载触发一个 Job 的行为。

`nodema cleanup` 已在每日准备和结束阶段运行，详情默认 60 天、日统计 365 天；成品默认 20 方案/64 MiB/100,000 成员和每方案 20 条版本摘要，可用 `nodema export budgets` 查看或调整。归档保留轻量批次摘要和累计统计；已归档明细不能通过降级还原，回退需使用备份。完整语义见 [ASYNC_SUBSCRIPTIONS.md](ASYNC_SUBSCRIPTIONS.md)。免费计划容量和 CPU 仍须在自己的账户监测，应用预算不是提供商额度承诺。
