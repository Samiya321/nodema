# Nodema · M1 数据资产库

本文保留 M1 阶段的交付说明。当前完整版本已经包含检测、自动任务、Dashboard 与导出，请以根 [README](../README.md) 和 [ARCHITECTURE](ARCHITECTURE.md) 为准。

M1 的范围是个人使用、优先 Serverless 的节点资产库：来源管理、格式解析、标准化、去重、加密存储、来源关联和基础命名。

**M1 阶段未包含网络健康检测、定时任务、Dashboard 或订阅导出。** 下载测速与自动线路推断在完整版本中也不做。`eligible` 只表示资产启用且有当前启用来源，不代表节点可用。线路字段固定为 `UNKNOWN`。

## 本地启动

需要 uv 和 Docker。uv 根据 `.python-version` 使用 Python 3.12；依赖精确版本由 `uv.lock` 固定。

```bash
uv sync --frozen
cp .env.example .env
uv run nodema keys init --env-file .env
docker compose up -d --wait db
uv run alembic upgrade head
```

Compose 只启动本地 PostgreSQL 17，绑定 `127.0.0.1:55432`。示例数据库账号仅用于本地开发。首次启动自动创建 `nodema` 和 `nodema_test`；若复用早期创建的卷，测试数据库缺失时可运行：

```bash
docker compose exec db createdb -U nodema nodema_test
```

`keys init` 生成独立的 32 字节 AES/HMAC 密钥，以 `0600` 权限原子写入 `.env`，不输出密钥，也不覆盖已有密钥。请私下备份密钥；丢失 AES 密钥后无法恢复已保存配置。不要把 `.env`、真实输入或数据库备份提交到 Git。

## 第一次导入

仓库 fixture 完全人工构造，只用于解析和入库，不用于连接任何代理。

```bash
uv run nodema source create --name demo --type UPLOADED_FILE \
  --input-file tests/fixtures/sample_clash.yaml
```

从 JSON 输出复制 `id`，然后运行：

```bash
uv run nodema source sync <SOURCE_ID>
uv run nodema source show <SOURCE_ID>
uv run nodema node list
uv run nodema node show <NODE_ID>
```

`create` 只创建来源，`sync` 才导入资产。所有命令输出 JSON。退出码：`0` 成功，`1` 操作/配置错误，`2` 同步失败或部分成功。部分成功已经提交有效节点，需根据报告处理坏记录。

支持的 Source 类型：`SUBSCRIPTION_URL`、`SINGLE_URI`、`UPLOADED_FILE`、`RAW_TEXT`。`--format-hint` 可选 `AUTO`、`URI`、`BASE64`、`CLASH`、`SINGBOX`。复杂 YAML 可明确指定 `CLASH`，避免自动识别歧义。

真实输入放在被忽略的 `private/` 或 `local-inputs/` 目录。单节点 URI 和订阅 URL 均通过文件或标准输入提交，命令行不接受 URL/URI 参数。例如，先用编辑器将 URL 写入 `private/subscription-url.txt`，再运行：

```bash
uv run nodema source create --name my-subscription --type SUBSCRIPTION_URL \
  --input-file private/subscription-url.txt
uv run nodema source create --name my-node --type SINGLE_URI --input-file -
```

标准输入模式读取到 EOF。订阅接受公网 HTTP/HTTPS，不支持 URL userinfo 认证；URL 路径和查询凭据会加密。普通配置不会递归抓取 provider。AUTO 下的 Sub-Store `/api/subs` 链接可按有界规则提取本地、远程及混合订阅，详见 [Sub-Store 导入](SUBSTORE.md)；纯解析和同步不连接节点端点。

Source 名称是用户指定的非敏感管理标签，存储为明文；不要把密码、UUID 或 URL 当作 Source 名称。

## 来源、资产与同步

```bash
uv run nodema source list
uv run nodema source update <SOURCE_ID> --name new-label
uv run nodema source update <SOURCE_ID> --no-enabled
uv run nodema source update <SOURCE_ID> --enabled
uv run nodema source update <SOURCE_ID> --input-file private/replacement.txt
uv run nodema source sync <SOURCE_ID> --force
uv run nodema source delete <SOURCE_ID>
uv run nodema source list --include-deleted
uv run nodema node disable <NODE_ID>
uv run nodema node enable <NODE_ID>
```

