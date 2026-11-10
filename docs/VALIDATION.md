# 本地验证记录

日期：2026-11-09。下列基础回归使用人工合成节点和订阅 fixture。之后新增六份用户授权订阅的真实本地检测，结果单独记录在 [LIVE_SUBSCRIPTIONS.md](LIVE_SUBSCRIPTIONS.md)；五个 Sub-Store API 的抓取、展开及入库记录见 [SUBSTORE.md](SUBSTORE.md)。不混用合成验证、导入和公网可用性结果。

## 本轮异步订阅与归档

最新完整回归 **277 Python、30 Worker、3 Echo，共 310 项**通过；下文较早的测试数属于历史记录。真实 PostgreSQL 执行至 `0011_scan_archives`，模型/默认值一致、旧 token 迁移、备份恢复、并发预算、租约恢复、两页快照及输入变化防覆盖通过。归档测试验证活动任务保留旧成功项、过期明细删除、摘要与日期水位、旧批次不能重跑、日统计北京时间保留边界及累计计数不回退。

实际 Worker handler → PG → Python 构建 → 下载的 100/1000/5000 节点五格式测试通过，原始安全数据见 [async-subscriptions.json](benchmarks/2026-11-09-async-subscriptions.json)。下载固定 3 次 SQL，包含可选用量；生产入口不含节点转换。5,000 节点大 JSON 报告约 4.75 MB，本地 API Node CPU 仍较高，需实际 Cloudflare 验证或收窄导出；本地墙钟时间不等于 Free CPU 配额。

浏览器使用临时 PG 和六个合成节点，验证 Top 2 JSON 的排队/生成/下载、编辑 Top 1 后同一地址更新、版本弹窗、Escape 关闭和 390px 视口；未操作真实节点。另以实际本地 Wrangler Worker → Hyperdrive → 独立 PostgreSQL 测试库验证 readiness、成品下载、ETag 304 及错误 token 404。19 种真实 loopback 握手重新通过，100 节点本地全链路全部 UP、0 重试且重放幂等，安全记录见 [async-pipeline.json](benchmarks/2026-11-09-async-pipeline.json)。

## 本次查询、执行与参考分级回归

- 全量 Python 257、Worker 28、Echo 3 项通过，共 288 项。真实 PostgreSQL 迁移升降级、0009 模型 drift、并发迁移及真实加密备份恢复通过。JS/Ruff/格式、三个 TypeScript 工程、Pages 静态/Functions 构建、API/Echo Wrangler dry-run 及全部工作流 actionlint 通过。
- Python 与 Worker 在同一 PostgreSQL 上保存/读取规则、版本冲突、标签、加密依据和五格式导出通过；CLI 子进程实际执行规则 apply、annotate、组合筛选/多排序/分页和 Top N 导出。非法字段、排序注入、数值/时间边界、空页、命名转义大括号有回归覆盖。
- Runner 统计按测点和窗口分组，失败后成功复测只记最终结果；PREFLIGHT/SKIPPED/环境错误/未完成批次不进入完整统计。已测过期样本移除、探针变化、空样本、资料不足、过期资料、不同运营商、人工声明不改变真实线路类型。
- DNS/TCP single-flight 并发计数、TTL、NXDOMAIN/NODATA SOA 负缓存、环境错误不缓存、所有地址均失败、IPv6 成功/本机无路由、QUIC 绕过 TCP、确定性抽样与强制完整检查有针对性测试。连续失败退避、跳过不增长计数/不延期、测点变化清零和成功恢复有数据库验证。
- 默认 4 并发/12 条测试批次中，每个 checker 独占核心、线程实际并行，24 节点的两轮验证产生 48 条尝试并完整发布。两种真实子进程强杀场景覆盖串行及 4 并发/4 条提交批次：已提交结果保留，只恢复未提交项，无重复发布。
- 19 种协议/传输/SS 方法真实 loopback 握手继续通过；同名节点错误认证不能沿用旧连接，恢复正确认证、固定 DNS 结果、保持进程 PID 均通过。压力测试曾发现频繁创建核心控制连接耗尽本机临时端口；改为持久连接池后重新完成 100/1000/5000 全链路。
- 浏览器通过实际 FastAPI 本地适配层和真实 PostgreSQL（无路由 mock）验证新版共享 Pages 静态界面：规则保存产生版本历史并从 P2 更新到 P1；Hysteria2 + P1 返回唯一节点；人工 IEPL 保持真实类型未知，依据需显式点击；资料年龄、启用状态过滤、Top 2 导出、Escape 焦点恢复及异步按钮焦点通过。收尾发现并修复移动端侧栏隐藏退出按钮的问题；390px 实际退出会清空页面会话并返回登录，页面无全局横向溢出；1280px 桌面与移动截图存于忽略目录 `output/playwright/optimization-*`，控制台无错误/警告。Worker 后端契约由跨端数据库测试验证；完整 Pages 服务绑定本地证据保留在下节历史记录。

