# Nodema：给接管此目录的 agent

本文件是工作入口。仓库包含已上线应用；不要将它当作空项目重新搭建。

## 开始顺序

1. 读取 [接管指南](docs/HANDOFF.md)，确认用户的最终决策与代码地图。
2. 读取 [当前状态](docs/STATUS.md)、[云端记录](docs/CLOUD_DEPLOYMENT.md)。记录是历史验收证据，不是实时健康保证。
3. 涉及生产时读取 [生产操作手册](docs/PRODUCTION_OPERATIONS.md)；本机若有 `private/README.md`，再按需读取。不要输出整个 private 目录或凭据文件。
4. `git status --short`、`git log -5 --oneline`，识别用户未提交修改；检查实际文件、迁移 head 和运行状态后再工作。
5. 原始需求见 `PROJECT_SPEC.md`；实现需求改动前完整阅读它，并结合接管指南中的后续用户决策，不能按旧规范撤销已确认的选择。

当前用户的新指令优先。无新指令时，当前实现约定见接管指南；历史评审、计划与基线规范不代表待办命令。发现文档与代码冲突时明确核实，不自行删除数据或重建生产资源。

## 必须保持的边界

- 生产：Cloudflare Pages + TypeScript Worker API + PostgreSQL（目前 Neon Free）+ Python GitHub Actions。严格免费，接受休眠/额度限制，不使用用户服务器，不增加付费服务。
- 拉取、解析、实际代理检测、订阅转换在 Actions。Worker 保存/查询/调度并提供已生成订阅；Python FastAPI 是可选本地入口。
- 不做下载速度测试、网段扫描、IPLC/IEPL/CN2 自动判断。大陆分级仅为理论候选，不能冒充大陆实测。
- 数据库按用户选择明文保存；保留 HMAC 去重、鉴权，AES 用于备份、MMDB 临时包和旧库转换。不要重新生成或更换生产密钥来解决连库/测试问题。
- 真实节点、订阅 URL/token、数据库连接、管理员密钥、备份、MMDB 不进 Git、日志或聊天；公开仓库只放源码、文档和合成 fixtures。先看文件名/键名，按需读取，禁止 `cat private/*.env`、`printenv`、带密钥 argv 或 `set -x`。
- 测试只使用隔离本地 PostgreSQL/临时 schema。不要把生产连接填入 `TEST_DATABASE_URL`，不要在生产跑 pytest、benchmark、restore、cleanup 验证脚本。
- 生产写入、恢复、删库、轮换密钥、资源重建等先核实任务授权及影响；已有会话授权有效，不为例行只读检查重复索要确认。恢复/迁移必须有新鲜备份和隔离恢复证据。
- 修改 Python/Worker 的协议、筛选、统计、来源或导出逻辑时检查两端一致性；修改 migration head 同步 readiness 和相关测试。不要编辑已在生产执行的历史 migration。

## 完成工作时

执行与改动相称的检查；命令见接管指南。保留用户修改，不随意重置/清空目录。
更新 `docs/STATUS.md` 和相关功能文档；上线后更新 `docs/CLOUD_DEPLOYMENT.md` 及本机私密部署记录。记录 commit、schema、CI 链接、验证范围、未完成项，不能只在聊天里交接。文档修改不需要重新部署运行代码。

<!-- postman-cli:installation:start -->
Postman CLI is installed on this device, and can be used for API Engineering work.
<!-- postman-cli:installation:end -->
