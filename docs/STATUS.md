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

2026-11-11 第二轮（**已合并并发布**，main `b477963`，迁移 `0015`，见 [CLOUD_DEPLOYMENT.md](CLOUD_DEPLOYMENT.md)）：修复单节点 DNS 超时导致整片中止（生产 run 42907816991）、滑动窗口并发检测；导入不再自动启动 Actions，改为手动“同步来源”和按范围检测；机场识别与流量/到期、Sub-Store 子来源、自建节点保留语义、`🇸🇬HK->SG|Webbing 01` 命名；Dashboard 全部重写。迁移 head `0014_sources_airports_naming`；本地 328 Python + 32 Worker + 3 Echo 通过，loopback 握手和 100 节点合成链路通过。说明见 [SOURCES_AIRPORTS_NAMING.md](SOURCES_AIRPORTS_NAMING.md)，上线顺序见 [HANDOFF.md](HANDOFF.md)。尚未在真实节点和生产 Runner 上验证速度。

2026-11-11 第三轮（迁移 `0016_servers_ipinfo_share`）：同一落地 IP 的节点共用序号并加协议后缀（`🇯🇵JP|Greencloud|xTom 01 VLESS`），落地 IP 归属/ISP 由 Actions 查询 ip-api.com，节点详情可显示 Shadowrocket 可扫的分享二维码，节点页新增“按落地服务器”视图。详见 [SOURCES_AIRPORTS_NAMING.md](SOURCES_AIRPORTS_NAMING.md) 第 8 节。

2026-11-11 第四轮（迁移 `0017_scale_ip_type`）：为大量数据优化列表页。节点页取回筛选后的全部节点（`/api/nodes?view=compact`，只含列表字段，每次请求 10000 个、其余并行，总数不设上限；Worker 直接转发 PostgreSQL 的 JSON 文本，不在 Worker 里解析），分组和组内行都按 100 个渐进显示，列表视图每页 100 行，切换视图/翻页 30 秒内复用结果；“全选”覆盖整个筛选结果。数量不设上限：检测所选节点超过 5000 个时拆成多条请求、由下一次运行合并成一个批次；批量导入链接不限行数（前端每 100 行一次请求，行号与名称连续）；来源/节点批量操作只受 10 MB 请求体限制。Actions 侧：`source sync-all` 先 8 线程并行下载订阅、再顺序解析写库；检测分片自动变大，单次运行最多 40 个作业（`MAX_SHARDS`），并行 10 个。保留的单个订阅安全上限：每个订阅最多 10000 个节点或 10 MB；单个导出订阅文件 10 MB。免费额度适配（Neon Free：1 GB 存储、每月 5 GB 网络传输；Workers Free：每天 10 万请求、每请求 10 ms CPU）：节点列表以位置数组传输（20000 节点一次完整载入约 4.9 MB），载入后保留到有变化或点“刷新”；`cleanup` 按启用节点数自动缩短明细与日统计保留天数（预算 350 MB / 250 MB，至少 7 / 30 天；20000 节点约 16 天明细、87 天统计）；ip-api 查询遇到每分钟限额会等待重置继续（预算 12 分钟），每次最多 50000 个 IP；同步与 finalize 作业超时放宽到 90 / 45 分钟（公开仓库不计费）。导出实测约 12000 个可用节点：Clash 1.5 MB、sing-box 1.9 MB、链接 1.4 MB、CSV 2.3 MB，只有 JSON 报告格式超过 10 MB。来源页 Sub-Store 子来源折叠在父来源下，支持排序和每页 50 个；机场多于 6 个时按机场折叠并显示汇总；Sub-Store 子来源弹窗可搜索、只看失败并分页。合成数据本地实测：5000 节点首次载入约 0.8 秒；20000 节点 / 200 来源首次载入约 2.5 秒（两次请求，各约 1.1 秒数据库时间），全选 29 毫秒，切换视图约 0.1 秒，页面内存约 17 MB；200 个来源的来源页约 0.13 秒。同日按用户要求清空了生产数据（保留设置和用量记录），清空前的加密备份已在隔离 PG 验证可恢复。

2026-11-11 第五轮（并入未上线的迁移 `0017_scale_ip_type`，参考公开节点仓库）：
- **备用检测地址**：Echo 请求失败（不含超时）时，经同一代理再访问 `FALLBACK_PROBE_URL`（默认 `https://www.gstatic.com/generate_204`）；能通则记为可用、落地信息未知（`echo_source=fallback`），避免出口被 Cloudflare 拒绝的节点被误判 DOWN。
- **落地 IP 类型**：ip-api 同一批量请求多取 `mobile/proxy/hosting`，`ip_info` 新增三列；目录/精简列表提供 `exit_ip_type`（家宽/机房/移动）与 `exit_ip_proxy`，可筛选，命名新增 `{IPTYPE}`。
- **共享批量运行时**：真实检测把预检后的节点每 128 个装进一个 mihomo 进程，每个节点一个回环监听（未命中规则为 REJECT），最多 3 个进程轮换；被 mihomo 拒绝的配置二分隔离后单独检测，进程中途退出的节点在新批次重试。每个分片只做一次核心/Echo 预检（之前每个并发线程串行一次）。默认并发 16 → 48。本地 1000 节点、模拟 500 ms 网络延迟：并发 16 从 71 秒降到 38 秒（共享预检）；并发 64 时逐节点模式 14.9 秒（启动 256 个进程）、批量模式 13.1 秒（0 次逐节点启动）。纯回环无延迟时批量模式反而略慢（3.3 → 4.2 秒，批次校验与启动开销），实际网络下收益来自更高并发。`scripts/smoke_protocols.py` 用真实 mihomo 验证了 21 种协议配置同进程、错误凭据失败、非法配置隔离。
- **GeoLite 缓存**：daily-check 用 `actions/cache`（按 ISO 周，回退到旧缓存）保存 `private/geoip`，8 天内的库直接复用（用户确认自用仓库接受缓存可被本仓库工作流读取）。
- `scripts/benchmark_pipeline.py` 的导出校验自 0010 异步导出起已失效，新增 `--skip-exports`、`--batch`、`BENCHMARK_ECHO_DELAY_MS`、`BENCHMARK_CONCURRENCY`。