## 本次上线前追加复核

导出分页快照、字节上限、使用量写入失败隔离、源配置密钥校验、租约续期、结果实际完成时间、备份尺寸边界和 IPv6 本机路由回归均通过。完整问题与证据见 [RELEASE_REVIEW.md](RELEASE_REVIEW.md)。

新增 Worker 合成导出规模结果见 [worker-export-review.json](benchmarks/2026-11-09-worker-export-review.json)，它使用实际 handler 和 PostgreSQL，但在 Node 中运行，不是 Cloudflare CPU/内存配额证明。当前免费平台建议及未实施的服务器适配见 [ARCHITECTURE_REVIEW.md](ARCHITECTURE_REVIEW.md)。

## 本次本地规模结果

相同固定版本的 Mihomo、PostgreSQL 17、macOS arm64。仅合成 VLESS/TLS + loopback HTTPS nonce，小响应、不测下载速度。计时包含真实协议连接；出口/地区为人工 fixture，不能解释为公网或大陆结果。

| 节点数 / 模式 | 完整链路（秒） | 检测墙钟（秒） | 核心启动 / 重载 | 全流程数据库往返 | 发布 UP |
| --- | ---: | ---: | ---: | ---: | ---: |
| 100，串行且每节点新核心对照 | 10.764 | 10.319 | 100 / 0 | 1260 | 100 |
| 100，有界并发/复用 | 0.986 | 0.560 | 4 / 96 | 237 | 100 |
| 1000，有界并发/复用 | 5.076 | 2.690 | 16 / 984 | 934 | 1000 |
| 5000，有界并发/复用 | 24.305 | 13.185 | 80 / 4920 | 4126 | 5000 |

优化模式仍对每个节点做完整代理 HTTPS；本组没有失败入口或冷却跳过，全部无重试、超时或环境失败。4 个并行分片、每片最多 4 核心；同入口每片一次 TCP 预检，5000 节点实际 20 次 TCP / 4980 次命中。包含五种导出和重放验证；对照模式也使用共享入口缓存，主要比较串行/新进程与有界并发/进程复用。安全原始数据：[optimized-pipeline.json](benchmarks/2026-11-09-optimized-pipeline.json)。

另以 15,000 / 50,000 条独立合成资产测试 SQL 分页（每种三次，返回 50 条）：本组为 90% VLESS / 10% Trojan，入口每五节点共享；地区/ASN 为固定合成值，未生成完整观测汇总，因此等级查询选择 U。该口径只验证查询规模，不代替不同真实分布/复杂规则的压测。

| 资产量 | 普通分页（ms） | 协议筛选（ms） | 地区/ASN/耗时（ms） | 理论等级筛选（ms） |
| --- | ---: | ---: | ---: | ---: |
| 15,000 | 17.69–25.50 | 11.04–11.79 | 12.68–15.65 | 192.24–197.53 |
| 50,000 | 38.99–44.68 | 19.29–20.51 | 23.71–25.83 | 629.73–666.56 |

分页先物化有序 ID，参考函数只投影实际需要的字段；避免在分页前计算全部名字、关系计数和 DTO。查询计划证明类型化 SQL 函数可内联且协议条件可下推索引；返回数据大小受页长约束。复杂等级筛选仍需评估候选，不保证所有组合都等同普通分页。原始计时和计划：[catalog-pages.json](benchmarks/2026-11-09-catalog-pages.json)。

这些是本机特定负载的测量；不推断 GitHub Actions/Neon RTT、长超时失效比例、免费额度或大陆体验。复现：`uv run python scripts/benchmark_pipeline.py --sizes 100 1000 5000`、`--sizes 100 --baseline`、`uv run python scripts/benchmark_catalog.py`；仅使用私下设置的测试数据库与临时 schema。

## 已验证

