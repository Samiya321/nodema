# 查询、检测与大陆参考分级实施清单

用户授权范围：沿用 Pages + TypeScript Worker + PostgreSQL + Python/Actions，实现此前讨论的优化；大陆分级仅为理论候选优先级，不增加大陆探针，不改写为 Go。

## 交付与验收

| 项目 | 必须实现的行为 | 验证证据 |
| --- | --- | --- |
| 查询 | PostgreSQL 内筛选、允许列表多字段排序、稳定分页、聚合概览；Python/Worker 一致 | 已验收：`test_quality_catalog.py`；Worker `api.test.mjs`；15k/50k [分页计划与计时](benchmarks/2026-11-09-catalog-pages.json) |
| 筛选与导出 | 入口/出口地区、地址、ASN、来源、协议、传输、安全层、状态、时间、Runner 统计、标签与参考等级；排序/Top N 同样用于导出 | 已验收：CLI 子进程、Python/Worker 五格式、浏览器 Hysteria2+P1 / Top 2 / 启用状态过滤 |
| 参考分级 | P1/P2/P3/U、理由、置信度、规则版本、依据时间；人工声明/资料独立保存，线路真实类型仍 UNKNOWN | 已验收：`test_quality_catalog.py`、Worker 跨端往返；缺失/过期/不稳定/人工声明与运营商范围 |
| 规则管理 | 通用及电信/联通/移动偏好、版本历史、人工标签/依据管理 | 已验收：两端输入校验、版本冲突、正文仅管理员显式读取；CLI 和浏览器规则/资料操作 |
| Runner 统计 | 同测点/目标/口径窗口内最终观测的成功率、中位数、P95、超时率、样本量；复测不重复统计 | 已验收：`test_execution_efficiency.py` 的最终尝试、双测点、窗口过期、跳过/环境失败 |
| 入口预检 | DNS TTL/负缓存、同入口共享 TCP；多地址、IPv4/IPv6、QUIC、环境错误分离 | 已验收：`test_precheck.py`（含 NXDOMAIN/NODATA SOA）；真实协议脚本及 5000 节点 20 次 TCP / 4980 命中 |
| 失败策略 | 可追溯的确认失败门控、抽样完整验证、退避复查；资产不删除、跳过不伪造完整检测 | 已验收：单元抽样/强制/QUIC；数据库退避/幂等跳过/成功与测点变更；身份变更仍由既有 HMAC 去重测试保证新资产 |
| 执行效率 | 少量隔离 Mihomo 进程复用、有界节点并发、减少逐节点数据库往返、保留租约和中断恢复 | 已验收：19 种真实配置；同名错误认证/恢复/DNS 固定；4 并发隔离与批量写入；真实串行及并发强杀恢复 |
| 运维 | 配置、迁移、工作流、用量指标、文档与合成规模验证同步更新 | 已验收：Python 257 + Worker 28 + Echo 3，迁移/备份、类型/构建、actionlint；[完整验证记录](VALIDATION.md) |

本表范围已完成代码与本地验收。生产部署、真实 Runner/Neon 测量与大陆实测不在本次代码交付范围，未标记为通过。真实订阅配置、URL、凭据和真实出口地址不进入公开测试或报告；不启动下载测速、不自动猜测 IPLC/IEPL/CN2。

本表对应已实现的查询/检测优化范围；最新 Actions 预生成、长期容量与 UI 反馈的完整交付状态见 [CONVERSATION_COMPLETENESS_REVIEW.md](CONVERSATION_COMPLETENESS_REVIEW.md)。
