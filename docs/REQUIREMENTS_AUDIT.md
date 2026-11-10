# 需求与证据核对

本表主要核对原规范。Actions 预生成与扫描归档的补齐及生产验收边界见 [CONVERSATION_COMPLETENESS_REVIEW.md](CONVERSATION_COMPLETENESS_REVIEW.md)；不能将本表理解为全部最新要求已交付。用户已选择数据库明文，覆盖原数据库 AES 要求。
基线为 [PROJECT_SPEC.md](../PROJECT_SPEC.md)，并按用户后续要求扩展为完整代码及六协议。这里区分代码、本地验收和生产验收，不把空白验收项标记通过。

## 最初八项交付

| 项目 | 实现与证据 |
| --- | --- |
| 需求理解、风险 | [M1_DESIGN.md](M1_DESIGN.md)、[ARCHITECTURE.md](ARCHITECTURE.md)、[DEPLOYMENT.md](DEPLOYMENT.md)；云端风险另见下表 |
| ER 关系 | ARCHITECTURE 的 22 张业务表 ER；数据库迁移和模型 drift 测试 |
| Python 结构与依赖 | `pyproject.toml`、`uv.lock`、`app/` 分层；生产 API 为 TypeScript，FastAPI 仅作本地适配 |
| Source / Node / NodeSource 与迁移 | `app/database/models.py`、`alembic/versions/0001` 至 `0011`；升降级、旧身份保留、并发迁移测试 |
| VLESS / VMess / YAML / JSON 接口 | `app/parsers/`，`parse_document` 统一入口；追加 SS/Trojan/AnyTLS/Hysteria2，保留不能映射的字段 |
| HMAC / 旧 AES-GCM | `app/security/crypto.py` 与 Worker `crypto.ts`；HMAC 去重保留，数据库已改明文；AES 仅迁移/备份等兼容用途 |
| 测试与脱敏 fixture | `tests/fixtures/` 均为合成数据；Python、Worker、Echo 测试以及两个真实本地协议脚本 |
| 本地运行与环境模板 | README、M1_GUIDE、DEPLOYMENT、`.env.example`、Compose；CLI 子进程验证 |

## 原规范逐项分组

