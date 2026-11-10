# 按完整对话核对的交付审查

日期：2026-11-09。结论：本轮已补齐前次审查的两项主要代码缺口——**Actions 预生成订阅、长期扫描明细归档**，并增加相应 API、前端、迁移、工作流和回归测试。当前是代码与本地验收交付，不等于生产上线验收或整体视觉改版完成。

## 采用的最新范围

- 用户后来要求全部代码，范围已超过最初仅 M1。
- 使用 Cloudflare Pages + TypeScript Worker API + Python Actions，尽量免费、尽量不用自有服务器。自有服务器只是被讨论过的备选，不是待实现的默认部署目标。
- 六协议：Shadowsocks、Trojan、AnyTLS、Hysteria2、VMess、VLESS。
- 本地/远程/混合订阅和 Sub-Store `/api/subs`；参考上游解析/抓取源码，不等于必须引入两个上游常驻服务。
- 节点筛选/排序、入口预检优化、仅根据海外 Runner 观测与资料做大陆理论候选分级。
- 最近新增首次收录、已收录天数和累计日可用率，用户已确认未检测日期不进分母、加入当天为第 1 天。
- 用户明确改用数据库明文存储，覆盖原规范的数据库 AES 要求；HMAC、访问鉴权及真实配置不入 Git 继续保留。
- 订阅转换和生成已移入 Actions；Worker 请求路径只管理方案、鉴权并读取已发布成品。

## 本轮补齐的代码

| 原缺口 | 现在的实现和证据 |
| --- | --- |
| Actions 预生成订阅 | `app/exports.py`、`app/export_render.py`、`0010_async_exports`；固定方案、租约、输入修订与快照校验、条件发布、历史摘要及容量预算 |
| Worker 仍同步转换 | `cloudflare/api-worker/src/export-api.ts` 只写请求、鉴权并读取成品；原 `src/exports.ts` 同步渲染器已删除，生产入口不导入转换器 |
| 缺少构建任务和恢复 | 新增 `.github/workflows/export-build.yml`，每日任务在来源同步后及 finalize 后构建；调度失败保留请求，支持手动重试及租约恢复；下载不创建任务 |
| 稳定链接与前端状态 | 默认长期地址、可选到期、管理员查看/更换 token、编辑/重试/版本摘要/撤销；生成期间 503，ETag 不能绕过失效检查；页面轮询保留表单 |
| scan_items / scan_shards 无限累积 | `0011_scan_archives` 与 `ScanService.cleanup` 归档旧节点明细和分片，保留摘要及关闭日期水位；活动/近期/被锁任务保留，避免破坏恢复 |
| 清理后累计统计与幂等 | 归档日期不能重开，归档批次不能重试；日统计清理不减 Node 累计计数；用量保留数值并解除过期分片引用 |

即时失效通过目录 revision、成品成员及数据库触发器传播。构建期间改变节点或方案，旧任务不会发布；无害更新时间可继续提供有效旧文件。完整行为和命令见 [ASYNC_SUBSCRIPTIONS.md](ASYNC_SUBSCRIPTIONS.md)。

## 已实现并有测试的功能

