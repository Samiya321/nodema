# 云端部署记录

初次部署于 2026-11-11（北京时间）。2026-11-18 数据库迁到用户指定云主机。生产仍使用 Pages、Worker 和标准 GitHub 托管 Runner，未开通新的付费服务。

| 服务 | 地址 / 状态 |
| --- | --- |
| Dashboard | https://nodema-dashboard.pages.dev |
| API | https://nodema-api.simb.workers.dev；管理接口需要管理员鉴权 |
| Echo | https://nodema-echo.simb.workers.dev；仅返回调用者的观测信息 |
| 源码 | https://github.com/Samiya321/nodema |
| 数据库 | 自建 PostgreSQL 17.12，用户指定云主机，目录 `/root/nodema-postgres`；当前 schema `0028_node_classification`。旧 Neon 项目已删除 |
| API 数据库权限 | 独立角色，授予业务 DML；数据库迁移使用单独的 owner 连接 |
| Hyperdrive | 经 Workers VPC 和 Cloudflare Tunnel 连接本机数据库；禁用查询缓存，源站连接数限制 5 |

管理员密钥、数据库连接、HMAC/AES 密钥和 GitHub 调度 token 保存在本地 `private/` 以及对应平台 Secrets 中，不在本页或 Git 仓库公开。

## 2026-11-28 第三十次发布：Dashboard 界面与交互优化