| 规范章节 / 要求 | 代码与可复验证据 | 当前边界 |
| --- | --- | --- |
| 0、1、18：资产、来源、观测分离；每天去重检测 | 模型、AssetService、ScanService；跨来源导入、补测并发、每日预约与发布测试 | 已有本地数据库证据 |
| 0、1、5：不测速、不枚举、不猜专线 | 入口仅从明确导入的 canonical identity 解析；HTTP 仅小型 Echo；line_type 为 UNKNOWN；转换器保留用户输入带宽参数但不测量 | 不支持通用扫描或自动线路判断 |
| 2：Pages + TypeScript Worker + Neon + Python Actions | Pages Functions 服务绑定、Worker Hyperdrive、daily/source/backup workflows；本地完整 Pages → Worker → PostgreSQL 与 CLI 流程 | 生产资源、权限、TLS、调度和真实节点待验收 |
| 3：四种 Source、混合格式、增量同步、删除/失败不丢历史 | Fetcher / AssetService；hash 未变跳过、部分合并、完整对账、revision 冲突、软删除、启停测试 | 上传配置按最新要求明文保存；无需真实订阅作为 fixture |
| 3、11：SSRF、重定向、DNS 绑定、超时/大小/解压上限 | SafeBackend、DeadlineStream；私网/metadata/混合 DNS、重定向、压缩与流式边界测试 | 抓取 URL 与明确导入的节点目标是不同权限边界 |
| 4：稳定 ID、身份规范化、保留扩展、不随意补默认值 | parser、canonical_json、fingerprint version=1；跨格式/改名/不同认证/未知字段及旧数据升级测试 | 参数映射范围见 PROTOCOLS；不能等价转换时 UNSUPPORTED |
| 5.1–5.3：DNS、TCP、核心、HTTPS、清理 | HealthChecker / Mihomo；TCP 不能代替代理成功；真实 loopback 握手与 HTTPS nonce；核心临时目录和端口隔离 | 真实运营商和 Runner 出口限制待验证 |
| 5.2、5.4–5.5：入口/出口 IP、GeoIP/ASN、版本与时间 | GeoIP 缓存、每个解析 IP 的地区/城市/ASN/组织和查询时间保存在 geoip_metadata；Echo 优先、MMDB 回退；独立 City/ASN miss 测试 | MMDB 缺失时保留未知；Echo 的云端 metadata、许可下载仍待验证 |
| 5.6–5.7：线路边界、阶段耗时 | UNKNOWN、DNS/TCP/HTTPS 时长；无法可靠测量的独立握手时间不虚构 | 本地合成出口数据不冒充公网观测 |
| 6：UP/DOWN/DEGRADED/UNKNOWN/UNSUPPORTED/STALE 与环境故障 | checker、两次失败、环境预检、完整发布、有效期筛选测试 | DNS/Echo/核心/任务错误不会作为完成批次整批发布 DOWN |
| 7：快照、稳定分片、matrix、并发、幂等与恢复 | ScanItem/Result 唯一键、租约、日锁、最多四个 jobs、prepare/worker/finalize CLI；真实强杀进程只恢复未完成项 | GitHub schedule 可能延迟；保留手动触发 |
| 8：数据库、索引、历史保留、加密配置 | 22 表、迁移、约束/索引/drift 测试；cleanup 明细、统计、导出与用量 | 清理不自动删除资产；生产容量需连续观测 |
| 9：命名模板、预览、批量应用与历史 | NamingRule / NamingRevision；名称按模板和已发布观测派生，避免逐节点冗余；ID/指纹不变 | 历史记录模板变更；初始 M1 文档解释此设计选择 |
| 10：七个 Dashboard 页面、筛选、详情、扫描、导出 | app/web、Worker API；增补用量页、来源错误/hash、当前/历史关联、已发布入口、GeoIP、分片时间、QUIC 筛选；浏览器桌面/移动检查 | 没有声称浏览器合成数据能证明实际代理可用 |
| 10：五种导出与接口 | Mihomo、sing-box、URI、JSON、CSV；Actions 预生成、固定方案/版本、资格变动阻断、撤销/期限和高熵 token；Worker/Python 往返测试 | 认证配置属于敏感下载；JSON/CSV 仅元数据；不丢字段凑可用 |
| 11：密钥、日志、权限、备份 | HMAC、管理员访问控制、旧 AES 迁移兼容、默认分支、固定 Action SHA、无生产 Secrets 的 PR、loopback 控制器；真实加密 pg_dump/pg_restore 恢复与重复恢复 | 云端备份和独立密钥保管仍需部署者演练 |
| 12：运行/成本观测 | UsageEvent/ActionRun/DatabaseSample、usage.yml、默认网卡差值；聚合不被列表上限截断，固定安全错误码 | 账单、Worker CPU、Neon CU-hours 由平台核对，见 COSTS |
| 13：目录与可运行交付 | app、cloudflare、web、scripts、tests、migrations、workflows、Dockerfile、环境模板与文档 | 采用少量内聚模块，未机械拆成规范建议的每个文件名 |
| 14–15：M1–M5 与初始配置 | M1–M4 代码和本地测试；100/1000/5000 完整本地链路；250/shard、并发4、3/5/10s、复测一次、明细60天/统计365天 | M5 云端成本/流量及完整生产验收未完成 |
| 16：十项开发风险 | 协议/字段保留、出口隔离、SSRF、幂等与本地规模已有证据；额度官方文档已核对 | Runner 可达性、真实协议组合、Echo metadata、账户限制保留为生产门槛 |
| 17：先读规范、按阶段 | 历史 M1 文档和测试保留；后续实现由用户“把所有代码都写完”和六协议要求授权 | 没有自动提交/推送敏感数据或自动部署 |

查询、缓存、批量执行与大陆理论分级的后续授权范围及证据见 [OPTIMIZATION_PLAN.md](OPTIMIZATION_PLAN.md) 和 [QUALITY_AND_EXECUTION.md](QUALITY_AND_EXECUTION.md)。这些策略明确区分完整验证、入口预检和冷却跳过，不把跳过项算成成功或新增完整失败。

本轮已补齐 Actions 预生成订阅与扫描明细归档，并通过相关本地回归；整体视觉改版和生产环境验收不在本轮完成范围。实际执行记录及测量数字见 [VALIDATION.md](VALIDATION.md)，当前状态见 [STATUS.md](STATUS.md)。后续生产部署仍需环境绑定、授权节点、云端用量与恢复演练；这些生产门槛尚未执行，也没有标记为已通过。
