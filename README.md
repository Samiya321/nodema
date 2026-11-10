# Nodema · 私有节点资产与健康监测

个人使用的 Shadowsocks / Trojan / AnyTLS / Hysteria2 / VMess / VLESS 资产管理系统。生产部署采用 **Cloudflare Pages + TypeScript Worker API + Neon PostgreSQL + GitHub Actions Python 检测任务**，不要求常驻服务器。

云端实例已于 2026-11-11 发布，地址、验证结果和当前边界见 [云端部署记录](docs/CLOUD_DEPLOYMENT.md)。

已包含 M1–M4 功能、六协议、Sub-Store 导入、累计可用率、Actions 预生成订阅和扫描明细归档，以及 M5 的本地规模测试、备份和验证文档。代码、本地回归与云端基础链路均已有验证；此前功能核对见 [交付审查](docs/CONVERSATION_COMPLETENESS_REVIEW.md)，最新上线结果见 [云端部署记录](docs/CLOUD_DEPLOYMENT.md)。用户真实公网节点与长期额度仍需实际使用验证。

最新存储与日期统计说明见 [明文存储与节点可用天数](docs/DATA_STORAGE_AND_LIFETIME.md)。原 AES 数据库要求已被用户的新选择覆盖；旧密文升级时仍需原密钥一次性转换。

## 功能

- Source CRUD、批量订阅 URL / Sub-Store API、文件/URI/Base64/Clash/sing-box 导入、HMAC 去重、数据库明文存储。
- 首次加入、已收录天数、累计可用/已检测天数与日可用率，支持组合筛选、排序和导出。
- 隔离的 Mihomo 单节点检测、入口 DNS/TCP、轻量 HTTPS Echo、入口/出口地区和 ASN。
- 保存来源后自动同步并检测；每日完整快照、同日新增补测、稳定分片、租约与断点恢复。
- 中文 Dashboard：总览、节点筛选/详情、来源管理、扫描进度/重试、命名模板/历史、五种私有导出。
- Actions 异步生成五格式订阅，固定链接默认长期有效，可编辑、重建、撤销及设置到期；停用、来源或健康资格变化即时阻断旧文件，报告不含认证信息。
- 旧扫描明细按保留期归档，保留批次摘要、日期幂等与累计统计；当前成品、成员和历史摘要受应用预算约束。
- 无下载测速、无网段扫描、无 IPLC/IEPL/CN2 自动推断。线路字段固定 UNKNOWN。

六种协议均已接通导入、检测和导出。参数与格式限制见 [PROTOCOLS.md](docs/PROTOCOLS.md)；不支持的扩展会明确显示 UNSUPPORTED。

## 本地准备

需要 Python 3.12、uv、Node.js 22+、Docker。

```bash
uv sync --frozen
cp .env.example .env
uv run nodema keys init --env-file .env
docker compose up -d --wait db
uv run alembic upgrade head
uv run python scripts/install_mihomo.py
```

`keys init` 将两把独立的 32 字节密钥及管理员随机密钥写入权限 0600 的 `.env`，不输出值。已有 M1 密钥的用户可用 `uv run nodema keys init --admin-only` 补充空的 `ADMIN_PASSWORD`，不要覆盖旧 AES/HMAC 密钥。

本地 PostgreSQL 绑定 `127.0.0.1:55432`，首次初始化创建 `nodema` 与 `nodema_test`。若旧卷缺少测试库，可执行 `docker compose exec db createdb -U nodema nodema_test`。

## 导入资产

```bash
uv run nodema source create --name demo --type UPLOADED_FILE --input-file tests/fixtures/sample_clash.yaml
uv run nodema source sync <SOURCE_ID>
uv run nodema node list
uv run nodema node show <NODE_ID>
```

Dashboard 的「订阅与来源 → 批量导入链接」支持一行一个地址，普通订阅与 Sub-Store API 可以混合粘贴；每批 100 个，重复跳过，无效行单独报告。命令行可用 `uv run nodema source import-links --input-file private/subscriptions.txt`，接口为 `POST /api/sources/bulk`。保存后统一调度一次 Actions。

