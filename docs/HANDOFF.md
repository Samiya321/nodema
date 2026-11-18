# 项目接管指南

更新：2026-11-18。面向新会话、其他 agent 和另一台机器的维护者；先读根目录 AGENTS.md。

## 当前可核对的基线

- 生产实例已部署：Dashboard https://nodema-dashboard.pages.dev；API https://nodema-api.simb.workers.dev；Echo https://nodema-echo.simb.workers.dev。
- 公开源码：Samiya321/nodema，main。**2026-11-11 已发布 `b477963`**：检测稳定性/速度、手动同步与检测、机场/Sub-Store 子来源、保留语义、新命名与前端重写；迁移 head `0015_exit_asn_numbering`（同日追加：按落地国家+ASN 编号、检测所选节点），27 张业务表。[CI 42933849350](https://github.com/Samiya321/nodema/actions/runs/42933849350)：331 Python + 32 Worker + 3 Echo。设计见 [SOURCES_AIRPORTS_NAMING.md](SOURCES_AIRPORTS_NAMING.md)，发布记录见 [CLOUD_DEPLOYMENT.md](CLOUD_DEPLOYMENT.md)。
- Cloudflare API version `8156a79e-b9b6-4192-8e77-609d04fac6d2`；Pages 预览 https://5bdfc055.nodema-dashboard.pages.dev。后续部署以实际资源状态为准。
- **2026-11-14 已发布 `7306266`**：节点质量分级与 Globalping 接入测量，迁移 head `0018_entry_probes_grading`，新工作流 `entry-probe.yml`（每小时 :30）。设计与实现见 [NODE_GRADING_DESIGN.md](NODE_GRADING_DESIGN.md)，发布记录见 [CLOUD_DEPLOYMENT.md](CLOUD_DEPLOYMENT.md)。
- **2026-11-14 已发布 `b23585e`**：CF 落地不测不分级、CF 入口不再用港新样本、港新家宽探针、前端与节点页重做；迁移 head `0019_grade_exclusions`。发布记录见 [CLOUD_DEPLOYMENT.md](CLOUD_DEPLOYMENT.md)。
- **2026-11-14 已发布 `3b4509b`**：共用凭据（≥5 节点、≥2 服务器）的节点算机场，迁移 head `0020_shared_credentials`；接入测量由 API Worker cron 每小时触发。
- **2026-11-15 已发布 `3b68418`**：UDP 检测（Wi-Fi Calling）、中转入口算机场、Neon 流量读数、节点页重做（ASN 排行）；迁移 head `0021_udp_relay`。数据库已搬到新 Neon 项目（ID 见私密 deployment-state）。
- **2026-11-16 已发布 `81c3c01`**：Globalping 多账户 token 轮询，Secret `GLOBALPING_TOKENS` 已由用户配置；Pages https://08bda24d.nodema-dashboard.pages.dev。main CI 43883188456 通过，schema 仍为 `0021_udp_relay`；真实运行与验证范围见 [CLOUD_DEPLOYMENT.md](CLOUD_DEPLOYMENT.md)。
- **2026-11-17 已发布 `6482b9a` / `7d82021` / `f83a0b4`**：英国 GB、接入补测与拒测冷却、等级列布局和待补测标识；schema `0022_uk_probes`。Pages https://43cad7f1.nodema-dashboard.pages.dev，API version `ed231caa-2f15-4ce6-b380-f4d2b72cd109`。生产分布、备份恢复和验证范围见 [本轮复盘](PRODUCTION_REVIEW_2026_11_17.md)。
- **2026-11-17 已发布命名修复 `d891e26` / `b76ad80`**：schema `0023_identity_naming`，同 IP 冲突不生成跨国箭头、未知入口用 `?`、核实 ASN 别名并排除占位文本，历史落地附观测时间，新 IP/ASN 不继承旧组织。API `5c9c3664-61c8-4656-a171-627aa3553c70`，Pages https://43b793dd.nodema-dashboard.pages.dev；main CI 43928480592 通过。生产复核与验证边界见 [归属命名规则](IDENTITY_NAMING.md) / STATUS。
- **2026-11-17 命名只读审核发现待修项**：同 IP 的国家库冲突生成跨国箭头、ASN 名称被 Private Customer 等组织文本误导、未知/历史归属展示不清；详见 [审核记录](NAMING_AUDIT_2026_11_17.md)。用户后续已要求直接修复，当前修复和发布状态见 [归属命名规则](IDENTITY_NAMING.md) 与 STATUS；不要把审核阶段的“未改名”当成禁止修复。用户真实节点、大陆体验、长期配额、生产恢复不属于已完成的合成验收证明。不得把“基础链路通过”写成所有公网参数都已保证可用。

**2026-11-18 生产数据库已迁到用户指定主机的自建 PostgreSQL 17。** Pages、Worker 和 GitHub Actions 继续按既有分工运行；旧 Neon 项目已删除，灾备使用 Actions 加密备份。详见 [云端记录](CLOUD_DEPLOYMENT.md) 和 [生产手册](PRODUCTION_OPERATIONS.md)。

同日上线节点列表读取优化 `4e44b75`，发布时 schema `0024_node_list_reads`。「可用节点」合并为一次查询，总数与当页共享匹配节点。上线记录及隔离基准见 [节点列表提速](CLOUD_DEPLOYMENT.md#2026-11-18-第二十一次发布节点列表提速)。

同日上线导航和溯源，Worker `c8fa6ca`、Pages `006324f`，当前 schema `0025_dashboard_lineage`。新增 `substore_source_references` 记录索引对已有来源的引用。节点仍通过 `node_sources` 进入直接来源，成品通过 `export_members` 进入成员节点。[发布记录](CLOUD_DEPLOYMENT.md#2026-11-18-第二十二次发布导航和来源溯源)

先看 git 与实际云端状态。历史记录中的“尚未导入真实节点”和表行数不代表此刻数据库为空；用户可以随时从 Dashboard 导入，禁止据此清库。

## 0014 上线记录（已于 2026-11-11 按此顺序完成；以后的迁移照此办理）

1. 合并后 main 上任何 Actions（含 04:17 定时）都会执行 `alembic upgrade head`；旧 Worker 严格检查 head，迁移后旧 Dashboard 会显示未就绪。因此在用户确认的时间窗口内一次完成：先做新鲜加密备份，再手动运行一次迁移（或 `source-sync.yml`），随即部署 API Worker、Pages、Echo（Echo 新增 `org` 字段，旧 Echo 也兼容，只是 ASN 名称回退到 GeoLite）。
2. 迁移会把仍为旧默认的命名模板换成 `{FLAG}{ROUTE}|{ASN} {SEQ}`，订阅中的节点名称会随下一次生成变化；客户端策略组如按旧名称匹配需要调整。
3. 现有 Sub-Store 来源在下一次同步时转换为父来源 + 子来源；旧节点关联保留。
4. 生产 repo vars 未覆盖 CHECK_CONCURRENCY，新默认 16 生效；若 Runner 出现资源问题可设 vars 回退。

## 用户最终决策（覆盖早期方案）

| 事项 | 当前要求 |
| --- | --- |
| 成本与运行方式 | 严格免费；接受休眠与额度限制。2026-11-18 用户指定的云主机只承载 PostgreSQL 和 Cloudflare Tunnel；继续用 Actions 做 Runner |
| 页面/API | Pages + TypeScript Worker；不改成 Python 一体服务，不迁到 Go，除非用户另有要求 |
| 数据库 | 标准 PostgreSQL 17；采用自建实例，不使用 Neon 专有数据 SDK，不引入 Redis/R2 |
| 数据安全 | 数据库明文是用户明确选择；HMAC/鉴权继续保留；AES 仍用于备份、临时 MMDB 和旧密文升级 |
| 协议 | Shadowsocks、Trojan、AnyTLS、Hysteria2、VMess、VLESS；具体参数兼容范围见 PROTOCOLS.md，不能静默丢参数 |
| 来源 | URI/Base64/Clash-Mihomo/sing-box，以及 Loon/Surge/QX 节点列表；Sub-Store /api/subs 提取本地、远程、混合原始订阅，不执行脚本 |
| 批量链接 | 普通订阅和 Sub-Store API 可混合，每行一个，每批 100 个/128 KiB，单 URL 8 KiB；逐行结果、去重、一次调度 |
| 检测 | DNS/TCP 预检、缓存、失败冷却和必要的完整代理 HTTPS；无下载测速、不做任意网段扫描 |
| 节点分级（2026-11-13，覆盖旧“大陆参考”） | 只记录能实测证明的东西。按视角（三网/电信/联通/移动/香港/新加坡）给 S/A/B/C/D/待定：等级 = 接入档（Globalping 社区探针 TCP ping 入口，三网用北京时间晚高峰）与稳定档（7 天日可用率）中较差的一项。线路只记录三网去程实测经过的 ASN；`line_type` 仍为 UNKNOWN，不判断 IPLC/IEPL/CN2，不推断回程，不提取机场自称线路名。界面不再显示 P1/P2/P3 理论等级和人工线路声明（数据保留）。用户接受把入口 IP 发给 Globalping（测量数据公开）；不做本机测量。账号配置见下行新决策 |
| 英国与采样修复（2026-11-17） | 新增英国 GB 独立视角，海外全天中位数；优先补齐不同探针，服务拒测冷却七天，不作为节点失败。保留原阈值与三网最差规则，缺接入的 B 标明待补测。已发布 `6482b9a` / `7d82021` / `f83a0b4`、schema `0022_uk_probes`，详见 PRODUCTION_REVIEW_2026_11_17.md |
| Globalping 多账户（2026-11-16） | 用户要求覆盖旧“只用一个账号”的限制：支持多账户 token 轮询。Secret `GLOBALPING_TOKENS`（换行/逗号/空白分隔、去重）优先，兼容 `GLOBALPING_TOKEN`；仅两者均为空时匿名。逐账户查免费剩余额度、各留 5 次并预扣并发预算，401/403/429 跳过该账户，全部不可用则停止；不自动花积分。单次总预算上限默认 5000，可用仓库变量降低。同一账号的不同 token 共享额度；使用仍受 Globalping 条款约束。配置与验证边界见 NODE_GRADING_DESIGN.md 第 0 节 |
| 共用凭据算机场（2026-11-14） | 同一 UUID/密码被 ≥5 个节点、≥2 个服务器地址共用即算机场节点（迁移 0020）。每日检测范围保持“仅自建”：用户确认这批节点（当时 28,242 个，7,684 个可用）不再每日检测，结果过期后自然退出等级与订阅 |
| UDP 检测（2026-11-15） | 为 Wi-Fi Calling 记录“经节点的 UDP 通不通”：HTTPS 通过后经同一 mihomo 监听做 SOCKS5 UDP ASSOCIATE，发 STUN（备用 DNS），共 4 次尝试、每次新关联，一次丢包不判失败。只能证明到公共 STUN/DNS 的 UDP，不对运营商 ePDG 发 IKE 包。Clash 导出对未声明仅 TCP 的节点写 `udp: true` |
| 中转入口算机场（2026-11-15） | 同一服务器、同一凭据、≥5 个节点且落地 ≥3 个国家，算机场中转（扩展 0020 规则，检测发布后也会重算） |
| 节点页简化（2026-11-15） | 用户要求筛选排序不要复杂、审美“大厂”：等级分布做页面主视觉兼等级筛选；一行控件（搜索、列表/按国家/ASN 排行、UDP 可用、家宽 IP、筛选面板）；其余条件都在筛选面板，折叠分组。ASN 排行只用实测数据，不做 ASN 名声打分 |
| 失败来源与死节点（2026-11-15） | 连续失败 7 天（或从未成功且加入满 7 天）的来源改为每周同步一次；节点不删除（保留语义不变），连续失败冷却上限改为 168 小时 |
| 备份（2026-11-18） | 云端加密备份每天北京时间 00:41，保留 7 天，每月隔离恢复演练。本机仅在发布演练中临时下载密文包 |
| 数据库去留（2026-11-15，已被 11-18 选型覆盖） | 用户决定先留在 Neon Free 并测量：以 11-15 20:17 UTC Worker 定时检测前后的 Neon 读数得出单次全量检测消耗，结合用量页的预计用完日期；预计早于周期重置（12-01）时再迁移，候选 Aiven Free（需先把连接并发降到约 14 以内）。自有服务器与“不使用用户服务器”的约定冲突，需用户另行明确同意 |
| 每日检测触发（2026-11-15） | 由 API Worker Cron `17 20 * * *` 派发 `daily-check.yml`（`trigger=schedule`），不再用 GitHub schedule（晚 4–5 小时）。失败冷却从 24 小时起翻倍、上限 168 小时 |
| 转换兼容（2026-11-15 第二轮） | 只在转换层映射 TCP 头伪装/raw/spx 等，不改解析结果与指纹；sing-box 不能表达的跳过该格式。XHTTP、HTTP Upgrade、`pcs` 证书固定试过但真实节点几乎全失败，保持不支持；以后再加新映射，上线后先用 `diagnose.yml` 的 mapping-outcomes 按映射核对可用率 |
| Cloudflare 落地（2026-11-14） | 用户不需要落地在 Cloudflare（AS13335）的节点：不做接入测量、不定档，界面显示“不分级”。不自动停用或删除这些节点，每日检测照旧；入口在 CF 的节点只用三网探针测 CF 接入，不用港新样本 |
| 触发方式（2026-11-11） | 导入/编辑/删除不启动 Actions；用户点“同步来源”或按范围“检测”；每日定时默认只测自建，可在设置页修改 |
| 来源与节点保留（2026-11-11） | 上游失效/移除/来源删除不删除或停测自建节点；机场节点随订阅暂停/过期/流量用完停测；删除来源默认保留节点 |
| 机场与 Sub-Store（2026-11-11） | subscription-userinfo 识别机场并归组；Sub-Store 条目物化为独立子来源；机场与自建分开检测 |
| 命名修复（2026-11-17） | 用户授权直接修复审核发现：同一入口/出口 IP 不因地理库冲突生成跨国箭头；未知入口标 `?`；ASN 别名采用有证据的修正，排除占位文本；保留历史落地并标最后观测时间。迁移 `0023_identity_naming`，细节见 IDENTITY_NAMING.md，发布状态见 STATUS |
| 命名（2026-11-11） | `🇸🇬HK->SG|Webbing 01`：落地国旗、入口->落地（相同只写一个）、ASN 简称、组内稳定两位序号；之后可能加线路字段 |
| 存活指标 | 首次入库不可因重导入刷新；北京时间加入当天算第 1 天，同时展示累计已检测/可用天数和可用率；未检测日不进分母 |
| 订阅导出 | Actions 预生成五格式，Worker 读取现成文件；固定私有链接默认长期有效，支持筛选、排序、Top N、编辑、重建、撤销、到期 |
| GeoIP | auto 优先已配完整官方 MaxMind 凭据，否则用 P3TERX/GeoLite.mmdb 的 GitHub Release；不需额外申请 Key。校验失败不阻断测活 |
| 交付方式 | 只公开源码与合成数据；生产维护资料留 private。部署已经完成，不需要重新开户建库 |

## 代码地图与变更入口

| 目录/文件 | 职责 |
| --- | --- |
| app/domain.py、config.py | 枚举、错误码、Python 设置与密钥检查 |
| app/database/models.py、alembic/versions | SQLAlchemy 模型、PostgreSQL 类型/函数/触发器/迁移 |
| app/parsers/ | 各种输入格式归一化；解析兼容边界见 PARSER_REFERENCES.md、PROTOCOLS.md |
| app/ingestion/service.py、bulk.py | 来源 CRUD、批量 URL、资产去重和关联生命周期 |
| app/ingestion/fetcher.py、subscriptions.py | 有界拉取、DNS/重定向/连接边界 SSRF 检查、Sub-Store 递归与预算 |
| app/checker/、app/scans.py | Mihomo 运行、预检/代理 HTTPS、租约分片、快照和发布；不在 HTTP 请求内长跑 |
| app/catalog.py、quality.py、naming.py | 节点组合查询、旧理论规则（界面已隐藏）和展示命名 |
| app/grading.py、app/probes/ | 节点分级纯规则；Globalping 客户端、每小时测量计划与执行、按视角重算 node_grades（`nodema probe run` / `nodema grade refresh`） |
| app/probes/pool.py | Globalping 多 token 轮询、逐账户预算预扣、失效/限流跳过和测量所属账号绑定 |
| app/exports.py、export_render.py、conversion.py、password_conversion.py | Actions 导出构建、转换、成员/版本、租约/条件发布 |
| app/geoip_update.py | 官方/GitHub MMDB 下载验证、私密临时包 |
| app/backup.py、usage.py、actions_usage.py | 加密备份/恢复、数值用量与可信 Actions 统计 |
| app/api.py、cli.py | 本地 FastAPI、生产 Actions 调用的 CLI；不是生产常驻后端 |
| cloudflare/api-worker/src/index.ts、source-bulk.ts | 生产认证 API、来源保存和一次调度 |
| cloudflare/api-worker/src/catalog.ts、quality.ts、export-api.ts | 生产查询、规则、导出控制及成品读取；与 Python 语义保持一致 |
| cloudflare/api-worker/src/grading.ts | 分级规则校验（与 app/grading.py 一致）、`/api/grading-policy`、`/api/probe-status`、`/api/nodes/:id/access` |
| cloudflare/api-worker/src/formats.ts | 转换兼容性测试参照；生产下载入口不应调用它做即时转换 |
| app/web/ | 中文界面 JS/HTML/CSS 的源文件；不要只修改生成 dist |
| web/dashboard/ | Pages 构建、Functions 代理与 API 服务绑定 |
| cloudflare/echo-worker/ | 轻量回显调用者 IP/国家/ASN，不是转发代理 |
| .github/workflows/ | tests、source-sync、daily-check、export-build、usage、backup |
| tests/unit、tests/integration、tests/fixtures | 单元/真实 PG 测试、合成 fixtures；Worker 的测试在自己的 test 目录 |
| scripts/ | 固定 Mihomo 安装、loopback 握手、隔离性能验证 |

## 数据地图与不可破坏的语义

| 表组 | 作用与注意事项 |
| --- | --- |
| sources、nodes、node_sources | 来源可软删除；节点身份按 HMAC 去重；多来源关联保留别名及出现时间。同步失败/部分成功不能抹掉旧关联 |
| scan_runs、scan_shards、scan_items | 日期批次、不变快照、租约与进度；不能为重试随意重开旧日期 |
| test_results、node_current_status | 历史检测与当前状态；环境失败不能变成整批节点 DOWN |
| node_daily_stats、runner_node_summaries、nodes 的累计字段 | 每日统计和累计计数；清理历史不能使已收录/累计检测天数倒退 |
| node_annotations、quality_policies、quality_policy_revisions | 旧人工证据与理论分级规则（界面只保留标签），不能生成真实线路结论 |
| entry_probe_results、entry_route_traces、entry_probe_runs、entry_probe_rejections | Globalping 测量（保留 14 天）、三网去程 ASN、每次运行的计数；不写目标到日志 |
| node_grades、grading_policy、grading_policy_revisions | 按视角的节点等级（Actions 计算，Worker 只读）与分级规则版本 |
| naming_rules、naming_revisions | 命名模板和修订 |
| catalog_state | 目录 epoch、导出预算、历史日期关闭水位；不要手改数值绕过失效或归档保护 |
| export_artifacts、export_members、export_versions | 一个方案仅保存当前成品，历史是摘要；token/成品是凭据，不查 SELECT * 到日志 |
| usage_events、database_samples、action_runs | 数值用量、容量和可信工作流记账，不是完整请求日志 |

数据库约束/触发器是业务实现的一部分，不能仅搬 ORM 表或手动直接改字段绕开。导出发布受租约、方案 revision、catalog revision、成员资格和新鲜度共同保护；token 鉴权在 ETag 304 之前。活跃扫描明细保留，过期细节归档后仍保留批次摘要、水位和累计统计。

批量接口的并发锁只保证批量提交之间去重；旧单条创建仍允许独立来源，不擅自合并历史重复来源。暂停来源不会因重复导入而被自动启用。

## 开发与验证

需要 Python 3.12、uv、Node.js 22+、Docker。已有 .env 时先核对用途，不覆盖它；全新本地开发可按 README 创建合成 .env。不要复制生产 env 为本地测试 env。

```bash
uv sync --frozen
uv run ruff check .
uv run ruff format --check .
node --check app/web/app.js
```

全量测试用新建、仅本任务拥有的容器。若名称或端口已占用，换名字/端口，不停止他人的容器。以下口令均为合成本地测试值：

```bash
docker run --rm -d --name nodema-handoff-test \
  -e POSTGRES_USER=nodema -e POSTGRES_PASSWORD=local_dev_only -e POSTGRES_DB=nodema_test \
  -p 127.0.0.1:55434:5432 postgres:17-alpine
# 先用 docker exec nodema-handoff-test pg_isready -U nodema 确认已就绪
export TEST_DATABASE_URL=postgresql+psycopg://nodema:local_dev_only@127.0.0.1:55434/nodema_test
export TEST_PG_CONTAINER=nodema-handoff-test
uv run pytest -q
(cd cloudflare/api-worker && npm ci && npm run check && npm test)
(cd cloudflare/echo-worker && npm ci && npm run check && npm test)
(cd web/dashboard && npm ci && npm run check && npm run build && npx wrangler pages functions build --outdir dist/functions)
# 完成后仅停止本任务容器；--rm 会删除该测试实例，不保留测试数据
docker stop nodema-handoff-test
```

pytest 和 Worker 测试会在此数据库创建/删除临时 schema；缺少测试 DB 应失败，不能通过 skip 掩盖。真实 PG 备份恢复测试需要 Docker。不要在测试进程环境中残留生产 DATABASE_URL/MIGRATION_DATABASE_URL/PGOPTIONS。

协议核心改动在停止上述测试容器前还运行：`uv run python scripts/install_mihomo.py`、`uv run python scripts/smoke_protocols.py`、`uv run python scripts/benchmark_pipeline.py --sizes 100`（`--batch` 测共享批量运行时，`--skip-exports` 只测检测段），同样在上述隔离 DB 环境；这是合成 loopback 验证，不是公网节点测速。仅文档改动检查链接、路径、命令和事实即可，不需要重新做性能测试。

## 常见的接管误区

- `PROJECT_SPEC.md` 最初要求 AES 数据库存储，后被用户覆盖；旧计划中的服务器/Go/R2 建议不代表当前部署方向。
- readiness 只核对配置/数据库状态，不能代替真实 Actions 调度权限、真实节点握手或大陆体验验收。
- 本机 100/1,000/5,000 节点测试不等于 Cloudflare Free CPU、Neon 容量或 GitHub 调度保证。
- `0012` 只为触发器固定自身 schema 的 search_path；不要给全部 SQL 查询函数加 SET search_path，可能破坏函数内联与索引下推。
- psycopg 连接要求 postgresql+psycopg；系统 CA 在 session.py 中解析，备份保留 TLS/CA/channel binding 参数。不要降为 sslmode=disable 解决 TLS 问题。
- GitHub 自带 GITHUB_WORKFLOW_REF 是 workflow 路径，不是可信分支名；用量收集用显式 trusted branch。
- 跳过的 GitHub Job 不计 Runner 时长，且 GitHub 记账时间可能倒置。
- 新迁移必须同步 app/readiness.py、Worker readiness 和相关测试；严格 head 检查可能在不兼容版本部署时暂时拒绝登录。
- GitHub 权限、平台额度与最新官方 API 用法应在实际改动时重新查证，不把本文件当永久平台保证。

## 下一位维护者的交接责任

完成任务后记录日期、需求/决策变化、commit、迁移 head、测试/CI、部署版本、验证边界和剩余事项。持久化到本指南/STATUS/相关功能文档，部署证据到 CLOUD_DEPLOYMENT；实际凭据、内部盘点和资源快照仅写 private。如果只有代码提交、没有发布，明确写“未部署”。
