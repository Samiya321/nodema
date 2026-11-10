# 实现与验收状态

新会话/其他 agent 先读 [接管指南](HANDOFF.md)；生产操作和凭据读取边界见 [生产操作手册](PRODUCTION_OPERATIONS.md)。

截至 2026-11-09，Actions 预生成订阅和长期扫描明细归档两项主要代码缺口已补齐，相关 API、Dashboard、迁移、工作流与回归均已接通。2026-11-11 已发布用户云端实例并完成基础链路验收，见 [云端部署记录](CLOUD_DEPLOYMENT.md)。逐项核对见 [交付审查](CONVERSATION_COMPLETENESS_REVIEW.md)。

| 范围 | 代码状态 | 验证与边界 |
| --- | --- | --- |
| M1 资产库 | 已实现 | Source/Node/NodeSource、六协议、跨格式去重、Sub-Store、本地/远程/混合订阅、明文存储/HMAC；真实 PG 迁移 |
| M2 检测 | 已实现，本地验证 | 入口 DNS/TCP、Mihomo、轻量 HTTPS Echo、地区/ASN、状态与失败区分；公网和 Runner 需上线验收 |
| M3 自动化 | 已实现，本地验证 | 每日/手动/补测、不可变快照、分片、租约、幂等发布、强杀恢复、活动任务保护及旧明细归档 |
| M4 Dashboard/API/订阅 | 已实现，本地验证 | Pages + TS Worker、组合筛选/多排序/Top N、理论分级、累计日期统计；Actions 生成五格式、固定链接、编辑/重建/版本/失效/撤销 |
| M5 性能与容量 | 本地验证 | 100/1000/5000 链路与异步生成测量；有限成品/成员/版本预算、明细保留期、用量与备份；免费云端额度未验收 |
| 生产部署 | 已发布，基础链路通过 | 页面/API、Neon、Echo、Actions、订阅和加密备份已接通；真实节点与生产恢复仍需后续验收；GitHub GeoLite 下载、安装和查询已验证 |

新增批量链接导入和 GitHub GeoLite 自动下载后，通过 **300 Python + 33 Worker + 3 Echo = 336** 项测试。迁移 head 为 `0013_export_usage`。新订阅默认长期有效，旧链接保留原 token hash 和到期时间；升级后需生成一次当前成品。运行步骤、预算及归档语义见 [ASYNC_SUBSCRIPTIONS.md](ASYNC_SUBSCRIPTIONS.md)。

没有改为 Go，没有引入自有服务器、Redis 或 R2。正常数据库读写不依赖 AES，HMAC 与访问鉴权保留；旧密文一次性迁移、加密备份和 MMDB 包仍使用 AES。

大陆等级是 P1/P2/P3/U 理论候选优先级；真实线路类型与大陆可达性保持 UNKNOWN。累计已收录天数及日可用率同时展示，清理历史不使累计天数倒退，未检测日期不进分母。

现有 UI 的异步交互和移动布局已有验证，本轮没有整体视觉重构；检测新鲜度仍通过环境变量配置。GitHub 定时延迟、云平台配额和网络限制不可能由本地代码保证，不能承诺永远零维护或部署后立即完成所有公网验收。

2026-11-11 增量：Dashboard / Worker / Python API / CLI 支持每批 100 个订阅 URL 与 Sub-Store API，逐行校验、去重、并发批次保护和单次调度；GeoIP 默认从 GitHub Release 下载并校验，无需另配 MaxMind 账号。说明与数据许可见 [BULK_IMPORT_AND_GEOIP.md](BULK_IMPORT_AND_GEOIP.md)。

2026-11-11 第二轮（分支 `claude/subscription-perf-node-mgmt-9e651c`，**未合并、未部署**）：修复单节点 DNS 超时导致整片中止（生产 run 42907816991）、滑动窗口并发检测；导入不再自动启动 Actions，改为手动“同步来源”和按范围检测；机场识别与流量/到期、Sub-Store 子来源、自建节点保留语义、`🇸🇬HK->SG|Webbing 01` 命名；Dashboard 全部重写。迁移 head `0014_sources_airports_naming`；本地 327 Python + 32 Worker + 3 Echo 通过，loopback 握手和 100 节点合成链路通过。说明见 [SOURCES_AIRPORTS_NAMING.md](SOURCES_AIRPORTS_NAMING.md)，上线顺序见 [HANDOFF.md](HANDOFF.md)。尚未在真实节点和生产 Runner 上验证速度。
