# 上线前代码复核

后续用户已选择数据库明文存储，并新增收录天数和累计日可用率；当前实现/迁移见 [DATA_STORAGE_AND_LIFETIME.md](DATA_STORAGE_AND_LIFETIME.md)。本页的 AES 数据库审查项保留为旧版记录。

日期：2026-11-09。结论：本轮已修复下列可复现问题并通过本地回归。生产平台的免费额度与用户节点验收尚未通过；新增自有服务器方案仍需适配，不能据此声明部署后立即可用。架构取舍与待实施清单见 [ARCHITECTURE_REVIEW.md](ARCHITECTURE_REVIEW.md)。

## 已修复

| 问题 | 修复与验证 |
| --- | --- |
| 大导出一次累计完整 DTO、密文和解密对象，内存不受结果体积约束 | Worker 使用导出专用 SQL 投影、1,000 条分页、按密文总字节分批、逐条渲染及 UTF-8 10 MiB 上限。新增迁移 `0008_export_projection`；Python 同步输出上限。超过上限明确拒绝，不悄悄截断 |
| 导出期间节点状态变化，offset 分页可能漏项/重复 | 当前改为整份 Python 构建在 REPEATABLE READ 只读快照中完成。真实数据库测试在第 1 页后停用后续节点，快照保持一致，目录 revision 校验拒绝发布旧任务；Worker 只下载已发布文件 |
| 订阅下载用量记录失败使正确下载返回错误 | Worker 将非关键用量写入隔离；故障注入后下载仍为 200 |
| 检测结果批次内用量 INSERT 失败会使业务事务失效 | 用量写入使用 savepoint；真实 PostgreSQL trigger 拒绝写入时，检测结果仍全部落库并发布 |
| 多个 checker 依次预检可能耗尽原分片租约 | 每次预检前续租；虚拟时间测试中累计预检超过初始租约仍正常完成 |
| 批量提交时间被当成节点完成时间 | Observation 在实际完成时保存 checked_at，落库使用该时间，避免延长成功有效期 |
| 恰好达到备份原文上限时，加密 envelope 使恢复拒绝同一备份 | 加密读取边界包含 envelope，解密后仍校验原文上限；边界 roundtrip 和真实 pg_dump/restore 通过 |
| 仅有来源、尚无节点的库无法发现错误 AES 密钥，可能继续混入新密文 | Python 与 Worker 均在写来源/受保护资料和 readiness 时验证已有密文，节点为空时回退来源密文；错误密钥写入被拒绝，原密钥仍可同步 |
| Runner 无 IPv6 路由或本机网络能力不足被归为节点 DOWN | 全 IPv6 目标增加不发送数据的本机路由检查；TCP 全部为本机环境错误时同样 SKIPPED/UNKNOWN，保留节点复测机会。Hysteria2 不做 TCP/UDP 主动探测 |
| Worker 把 null 规则列表当空数组，Python 拒绝相同输入 | 两端统一拒绝 null；资料读取不存在节点统一 NODE_NOT_FOUND |
| Actions 迁移未沿用独立直连地址 | daily/usage 增加可选 MIGRATION_DATABASE_URL，未设置时兼容 DATABASE_URL |

## 本地证据

- Python **252** 项、Worker/API/部署检查 **27** 项、Echo **3** 项通过，共 **282** 项。Python 有一条 Starlette TestClient/httpx 弃用警告，不影响测试结果。
- 迁移 head 为 `0008_export_projection`；真实 PostgreSQL 升降级、模型 drift、并发迁移和加密备份恢复通过。
- Worker 测试用 1,250 个合成 UP 节点，实际跨两页导出 Top 1,225，验证五种格式、稳定快照、停用后下次下载更新和用量故障隔离。
- 19 个真实 loopback 协议/传输/SS 方法组合通过；同名节点改认证、错误认证后恢复及 DNS 固定结果用例继续通过。
- 本轮重新执行 100 节点真实 loopback 流程：全部 100 UP，0 重试、0 超时、0 环境失败；检测 0.586 秒、完整流程 0.973 秒。此前 1,000/5,000 的测量保留在 [VALIDATION.md](VALIDATION.md)，未冒充本轮重新执行。
- 实际 Worker handler + PostgreSQL 导出测量覆盖 1,000/5,000/15,000 节点。5,000 节点创建并下载五种格式约 0.65–0.91 秒；15,000 的 JSON 因超过 10 MiB 返回明确错误。安全原始记录见 [worker-export-review.json](benchmarks/2026-11-09-worker-export-review.json)。Node 运行时间和内存不代表 Cloudflare isolate 配额。
- Ruff/格式、JS 语法、三个 TypeScript 工程、API dry-run、Pages 静态/Functions 构建和全部工作流 actionlint 通过。API 生产依赖 npm audit 报告 0 漏洞。
- 本轮浏览器通过真实 FastAPI 本地适配层及独立 PostgreSQL，登录后生成 Top 2 并实际下载两条配置、390px 移动退出回到登录。Worker 对应契约由数据库互操作测试覆盖；这不是新自有服务器生产方案的验收。

没有下载测速、猜测 IPLC/IEPL、使用未授权节点或将敏感配置提交 Git。没有创建 Git 仓库、部署生产资源、推送代码或发送外部消息。

## 上线判断

当前发现的上述功能缺陷已修复；没有声称“再无 bug”。免费 Worker 大导出、长期数据库容量与历史保留、Actions 真实调度/分钟数、实际用户节点、Echo 云端字段和生产恢复演练仍是实质边界。用户已经选择严格不增加托管费用，并进一步倾向不使用自有服务器；最新建议为 [Actions 预生成订阅](ASYNC_SUBSCRIPTIONS.md)，仍需实现并验证新路径后再做小批授权节点验收。
