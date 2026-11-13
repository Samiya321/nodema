# 筛选、Runner 统计与大陆参考分级

本系统继续使用 Cloudflare Pages + TypeScript Worker API + Neon/PostgreSQL + Python/Actions + Mihomo。当前优化针对数据库往返、重复 DNS/TCP、逐节点启动核心和串行等待，不迁移为 Go。网络超时和核心进程成本需要在实际 Runner 上测量；更换调度语言不会改变这些网络条件。

## 节点等级（2026-11-13 起的主要分级）

界面与订阅使用按视角的 S/A/B/C/D/待定 等级，见 [NODE_GRADING_DESIGN.md](NODE_GRADING_DESIGN.md)。下面的 P1/P2/P3/U 理论候选仍由 SQL 计算并保留在 API/报告字段中，但界面已不再显示，也不再接受人工线路声明的编辑。

## 大陆参考等级（旧，界面已隐藏）

P1/P2/P3/U 是可解释的候选优先级，面向没有大陆探针的使用方式。任何等级都不证明中国大陆可达、三网直连或 IPLC/IEPL/CN2；数据库 `line_type` 和 `mainland_reachability` 始终为 `UNKNOWN`。`line_claim` 仅是管理员录入的声明，不能替代观测。

按以下顺序计算，前面的条件优先：

| 条件 | 等级与含义 |
| --- | --- |
| 当前不是新鲜 UP、资产停用/失去有效来源 | U：当前不满足候选资格 |
| 同测点七天内完整观测不足，或旧记录没有测点信息/Runner 无法定位 | U：资料不足；不把不同 Runner 的结果合并补样本 |
| 同测点成功率低于规则阈值 | P3：Runner 历史不稳定，作为备用 |
| 缺少入口地区/ASN 或出口地区 | U：不以节点名字补全信息 |
| 管理员指定候选优先级 | 使用指定 P1/P2/P3，低置信度；仍不能覆盖前面的不可用/不稳定条件 |
| 有未过期且适用于所选运营商的人工资料 | P1，中置信度；表示有可核对资料，并非系统认证 |
| 符合管理员配置的地区、ASN 或协议偏好 | P1，低置信度 |
| 其余当前可用且样本充足的节点 | P2，普通候选，低置信度 |

默认最少 3 个样本，成功率阈值 80%，资料有效期 90 天。样本窗口固定七天，最少样本允许 1–7。系统不内置某个地区/ASN/协议对大陆更好的断言，也不根据命名推断专线。GENERAL/CT/CU/CM 分别表示通用/电信/联通/移动的人工偏好集合；未填写的运营商字段继承通用值。接口可用空数组显式清空某个偏好；界面空白表示继承。

每次返回等级同时返回理由、置信度、运营商规则、规则版本、计算时间、资料维护时间和资料年龄。规则保留版本历史，更新可携带 `expected_version` 防止覆盖别人的修改；冲突返回 409。人工资料正文/URL 在数据库明文保存，普通列表、导出及历史不含正文。仅管理员显式请求 `/api/nodes/{id}/evidence` 后才返回。系统不会自动访问这些依据链接。维护时间表示管理员最近替换资料的时间，不是外部证据的真实性证明。

## 可比较的 Runner 统计

`probe_key` 区分 Runner 标识、国家/ASN、IP 族、Echo 目标（scheme/host/path 的摘要）及 `https-v1` 口径。自定义 `RUNNER_PROBE_ID` 仍保留国家/ASN，避免相同名字掩盖网络变化；Runner 无国家/ASN 时使用出口摘要区分，参考分级为 U。不输出 Runner 原始直连 IP。

同一批次、同一节点仅取最后一次尝试。只汇总已完整发布批次中的 `FULL` 结果，窗口为最近七天，分别计算成功率、超时率、样本数，以及成功 HTTPS 请求耗时的中位数/P95。成功包含 UP/DEGRADED；失败为 DOWN；超时以最终尝试的阶段记录为准。PREFLIGHT、SKIPPED、环境失败和未完成批次不混入完整代理统计。没有样本时百分位为 null。过期样本会在刷新时移除，旧汇总不会继续伪装为新样本。