- Python：243 项测试通过。涵盖解析/去重/加密、真实 PostgreSQL 迁移、事务回滚、跨来源并发、分片租约/恢复、复测与环境错误、批次发布、实时导出筛选、鉴权和 GeoIP；新增用量聚合、进程强杀恢复、并发迁移、真实数据库备份恢复、逐 IP GeoIP 记录、Loon/Surge/QX 兼容，以及 Sub-Store 聚合导入与安全边界测试。
- Worker 与部署检查：24 项 Node 测试通过。其中 14 项验证真实 PostgreSQL 上 Worker → Python Source 解密和导入、Python → Worker 观测读取、五种导出、实时停用排除、撤销、命名持久化以及 Python 解密 Worker 生成的产物，用量聚合与 Python 结果逐项一致；另 4 项验证 JSONC 部署配置、占位符、非法结构和安全错误输出，2 项验证原生格式附加字段不覆盖认证、不被静默移除，1 项验证 HTTP Sub-Store URL 经 Worker 加密、Python 聚合导入和 Worker 摘要读取；另新增 2 项参考规则/查询参数单测和 1 项规则/资料/筛选/导出的跨端回归。
- Echo：3 项测试、TypeScript 类型检查和 Wrangler dry-run 构建通过。不接收任意转发 URL，不缓存或记录调用者 IP。
- 浏览器：桌面与 390px 移动视口检查通过，登录、来源创建、调度缺失提示、批次类型展示和表格滚动可用；移动视口 document.scrollWidth=390，表格在自身 980px 区域滚动，没有页面级横向溢出。
- Pages：TypeScript 类型检查、静态打包和 Functions 构建通过。Wrangler 本地 Pages → 服务绑定 → Worker → Hyperdrive 本地代理 → PostgreSQL 实际请求成功，本次以两次合成导入验证 1 个空 DAILY 与 2 个 SUPPLEMENTAL，2 个节点可用；界面显示正确的批次类型。
- Mihomo v1.19.33：下载资产摘要校验通过；实际启动 VLESS TCP/TLS、WS/TLS、gRPC/TLS、TCP/Reality 和 VMess WS/TLS 合成配置，控制器验证成功，随后关闭并清理临时配置。另以本地协议服务端和 HTTPS Echo 完成六协议真实握手及 SS 方法回归；新增授权公网节点验证见独立报告。
- Ruff、Python 格式、uv 锁文件、Compose 配置检查通过；Docker 本地调试镜像构建通过。

Python 测试当前有一条依赖层的 Starlette/httpx 弃用提示，未影响测试结果。运行时无该提示。

## 用量与恢复补充回归

- `0005_usage_observability` 升降级及模型 drift 检查通过；两个独立 Alembic 进程同时升级同一空 schema 均成功，最终为 15 张业务表和一张版本表。
- 真实子进程在提交第一个结果、处理第二项时被强杀；租约失效后只重测两个未完成项，最终三个节点发布成功，无重复结果。强杀前无 current status 发布，原执行统计为 INTERRUPTED。
- 检测重试、Echo 预检/失败/字节数、合法订阅下载计数、1001 条 Action/数据库采样的汇总不受显示上限截断。拒绝未知指标字段及负数，统计不含配置、token 或任意 job 名称。
- Actions 元数据仅以受控响应测试验证信任判断与幂等；未使用真实账户调用 GitHub API。Linux 网卡差值、私有文件权限、接口缺失/更换/重置和非法采样文件有单元测试；本机 macOS 不冒充 Linux Runner 的实际公网流量测量。
- 部署预检改用 JSONC parser，接受 Wrangler 配置中的注释与尾逗号；仍拒绝全零 Hyperdrive ID、空仓库和非法配置，错误不回显配置内容或原始异常。新增依赖仅用于本地部署检查，Worker dry-run 大小保持 465.38 KiB；npm 安装审计报告 0 漏洞。
- Ruff、JS 语法、三个 TypeScript 项目类型检查、Pages 静态构建和全部工作流 actionlint 通过。新增用量、来源/节点详情与分片时间已完成浏览器回归；见下节。

完整验收缺口见 [STATUS.md](STATUS.md)，云端实际成本、流量与授权公网节点验收仍未完成。

## 新增界面与备份验收

