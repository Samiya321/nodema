# Sub-Store `/api/subs` 导入

在 Dashboard 添加来源，选择「订阅 URL / Sub-Store API」和「自动识别」，填入完整 `/api/subs` 链接即可。支持路径前缀、查询参数和末尾斜杠。接口不需要新增来源类型、迁移数据库或更换 AES/HMAC 密钥；一个接口作为一个 Source，展开后的节点沿用现有去重、加密、来源关联及检测流程。

CLI 也使用既有命令。将真实链接私下保存到忽略目录中的文件，不把带凭据的 URL 放进命令历史：

```bash
uv run nodema source create --name my-sub-store --type SUBSCRIPTION_URL \
  --format-hint AUTO --input-file private/substore-url.txt
uv run nodema source sync <SOURCE_ID>
```

## 提取规则

接收官方 `{"status":"success","data":[...]}` 结构，兼容旧式按名称索引的 `data` 对象。字段行为对照 [Sub-Store 订阅接口](https://github.com/sub-store-org/Sub-Store/blob/2888806251d90d45eabf2baf7a7fd4e8be2a4787/backend/src/restful/subscriptions.js) 和 [原始内容合并逻辑](https://github.com/sub-store-org/Sub-Store/blob/2888806251d90d45eabf2baf7a7fd4e8be2a4787/backend/src/restful/sync.js) 独立实现。

| 定义 | 提取方式 |
| --- | --- |
| `source: local`，无合并模式 | 解析 `content`，忽略未启用的 `url` |
| `source: remote` 或缺省 source | 抓取 `url` 中以换行分隔的链接，忽略未启用的 content |
| `mergeSources: localFirst` | 先解析 content，再按顺序解析远程链接 |
| `mergeSources: remoteFirst` | 先解析远程链接，再解析 content |

每块内容分别交给既有 URI/Base64、Clash、sing-box、Loon、Surge、QX 适配器，避免直接拼接 YAML/JSON 破坏结构。相同 URL 与 User-Agent 的组合在一次同步中只抓取一次；数据中的多处引用仍参与别名归并。支持安全的自定义 `ua`，不执行配置中的处理器、重写脚本、远程脚本或任意请求代码。Dashboard 明确标记「原始内容导入」，因此结果不等同于 Sub-Store 处理器执行后的订阅导出。

`/api/collections`、加密 AGE 内容、依赖上游脚本才能生成的节点、URL fragment 中的 Sub-Store 特殊下载参数不在本入口的兼容范围。未知 source/merge 模式、非法 URL 和无法解析的内容均返回固定错误码，不自动猜测其含义。

## 同步与失败处理

每次同步都会检查远程引用，即使 `/api/subs` 清单本身没有变化。内容 hash 覆盖清单和取得的远程响应，远程节点变化会触发重新入库；完全一致的成功快照返回 UNCHANGED。

引用失败时，成功部分仍可导入并报告 PARTIAL，已有 NodeSource 关联继续保留。只有完整成功的快照才对已移除节点取消来源关联。空清单、接口错误、登录 HTML、大小或条目预算超限返回 FAILED，保留已有资产。旧来源在解析器升级至 `protocols-v4` 后会重新解析。

HTTP 与 HTTPS 公网链接均支持。HTTP 内容在网络上不加密，宜使用上游提供的 HTTPS 链接。HTTPS 不允许重定向降级为 HTTP；不关闭 TLS 验证，不转发任意认证头。每次实际连接及重定向继续验证 DNS/IP，拒绝内网、loopback、云元数据地址和 DNS rebinding。

原清单、远程链接及响应快照仅进入既有 AES-GCM 密文；公开 DTO/日志只包含计数、序号和固定错误码，不返回原始名称、URL 或节点凭据。纯解析器没有网络访问；有界引用解析位于 `app/ingestion/subscriptions.py`。

## 资源上限

| 环境变量 | 默认值 | 范围与用途 |
| --- | ---: | --- |
| `SOURCE_MAX_BYTES` | 10485760 | 根响应及去重后远程响应的解码总字节数；每次单独下载也受此限制 |
| `SOURCE_MAX_ITEMS` | 10000 | 普通订阅解析上限，以及单份 API 清单的定义数上限 |
| `SOURCE_SUBSTORE_MAX_ITEMS` | 50000 | 聚合资源预算，包含定义、引用与解析条目；最大可配置 100000 |
| `SOURCE_SUBSTORE_MAX_FETCHES` | 256 | 不同 URL/UA 抓取尝试数，包含根接口；最大 256 |
| `SOURCE_SUBSTORE_MAX_DEPTH` | 3 | 嵌套引用深度，根接口为 0；最大 8 |
| `SOURCE_SUBSTORE_TIMEOUT_SECONDS` | 120 | 聚合网络时间预算；最大 300 秒 |
| `SOURCE_TOTAL_TIMEOUT_SECONDS` | 30 | 单 URL 时间预算，也受剩余聚合预算限制 |

每个来源最多同时抓取四个引用，任务队列也受抓取上限限制。重定向次数、压缩响应大小、总字节数及聚合条目预算独立约束，不会截取部分内容后假装完整成功。参数在 `.env.example` 中提供；GitHub Actions 使用默认值，定制时在工作流环境中设置同名变量。

## 本地验证，2026-11-09

A1–A5 按用户本次给出的五个接口顺序编号。实际 GET 得到前三份成功清单；后两份两次请求均超时。本次仅验证下载、解析和入库，没有对其中的节点发起健康检测。

| 接口 | 清单定义数 | 修正后导入的唯一节点 | 结果 |
| --- | ---: | ---: | --- |
| A1 | 170 | 15078 | PARTIAL；含本地、远程与混合定义，部分引用失败或配置不合法 |
| A2 | 85 | 142 | PARTIAL；部分引用不可达或未配置 URL |
| A3 | 18 | 0 | 清单可读取；引用返回错误或空内容，未解析出有效节点 |
| A4 | — | 0 | 根接口 FETCH_TIMEOUT |
| A5 | — | 0 | 根接口 FETCH_TIMEOUT |

初次现场验证发现 A1 超过旧版单份订阅的 10000 条限制；因此新增独立聚合预算。修改后使用同次实际下载并加密保存的响应进行确定性重放，在真实 PostgreSQL 完成 15078 个节点入库，耗时约 9.49 秒。重放不补抓之前未取得的响应，缺失响应明确报错；这不是新的网络可达性测量。A2/A3 也重放一致。合计 15220 个唯一资产，保持六协议范围，失败配置没有作为成功节点存储。

合成 fixtures 和测试覆盖本地/远程/两种混合顺序、远程更新而清单不变、部分失败保留资产、引用去重、递归/环路/限额、HTTP 和 TLS 降级、累计用量、Worker 保存 HTTP URL → Python 导入 → Worker 读取提取摘要。真实响应位于忽略的 `private/substore-validation/`，未复制到 fixtures 或交付文件。

完整回归为 Python 204 项、Worker 21 项通过；Pages 类型检查和静态构建、Python/JS 格式与语法检查通过。安全汇总见 [2026-11-09-substore.json](validations/2026-11-09-substore.json)。数据库已另存为私有 AES-GCM 快照并解密比对，临时 PostgreSQL 容器已停止并自动移除。本次没有部署云端资源。