真实输入放入 `private/` 或 `local-inputs/`；URI 和订阅 URL 通过 `--input-file` 或标准输入 `-` 提交，不放在命令行参数中。Source 类型支持 SUBSCRIPTION_URL、SINGLE_URI、UPLOADED_FILE、RAW_TEXT；`--format-hint` 支持 AUTO、URI、BASE64、CLASH、SINGBOX。AUTO 还可识别 Loon、Surge 和 Quantumult X 节点列表，本地与远程内容共用解析入口；兼容边界与上游参考见 [解析说明](docs/PARSER_REFERENCES.md)。

Sub-Store `/api/subs` 链接可直接作为订阅 URL 添加，使用 AUTO 自动提取本地、远程与混合订阅。支持公网 HTTP/HTTPS、引用去重、部分失败保护和远程内容变化同步；导入原始内容，不应用上游处理器。配置及本次五个接口的验证结果见 [Sub-Store 导入](docs/SUBSTORE.md)。

同一连接身份只保留一份 Node。名称和来源不参与指纹；认证或关键连接参数变化创建新资产。部分成功导入有效项并保留旧关联，完整成功才对账缺失项。`eligible` 只表示资产启用且有启用来源，不代表健康状态。

```bash
uv run nodema source list
uv run nodema source update <SOURCE_ID> --no-enabled
uv run nodema source update <SOURCE_ID> --enabled
uv run nodema source update <SOURCE_ID> --input-file private/replacement.txt
uv run nodema source sync-all --due-only
uv run nodema source delete <SOURCE_ID>
uv run nodema node disable <NODE_ID>
uv run nodema node enable <NODE_ID>
```

Source 删除是软删除，不删除资产或历史。整天倍数的同步周期按 SCAN_TIMEZONE 的日历日计算，避免每日调度抖动导致跳过一天；其他周期按经过的秒数计算。未识别的连接字段保留并参与保守指纹；不能保证未知扩展的跨格式配置一定合并。运行/导出无法无损转换的配置会明确报告 UNSUPPORTED，不能静默丢掉参数。

## 启动 Pages 与 Worker 本地预览

在 `cloudflare/api-worker` 运行 `npm ci` 和 `npm run types`，将 `.dev.vars.example` 复制为 `.dev.vars`，用编辑器填入与根 `.env` 相同的管理员密钥和 GitHub 调度 token。Worker 不需要 AES；HMAC 密钥只提供给 Python/Actions。

```bash
cd cloudflare/api-worker
npm ci
npm run types
npm run dev
```

默认 Hyperdrive 本地连接为 `127.0.0.1:55432/nodema`。另开终端：

```bash
cd web/dashboard
npm ci
npm run types
npm run dev
```

打开 Pages 命令显示的本地地址，输入 `.env` 中的 `ADMIN_PASSWORD`。Pages 通过 `API` 服务绑定转发同源请求。保存来源时自动投递“同步 → 入库 → 检测 → 发布”任务，界面每 15 秒刷新状态。Worker 只负责保存和调度，解析与 Mihomo 在 Actions 执行。未配置调度或提交失败时明确提示，已保存来源与待处理请求不会丢失；可点击“同步”重试，也会由下次每日任务处理。

不配置 GitHub 时仍可使用 Python CLI 同步和运行检测。还保留 `uv run nodema serve --port 8000` 作为本地调试 API/界面入口；它不属于生产部署链路。可选 Docker 镜像同样只用于本地或自有服务器调试。

## 检测与任务

先部署 Echo Worker，将根 `.env` 的 `ECHO_URL` 设置为返回真实来源 IP 的 HTTPS 根地址。原仓库 Echo 不需要令牌；`ECHO_TOKEN` 可用于自建受保护替代端点。

```bash
uv run nodema scan run-local
uv run nodema scan list
uv run nodema scan show <RUN_ID>
```

按 `SCAN_TIMEZONE=Asia/Shanghai` 每日创建一次完整快照。当天再次导入后创建 SUPPLEMENTAL 补测批次，只包含当天尚未入选快照的新节点；已开始的快照不变。空批次不会阻止后续导入，同一节点每天不会重复入选。自动任务恢复保留期内的未完成批次，并检测新导入节点。每个批次只在全部分片和项目完成后发布 current status；环境错误不会批量更新 DOWN。首次普通失败复测一次；TCP 成功不代表 UP。