- 浏览器实际访问 Pages → 服务绑定 → Worker → Hyperdrive 本地代理 → PostgreSQL。使用独立临时数据库中的七个合成节点；不是浏览器路由 mock。1200px 桌面、390px 移动视口检查用量页、7 天范围提交、容量/分钟/计数展示、来源 hash/错误摘要、节点入口/出口/GeoIP/来源、分片起止时间。
- QUIC 筛选实际返回唯一 Hysteria2 节点。来源与节点弹窗支持 Escape；嵌套进入来源后关闭，焦点回到原始节点详情按钮。修复移动用量指标四列拥挤和关闭按钮换行；移动 document.scrollWidth=390，表格在自身容器滚动。控制台无错误或警告。
- 截图在忽略目录 `output/playwright/`：usage-mobile、usage-desktop、source-detail-mobile、node-detail-mobile、scan-detail-desktop。UI 观测为合成数据；没有据此证明实际公网节点可用。
- 修复 pg_restore 未指定数据库导致只输出 SQL 的缺陷，恢复命令显式传递数据库名，并使用单事务。实际 pg_dump → AES-GCM → 独立空库 pg_restore → 解密资产与检查迁移版本成功；修改目标节点启用状态后重复恢复，状态恢复为备份值。CI 使用 PostgreSQL 服务容器内的真实工具执行此测试。
- GeoIP 逐解析 IP 保留地区、城市、ASN、组织、查询时间和数据库版本；本地 lookup 结果与 Echo 优先字段分开存放。City 库 miss 不再阻断 ASN 查询，缓存测试和逐 IP 观测测试通过。未使用真实 MMDB 许可文件冒充验证。

## 六协议扩展回归

- URI、Clash YAML、sing-box JSON 中的六协议规范化与跨格式去重通过；SS 旧 Base64/SIP002/2022、密码特殊字符、IPv6、插件、AnyTLS 会话设置、Hysteria2 userpass/混淆/端口范围和带宽单位有针对性测试。
- Worker 与 Python 的原生配置和 sing-box 输出逐项比对，URI 由 Python 重新解析验证身份；无法表达的会话/带宽选项会拒绝 URI 导出。
- Worker 保存混合来源 → Python 导入并发布六协议状态 → Worker 生成五种订阅/报告的真实数据库链路通过；JSON/CSV 不输出密码或 UUID。
- 0003 → 0004 升级后原 VLESS 的 Node UUID、short_id、指纹和密文不变；迁移模型无 drift。
- sing-box TLS 未启用不会被默默改为启用；Hysteria2 物理 TCP 状态为 NOT_APPLICABLE，UP 仍由代理 HTTPS 请求确定。
- `scripts/smoke_protocols.py` 使用固定 Mihomo、临时本地协议服务端与 HTTPS nonce 回显实际完成握手；服务端、目标与凭据均为合成数据，所有连接仅在 loopback。所有允许的 SS 方法（包括三种 2022）通过。该脚本已接入 CI，不访问生产 Secrets。
- 补充 VLESS TCP / Reality / xtls-rprx-vision 真实握手与 HTTPS nonce 验证；临时 X25519 密钥及 TLS 回落目标均只在 loopback。共 19 个协议/传输/加密方法用例通过。

## 此前流程闭环回归

- 空 DAILY 完成后仍能创建同日 SUPPLEMENTAL；每日完成后新导入仅补测新节点，原快照不变，统计不重复计数。
- PostgreSQL 并发创建补测仅生成一个批次；旧环境失败批次与新节点一起规划，CLI worker-batch/finalize-batch 实际执行并发布。
- Worker 新增/修改来源自动提交完整流程，调度网络异常保留已保存来源及 pending 请求；不在响应中输出原始异常。
- 手动 sync 请求优先于同步周期；抓取时发生并发新请求则 revision 冲突，保留新请求并阻止旧结果覆盖。
- 既有 0002 数据库升级到 0003 后资产 ID、完成批次与订阅结果不变。
- GeoIP 密文包往返、权限、篡改拒绝和非法归档路径拒绝；readiness/doctor 的数据库版本、密钥与环境错误分离检查通过。
- actionlint v1.7.12 检查全部工作流通过；部署脚本实测拒绝占位 Hyperdrive ID 和空仓库。

## 合成导入规模

Python 3.12.11、PostgreSQL 17.6，本机 Docker。每次使用随机 schema，结束后删除。

| 资产数 | 首次导入秒 | 数据库往返 | 内容不变秒 | 表与索引字节 |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 0.042 | 9 | 0.014 | 606208 |
| 1000 | 0.282 | 18 | 0.035 | 2293760 |
| 5000 | 1.239 | 66 | 0.112 | 9592832 |