相同国家/ASN 仍不能证明物理测点完全一致；这些数值只帮助比较对应 Runner 环境。GitHub Runner 到节点和大陆用户到节点的路径不同，低延迟和高成功率不能证明大陆体验。当前没有下载速度、带宽、真实大陆 RTT 或大陆丢包指标。

## 查询与导出

筛选和排序在 PostgreSQL 中执行，Python 与 Worker 共用迁移内的 SQL 函数。先计算有序 ID 页，再生成这页的详情，避免为每条资产提前生成名称、计数和分级 DTO。概览使用数据库聚合；API 默认 50 条、最多 500 条，CLI 默认 100 条。排序只接受允许列表中的字段，最多三个字段，统一 `NULLS LAST`，并以 UUID 保证稳定次序。页码采用 offset；深分页仍有扫描成本。

支持的主要字段：

- 身份：协议、入口主机/端口、传输、安全层、短编号/名称搜索。
- 路径元数据：入口解析 IP、入口/出口地区与 ASN、出口 IP/城市。`asn` 匹配任一侧；入口/出口 ASN 可独立指定。
- 资产与历史：来源 ID、启用/有效来源、当前状态、最近检查/成功时间。
- 参考：人工标签（全部包含）、运营商规则、等级、置信度、线路声明、资料类型。
- Runner：测点、样本下限、成功率下限、超时率上限、HTTPS/P95 耗时上限。

API 比例采用 0–1；界面用百分数输入。时间筛选必须带时区，例如 `2026-11-09T00:00:00Z`。排序写为 `http_p95_ms:asc,success_rate:desc`。未知字段、非法排序、非法比例/端口/时间会被拒绝，数据库异常不会回显输入。

五种导出复用同一筛选与排序，支持 Top N。始终强制新鲜 UP、启用、有有效来源且最近完整成功未过期；冷却跳过和入口门控不会产生导出资格。JSON/CSV 仅输出允许列表中的元数据；Mihomo/sing-box/URI 是敏感配置。依据正文、内部密文不进入任一种导出。订阅由 Actions 生成；链接过期或撤销时立即拒绝下载，节点停用或成员来源失效会立即阻断受影响旧文件并等待重建，见 ASYNC_SUBSCRIPTIONS.md。

CLI 示例（文件内容也应放在忽略目录）：

```bash
uv run nodema quality show
uv run nodema quality apply --input-file private/quality-policy.json --expected-version 1
uv run nodema quality annotate <NODE_UUID> --input-file private/annotation.json
uv run nodema node list --filters-file private/filters.json --sort 'http_p95_ms:asc,short_id:asc' --limit 50 --with-total
uv run nodema export create --format mihomo --filters-file private/filters.json --sort 'http_p95_ms:asc' --limit 20
```

示例筛选文件：

```json
{"entry_country":"SG","exit_country":"JP","protocol":"vless","operator":"CT","grade":"P1","min_samples":3,"min_success_rate":0.9}
```

规则文件可以只包含需要覆盖的配置项，未提供项使用默认值；规则 apply 是整份替换，不是增量合并。人工资料 annotate 是增量修改，`reference: null` 表示删除正文；DOCUMENTED 必须同时保留正文。

## 检测执行策略

