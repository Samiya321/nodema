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
4. 可选：提供 MaxMind 账户与许可密钥后启用入口 GeoIP/ASN。当前没有配置这两个凭据，入口地区/ASN 可能显示未知；出口信息优先来自 Echo。

当前验收证明部署和调度链路可用，不能代替用户真实公网节点的协议参数、Runner 可达性、大陆体验与长期免费额度验收。历史修复前的失败工作流保留作为排查记录，以上链接指向已通过的验证。