- `Node` 代表连接身份。同端点更换认证或关键连接参数会建立新资产；名称、来源和排序不参与指纹。
- 一个来源内同一节点出现多个名字，合并为一条关联，别名列表加密保存。名称不跨来源覆盖。
- `content_hash` 是最近取得内容的 SHA-256，`applied_hash` 是最近完整应用的内容。后者与解析器版本均匹配时跳过解析，并刷新检查/出现时间。
- 部分成功导入有效项、合并别名，并保留所有旧关联；不推进 `applied_hash`，下次会重试解析。该策略可能保留过期关联，必须关注 `PARTIAL` 报告。
- 下载失败、解析失败、空白响应均保留旧关联。合法的 `proxies: []` 或 `{"outbounds": []}` 可清空该来源的当前关联，但不删除节点。
- 完整同步将消失的关系设为 `is_present=false`。Node 的人工启用状态保持独立；其他来源仍存在时仍可成为后续任务候选。
- Source 删除是软删除，保留关联和资产。删除后不再出现在默认列表，也不可再次同步；M1 不提供恢复或硬删除命令。
- `revision` 防止并发旧结果覆盖新内容；`SOURCE_CHANGED_RETRY` 表示应重新同步。事务回滚不会留下半批资产；编号允许出现间隙。
- `sync_interval_seconds` 保存来源周期元数据，M1 没有调度器，不会自动发起同步。

## 解析和安全边界

支持 VLESS URI、VMess Base64 JSON、Clash/Mihomo `proxies`、sing-box `outbounds`、多行 URI 和单层 Base64 订阅。资产协议优先 VLESS/VMess；其他协议报告 `UNSUPPORTED_PROTOCOL`。sing-box 的 direct、block、dns、selector、urltest 为非资产项，会忽略；涉及 detour/dialer-proxy 的节点报告不支持依赖。

四类适配器输出统一的 `NormalizedNode`。已确认的同义字段统一映射；缺失和显式值保持区分。未知连接字段以格式命名空间参与指纹，避免不同配置误合并，因此**不保证带有未知扩展的跨格式配置一定能去重**。原始 Source 快照也加密保留。解析成功仅表示数据有效，不声明 Mihomo 支持或节点可用。

YAML 拒绝自定义标签、重复键、alias 和过深结构；不执行任何配置。JSON 拒绝重复键、NaN 和非预期结构。每份输入默认最多 10 MiB / 10,000 条，结构深度最多 64。大小上限可向下调整。

HTTPS 获取限制总时限、重定向和传输/解压后的大小。实际连接前校验全部解析地址并固定连接 IP；每次重定向重新校验；TLS 校验原域名，环境代理不会被使用。私网、回环、链路本地、保留地址以及不安全的 IPv6 转换地址被拒绝。TLS 校验不能通过配置关闭。

AES-256-GCM 保护 URL、原始内容、规范配置和来源别名；AAD 绑定记录及字段，防止交换密文。HMAC 与 AES 密钥独立。首次同步已有资产时，会解密样本核对指纹，错误密钥会停止导入。M1 不提供密钥轮换，切勿直接更改 `.env` 中的密钥或 key ID。

CLI 只输出安全 DTO/固定错误码；不输出原文、别名、解密配置或第三方异常正文。第三方 SQL/HTTP 日志关闭，SQL 参数隐藏。Python 接口只应将返回的 DTO 或解析摘要写入日志，勿序列化内部 `identity`。

## 基础命名

展示名称实时生成，不重复持久化，不参与指纹：

```text
UNK → UNK | VLESS-WS-TLS | N000001
```

在 `.env` 设置 `NAME_TEMPLATE` 即可统一改变展示名称，例如：

```dotenv
NAME_TEMPLATE="{PROTOCOL}-{TRANSPORT}-{SECURITY} | {SHORT_ID}"
```

支持 `ENTRY_COUNTRY`、`EXIT_COUNTRY`、`PROTOCOL`、`TRANSPORT`、`SECURITY`、`SHORT_ID`。M1 地区固定为 `UNK`；不从原名称猜测地区或线路。模板只支持简单字段替换，不支持表达式、属性访问或格式化指令。

```bash
uv run nodema naming preview
uv run nodema naming preview --template-file private/name-template.txt
```

## 测试与迁移

```bash
uv run pytest tests/unit -q
# 默认读取 .env 中的 TEST_DATABASE_URL；必须使用独立测试数据库。
uv run pytest -q
uv run ruff check .
uv run ruff format --check .
```

集成测试通过 Alembic 在测试数据库中创建随机 schema，结束后删除该 schema；不清空其他 schema。缺少 `TEST_DATABASE_URL` 或数据库不可用时明确失败，不静默跳过。不访问真实订阅或节点。

当前全量回归还包括在临时独立数据库恢复真实备份，需要兼容的 PostgreSQL 客户端工具，或按 README 设置 `TEST_PG_CONTAINER`；测试账户需要创建/删除临时数据库的权限。

```bash
uv run alembic current
uv run alembic check
uv run alembic upgrade head --sql > /tmp/nodema-schema.sql
```

当前版本的 `alembic downgrade base` 会删除全部 15 张业务表及数据，并非仅 M1 的三张表；仅用于可丢弃的开发/测试库。Neon 等远程数据库按服务方要求开启 TLS；如迁移需直连，可额外设置 `MIGRATION_DATABASE_URL`。M1 不创建云端资源。

SQLAlchemy 模型、最终 ER、解析接口和设计取舍见 [M1_DESIGN.md](M1_DESIGN.md)。规范基线见 [PROJECT_SPEC.md](../PROJECT_SPEC.md)。