1. 只处理明确导入的资产；先标准化、HMAC 去重，再冻结每日快照。同入口按 HMAC 分组，超过分片目标大小的组拆分，并按负载分配。已存在快照的分片不重排。
2. 每个分片共享 DNS/TCP single-flight 缓存，避免相同入口并发重复请求。DNS 使用 A/AAAA 全部地址，正缓存不超过响应 TTL 与配置上限；NXDOMAIN/NODATA 负缓存服从 SOA 与短上限。超时、SERVFAIL/环境故障不做长期负缓存。字面 IP 不查 DNS。
3. TCP 对全部候选地址进行最多两轮、有超时预算的连接诊断，任一成功即可。超过 32 地址、预算不足、过短超时或本机无路由/资源错误均不构成确认失败。IPv4/IPv6 分别保留地址证据。Hysteria2 使用 QUIC，完全绕过 TCP 预检和 TCP 门控。
4. 确认 TCP 全失败时，默认跳过昂贵核心验证并记录 PREFLIGHT；仍按固定抽样率做完整复查。不删除资产。DNS 不存在记录 PREFLIGHT；DNS/Echo/核心环境故障中止发布。入口记录保留时间、缓存命中、检查 ID 和决策，不能被解释为完成过代理握手。
5. 连续 DOWN 达到阈值后，按同测点失败次数计算指数退避，默认从 6 小时增至最多 72 小时；由于日调度，短于一天的退避可能仍在次日完整检查。冷却期记录 SKIPPED/UNKNOWN，保留连续失败数与原复查时间，不新增成功/失败、不刷新成功时间。测点变化绕过旧冷却；完整成功清零。每天确定性抽样可提前发现恢复，恢复执行沿用同一抽样决策。
6. 默认每分片最多 4 个隔离核心并行，批次 16 条。每个核心同时仅绑定一个节点，重载前后关闭旧连接、验证 CHECK 绑定；DNS 结果固定到原入口主机而保留 TLS SNI。控制 HTTP 连接复用，防止高频新连接耗尽临时端口。每处理最多 250 节点轮换进程；所有控制器/代理只绑定 loopback，临时目录 0700、配置 0600，结束时清理。
7. 预约尝试与结果批量提交，等待长检查时续租。进程中断只重做未提交批次；已提交 DONE 项保留。中途的诊断不发布 current status；全部分片完成后原子发布。环境失败保留原可用状态，直到恢复完成或原观测自然过期。

`CHECK_FORCE_FULL=true` 绕过 TCP 门控及冷却，针对尚未完成的任务；无法绕过不存在的 DNS 或 Runner 缺失的 IPv6 路由。全 IPv6 入口且本机无路由时记录 SKIPPED/UNKNOWN，不把本机能力不足记为节点 DOWN；Hysteria2 同样检查本机路由，但不发送 UDP 探测包。它不会修改已经完成的每日快照或预约同日第二次检测。永久关闭优化可配置 `MIHOMO_REUSE=false`、`CHECK_CONCURRENCY=1`、`CHECK_BATCH_SIZE=1`、`PRECHECK_GATE_ENABLED=false`、`FAILURE_COOLDOWN_ENABLED=false`。

默认缓存：DNS 上限 300 秒、DNS 负缓存 15 秒、TCP 成功 60 秒、TCP 失败 15 秒。缓存仅在单次分片执行中共享；不会跨不同 Runner/不同任务共享失败结论。连续失败和复查时间保存在数据库。配置项见 `.env.example`，每日工作流读取同名 Repository Variables；不得把密钥或节点配置放入 Variables。

用量页新增完整验证/抽样、入口门控/冷却、DNS 逻辑解析/命中、TCP 预检/套接字尝试/命中、核心启动/重载计数。DNS 次数是应用级 `resolve_name` 次数，底层 A/AAAA 的实际网络包数可能更多。聚合事件按执行 owner 保存累计快照；进程强杀前尚未提交的数字可能缺失，不伪造精确账单。

升级保持原 AES/HMAC 密钥不变，先 `uv run alembic upgrade head` 到 `0009_plaintext_lifetime`，再更新 Worker/Pages/Actions。0006 新增注释、规则及版本、Runner 汇总四表和安全查询函数；0007 新增复查状态、数字指标及入口/出口/主机/标签索引。0008 新增导出专用轻量投影，普通 API 保持原字段。旧数据仍保留，旧观测无可比较测点，等待新任务积累样本后才参与等级。部署及公网验收边界见 [STATUS.md](STATUS.md)。

新增首次收录、已收录天数和累计日可用率，以及当前明文存储策略见 [DATA_STORAGE_AND_LIFETIME.md](DATA_STORAGE_AND_LIFETIME.md)。
