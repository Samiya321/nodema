# 云端部署记录

部署日期：2026-11-11（北京时间）。已发布生产页面、API 和 Echo，使用 Neon Free PostgreSQL 与标准 GitHub Actions Runner；本次没有开通或升级付费套餐，没有使用自有服务器、R2 或 Redis。

| 服务 | 地址 / 状态 |
| --- | --- |
| Dashboard | https://nodema-dashboard.pages.dev |
| API | https://nodema-api.simb.workers.dev；管理接口需要管理员鉴权 |
| Echo | https://nodema-echo.simb.workers.dev；仅返回调用者的观测信息 |
| 源码 | https://github.com/Samiya321/nodema |
| 数据库 | Neon Free，PostgreSQL 17，美国东部；迁移至 `0013_export_usage` |
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