这只测量资产解析、加密、去重与入库；不测量 Mihomo 网络耗时、Runner 冷启动、远程数据库延迟或云端费用。复现命令：`TEST_DATABASE_URL=... uv run python scripts/benchmark.py`；凭证应来自私下环境设置，实际不要把连接密码输入命令历史。

## 优化前的完整本地检测规模（历史基线）

Python 3.12.11、Mihomo v1.19.33 darwin arm64、PostgreSQL 17.6 Docker，开发机本地测量。每种规模生成不同合成 UUID，实际 VLESS/TLS 服务端、代理客户端和 HTTPS nonce 回显均在 loopback；出口地区/IP 为明确的 fixture 值。并行上限四个分片，每次使用独立临时 schema 并清理。

| 节点 | 分片 | 导入至五种导出秒 | 分片检测墙钟秒 | 单次完整检测均值 ms | 尝试 / 复测 | 最终 UP | 峰值池连接 | 发布后表/索引字节 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 1 | 10.759 | 10.383 | 84.85 | 100 / 0 | 100 | 1 | 933888 |
| 1000 | 4 | 28.081 | 25.719 | 77.28 | 1000 / 0 | 1000 | 4 | 2981888 |
| 5000 | 20 | 132.719 | 121.722 | 76.24 | 5002 / 2 | 5000 | 4 | 11444224 |

三种规模的阶段超时率与本地分片执行环境失败率均为 0。5000 节点出现两次 LOCAL_HTTPS_FAILED，正常复测后成功，未隐去失败尝试。重新执行已完成分片和 finalizer 后结果数不变，逐节点每日计数正确；五种导出均包含完整数量。5000 节点五种导出后表/索引合计 17776640 字节，记录 90500 次数据库往返、5024 次 Echo 请求和 497178 字节响应载荷。

这测量完整本地真实协议链路，但不是 GitHub Runner / Neon / Cloudflare 压测。共享开发机背景负载、loopback、无公网 DNS/MMDB、同区域数据库均影响数据；不推断云端固定耗时或费用。Actions 分钟和公网流量未测量，原始报告相应字段为 null。复现脚本 `scripts/benchmark_pipeline.py`，安全原始数据见 [benchmarks/2026-11-09-loopback.json](benchmarks/2026-11-09-loopback.json)，口径见 [COSTS.md](COSTS.md)。

## 仍需生产验证

1. 50–100 个用户授权节点上的 TLS/Reality/WS/gRPC 握手与指定代理出口归属。
2. GitHub Runner 出口是否被服务商限制，真实超时分布和每日整体耗时。
3. 部署的 Echo 实际 metadata，Neon TLS/连接池和禁用 Hyperdrive 查询缓存。
4. Cloudflare Pages/Worker、GitHub 调度、MaxMind 许可下载与周期更新。
5. 账户额度、实际分钟数、Worker CPU、流量、数据库增长和收费。
6. 使用生产独立目标库演练备份与私下密钥恢复；本地真实 pg_dump/pg_restore 已通过。

代码、配置和验证工具已提供；这些生产结果没有用 mock 或本地测试冒充。

本轮新增已收录天数和累计日可用率、筛选/排序/报告，并按用户要求改为数据库明文存储；正常运行不需要 AES。迁移 head 为 `0009_plaintext_lifetime`，旧密文转换和累计统计边界见 [DATA_STORAGE_AND_LIFETIME.md](DATA_STORAGE_AND_LIFETIME.md)。本页较早的加密实现记录属于历史验证。

本轮明文版本补充验证：19 种真实 loopback 握手通过；100 节点完整流程全部 UP，0 重试、重放幂等；5,000 节点的五格式 Worker 创建并下载在本地 Node + PostgreSQL 中为 0.52–0.94 秒，仍不是 Cloudflare 配额证明。安全记录见 [plaintext-pipeline.json](benchmarks/2026-11-09-plaintext-pipeline.json) 和 [plaintext-exports.json](benchmarks/2026-11-09-plaintext-exports.json)。浏览器实际验证累计条件筛选、详情、Top 2 JSON 下载和 390px 无全局溢出/退出。

完整对话复核再次通过 257 + 28 + 3 项测试，并去掉导出元数据操作中的无用成品读取。测试通过不代表 Actions 预生成或长期扫描快照归档已经实现；当前未完成项见 [CONVERSATION_COMPLETENESS_REVIEW.md](CONVERSATION_COMPLETENESS_REVIEW.md)。
