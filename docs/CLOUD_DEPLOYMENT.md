# 云端部署记录

部署日期：2026-11-11（北京时间）。已发布生产页面、API 和 Echo，使用 Neon Free PostgreSQL 与标准 GitHub Actions Runner；本次没有开通或升级付费套餐，没有使用自有服务器、R2 或 Redis。

| 服务 | 地址 / 状态 |
| --- | --- |
| Dashboard | https://nodema-dashboard.pages.dev |
| API | https://nodema-api.simb.workers.dev；管理接口需要管理员鉴权 |
| Echo | https://nodema-echo.simb.workers.dev；仅返回调用者的观测信息 |
| 源码 | https://github.com/Samiya321/nodema |
| 数据库 | Neon Free，PostgreSQL 17，美国东部；2026-11-14 搬到新项目（见下方第十三次记录），当前 schema 见最新发布记录 |
| API 数据库权限 | 独立角色，授予业务 DML；数据库迁移使用单独的 owner 连接 |
| Hyperdrive | 已禁用查询缓存，origin 连接数限制为 5 |

管理员密钥、数据库连接、HMAC/AES 密钥和 GitHub 调度 token 保存在本地 `private/` 以及对应平台 Secrets 中，不在本页或 Git 仓库公开。

## 已完成验证

- 本地 284 项 Python、30 项 Worker、3 项 Echo 测试，共 317 项通过；对应代码的 [GitHub 回归](https://github.com/Samiya321/nodema/actions/runs/42900459248) 通过，包含真实 PostgreSQL 恢复、19 个 loopback 配置握手和 100 节点合成全链路。
- 生产页面 HTTP 200，未授权管理请求 401；登录后 readiness、节点查询、扫描摘要和用量查询正常。
- 实际浏览器完成登录、页面导航、订阅表单、检测记录、用量页、退出和 390px 布局验证。
- 网站创建临时零节点订阅方案，成功触发 [Actions 构建](https://github.com/Samiya321/nodema/actions/runs/42898060851)，验证排队时 503、生成后下载、ETag 304、撤销后立即 404。临时链接已撤销。
- [每日工作流](https://github.com/Samiya321/nodema/actions/runs/42898467663) 与 [来源同步复用流水线](https://github.com/Samiya321/nodema/actions/runs/42899588060) 已在真实 GitHub 账户执行成功；当前云库没有真实节点，因此检测批次为零节点。
- [云端加密备份](https://github.com/Samiya321/nodema/actions/runs/42896502125) 成功；本地也对云库做了一次真实加密 pg_dump。没有执行破坏性生产恢复。
- [自动用量汇总](https://github.com/Samiya321/nodema/actions/runs/42900792470) 已通过；历史成功工作流的统计已补录。
- 已确认实际 Echo 返回 IP、国家和 ASN；未记录具体调用者地址。

## 部署中补齐的兼容性修复

`0012` 固定触发器的 schema 查找路径，保证恢复后从默认连接路径写入也能工作，同时保留查询函数的内联能力。PostgreSQL 二进制驱动显式解析系统 CA 文件，并在需要时使用 certifi；备份保留完整 TLS 验证参数。用量收集显式传入可信默认分支，避免 GitHub 保留环境变量的语义冲突。`0013` 扩展订阅构建的用量类型约束，跳过任务不按可能倒置的记账时间计费时长。

## 接下来的使用

1. 用本地 `private/nodema-login.txt` 中的管理员密钥登录。
2. 先小批导入有权使用的节点或订阅，等待 Actions 完成解析和实际代理检测。
3. 筛选成功节点，保存订阅方案，等待生成后复制固定链接。
4. GeoIP 默认通过 GitHub Release 获取 City/ASN，无需手动配置 MaxMind 账号；下载失败或地址没有记录时，入口资料保持未知，出口信息优先来自 Echo。

当前验收证明部署和调度链路可用，不能代替用户真实公网节点的协议参数、Runner 可达性、大陆体验与长期免费额度验收。历史修复前的失败工作流保留作为排查记录，以上链接指向已通过的验证。

## 2026-11-11 增量更新

已补充批量订阅 URL / Sub-Store API 导入和 GitHub GeoLite 自动下载，无需额外 MaxMind 账号。每批最多 100 个地址，有逐行结果、重复跳过和统一调度；无需数据库迁移。

全量 300 Python + 33 Worker + 3 Echo = 336 项通过，[功能代码 GitHub 回归](https://github.com/Samiya321/nodema/actions/runs/42905722698) 通过，含真实协议 loopback 与 100 节点链路。已实际下载并校验 2026.11.10 GeoLite Release，完成加密包安装及查询。批量接口线上鉴权和无效输入处理已验证；有效批次的并发、调度失败和 100 地址保存使用合成本地数据验证，没有导入用户真实订阅。

UI 额外验证逐行结果、重复提交、390px 布局，以及慢网络下快速关闭弹窗后的焦点恢复。配置与数据署名见 [批量导入与 GeoIP](BULK_IMPORT_AND_GEOIP.md)。

## 2026-11-11 第二次发布：0014、手动流水线、机场与 Sub-Store、新命名、新 Dashboard

- 代码 `7628c9e`（main，快进合并），[CI 42930231326](https://github.com/Samiya321/nodema/actions/runs/42930231326) 通过：328 Python（含 19 种 loopback 握手与 100 节点合成链路）、32 Worker、3 Echo，Pages/Worker 构建通过。
- 发布前：只读盘点（schema 0013，6 个有效订阅来源，259 个节点，1 个未完成批次），本机生成新的加密备份（私有目录，0600），在隔离 PostgreSQL 恢复，行数与生产一致；在该恢复副本上演练 0014，发现并修复了序号 ≥100 被 `lpad` 截断导致重名的问题，复演练零重名。
- 迁移：以 owner 角色执行 `alembic upgrade head` 到 `0014_sources_airports_naming`；259 个节点全部分配稳定名称、零重名；默认权限使 `nodema_api` 自动获得新表、视图、函数权限（已核对）。
- 发布：API Worker 版本 `6d21453b-f8d6-49a6-954a-be99d91ef9f8`；Pages 部署 https://824dd0ac.nodema-dashboard.pages.dev；Echo 版本 `67a84d39-835b-4f2e-8652-f0c4d11f2e56`（新增 `org`）。
- 验证：health 200、未认证 401、认证 readiness 全部为真（schema、dispatch）；pipeline/overview/airports/substores/sources/nodes/asn-labels 返回正常；Dashboard 首页、模块与 /api 代理 200；Echo 返回 ip/country/asn/org（未记录调用者地址）。真实节点名称已是新格式（如 `🇯🇵JP|Azure 01`）。
- 未做：没有用管理员密钥登录生产 Dashboard 做浏览器检查（界面在本地合成数据上做过逐页检查）；没有在生产触发同步或检测。现有 6 个订阅在下一次“同步来源”后才会识别机场/Sub-Store；昨天失败的那个未完成批次会在下一次检测或定时任务中被继续执行；真实节点上的检测速度尚未验证。

## 2026-11-11 第三次发布：0015 按落地国家+ASN 编号、检测所选节点、节点页分组

- 代码 `b477963`（main，快进合并），[CI 42933849350](https://github.com/Samiya321/nodema/actions/runs/42933849350)：331 Python、32 Worker、3 Echo。
- 发布前只读盘点：schema 0014，259 个节点均已有检测结果（此前中断的批次已由一次 Daily node health 运行补完），无租约、无未完成批次。新加密备份在隔离 PG 恢复后演练 0015：41 个有落地信息的节点按 15 个“落地国家 + ASN”组编号（最大 04），其余用节点编号，零重名。
- 迁移到 `0015_exit_asn_numbering`，结果与演练一致；`nodema_api` 对新列有权限。API Worker 版本 `532ef6fc-d03b-4777-8a41-146bedadc033`；Pages https://b4446da8.nodema-dashboard.pages.dev；Echo 未变。
- 验证：health 200、未认证 401、readiness 全真；节点名称唯一；Dashboard 新模块已上线。未在生产触发同步或检测；6 个订阅尚未在新代码下同步（机场/Sub-Store 识别待用户点击“同步来源”）。

## 2026-11-11 第四次发布：修复“同步来源”返回 INVALID_REQUEST

- 原因：Dashboard 的“同步来源”是不带请求体的 POST，经 Pages 服务绑定转发后变成空的请求流（不是 null），Worker 按 JSON 解析失败。`/api/pipeline/sync` 与 `/api/scans` 现在把空请求体视为 `{}`；新增回归测试（修复前 422，修复后 202）。
- 代码 `720ae9d`（main），仅 API Worker：版本 `11350de9-6d95-472b-a53b-0f3ec6a2ec6e`。无迁移，Pages/Echo 未变。本地 32 Worker 测试通过。
- 验证：health 200、未认证 POST 401、认证 readiness 为真。没有替用户在生产触发同步。
- ASN 排查（只读）：259 个节点中 218 个从未连通（146 入口域名不解析、39 Echo 请求失败、28 TCP 不通等），没有落地信息，无法得到落地 ASN；41 个可用节点都有 ASN，但其中 38 个最后一次检测早于返回 `org` 的新 Echo，只能靠内置简称表，AS6939/AS3258 因此显示为 AS 号。下一次检测会写入 Cloudflare 的运营商名称（启发式得到 Hurricane、xTom 等）。

## 2026-11-11 第五次发布：0016 按落地服务器编号、落地 IP 归属（ip-api）、分享二维码

- 代码 `10013a4`（main，快进合并），[CI 42953963233](https://github.com/Samiya321/nodema/actions/runs/42953963233)：339 Python、32 Worker 通过。
- 发布前：新加密备份 `backup-2026-11-11-pre-0016.nma`，在隔离 PG 恢复后演练 0016：259 个节点名称零重复，再次编号无变化，41 个节点 / 23 台落地服务器，16 对同 IP 的 VMess 节点为 `01 VMess` / `01 VMess-2`，节点落地国家与服务器一致；分享链接 257/259 可生成（61 个省略了无法表示的设置，2 个 SS 不支持）。
- 生产：确认无运行中的工作流与租约后迁移到 `0016_servers_ipinfo_share`，结果与演练一致；`nodema_api` 对新表、视图和函数均有权限；`nodema node share-links` 生成 259 条（本地计算，无外部请求）。API Worker 版本 `214ee485-4956-4471-bc88-170c6676e0a4`；Pages https://a829be38.nodema-dashboard.pages.dev；Echo 未变。
- 验证：health 200、readiness 为真；节点列表包含新字段；分享接口未认证 401、认证 200 且 `no-store`，名称与目录一致；二维码模块以 JavaScript 类型提供。
- 未做：生产尚未查询 ip-api（由下一次“同步来源”或检测在 Actions 中执行，届时名称会加上 IP 归属并再变化一次）；未在真实手机上扫码验证；没有用管理员密钥登录生产 Dashboard 做浏览器检查（本地合成数据上检查过服务器视图、详情和二维码弹窗）。

## 2026-11-11 按用户要求清空生产数据

- 用户准备正式批量导入 Sub-Store API，要求删除全部数据、保留设置。确认无运行中的工作流后，先做加密备份 `backup-2026-11-11-pre-wipe.nma`，在隔离 PG 恢复验证（47 个来源、259 个节点、486 条检测结果，schema 0016），并在恢复副本上先演练清空脚本。
- 生产在单个事务中删除：来源、机场分组、节点及其状态/命名/服务器编号/分享链接/人工资料/日统计、检测批次/分片/条目/结果/请求、Runner 汇总、落地 IP 信息、订阅导出（0 个）。节点编号序列重置为 N000001。用量记录保留，只解除与已删除检测批次的关联。
- 保留：命名模板、定时检测设置、大陆参考规则及历史、ASN 简称、运行用量（Actions 运行、使用事件、数据库采样）。
- 验证：所有数据表为 0，保留表行数不变；readiness、总览、流水线、来源、节点、机场、Sub-Store、订阅、用量、检测记录、ASN、设置接口均返回 200。

## 2026-11-11 第六次发布：0017 大数据量列表、去掉数量限制、备用检测地址、落地 IP 类型、共享批量运行时

- 代码 `f6f7b06`（main，快进合并），[CI 42984169955](https://github.com/Samiya321/nodema/actions/runs/42984169955)：353 Python、33 Worker 通过；Linux 上真实 mihomo 回环验证 21 种协议配置同进程批量检测、错误凭据失败、非法配置隔离。
- 发布前：确认无运行中的工作流；生产仍为清空后的空库（0 来源 / 0 节点）。加密备份 `backup-2026-11-11-pre-0017.nma` 在隔离 PG 恢复后升级到 0017：模板校验通过、精简列表返回 24 个字段、`ip_info` 新增 3 列。
- 生产迁移到 `0017_scale_ip_type`；`nodema_api` 对新/重建的函数与视图均有权限。API Worker 版本 `bde2e506-89ef-4b88-a2a5-20c637752180`；Pages https://e13e8f92.nodema-dashboard.pages.dev；Echo 未变。
- 验证：health 200、未认证 401、readiness 为真；`/api/nodes?view=compact` 直接返回 JSON 文本（`no-store`，位置数组 + `fields`），IP 类型筛选可用，非法视图 400、超限 422；各页面接口 200；新前端模块以 JavaScript 类型提供。
- 待真实数据后观察：生产节点列表载入耗时与 Workers CPU 限制；首次检测中经备用地址判为可用的节点数、批量运行时指标（`batch_runtimes`/`batch_nodes`/`batch_rejected`）与 `MIHOMO_BATCH_CRASHED`；GeoLite 缓存命中。可用仓库变量 `MIHOMO_BATCH_SIZE=0`、`FALLBACK_PROBE_URL=` 关闭新行为。

## 2026-11-11 第七次发布：转换兼容、机场分组与订阅链接、Sub-Store 筛选、顶部状态

- 代码 `59468cd`（main，快进合并），[CI 42997630514](https://github.com/Samiya321/nodema/actions/runs/42997630514)：377 Python、33 Worker 通过。无迁移（schema 仍为 `0017_scale_ip_type`）。
- API Worker 版本 `e1c33ee2-de7f-4864-9b1e-1dab96cc3626`；Pages https://3186f037.nodema-dashboard.pages.dev；Echo 未变。检测器与同步代码随 main 在下一次 Actions 运行时生效。
- 验证：health 200、readiness 为真；`/api/airports` 146 条均带条目名与来源 Sub-Store；`/api/sources/:id/link` 认证 200 且 `no-store`、未认证 401；流水线返回 204 个失败来源中 0 个“之前正常”（全部为从未成功的链接）；新前端模块已提供。
- 待观察：下一次同步后机场分组拆分（当前 60 组）；下一次检测中原 6,665 个“不支持”节点的实际检测结果与导出跳过计数。

## 2026-11-11 第八次发布：单订阅条数上限放开、超时来源重试

- 代码 `0460978`（main，快进合并），分支 [CI 43018343340](https://github.com/Samiya321/nodema/actions/runs/43018343340)、main [CI 43022767276](https://github.com/Samiya321/nodema/actions/runs/43022767276)：380 Python 测试通过。无迁移（schema 仍为 `0017_scale_ip_type`），Worker、Pages、Echo 未变，未重新部署。
- 仅 Actions 侧：单条订阅默认条数上限 200,000（实际受 10 MB 约束），Sub-Store 聚合预算 200,000；`source sync-all` 对本轮 `FETCH_TIMEOUT` 的来源再同步一次。下一次“同步来源”生效。
- 第七次发布的待观察项已在第二次全量检测中复核（见 STATUS 第七轮）：原“不支持”节点 984 个可用；机场 61 组，剩余按域名分组确为同一机场。
- 待观察：下一次同步中原超过 10,000 条的子订阅能否入库，及超时来源重试后的结果（标 `retried`）。


## 2026-11-15 第十四次发布：UDP 检测、中转规则、Neon 流量、节点页重做（迁移 0021）

- 代码 `3b68418`（main，CI [43618081596](https://github.com/Samiya321/nodema/actions/runs/43618081596) 通过，含真实 mihomo 的 UDP 回环冒烟）：414 Python、35 Worker。迁移 head `0021_udp_relay`。
- 发布前：无运行中的工作流和扫描租约。临时加密备份（35 MB，本机 270 秒，接近备份命令 300 秒上限）在隔离 PG17 恢复（删除 Neon `pg_attver` 列选项后），迁移 1 秒；中转规则在副本上把 182 个自建节点改为机场（自建 10,566 → 10,384）。按用户要求，备份用完已移到废纸篓。
- 生产迁移到 0021，doctor ready；API Worker 版本 `19fd1c5b-5c86-46ce-a7db-f59623d93b39`（cron 不变）；Pages https://04fe86f5.nodema-dashboard.pages.dev。readiness 为真；精简列表含 `udp`/`udp_ms`；`udp=true` 筛选可用（当时 0，等每日检测）。
- `backup.yml` 重新启用（每月 1、15 日 UTC 21:41）；仓库变量 `NEON_PROJECT_ID` 已设置。经用户同意，同日创建只能访问本项目的 Neon API Key `nodema-usage-readings`（id 3537435），存为 Secret `NEON_API_KEY`；撤销用 `npx neon@9.3.2 api-keys revoke 3537435`。
- 补丁 `2d25ebf`（CI 43619254555；Pages https://2635542d.nodema-dashboard.pages.dev）：`daily-check.yml` 支持仓库变量 `UDP_CHECK_ENABLED=false` 关闭 UDP 检测；备份 artifact 保留 20 天（每月两次运行时始终有一份）；订阅方案可选“只要 UDP 可用”。中转规则在生产改判 182 个节点（2 台服务器，当时 32 个可用），按“只测自建”的既有决定，它们约 36 小时后退出每日检测、等级和订阅。
- 注意：在 worktree 里发布 Worker 时 `--secrets-file` 要用主目录 private 的绝对路径。

## 2026-11-14 第十三次变更：数据库搬到新的 Neon 项目

- 原因：旧项目本计费周期（11-10 到 12-01）公网传输已用 4.23 / 5 GB，按日常用量撑不到重置；用户决定搬到同账号新的 Neon 项目（Free 额度按项目计算）并删除旧项目。
- 过程：停用全部写数据库的工作流 → 新建项目（AWS us-east-1，PG17，库 `nodema`，owner `nodema_owner`），用 SQL 建 `nodema_api` 并设置与旧库一致的默认权限 → 一次性工作流在 GitHub 美国 Runner 上复制（[run 43608870500](https://github.com/Samiya321/nodema/actions/runs/43608870500)，`scripts/move_database.py --mode reduced`，压缩 30 MB）→ 切换 GitHub Secrets（`DATABASE_URL`、`MIGRATION_DATABASE_URL`、`BACKUP_DATABASE_URL`）、Hyperdrive origin（Cloudflare API，密码不进命令行）和本机 private env → 验证 → 重新启用工作流 → 删除旧项目。临时 Secrets 与一次性工作流已删除，脚本保留。
- **数据取舍**：为不让复制本身把旧项目推过 5 GB，`test_results` 只复制了 `node_current_status` 引用的最新结果（40,026 / 223,517 行）；其余 36 张表逐表行数一致（共 574,813 行）。丢的是 7 天保留期内较早的单次检测明细（本来 7 天内也会被清理）；每日统计、等级、接入测量、当前状态都完整。新库 194 MB（旧 557 MB）。
- 验证：schema `0020_shared_credentials`；31 个函数、11 个触发器、70 个索引、135 个约束、3 个视图与旧库一致；`nodema_api` 对全部表/函数/序列有权限；Worker 经 Hyperdrive 查询（可用 8,865 个 UP 节点）且连接只出现在新库；readiness 为真；手动运行 entry-probe（[run 43609618984](https://github.com/Samiya321/nodema/actions/runs/43609618984)）成功写入新库。
- 备份：搬家前从本机取整库备份失败（`pg_dump` 跨洋 271 秒后退出，原因未记录）；搬家后备份 `backup-2026-11-14-post-move.nma`（35 MB）在本机 PG17 隔离恢复通过（需删除 Neon 写入的 393 条 `pg_attver` 列选项）。旧项目的完整内容（含全部检测明细）只在 `backup-2026-11-14-pre-0020.nma` 里。
- 用户决定（2026-11-14，11-15 改为每月两次，见第十四次发布）：`backup.yml` 保持停用，不做每周云端备份。需要恢复点时在本机手动备份（见 PRODUCTION_OPERATIONS.md），或 `gh workflow enable backup.yml` 重新打开（新库每次约 0.2 GB 传输）。同日按用户要求把本机 `private/*.nma` 全部 11 个备份移到废纸篓：**目前没有任何数据库备份**，上文提到的备份文件都已不在 private/ 中。

## 2026-11-14 第十二次发布：按落地国家查看、削减 Neon 传输（无迁移）

- 代码 `80a7e96`（main `c830336`，CI 43602045768 通过，401 Python）；Pages https://28607225.nodema-dashboard.pages.dev；Worker、Echo、schema 未变（仍为 0020）。
- 起因：Neon 发出 84%（4.2 GB / 5 GB）公网传输提醒。Free 用完会暂停计算实例到下个计费周期。
- 生产操作：`backup.yml` 已手动停用（`gh workflow disable`），以免当晚第一次定时整库备份占用剩余额度；计费周期重置后执行 `gh workflow enable backup.yml`。最近的恢复验证备份是 `backup-2026-11-14-pre-0020.nma`。
- 改动：每日检测收尾只读 14 列测试结果；节点页默认只加载可用节点；新增“按落地国家”视图（国家 → 落地 ASN 分组）。下一次每日检测（范围 10,566 个自建节点）起生效。
- 验证：经 Pages 域名确认新脚本与样式已上线、health 200。为省传输，没有在生产上加载节点列表做界面回归，界面在本地合成数据上检查。

## 2026-11-14 第十一次发布：共用凭据算机场（迁移 0020）

- 代码 `3b4509b`（main，CI 43593036489 通过）：400 Python、35 Worker。迁移 head `0020_shared_credentials`：`nodes.credential_key`（凭据 MD5）、`nodes.credential_shared`、函数 `nodema_mark_shared_credentials()`，视图 `nodema_node_scope` 新增尾列 `credential_shared`。规则：同一凭据 ≥5 个节点且 ≥2 个服务器地址即算机场节点。
- 依据（生产只读、只看哈希与计数）：38,808 个“自建”节点全部来自没有流量头的 Sub-Store 子来源，只有 6,964 个不同凭据；58 个凭据各被 100+ 节点共用。
- 发布前：无扫描租约、无运行中的工作流。加密备份 `backup-2026-11-14-pre-0020.nma`（58 MB）在隔离 PG 恢复（42,051 节点，同样先删除 Neon 列选项），迁移 2 秒。第一版在视图里实时分组，精简列表 1 万条从 0.85 秒变成 22 秒，改为存储标志后回到 0.85 秒；导入新节点时重算标志约 60 ms。
- 生产迁移到 0020，doctor ready；API Worker 版本 `763a8ded-641e-4138-a05a-9126a4a851e9`（cron 不变）；Pages 未变。readiness 为真。分类：机场 31,485（其中按共用凭据 28,242，可用 7,665 含原机场），自建 10,566（可用 1,200）。
- 用户决定每日检测仍只测自建：这 28,242 个节点不再每日检测，结果 36 小时后过期，随后退出等级、接入测量与订阅。

## 2026-11-14 补丁：二维码覆盖

- 代码 `bf010e3`（main，CI 43590209211 通过，399 Python）；Pages https://58528bc2.nodema-dashboard.pages.dev；无迁移、Worker 未变。
- 原因（生产只读统计，只看键名）：591 个可用节点没有二维码，主要是 Sub-Store/Clash 给 WebSocket 节点加的 `User-Agent` 请求头（分享链接没有请求头字段，整条转换被拒），其次是 AnyTLS 空闲会话参数和无 TLS 的 Shadowsocks 带证书开关。现在二维码链接省略这些并在弹窗中说明（Host 头转为传输 host），保存的节点不变。
- 在本机运行 `nodema node share-links` 重试失败行（21 秒）：可用节点中仍无二维码的只剩 13 个 VLESS（新的 `encryption` 字段，分享链接无法可靠表达）；其余失败的是不可用/不支持的节点。

## 2026-11-14 第十次发布：CF 落地不分级、港新家宽探针、前端重做

- 代码 `b23585e`（main，快进合并，[PR #2](https://github.com/Samiya321/nodema/pull/2)，CI 通过）：398 Python、34 Worker。迁移 head `0019_grade_exclusions`（只替换 `nodema_effective_grade`：可用但无等级行的节点为 NULL，不再算待定）。
- 发布前：无扫描租约、无订阅方案。加密备份 `backup-2026-11-14-pre-0019.nma`（47 MB）在隔离 PG 17 恢复（38,308 节点）：需先删除 Neon 写入的 67 条 `SET (pg_attver=…)` 列选项（见 PRODUCTION_OPERATIONS.md），升级到 0019 即时完成；重算 6,860 个节点约 4 秒，三网 B 3,043 / 待定 3,786 / C 31；港新 <3 ms 的节点从约 1,600 降到 32 / 50；精简列表 1 万条 0.8 秒（与之前相同）。
- 生产迁移到 0019，doctor ready；API Worker 版本 `2036b2b8-6072-43d0-bbf7-4325960ec8e7`；Pages https://1a360c91.nodema-dashboard.pages.dev；Echo 未变。
- 验证（经 Pages 域名）：health 200、未认证 401、readiness 为真（schema 0019）、精简列表 33 个字段、`/api/probe-status` 200、新样式表已生效。
- 等级重算：在本机对生产执行 `grade refresh` 因跨洋上传约 4 万行过慢（超过 40 分钟），已中止（事务回滚，旧等级保留）。改由同时进行的定时每日检测（[run 43537181714](https://github.com/Samiya321/nodema/actions/runs/43537181714)，代码 `b23585e`）在 Actions 内重算（01:31 UTC 完成）：定档 7,558 个节点，三网 B 5,594 / C 175 / 待定 1,789；落地 CF 的 1,397 个可用节点不再定档（0 行）；港新 <3 ms 的节点从约 1,650 降到 32 / 53（641 个已测节点中，均为机房探针测同城机房的真实值，7 天内被家宽样本替换）。以后不要从本机跑生产重算。
- 同日补丁：`6ff757d` 等级条只按可用节点比例显示（生产约 75% 节点不可用，否则彩色部分只剩一小段），Pages https://5b9bc4c9.nodema-dashboard.pages.dev；`b701338` 港新分开测量、运行摘要按错误码统计失败（只有计数）。验证：[entry-probe 43542759466](https://github.com/Samiya321/nodema/actions/runs/43542759466)（token 认证、447 次测试、0 限流，新样本无 CF 前缀的港新数据，港新探针为 HKT/HKBN/MyRepublic 等家宽网络）；[43544959809](https://github.com/Samiya321/nodema/actions/runs/43544959809)（同小时剩余额度 28 次内运行，2 次失败均为 `HTTP_422`：随机选中的运营商 ASN 当时无在线探针）。
- **定时不可靠**：GitHub 定时严重延迟/丢弃。`entry-probe.yml` 上线后约 10 小时只自动触发 1 次；`daily-check.yml` 的 20:17 UTC 定时于 00:53 UTC 才开始。晚高峰样本因此可能远少于设计。用户决定改由 Worker 触发：`63ce3a0` 给 API Worker 加 Cron Trigger `30 * * * *`，每小时调用现有 workflow dispatch 启动 `entry-probe.yml`，工作流移除 GitHub 定时（避免重复）；CI 通过（35 Worker 测试），API Worker 版本 `acb85648-1d13-4389-a32e-cd5b4830067a`，readiness 为真（dispatch 已配置）。首个 Worker 触发的运行 [43561839630](https://github.com/Samiya321/nodema/actions/runs/43561839630) 于 05:30:20 UTC 准点启动。结果：266 次测量 / 442 次测试 / 0 限流；31 次失败（`HTTP_422` 14：随机选中的运营商 ASN 无在线探针；`HTTP_404` 14：刚创建的测量查询时短暂返回 404，测试已计费；`INVALID_RESPONSE` 3）。随后的补丁让查询新测量时 10 秒内的 404 继续等待。

## 2026-11-14 第九次发布：节点质量分级（Globalping 接入测量）

- 代码 `7306266`（main，快进合并，[PR #1](https://github.com/Samiya321/nodema/pull/1)），main [CI 43459412230](https://github.com/Samiya321/nodema/actions/runs/43459412230)：396 Python、34 Worker、3 Echo 通过。迁移 head `0018_entry_probes_grading`。
- 发布前：无运行中的工作流、无扫描租约、无订阅方案。加密备份 `backup-2026-11-13-pre-0018.nma` 在隔离 PG 恢复（38,308 节点 / 8,434 可用）后升级到 0018（约 3 秒）；精简列表 1 万条 0.8–1.3 秒（与 0017 相当），全量重算等级约 4 秒（47,424 行）。用公共目标（非节点）验证了 Globalping 实时接口：三网/HK/SG 的 TCP ping、大陆可达检查、mtr 均能解析。
- 生产迁移到 0018；API Worker 版本 `db942186-6be8-4278-8337-11cd8b66d543`；Pages https://27e19949.nodema-dashboard.pages.dev；Echo 未变。
- 验证（经 Pages 域名）：health 200、未认证 401、readiness 为真；`/api/grading-policy`、`/api/probe-status`、`/api/nodes/:id/access` 200；精简列表带 9 个等级字段。手动触发 [entry-probe 43460423446](https://github.com/Samiya321/nodema/actions/runs/43460423446)：匿名额度，157 次测量 / 245 次测试 / 0 失败，写入 240 条；重算 7,904 个节点，三网视角 B 3,511、待定 4,344、C 49（尚无晚高峰样本，S/A 需要若干晚上的测量和 3 天以上检测）。
- 仓库尚未配置 `GLOBALPING_TOKEN`，当前按匿名额度（每 IP 每小时 250 次）运行。
- 待观察：晚高峰三网覆盖（总览“接入测量”的三网晚高峰网段数，3–4 晚后核对）；`entry_probe_results` 占用；Neon 每月传输。可在设置 → 质量分级规则 → 接入测量关闭。