```bash
uv run nodema scan prepare
uv run nodema scan worker --run-id <RUN_ID> --shard 0
uv run nodema scan finalize --run-id <RUN_ID>
uv run nodema cleanup
```

租约过期可恢复，重试只处理未完成项目。每天默认北京时间 04:17 执行；GitHub schedule 可能延迟，保留手动触发和 Web 重试入口。默认 250 节点/分片、4 个并行 Job、单 Job 60 分钟；需要根据实测调整。定时工作流只在受信任默认分支使用生产 Secrets。

## GeoIP、命名与导出

入口地区/ASN 使用 GeoLite2，出口优先采用 Echo 元数据。默认从 [P3TERX/GeoLite.mmdb](https://github.com/P3TERX/GeoLite.mmdb) 的 GitHub Release 自动获取 City/ASN，无需填写下载账号；如填写 `MAXMIND_ACCOUNT_ID` 和 `MAXMIND_LICENSE_KEY` 则自动优先官方源：

```bash
uv run nodema geoip-update
```

本地设置 `GEOIP_CITY_PATH=private/geoip/GeoLite2-City.mmdb`、`GEOIP_ASN_PATH=private/geoip/GeoLite2-ASN.mmdb`。Actions 准备任务下载一次，再通过 AES-GCM 临时包交给检测分片；需要现有 `ENCRYPTION_KEY_B64`，artifact 保留 1 天。GitHub 源校验 Release 的 SHA-256、MMDB 类型和最近 30 天的数据日期。上游不可用时不阻断测活，入口资料保持未知。通过 `GEOIP_DOWNLOAD_PROVIDER=auto|github|maxmind|disabled` 选择来源。数据库不提交 Git；许可与实现说明见 [批量导入与 GeoIP](docs/BULK_IMPORT_AND_GEOIP.md)。

命名模板可在 Dashboard 应用并保留历史；地区来自观测，未知值为 UNK。没有已保存模板时使用 `.env` 的 `NAME_TEMPLATE`。

```bash
uv run nodema naming preview
uv run nodema naming apply --template-file private/name-template.txt
uv run nodema export create --format mihomo --name my-subscription
uv run nodema export build-pending
uv run nodema export list
uv run nodema export budgets
uv run nodema export revoke <EXPORT_ID>
```

导出格式为 mihomo、singbox、uri、json、csv。创建默认入队，生产由 `export-build.yml` 及每日流水线生成；本地可执行 `build-pending` 或创建时加 `--build-now`。固定地址为 `/subscriptions/<EXPORT_ID>?token=<TOKEN>`，默认长期有效，也可指定 `--expires-in-hours`。管理员可重新查看链接；更换密钥会使旧 token 失效。首次生成或旧文件失效时下载返回 503，成功后下载直接读取成品。配置文件包含认证信息，JSON/CSV 仅含安全元数据。完整状态、预算与归档说明见 [异步订阅](docs/ASYNC_SUBSCRIPTIONS.md)。

## 筛选、参考分级与检测优化

节点与导出支持入口/出口、IP、ASN、来源、协议、传输、安全层、标签、Runner 成功率/P95、最近成功和 P1/P2/P3/U 等筛选；数据库执行多字段排序、分页和 Top N。Dashboard 的“大陆参考规则”可维护通用/电信/联通/移动偏好，节点详情可维护人工标签、声明和受保护的依据。

大陆等级仅为理论候选优先级，附理由、置信度和规则版本。没有大陆探针时，大陆可达性与真实线路类型始终 UNKNOWN；不会把 Runner 延迟或节点名称当作专线证明。

检测已加入共享 DNS/TCP 缓存、协议适配门控、抽样完整复查、失败退避、隔离核心复用和有界并发。仅完整代理 HTTPS 成功可为 UP，冷却跳过不延长成功有效期。详细规则、配置与 CLI 示例见 [QUALITY_AND_EXECUTION.md](docs/QUALITY_AND_EXECUTION.md)，本地基准见 [VALIDATION.md](docs/VALIDATION.md)。已有安装保持密钥不变，先迁移至 `0013_export_usage`，再更新 API/前端/任务。

## 测试、规模与备份

```bash
uv run pytest -q
uv run ruff check .
uv run ruff format --check .
uv run python scripts/smoke_protocols.py
uv run python scripts/benchmark.py
uv run python scripts/benchmark_pipeline.py
```

集成测试读取 `TEST_DATABASE_URL`，在随机 schema 中迁移和清理；缺少数据库明确失败。真实备份恢复测试需要兼容的 `pg_dump`/`pg_restore`，使用 Compose 数据库时可设置 `TEST_PG_CONTAINER="$(docker compose ps -q db)"`，直接调用该测试容器内的工具；测试账户须能创建/删除临时数据库。测试、fixtures 和规模测试均不连接真实代理节点。Worker 集成测试还会调用根 `.venv/bin/python` 验证跨语言加密互通：

```bash
cd cloudflare/api-worker
npm ci
npm run types
npm run check
npm test
npx wrangler deploy --dry-run --outdir dist/worker
```

Node 测试需要同一个 `TEST_DATABASE_URL` 环境变量（根 `.env` 不会被 Node 自动加载）。Echo 测试位于 `cloudflare/echo-worker`，执行 `npm ci && npm run types && npm run check && npm test`。CI 使用合成数据库，不向 PR 提供生产 Secrets。

加密备份：`uv run nodema backup --output-file backups/database.nma`，需要兼容目标 PostgreSQL 版本的 pg_dump；远程数据库可加 `--docker-client` 使用 PostgreSQL 17 容器。每周备份工作流只上传 AES-GCM 密文，保留 7 天。恢复命令 `uv run nodema restore --input-file backups/database.nma --confirm-restore` 会清理目标数据库，先在独立库验证；恢复同样支持 `--docker-client`。密钥必须另行私下备份。

默认保留详细结果 60 天、每日统计 365 天；资产和来源关联长期保留。只有完整发布的结果才进入可用性统计。

Dashboard 的“运行与用量”提供检测平均耗时、超时/环境错误、Echo 请求、订阅字节数、数据库容量采样和已完成 Actions 用时。CLI 对应 `uv run nodema usage show --days 30` 与 `uv run nodema usage sample`。部署时同时提交 `.github/workflows/usage.yml`，使用自动提供的 `GITHUB_TOKEN` 读取受信任运行的元数据，无需另存 token。Linux Job 采集默认路由网卡计数，不产生测速流量；统计覆盖范围和计费差异见 [ARCHITECTURE.md](docs/ARCHITECTURE.md#用量口径)。

## 部署与验证边界

现有同步导出版本在完成部署并通过验收后，可在 Dashboard 批量添加来源并自动导入、检测，不必另外点击创建批次。支持范围以解析器和运行时转换器为准；不兼容配置显示 UNSUPPORTED。部署前执行 `uv run alembic upgrade head`，再用 `uv run nodema doctor --network` 检查数据库版本、已有数据的 HMAC 指纹、Mihomo 与 Echo。登录时还会检查 Worker 的迁移版本和调度配置；该检查不代替实际 GitHub 权限与真实节点验收。

部署步骤和密钥映射见 [DEPLOYMENT.md](docs/DEPLOYMENT.md)，完整 ER 和协议边界见 [ARCHITECTURE.md](docs/ARCHITECTURE.md)，本地验证证据见 [VALIDATION.md](docs/VALIDATION.md)，规模与费用口径见 [COSTS.md](docs/COSTS.md)，逐项核对见 [REQUIREMENTS_AUDIT.md](docs/REQUIREMENTS_AUDIT.md)，代码交付与生产验收状态见 [STATUS.md](docs/STATUS.md)。初始 M1 文档保留在 [M1_GUIDE.md](docs/M1_GUIDE.md)。

本次源码工作不自动创建云资源、上传真实节点、启用账户计费或发布站点。上线前需要用 50–100 个你有权测试的实际节点验证协议兼容性、Runner 出口限制、Echo 字段和实际用量；不承诺固定检测耗时或永久零费用。