| 用户要求 | 核对结果与证据 |
| --- | --- |
| Source / Node / NodeSource、稳定身份、多来源去重 | 已实现；models、ingestion/service、test_assets；十一份迁移至 0011，旧 ID/指纹转换保持 |
| 六种协议及 URI/Base64/Clash/sing-box | 已实现规定范围；parsers、conversion、password_conversion、protocol fixtures 与跨端转换测试；不宣称兼容上游全部扩展 |
| 本地与远程订阅拉取 | 已实现；统一 parse_document；fetcher 有 URL/DNS/重定向/大小/时限约束 |
| Sub-Store `/api/subs` 本地/远程/混合提取 | 已实现；parsers/substore、ingestion/subscriptions、test_substore、test_substore_ingestion；不执行上游脚本处理器 |
| 借鉴 Sub-Store / subconverter | 已记录固定提交和源码对照；PARSER_REFERENCES、ARCHITECTURE_REVIEW；独立实现，未把上游运行时部署进系统 |
| Actions 每日/手动、自动导入后检测 | 已实现原检测流水线；daily-check/source-sync、数据库待同步请求、动态 matrix、租约、幂等与中断恢复测试 |
| DNS/TCP 预检、缓存、抽样、失败退避、并发和核心复用 | 已实现；precheck、health、runtime、scans、test_precheck/test_execution_efficiency；资产不因预检失败直接删除 |
| 入口/出口/协议/线路资料等组合筛选、排序、Top N | 已实现；共享 PostgreSQL 查询函数、catalog、前端和五格式导出、CLI/Worker/Python 互操作 |
| 大陆理论分级 | 已实现 P1/P2/P3/U、运营商偏好、解释与资料版本；没有大陆实测，真实线路类型/大陆可达性仍 UNKNOWN |
| 首次收录、已收录天数、累计日可用率 | 已实现；0009、Node 累计计数、日统计触发器、列表/详情/筛选/排序/报告；test_lifetime_plaintext |
| 数据库明文 | 已实现；`*_data` 字节列，正常读写不依赖 AES；旧密文一次性转换、缺失/错误旧密钥回滚测试 |
| HMAC、鉴权、撤销、新鲜度、敏感配置不入 Git | 已实现相应代码及合成测试；数据库明文不改变这些约束 |
| PostgreSQL 可迁移性 | 具备普通 PG schema 和 pg_dump/pg_restore 基础，真实本地恢复通过；不是任意数据库更换连接串即可迁移，跨云/跨版本仍需验收 |
| 不测速、不扫描任意网段、不自动猜 IPLC/IEPL | 保持；只检查明确导入的节点；转换中保留用户带宽参数不等于实现下载测速 |

## 仍需验证或改进的部分

- **前端体验**：Pages 静态前端已经存在，生产不依赖 Python Web 服务。当前构建仍复用 app/web 的 JS/CSS，做过功能、移动端和无障碍修复；没有完成针对用户 UI 不满意反馈的整体改版和专项浏览器性能验收。用户没有要求必须使用某个框架，缺少 React/Vue 本身不算功能缺失。
- **生产验收**：实际 GitHub Runner、Cloudflare CPU/内存、Neon TLS/连接与额度、Echo 云端 metadata、授权公网节点、MaxMind、云库恢复尚未完整验收。这属于部署/验收边界，不能用本地测试冒充，也不在本轮自动部署。
- **配置方式**：检测新鲜度仍通过环境变量设置，原规范提到的后续 Dashboard 调整入口未实现；链接到期时间现已支持逐方案在页面设置。原先建议的 `/api/nodes/import` 由 Sources 导入功能等效覆盖，不因为路径不同就判定导入未实现。
- **自动化维护**：有运行状态、手动入口与重试；不能承诺 GitHub 定时一定执行、额度永远足够或完全无需照看。预生成和容量策略已有本地证据，免费计划契合度仍需云端验收。

## 本轮验证结果

- Python **277**、Worker **30**、Echo **3**，共 **310** 项通过。包括真实 PostgreSQL 迁移/降级、模型与默认值 drift、旧 token 兼容、真实加密备份恢复、并发方案预算/构建租约、两页一致性快照、旧任务防覆盖和归档恢复边界。Python 有一条既有 Starlette TestClient 弃用提示。
- 100 / 1,000 / 5,000 节点、五种格式的实际 Worker handler → PostgreSQL → Python 构建 → 成品下载通过。5,000 节点本地创建约 8–11 ms、Python 构建约 0.8–1.3 s、下载约 10–17 ms，下载固定 3 条数据库语句（含可选用量），不读节点配置。JSON 大报告的本地 Node CPU 仍高于小配置文件，不能据此承诺 Cloudflare Free CPU 配额通过。原始记录见 [async-subscriptions.json](benchmarks/2026-11-09-async-subscriptions.json)。
- 浏览器使用六个合成节点和真实本地 API：保存 Top 2 JSON、等待状态、执行构建后下载、编辑 Top 1 后原链接更新、版本弹窗与移动视口检查。实际服务绑定/运行时、构建与协议回归的最新记录见 [VALIDATION.md](VALIDATION.md)。
- Ruff、格式、JS/TS、Pages/Functions、Worker 本地编译与工作流 actionlint 已核对；没有提交真实配置或部署生产资源。

本轮没有整体重做 UI，仍需按实际使用反馈迭代；也没有把本地吞吐量、合成地区或 loopback 握手冒充用户 GitHub Runner、Cloudflare CPU、Neon 额度或大陆实际体验。上线应先用小批授权节点验证完整流水线。