- 本次仅发布 Pages，部署 ID `ddb0d42f-fd42-4790-8f6a-f7e135cecaf3`，源码 `c120925`。API Worker 仍为 `97dfbdb7-fa2f-44c7-979e-918a30e31504`，schema 仍为 `0028_node_classification`。[Pages 部署](https://ddb0d42f.nodema-dashboard.pages.dev) · [main CI](https://github.com/Samiya321/nodema/actions/runs/46081562340)
- 在不新增依赖、保留既有 API 契约与严格 CSP 的前提下，重构总览（KPI 胶囊、6 格质量网格、5 格资产卡、中文落地标签）、节点列表（占比磁贴、统一控制条、单行元数据 + 语义异常标记、7 天可用率着色）、节点详情（4 指标 Hero 条与折叠摘要）、运维接入测量（CSSOM 每日柱状图）及导出页统计条，统一 `SearchField`（`/` 聚焦、回车提交、一键清空）与弹窗滚动锁，新增路由级 `PageErrorBoundary`，并修复 390/320 px 横向溢出与 7 日徽标裁切。
- `main` CI（46081562340）全绿：Python/Worker/Echo 回归、12 项前端 Vitest、真实回环握手、100 节点合成流水线及 Pages/Functions 构建全部通过。生产 `https://nodema-dashboard.pages.dev` 全部 5 个静态资源（`/`, `assets/favicon.svg`, `assets/index-DGH_bX9u.css`, `assets/index-CpEcCgSO.js`, `assets/qrcode-B5qZJ9Yy.js`）返回 200 且 SHA-256 与构建产物逐字节一致；严格 CSP 与 `Cache-Control: no-store` 生效；`/api/health` 200，匿名 `/api/session` 与 `/api/readiness` 401，认证 `/api/readiness` 返回 `ready=true`（database/schema/dispatch 全真）；真实 Chrome 加载线上首页零 CSP/脚本报错。

## 2026-11-28 第二十九次发布：Dashboard 前端重构

- 本次仅发布 Pages，部署 ID `e6d85d6f-80ee-49d3-83b0-2fd07350cd48`，源码 `41c443c`（测试日期锚定修复 `d0b0b40`）。API Worker 仍为 `97dfbdb7-fa2f-44c7-979e-918a30e31504`，schema 仍为 `0028_node_classification`。[Pages 部署](https://e6d85d6f.nodema-dashboard.pages.dev) · [main CI](https://github.com/Samiya321/nodema/actions/runs/46070362655)
- 将原 `app/web/` 原生 DOM 前端完整重构为 `web/dashboard/src/`（React 19 + TypeScript + Vite + 模块化 CSS 设计系统），保留严格 CSP、无内联样式/脚本、Pages Functions 服务绑定和全部既有 API 路由契约。
- `main` CI（46070362655）全绿：481 项 Python、Worker/Echo 测试、10 项前端 Vitest、真实回环握手、100 节点合成流水线及 Pages/Functions 构建通过。生产 `https://nodema-dashboard.pages.dev` 全部 5 个静态资源（`/`, `favicon.svg`, CSS, 主 JS, 按需拆分 `qrcode` JS）返回 200 且 SHA-256 与构建产物逐字节一致；严格 CSP 与 `Cache-Control: no-store` 生效；`/api/health` 200，匿名 `/api/session` 与 `/api/readiness` 401，认证 `/api/readiness` 返回 `ready=true`（database/schema/dispatch 全真）；真实 Chrome 加载线上首页零 CSP/脚本报错。

## 2026-11-25 第二十八次发布：节点归属与机场资格

- 运行提交 `8c49141`，schema `0028_node_classification`，API Worker `97dfbdb7-fa2f-44c7-979e-918a30e31504`，Pages `887043d6-8009-4b26-a5f5-929453513258`。[Pages 部署](https://887043d6.nodema-dashboard.pages.dev) · [main CI](https://github.com/Samiya321/nodema/actions/runs/45601816874)
- 新鲜[加密备份](https://github.com/Samiya321/nodema/actions/runs/45600255297)恢复至独立 PostgreSQL 17，通过 `0027 → 0028 → 0027 → 0028`。往返时 75,379 个节点、1,514 个来源、84,573 条来源关联和 196,139 条检测结果计数一致。两个任务专用隔离库已移除。
- 481 项 Python 和 41 项 Worker 检查通过。浏览器验证列表标签、历史机场资格、人工确认、撤销、手机布局和键盘操作。生产静态资源散列、health、匿名 401、认证 readiness、列表与详情已验证。人工写入与已发布订阅失效用合成数据验证。
- 生产实测机场候选 55,314 → 52,858，自建候选 16,867。上线时人工确认记录 0 条，正在提供下载的订阅 0 个。

## 2026-11-25 第二十七次发布：节点浏览和扫码

- Pages `df5caeaf-c6bb-456c-b607-5b22a9887503`，源码 `ca677b4`。本次发布 Pages，API Worker 版本 `d9b61bf4-3dc9-4eb1-85f3-efbcfeb5c974`，schema `0027_node_observations`。[Pages 部署](https://df5caeaf.nodema-dashboard.pages.dev) · [main CI](https://github.com/Samiya321/nodema/actions/runs/45596197810)
- 本地通过 Dashboard 类型检查、静态构建、JavaScript 语法、Pages Functions 构建和桌面 / 手机合成浏览器验证。带筛选和分页的普通列表、已展开的国家分组在详情返回后都直接恢复，额外节点列表请求为 0。显式刷新与节点写入失效路径已验证。二维码使用合成凭据验证生成、关闭、重试及键盘焦点。
- 生产 8 个修改资源的 SHA-256 与构建一致，health 200，匿名会话和分享端点 401，认证 readiness 为 true，认证精简列表返回 200。单次 1 行列表的首字节约 13.85 秒，首次查询仍有上游等待。真实节点分享 URI 未用于验收。

## 2026-11-25 第二十六次发布：Dashboard 侧栏

- Pages `2b2c62fe-8036-4fe7-85b2-3adfb632e470`，源码 `8472f72`。本次只发布 Pages。API Worker 仍为 `d9b61bf4-3dc9-4eb1-85f3-efbcfeb5c974`，schema `0027_node_observations`。[Pages 部署](https://2b2c62fe.nodema-dashboard.pages.dev) · [main CI](https://github.com/Samiya321/nodema/actions/runs/45589047320)
- JavaScript 语法、Pages 和 Functions 构建通过。Playwright 使用合成数据验证桌面收起和恢复、刷新记忆、键盘焦点、320 / 390 px 手机导航和「导出」标题。生产入口和三个变更静态资源的 SHA-256 与本地构建一致，health 200、匿名会话 401、认证 readiness 为 true。

## 2026-11-25 第二十五次发布：Dashboard 交互提速

- 运行提交 `670c1a7`，schema `0027_node_observations`。Worker `d9b61bf4-3dc9-4eb1-85f3-efbcfeb5c974`，Pages `79cfaa12-d755-4a45-a910-6ffe73d22461`。[Pages 部署](https://79cfaa12.nodema-dashboard.pages.dev) · [main CI](https://github.com/Samiya321/nodema/actions/runs/45478708754)
- 新增精简来源目录和顶部状态视图，传统 API 仍可读取。导航与顶部状态取数解耦，当前会话的列表短时复用。与同一份隔离数据的原响应比，来源体积减少约 59%，服务端处理的中位数由 436 降至 115 毫秒。
- 本地 42 项 Python 定向用例、40 项 Worker 用例、Worker/Pages 构建通过；合成浏览器确认翻页和返回复用数据、保存后重新读取。生产通过 Worker 健康、匿名 401、认证 readiness、新版来源和顶部接口、节点分页及静态模块散列验证。生产首次读取节点和来源仍有首字节等待波动。复测时间与限制见 [实现状态](STATUS.md#2026-11-25-dashboard-交互提速)。

## 2026-11-25 第二十四次发布：节点证据、独立日检和登录会话

- 运行提交 `0c60995`，schema `0027_node_observations`。Worker 版本 `37a0300c-1031-4f9e-b0b9-3268f2969666`，Pages 部署 `bf19f7e2-782f-49cb-9802-b07b6a3cbd68`。[Pages 部署](https://bf19f7e2.nodema-dashboard.pages.dev) · [发布分支 CI](https://github.com/Samiya321/nodema/actions/runs/45473947379) · [main CI](https://github.com/Samiya321/nodema/actions/runs/45475269590)
- 上线前 [加密备份](https://github.com/Samiya321/nodema/actions/runs/45471903099) 已恢复至独立 PostgreSQL 17。往返验证 `0026 → 0027 → 0026 → 0027`，节点、来源、检测明细和来源关联的数量一致。合成回归 479 项 Python、40 项 Worker、3 项 Echo，附六协议回环、30 节点共享运行时和 100 节点流水线。初次本机批量 UDP 回环出现一次失败，独立重跑和最终发布分支 CI 通过。
- 生产烟测通过 Pages 与 Worker 健康、匿名 401、Cookie 登录与清除、跨源拒绝、Bearer、巡检凭据权限、数据库 readiness、节点分页、分阶段用量和 Pages 模块散列。生产会话签发此次实测 1.08 秒。
- [生产等级重算](https://github.com/Samiya321/nodema/actions/runs/45475385939) 使用已存观测。三网 1,592 个当前可用节点中 1,256 个有接入参考或实测，116 个通过端点确认。生产只读抽查覆盖 42 个多地址节点，端点确认或 S/A/D 归属数为 0。日检、同步和归档的端到端耗时以各自后续正常定时运行核验。
- 恢复前一应用版本应核对 schema 相容性。保留迁移后已写入的信息，先诊断并使用兼容版本修复；隔离迁移往返仅为恢复演练证据。最新备份与版本标识在本机部署记录中。

## 2026-11-18 第二十三次发布：长期运维和总览

- 运行代码 `2e183a8`，schema `0026_maintenance`，Worker `d199753d-668c-44f2-9617-7227040d9e94`，Pages `fbede569-67c0-45e1-84f6-2a23a483e417`。认证 readiness 为真，巡检凭据仅能访问只读 heartbeat；静态 JS/CSS 与发布源码一致。[分支 CI](https://github.com/Samiya321/nodema/actions/runs/44262864674) · [main CI](https://github.com/Samiya321/nodema/actions/runs/44278542254) 通过，覆盖 471 个 Python、37 个 Worker、3 个 Echo 测试与 100 节点合成流水线。
- [发布前备份](https://github.com/Samiya321/nodema/actions/runs/44260766354) 已在隔离 PostgreSQL 恢复，并按最新脚本升级、降级、再升级。三次均为 56,597 个节点、1,076 个来源、61,236 条节点来源关系。[上线后备份](https://github.com/Samiya321/nodema/actions/runs/44278642892) 为 54,296,995 字节，保留 7 天。[独立恢复演练](https://github.com/Samiya321/nodema/actions/runs/44279243192) 实际下载密文包，在 Runner 临时库恢复，schema、密钥检查及最低权限读取均通过。
- 生产容量采样服务首次运行成功，五分钟定时器已启用。独立巡检的补发、同批次恢复、活跃租约和异常阈值用合成状态验证。首次巡检请求的默认客户端标识收到 403，触发 [Issue 3](https://github.com/Samiya321/nodema/issues/3)。巡检修正 `1f1e7d3` 明确标识客户端，并重试限流和暂时性故障。[复验 44280203432](https://github.com/Samiya321/nodema/actions/runs/44280203432) 成功，自动关闭 Issue 并发布恢复通知。最近完整日检的容量曲线从下一轮正常日检开始积累。当前生产成品订阅为 0，已用合成方案验证订阅生成与下载规则。
- 生产浏览器验证 1440、390、320 px 的总览与状态区，全状态列表前两页各 50 行、总数 56,597。生产首屏可用节点请求为 21,859 字节、约 2.52 秒；全状态首批 50 条为 22,260 字节、一次并行验收中约 6.24 秒，第二页为 22,662 字节、约 4.12 秒。隔离生产副本对照，旧全状态首批 10,000 行为 3,352,111 字节，新首屏 50 行为 22,260 字节。按国家和 ASN 汇总改为打开对应视图时请求。均为单次观测。
- 总览把系统状态、检测动态、来源事项和资产摘要集中在首屏及后续区域。来源异常按根分组，显示预计重试；续期保留原来源 ID 和关联。单条、批量导入与 Sub-Store 物化按归一化的订阅链接去重或记录引用。详见 [生产手册](PRODUCTION_OPERATIONS.md#独立巡检) 和 [来源维护](SOURCES_AIRPORTS_NAMING.md#来源维护)。

## 2026-11-18 第二十二次发布：导航和来源溯源

- Worker 源码 `c8fa6ca`，版本 `10cc6092-5ba5-4166-b25a-44d9e4f6be41`，Pages 源码 `006324f`，部署 `320b75fe-944b-4359-b4d7-c5cd2d0d98a7`。schema `0025_dashboard_lineage`。生产健康及认证 readiness 通过，未认证 readiness 返回 401，抽查静态模块散列一致。[分支 CI 44246600027](https://github.com/Samiya321/nodema/actions/runs/44246600027) 和 [main CI 44247192862](https://github.com/Samiya321/nodema/actions/runs/44247192862) 通过，覆盖 470 个 Python、37 个 Worker、3 个 Echo 测试与 100 节点合成流水线。
- [发布前加密备份 44243519455](https://github.com/Samiya321/nodema/actions/runs/44243519455) 在独立 PostgreSQL 17 恢复并完成升级、降级、重新升级。新增一张 Sub-Store 引用表，业务表从 38 到 39。升级前后保持 56,597 个节点、123,501 条检测明细。加密包有效至北京时间 2026-12-08 13:21。
- 来源统一提供全部来源、机场订阅、Sub-Store 标签。运维将节点检测、接入测量、用量与备份集中在一个入口。旧机场、Sub-Store、检测、用量链接保留跳转及原筛选。检测详情和通知可链接，旧 Neon 流量折叠到历史。
- 生产复核同一批 161 条机场订阅，来源页与机场页的当前可用、过期通过、历史关联一致，合计 0 个当前可用关联、435 个通过但已过期关联。总览「可用机场节点」为 31，列表包含正常及较慢状态，未检测和过期分别跳转。真实样本从节点关联追到上级 Sub-Store，并从父级查看 9 个直接子来源。另外抽查一个多来源节点，2 条直接关联中有 1 条仍存在，2 条均有各自的来源路径。
- 生产浏览器复核 1440 和 390 像素的 10 个页面及标签，两轮均无页面横向溢出。320 像素下首页四个固定入口可见，键盘通过「更多」进入运维。旧机场书签保留筛选，实际节点能点进上游、从父级返回子来源，批次详情可复制链接。
- 合成浏览器走通最近成品 → 成员节点 → 直接来源 → 两级上级、原筛选预填及重新估算。生产预览按最多 3 个计算返回 3，生产导出方案为 0。上级索引中以前只计作重复的条目将在后续成功同步时逐条记录。关系口径见 [来源关系与订阅成员](SOURCES_AIRPORTS_NAMING.md#来源关系与订阅成员)。

## 2026-11-18 第二十一次发布：节点列表提速

- 代码 `4e44b75`，生产 schema `0024_node_list_reads`，Worker `db95dd39-393c-4545-83ea-004362f3a13e`，Pages `12f5b4fd-bc28-42da-8d90-63be6339520a`。生产静态模块散列与源码一致，health 200，认证 readiness 为真，未认证 401。[分支 CI 44237426789](https://github.com/Samiya321/nodema/actions/runs/44237426789) 和 [main CI 44237999699](https://github.com/Samiya321/nodema/actions/runs/44237999699) 通过，覆盖 469 个 Python、37 个 Worker、3 个 Echo 测试和 100 节点合成流水线。
- 发布前 [加密备份 44237223839](https://github.com/Samiya321/nodema/actions/runs/44237223839) 已恢复到独立 PostgreSQL 17 并演练迁移。升级前后均为 38 张表、56,597 个节点和 123,501 条检测明细。更早的独立副本也通过升级、降级、重新升级。新备份有效至北京时间 2026-12-08 12:27。
- 迁移让可用状态明确带上原 36 小时窗口的时间条件，PostgreSQL 可在连接目录前利用现有索引。总数和分页共用匹配 ID，只对所取页组装结果。页面合并 UP 和 DEGRADED 请求，由列表响应提供默认分级视角；Worker 在同一次数据库往返读取命名模板。查询超时返回可重试的 503。
- 隔离生产副本对照中，默认可用全结果两次旧 SQL 的耗时合计中位约 185 毫秒，新 SQL 约 95 毫秒。1,655 项结果、排序、去重、偏移量越界及抽查的完整投影一致。生产 HTTP 实测可用全结果 1,468 项、606,620 字节、4.68 秒。50 行取数约 2.07 秒，旧版正常状态的 50 行约 6.41 秒。两类测量的入口与环境见本机记录，生产结果为单次样本。
- 390 px Playwright 只读复验中，节点请求从两次缩为一次，最慢请求从 10.45 秒降到 5.85 秒，同时省去约 0.98 秒的串行分级设置请求。验证两页各 50 行、国家和 ASN 视图及全选 1,468 项。分组、等级分布及全选仍使用完整筛选集。5.6 万项「全部状态」首 50 行 API 为 2.38 秒，该页面仍需分段取得完整结果。实际夜间日检并发待验证。

## 2026-11-18 第二十次发布：日检恢复、分级证据和页面优化

- 发布到 main，运行代码 `fe829b3`、`b58c098`、`91bafab`，页面窄屏补丁 `2c8694a`、`c3c52cd`。API Worker 版本 `324223dd-3e45-4946-bc9d-594079117db4`，Pages deployment `0ca7f89c-c5f0-4b26-b1bc-95b0bbc0f255`，schema `0023_identity_naming`。生产静态 CSS 与源码一致，health 200，公开 readiness 401，认证 readiness 的 database/schema/dispatch 均为真。[功能 CI 44233535469](https://github.com/Samiya321/nodema/actions/runs/44233535469) 和 [最终 main CI 44235470106](https://github.com/Samiya321/nodema/actions/runs/44235470106) 通过，覆盖 468 个 Python、36 个 Worker、3 个 Echo 测试，以及隔离 PostgreSQL 恢复、合成流水线和 Pages 构建。
- 每日检测直连 Echo 可复查一次，原批次内最多追加一轮未完成分片，活跃租约继续受保护。部分成功先发布，失败等完整收尾。清理根据自己的条件执行。生产 [日检恢复 44234114270](https://github.com/Samiya321/nodema/actions/runs/44234114270) 从 **13,169/13,346** 补到 **13,346/13,346**，只派发剩余 1 个分片。恢复计划确认无需追加作业，收尾、等级重算、订阅构建和归档均成功。租约超时及重复失败路径有隔离回归。本次收尾步骤约 2 分 54 秒，期间节点列表和流水线接口出现短时 400/503，之后恢复 200。尚待下一轮正常日检验证完整并发峰值。
- 三网 D 需要明确触发的运营商对同一入口端点的重复失败证据。通用失败和既有成功时间分别展示；Hysteria2 的 TCP 接入数据不作为 UDP 不通的依据。按既有样本 [重算 44234213633](https://github.com/Samiya321/nodema/actions/runs/44234213633) 后，同一批 1,646 个分级节点的三网 D 从 1,168 降至 1,013，S/A/B 阈值不变。总览增加接入覆盖分母和 CF 规则排除数。等级字母相同但 RTT、丢包、评分等导出依赖变化也会触发订阅重建，已用隔离数据验证。生产订阅方案仍为空。
- 机场按节点去重汇总，当前可用要求节点仍出现在启用且可用的来源中、节点启用且检测成功在新鲜窗口。上线抽查合计 4,885 条历史来源关联、435 条仍存在但通过已过期、0 条当前可用。节点页机场筛选读取 4.8 KB 机场名称摘要，旧机场详情响应约 145 KB。总览首次加载只读取一次流水线状态，1.6 KB 待办摘要替代来源、机场、Sub-Store 和订阅的完整列表，落地区域与节点链接共用当前可用范围。
- 来源支持按曾成功、从未成功和部分解析筛选，可仅同步待处理来源。用量页显示最近实际备份包时间与到期时间，当前可恢复包为 [44231649933](https://github.com/Samiya321/nodema/actions/runs/44231649933)，北京时间 12 月 8 日 11:38 到期。接入工作流网络采样写入已由重算运行验证，记录 Runner 网卡收发。Playwright 经只读代理检查生产页面，320/390 px 下节点详情无横向溢出，Escape 返回触发按钮，当前导航和跳转链接可用。节点常规列表服务端分页、来源下次执行提示、协议原因汇总、非空生产订阅端到端仍待验证或实现。

## 2026-11-18 退役 Neon

按用户明确指令删除旧 Nodema Neon 项目，控制面再次读取确认项目不存在。删除前验证生产 readiness 与生产数据库入口指向自建库；[自建库加密备份 44231649933](https://github.com/Samiya321/nodema/actions/runs/44231649933) 在独立 PostgreSQL 17 完整恢复，核对 `0023_identity_naming`、38 张表、56,597 个节点和 123,153 条检测明细。删除旧用量 Secret 和项目变量，历史用量采样保留。本机下载备份已移至废纸篓。

## 2026-11-18 第十九次发布：迁移到自建 PostgreSQL

- 用户指定云主机并授权部署。PostgreSQL 17.12 和 cloudflared 在 `/root/nodema-postgres` 的独立 Compose 项目运行。数据库和连接器指标只监听回环。Cloudflare VPC 验证数据库 CA 与名称，GitHub 托管 Runner 用受限 SSH 账号连接并校验主机密钥和 PostgreSQL TLS。Worker 与迁移使用独立数据库角色。原数据库加密密钥、HMAC、管理员鉴权和调度凭据继续使用。
- [演练备份 44226425547](https://github.com/Samiya321/nodema/actions/runs/44226425547) 在隔离库完整还原。隔离 Worker 和 [GitHub Runner 演练 44228333703](https://github.com/Samiya321/nodema/actions/runs/44228333703) 验证成功，后者实际经 SSH 转发用 Docker PostgreSQL 客户端生成 AES 加密备份。
- 暂停写工作流，旧 Neon 库默认只读。恢复 [切换备份 44229140683](https://github.com/Samiya321/nodema/actions/runs/44229140683)；数据库 schema `0023_identity_naming`，逐表核对 38 张表行数，以及 4 个视图、34 个函数、11 个触发器、71 个索引、142 个约束和关键 ID 摘要。56,597 个节点、1,076 条来源、123,153 条检测明细、42,798 条当前状态和 15,559 条接入样本，订阅方案 0。未执行裁剪迁移。
- Actions/Compose `a92e037`、用量 `e790273`、连接器指标绑定 `b2e5925`；[main CI 44229386266](https://github.com/Samiya321/nodema/actions/runs/44229386266) 通过。生产保留原 Hyperdrive binding，源站改为 VPC。API version `573c2fa7-fa3c-4260-80b6-4c10f9da7cda`，Pages https://f00a9941.nodema-dashboard.pages.dev 。Pages 与 Worker 认证 readiness 返回 200，未认证返回 401，首页 health 200，用量页模块 SHA 与源码一致，旧 Neon 实时告警已移除，历史读数保留。
- 恢复原有工作流和 Worker 调度。移除用于节省 Neon 出站的暂缓备份变量。新库通过 [加密备份 44230237908](https://github.com/Samiya321/nodema/actions/runs/44230237908) 成功产出约 54 MB artifact，保留至北京时间 12 月 8 日 11:26；[用量 44230508395](https://github.com/Samiya321/nodema/actions/runs/44230508395) 在新库写入工作流账本和数据库容量采样。旧 Neon 实例保留只读，发生故障应先处理切换后产生的写入再决定回退。详见 [生产手册](PRODUCTION_OPERATIONS.md#自建-postgresql-运维)。
- 切换后首轮 [11:30 定时接入 44230924976](https://github.com/Samiya321/nodema/actions/runs/44230924976) 全步骤通过，确认 23 次测量结果写入新库。新库与 Tunnel 在抽样中约占 59 MiB 与 17 MiB，数据库容器无重启或 OOM。完整日检高峰与生产非空订阅下载仍待实际工作负载验证。

## 2026-11-17 第十八次发布：归属证据、保守命名与历史落地

- 用户在只读审核后授权直接修复；代码 `d891e26` + `b76ad80` 快进合入 main。分支 [CI 43927688684](https://github.com/Samiya321/nodema/actions/runs/43927688684) 与 main [CI 43928480592](https://github.com/Samiya321/nodema/actions/runs/43928480592) 通过：467 Python / 36 Worker / 3 Echo，包含真实协议与 UDP 回环、100 节点流水线、Worker/Pages 构建。具体规则见 [IDENTITY_NAMING.md](IDENTITY_NAMING.md)。
- 新鲜加密备份 [43926097755](https://github.com/Samiya321/nodema/actions/runs/43926097755)（约 45.3 MB，云端保留 20 天）在隔离 PG17 恢复并演练 `0022 -> 0023`；七表行数不变、名称零重复，全库 2,671 个/当前可用 166 个名称变化。改名不改变节点资产 ID、短编号、指纹或订阅 token；已改品牌所属组的序号可能变化。迁移前确认无活动扫描租约/接入测量。
- 生产于北京时间 02:25:38 完成 `0023_identity_naming`。新增出口观测时间并从实际同 IP 成功明细回填；不覆盖 GeoIP 原始值。唯一入口 IP=出口 IP 的国家差异不再渲染成跨国箭头；未知入口显示 `?`，五个已核实 ASN 别名及精确占位文本防护生效。API version `5c9c3664-61c8-4656-a171-627aa3553c70`，Pages deployment `43b793dd-c117-43c4-ad71-8665febed83d`，https://43b793dd.nodema-dashboard.pages.dev。Echo 未变；未改密钥或增加付费服务。
- 生产只读复核：health/静态模块 200、未认证 readiness 401、认证 readiness 为真；首页、CSS 与四个相关 JS 文件 SHA 与源码相同。1,391 个可用节点，同 IP 展示冲突 0、Private 品牌简称 0；932 个同 IP、166 个来源分歧提示、21 个历史落地提示；抽查完整节点保留原入口国家和出口观测时间，英国 GB 端点正常。
- 浏览器通过仅允许 GET 的本地镜像读真实生产 API，静态资源已验证与生产一致；1440px/390px 均无页面横向溢出、名称/等级列交叠。实际分歧节点详情显示原始 GeoLite 入口、各来源 ASN/国家与出口观测时间；截图脱敏后才查看，私密证据在 `private/naming-fix-20261117/`。只读镜像与专用浏览器检查结束后关闭。
- [export-build 43928935333](https://github.com/Samiya321/nodema/actions/runs/43928935333) 成功。生产订阅方案当前 0 个（活动 0、未就绪 0），未创建验收用订阅，不把零队列构建当作真实非空下载证明。检测器新来源标记和出口原子更新待下一次正常完整检测体现，已通过隔离回归；未为了此次展示修复再触发全量检测。本机临时加密备份用完移入废纸篓，隔离容器清理，云端加密 artifact 保留。

## 2026-11-16 第十六次发布：Globalping 多账户 token 轮询（无迁移）

- 代码 `81c3c01`，从 `codex/globalping-token-pool` 快进合并并推送 main。[分支 CI 43882425604](https://github.com/Samiya321/nodema/actions/runs/43882425604)、[main CI 43883188456](https://github.com/Samiya321/nodema/actions/runs/43883188456) 全部通过：447 Python、36 Worker、3 Echo，含真实 PG 备份恢复、协议回环握手和 100 节点合成流水线。本机 Pages check/build/Functions build 通过。
- 新工作流从 `GLOBALPING_TOKENS` Secret 读取多个账户 token，按账户免费剩余额度规划并轮询，兼容旧 `GLOBALPING_TOKEN`。每账户留 5 次，单次合计最多 5000，遇创建 401/403/429 跳过账户，不退回匿名、不主动用积分。用户已自行添加新 Secret 并删除旧 Secret，本次只核对名称，未读取或修改凭据。
- Pages 生产部署 `08bda24d-7340-48bc-a2ab-55ce14d68eaa`，https://08bda24d.nodema-dashboard.pages.dev，生产域名 https://nodema-dashboard.pages.dev 已确认新文案。API Worker/Echo 未重新发布；schema 仍为 `0021_udp_relay`，未迁移或改写生产设置、来源、节点。
- 只读 HTTP 验证：生产首页、模块、health 200；未认证 readiness 401，认证 readiness 200 且 database/schema/dispatch 均为真。API 直连与 Pages 代理均正常。
- 按用户发布授权手动运行现有 [entry-probe 43883212661](https://github.com/Samiya321/nodema/actions/runs/43883212661)，代码为 `81c3c01`，北京时间 22:11:54–22:22:08 成功。识别 **2 个账户，0 个不可用，0 个账户限流**；按当时免费剩余规划合计预算 608，计划 202 次测量，完成 **200 次测量 / 600 次测试**，写入 456 条样本；另有 **2 次 HTTP 400**，仅保留错误码计数，原因没有响应体证据，不推断为节点失效或 token 失效。整轮 `status=OK`、认证为真、限流 0，等级/订阅后续步骤成功。600 次完成测试超过单账户本轮上限，证明多个账户实际参与。
- 验证边界：本次证明新 Secret 能被默认分支工作流读取、2 个账户通过额度查询并实际参与测量，不能保证未来第三方探针、额度或所有测量参数永远成功。本轮未创建账号、未增加付费服务、未导入或删除来源/节点。

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


## 2026-11-15 第十五次发布：可检测节点、调度与页面打磨（无迁移）

- 代码 `6bc3a9f`（诊断）、`155047e`（转换、等级、调度）、`3a81354`（页面）、`47c129f`/`a19ffff`（测试与计时，CI [43655419472](https://github.com/Samiya321/nodema/actions/runs/43655419472) 通过）。本地隔离 PG 432 Python、36 Worker、真实 mihomo 冒烟通过。schema 仍为 `0021_udp_relay`。
- API Worker 版本 `b5363895-2f4b-4664-bfa3-19c64ad2c7a5`：Cron 增加 `17 20 * * *` 触发 `daily-check.yml`（`trigger=schedule`，仍按设置页开关与范围）；`daily-check.yml` 去掉 GitHub schedule。Pages https://73f398f5.nodema-dashboard.pages.dev。
- 仓库变量 `BACKUP_SKIP_UNTIL=2026-11-30`（跳过 11-15 那次；GitHub 定时常晚几小时，日期留了余量，12-01 恢复；变量过期即无效）。`FAILURE_COOLDOWN_BASE_HOURS` 默认 24。
- 生产只读诊断 `diagnose.yml`（run 43652259091）：7,763 个启用“不支持”节点的原因计数，见 STATUS。随后对 3,470 个原“不支持”的自建节点定向检测（run 43653257902）：自建可用 934 → 1,099，仍不支持 1,996。
- 测量基线：11-15 00:50 UTC Neon 读数 1.134 GB（此前 2.75 小时含定向检测、两次诊断、本地只读镜像逐页检查和接入测量，计数有滞后）。下一步在 20:17 UTC 定时检测开始前后各读一次（`npx neon@9.3.2 projects get green-brook-35133737`），读数稳定后再判断。
- 映射核验（`diagnose.yml` run 43656195105，只读）：XHTTP 5/179、HTTP Upgrade 2/69、证书固定 0/106（入口可达的节点中可用数），普通节点约 42%；这三项已撤回为不支持（见 STATUS）。`unsupported_protocols` 汇总当时为空（解析器版本未变，只有内容变化的来源会写入）。
- 等级重算在生产仍约 13 分钟（定向检测 23:33–23:46 UTC，此前每日/到期重算 14–15 分钟），本地计算部分已从秒级降到毫秒级，剩余在数据库；`grade refresh` 输出新增 `timings`，下一次每日检测后据此处理。
- 11-14 19:28 UTC 手动全量检测后、计数滞后的 Neon 读数从 0.49 升到 0.98 GB（同时段还有每小时接入测量和本次诊断/定向检测）；单次全量检测的准确消耗等 11-15 20:17 UTC 的 Worker 定时检测前后读数。

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


## 第十七次发布：英国视角与接入样本修复（2026-11-17）

- 代码 `6482b9a`（分支 `codex/uk-probes-production-audit` 快进 main）与 `7d82021`（新视角/规则变更及时重算）。新增 GB，保留既有绝对阈值；优先补齐探针数、不因非高峰差跳过高峰；拒测目标七天冷却；两个探针与两个小时段才证明 TCP 不通；B 的接入未知单独标识；修复名称列溢出和运行提示。聚合生产分析见 [本轮复盘](PRODUCTION_REVIEW_2026_11_17.md)。
- 生产迁移 `0021_udp_relay` → `0022_uk_probes` 已执行；未修改旧 migration 或生产密钥。新增小型拒测记录表、GB 约束/目录校验，compact 尾部追加 access_band。Worker 发布前后存在严格 readiness 检查的短暂切换窗口。
- 备份：本机直连 pg_dump 300 秒超时，未形成有效文件。改用原有 [backup 43908687462](https://github.com/Samiya321/nodema/actions/runs/43908687462)，45,282,417 bytes 加密 artifact（保留 20 天）。下载后在独立 PG17 恢复成功（本次无需删除 pg_attver），再演练 0022 升级、降级、再升级。50,396 nodes / 1,014 sources / 54,119 node_sources / 82,211 test_results / 8,268 node_grades / 9,973 entry_probe_results / 8 scan_runs 行数保持。只在隔离本地数据库恢复与测试，生产只做升级；没有恢复线上库。
- API version `ed231caa-2f15-4ce6-b380-f4d2b72cd109`（代码 6482b9a），Pages https://43cad7f1.nodema-dashboard.pages.dev（代码 7d82021），Echo 未更改。生产入口/改动静态资源 200 且 SHA256 与源码一致；health 200，未认证 readiness 401，认证 readiness=true，GB 状态/目录接口 200，compact 含 access_band。
- 本地 454 Python / 36 Worker / 3 Echo 通过；随后最终重算变更分级/计划/客户端/真实 PG 集成 29 项通过。分支 [CI 43908667084](https://github.com/Samiya321/nodema/actions/runs/43908667084) 通过。首次 main [43909771141](https://github.com/Samiya321/nodema/actions/runs/43909771141) 在既有合成批量 Reality UDP 回环报 BATCH_UDP_FAILED_B27；同 SHA 分支 CI 和本机 30 节点批量协议回环通过。功能版 [main CI 43910432706](https://github.com/Samiya321/nodema/actions/runs/43910432706) 全部通过，包含真实协议/UDP 批量回环与 100 节点合成流水线。
- 页面以仅允许 GET 的本机生产镜像核对 1440 px / 1100 px / 375 px 和深色主题；375 px 文档宽度等于视口，说明行未越过单元格，1440 px 英国选项和待补测提示可见。未重新做 20k 节点性能基准；本轮未改列表分组算法。
- 真实验证 [entry-probe 43910530143](https://github.com/Samiya321/nodema/actions/runs/43910530143)：临时将原本未设置的 PROBE_MAX_TESTS_PER_RUN 设为 120，仅用于本轮验证；测量步骤启动后已删除 Variable，恢复原默认。英国已写入真实结果，运行已成功：2 账号、58 次测量、120 次测试 / 120 条样本，0 失败 / 0 限流；GB 68 条样本覆盖 34 个网段，全部满足两个身份。等级已补齐至 9,646 条，英国 S1/A25，实际页面可见 RTT。没有修改 Globalping tokens、账号并发或免费额度策略。

- 收尾发现该轮等级写回 305.9s（计算 0.1s、读取 2.2s），`f83a0b4` 修复 nullable 字段导致 ORM 插入批次碎片化：隔离真实 PG 中混合已测/未测的 14 行由 5 个 INSERT 批次 变为 1 次且 NULL 语义保持，30 项分级定向回归与本地完整 456 项 Python 回归通过；生产耗时改善留待下一次正常重算验证，不在生产跑性能测试。仅 Actions Python 代码变化，API/Pages/Echo/schema 无需再发布。

- 批量写入最终版 [main CI 43912684700](https://github.com/Samiya321/nodema/actions/runs/43912684700) 通过：456 Python / 36 Worker / 3 Echo，含真实协议/UDP 批量回环、100 节点流水线及 Pages/Worker 构建。私密部署记录与发布后盘点已更新；临时加密下载已移废纸篓，本轮三个隔离容器均移除。
