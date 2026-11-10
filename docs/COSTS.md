# 用量、预算与规模验证

核对日期：2026-11-09。本项目不保证零费用。账户套餐、账期、其他项目的共享用量和实际公网可达性会影响结果，部署时必须再次核对。

| 平台 | 应核对的指标 | 官方依据 |
| --- | --- | --- |
| GitHub Actions | 仓库可见性、Runner 类型、账户剩余计算用量、artifact/cache 存储；并行 jobs 的时间需要相加 | [Actions 计费](https://docs.github.com/en/billing/concepts/product-billing/github-actions)区分公共仓库标准 Runner、私有仓库计算用量和存储；业务时长不是账单 |
| Neon | CU-hours、Postgres 存储、项目公网传输和连接数；本地表大小不能代替账期用量 | [套餐与限制](https://neon.com/docs/introduction/plans)、[监控面板](https://neon.com/docs/introduction/monitoring-page) |
| Cloudflare Workers / Pages Functions | API、Echo 和 Functions 请求数，以及 API 导出的 CPU/内存；静态文件与动态请求分别统计 | [Workers 价格](https://developers.cloudflare.com/workers/platform/pricing/)、[Pages Functions 价格](https://developers.cloudflare.com/pages/functions/pricing/) |
| Hyperdrive | API 经过 Hyperdrive 的 SQL 查询数、连接和查询缓存设置 | [Hyperdrive 价格](https://developers.cloudflare.com/hyperdrive/platform/pricing/)、[查询缓存](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)；Python 任务直连 PostgreSQL，不经过 Hyperdrive |
| MaxMind | 许可、数据库更新与下载限制 | [GeoLite 使用条款](https://www.maxmind.com/en/geolite2/eula)、[数据库下载](https://dev.maxmind.com/geoip/updating-databases/) |

具体免费额度不进入业务代码。Neon 同时有计算、存储和网络限制，不能仅凭数据库文件较小断言免费；Cloudflare 大批量解密/转换导出需要单独测 CPU，不能根据 Echo 请求很小推断 API 也满足免费计划限制。

## 可重复的本地测量

```bash
uv run python scripts/install_mihomo.py
uv run python scripts/benchmark_pipeline.py
```

从私下环境读取 `TEST_DATABASE_URL`。脚本为每种规模创建并删除独立 schema，生成不同合成 UUID，在 loopback 启动临时 VLESS/TLS 服务端与 HTTPS nonce 回显，使用真实 HealthChecker、Mihomo、数据库发布和五种导出；最多四个并行分片。没有下载测速，不读取真实节点，不产生代理公网测试流量。

原始安全报告见 [benchmarks/2026-11-09-loopback.json](benchmarks/2026-11-09-loopback.json)。`mean_check_ms` 包含本地核心校验、启动、TCP 与代理 HTTPS，不包含结果落库；`pipeline_seconds` 包含导入、分片检测、发布与导出，不包含依赖安装、数据库迁移和 fixture 服务端准备。`local_worker_minutes` 是分片执行时间之和，不能当作 GitHub 计费分钟。数据库容量包含表和索引，不包含 WAL、备份、Neon 计费计算和其他项目。

正常复测会增加 attempts。脚本核对每个节点均有最终发布结果、每日计数正确，且重新运行已完成分片和 finalizer 不增加记录。CI 运行 100 节点真实本地链路；1000/5000 可手动执行，便于检测规模回归。

## 生产测量流程

1. 先完成 [部署说明](DEPLOYMENT.md)，导入 50–100 个授权节点。记录日期、计划、节点数、分片大小和超时参数；不要把节点配置放进测量报告。
2. 在 Dashboard“运行与用量”查看检测尝试、均值、超时/环境错误、执行失败、订阅下载、Echo 与容量采样。`usage.yml` 在受信任工作流完成后读取 attempt/jobs 时间；缺失时间单独显示，不补成零分钟。
3. Linux Job 的默认路由网卡差值包含该时间段依赖下载、数据库和任务流量。强杀、网卡重置或依赖安装失败可能没有样本；缺失样本不能当作零。应用层响应字节不包括 TLS、协议头、请求和重传。
4. 从平台控制台核对同一时间窗的 Actions 账单、Neon CU-hours/传输、Worker 请求与 CPU。采集页面需要隐去订阅 URL 和认证头，保持本项目默认不记录请求 URL 的配置。
5. 在实际超时分布允许的前提下逐步扩展到 1000、5000。至少运行多个日批次并包含失败重试、清理和一次备份，观察存储增长；不要把首日插入量直接当作长期稳定容量。
6. 按实际账户剩余额度设预算和支出通知。若费用超预算，先调整分片、历史保留和调用频率；是否升级套餐由实际测量决定。

尚未获得用户云账户和授权节点的测量结果，报告中的 `github_actions_minutes` 与 `public_network_bytes` 为 null，明确表示未测量。
