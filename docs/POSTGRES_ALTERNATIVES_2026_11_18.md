# Nodema 免费 PostgreSQL 替代方案 · 2026-11-18

**优先验证 Aiven Free，保留 Layerbase Free 作为第二候选。** 两者均可走现有 PostgreSQL 协议，官方文档均支持自建数据库角色。Aiven 需确认免费公网传输规则、可用区和连接余量。Layerbase 有明确的传输额度，但免费服务要求每七天至少休眠 25%，需验证现有定时任务和连接池能满足条款。

## 生产负载

- 11 月 18 日北京时间 10:17 左右复核 Neon 控制面，公网出站 **3.573 GB / 5 GB**，剩 **1.427 GB**。周期于 **12 月 1 日 08:00** 重置。此前两次快照间约一天增长 0.66 GB，生产用量页按更短历史推算约 11 月 20 日耗尽。按近期不同采样窗口估算，现有流量约 **20–29 GB / 30 天**，因此将 **30 GB / 月以上**作为替代服务的规划起点。实际用量包含页面、Actions、维护和备份，尚未逐项归因。公网额度耗尽后计算实例会暂停，`pg_dump` 也会返回 `53000`。[生产评估](PRODUCTION_REVIEW_2026_11_18.md) · [Neon 免费计划](https://neon.com/docs/introduction/plans)
- 当前 PostgreSQL 17，schema `0023_identity_naming`，库约 **401 MB**，检测明细约 **174 MB**。迁移容量评估还需考虑索引重建、WAL、临时文件和提供商的磁盘口径。生产约 56,600 个节点，最近每日工作流约 13,300 个检测项，另有每小时接入测量。[生产评估](PRODUCTION_REVIEW_2026_11_18.md)
- [每日工作流](../.github/workflows/daily-check.yml#L162)最多 10 个检测 Job 并发，[Python 池](../app/database/session.py#L26)每引擎最多 2 条连接。Hyperdrive 的生产源站限制为 5，Cloudflare 明确这是软上限。单次只读检查观察到 3 个会话，不能代表高峰。`pg_stat_database` 的累计提交/回滚为 72,640 / 5,473，重置时间为空，`pg_stat_statements` 未安装。这些计数不足以确定计费 SQL 数或月增长率。[部署配置](CLOUD_DEPLOYMENT.md) · [Hyperdrive 限制](https://developers.cloudflare.com/hyperdrive/platform/limits/)

## 候选对照

| 免费方案 | 主要配额及能力 | 对 Nodema 的判断 |
| --- | --- | --- |
| **Aiven PostgreSQL** | 1 GB 磁盘、1 GB RAM、单节点、20 个总连接，官方建议按预留 6 个计算应用容量。含备份和网络费用。公开免费档文档未列 PostgreSQL 月度公网传输上限。支持建角色并授权。免费档无 SLA，地区选择受限。 | **首选验证**。现有数据量有望恢复。以 14 个应用连接为规划上界，测实际峰值、日常运行耗时及磁盘水位。在可查的免费计划条款或控制台中确认公网出站口径和限流条件。 [免费规格](https://aiven.io/docs/products/postgresql/concepts/pg-free-tier) · [网络费用](https://aiven.io/free-postgresql-database) · [连接](https://aiven.io/docs/products/postgresql/reference/pg-connection-limits) · [角色](https://aiven.io/docs/products/postgresql/concepts/dba-tasks-pg) · [服务条款](https://aiven.io/service-specific-terms) |
| **Layerbase PostgreSQL** | 5 GB 账号共享磁盘，最多 20 个并发连接，一个手动备份槽。双向网络流量滚动上限为 10 GB / 24 小时、50 GB / 7 天、150 GB / 30 天。支持直连自建角色，池化地址要同步角色。 | **第二候选，网络额度更明确**。免费库须在滚动七天内休眠至少 25%，共享 CPU，定价页标注 beta 规则。正常任务窗口、空闲池释放、冷启动和 `verify-full` 均需验证，按实际双向流量核算。免费条款允许个人和开源项目，持续取得生产收入的产品须付费。 [价格](https://layerbase.com/pricing) · [流量与休眠条款](https://layerbase.com/acceptable-use) · [连接与角色](https://cloud.layerbase.com/docs/cloud/connecting/postgresql) |
| **Prisma Postgres** | 2 GB、出站不限量、全工作区 20 万条查询/月，超额暂停读写。免费无自动备份。可用标准 PostgreSQL 客户端，但不支持 `CREATE ROLE`，生成的凭据均有完整数据库权限。 | **排除**。无法保留 Worker 与迁移角色的权限区别。日均查询预算约 6,700 条，现有事务计数也不足以证明能跑进该额度。 [规格](https://www.prisma.io/postgres/free-postgresql-hosting) · [角色限制](https://www.prisma.io/docs/postgres/faq) |
| Supabase | 500 MB，5 GB 非缓存出站。数据库和共享连接池流量计入出站，另列的 CDN 缓存额度用于缓存响应。 | 存储余量小，继续面临相近的出站限制。 [价格](https://supabase.com/pricing) · [计量](https://supabase.com/docs/guides/platform/manage-your-usage/egress) |
| Railway / Render / Koyeb | Railway 每月 $1 免费额度，同一额度承担出站、计算和存储，出站 $0.05/GB。Render 免费数据库 30 天到期。Koyeb 免费数据库每月仅 5 小时活跃计算。 | 当前负载缺少长期运行余量。Railway 约 20 GB 的出站已用完免费余额。 [Railway](https://docs.railway.com/pricing/plans) · [Render](https://render.com/docs/free) · [Koyeb](https://www.koyeb.com/docs/databases) |
| Cloudflare D1 | SQLite，单个免费数据库上限 500 MB。 | 现有 PostgreSQL SQL、迁移、触发器和 Actions 数据路径需要改写。此方案超出更换托管 PostgreSQL 的范围。 [D1 限制](https://developers.cloudflare.com/d1/platform/limits/) |

## 免费档之外的选择

- **允许付费并离开 Neon。** PlanetScale 单节点 PostgreSQL 从 $5/月起，含 10 GB 出站，超额 $0.06/GB。按 20–30 GB/月估算，实例和流量合计约 $5.60–6.20/月，备份等其他用量另核，需实测最小实例能否按时跑完日检。DigitalOcean 托管 PostgreSQL 单节点从 $15/月起，官方说明托管库流量不计入带宽账单。[PlanetScale 单节点](https://planetscale.com/changelog/single-node) · [出站额度](https://planetscale.com/blog/database-egress) · [超额费率](https://planetscale.com/pricing) · [DigitalOcean](https://docs.digitalocean.com/products/databases/postgresql/details/pricing/)
- **允许短期付费留在 Neon。** Launch 每项目每月含 500 GB 公网出站，计算按 $0.106/CU-hour 计费，另计存储等用量。11 月 18 日 10:48 左右复核出站已用 3.582/5 GB，计算累计约 5.02 CU-hour。按 Launch 单价折合约 $0.53 的观测期计算费，月费仍取决于实际运行时长和其他用量。适合在额度耗尽前保住访问或安排迁移。[Neon 定价](https://neon.com/pricing)
- **维持零费用且允许自管云主机。** OCI Always Free 提供每月 10 TB 出站，可在云主机仅部署 PostgreSQL 17。免费规格可能缺货，空闲实例可能被回收。需要自己处理补丁、连接访问、磁盘、异机加密备份和恢复。单机故障会导致数据库中断。[OCI 网络](https://www.oracle.com/cloud/networking/) · [Always Free 实例条款](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
- **维持零费用和全托管。** 若免费候选均不接受，需改变应用的流量或存储要求。按 20–29 GB/月的估算，压进 Neon 的 5 GB 需要约 75–83% 降幅，具体靠 Actions 和页面请求的分阶段归因验证。转向 D1 则需迁移到 SQLite，重写数据库访问，并验证每日读写额度和单库容量。[D1 定价](https://developers.cloudflare.com/d1/platform/pricing/) · [D1 限制](https://developers.cloudflare.com/d1/platform/limits/)

## Aiven 上线前的验证顺序

1. **优先保住可迁移副本。** 当前最新已验证可恢复的加密备份生成于 11 月 17 日 02:11，早于 `0023_identity_naming` 发布，适合演练。正式切换前在 Neon 仍可读期间安排新鲜完整备份并验证隔离恢复。此前跨 Neon 项目迁移使用的 `reduced` 会丢历史检测明细，本次计划用全量备份保留历史。 [备份证据](PRODUCTION_REVIEW_2026_11_18.md) · [生产手册](PRODUCTION_OPERATIONS.md) · [迁移脚本](../scripts/move_database.py)
2. **验证角色、TLS 和容量。** 确认目标区实际可选 PostgreSQL 17 或经验证兼容的大版本。隔离恢复后核对 schema `0023_identity_naming`、关键行数、主键、序列、约束、函数、触发器以及 owner/业务角色权限；用 Aiven 项目 CA 保持 Worker 和 Actions 的 `verify-full`。检查备份恢复峰值和完成后的磁盘水位。 [Aiven 恢复](https://aiven.io/docs/products/postgresql/howto/migrate-pg-dump-restore) · [Aiven CA](https://aiven.io/docs/platform/concepts/tls-ssl-certificates) · [Hyperdrive TLS](https://developers.cloudflare.com/hyperdrive/configuration/tls-ssl-certificates-for-hyperdrive/)
3. **验证日常并发与耗时。** 初始试验采用 4 个检测 Job、每个 Python 进程 1 条池连接、Hyperdrive 源站限制 5。分别观察 Worker 页面、日检、小时探测和备份，留出至少 3 条业务空闲连接，并确认日检能在工作流时限内完成。连接数应在数据库端观测，包括重连和任务重叠。用代表性的正常负载验证，检查计划条款与目标约束。 [Cloudflare 源站设置](https://developers.cloudflare.com/api/python/resources/hyperdrive/subresources/configs/methods/create/) · [Aiven 使用条款](https://aiven.io/aup)
4. **验证用量页与切换。** 目前公网传输采样依赖 Neon API。改为标记旧读数来源、显示 Aiven 能实际提供的指标以及采样时间，未提供的额度显示未知。切换时暂停写端、做最终备份并核对后切换 Actions、Hyperdrive 及本机连接，验证 readiness 和代表性流程，再恢复调度。保留旧库和最终加密备份作为回退来源，回退时核对切换后写入的处理方式。继续减少总览整表读取和节点页全量分页。[当前采样](../app/usage.py#L267) · [生产手册](PRODUCTION_OPERATIONS.md)

本轮范围为官方条款、源码与小量生产只读核对。候选实例、实际传输条款、隔离恢复和完整并发运行均待验证。生产连接与调度仍指向 Neon；没有部署或提交运行代码，无对应新 CI。
