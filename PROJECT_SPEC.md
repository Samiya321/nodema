# Node Monitor Free Edition

## Serverless 节点资产管理与每日健康检测系统 --- 技术设计说明

-   文档版本：v0.1
-   日期：2026-11-07
-   目标规模：1,000～5,000 个节点
-   检测频率：每天完整检测一次
-   部署原则：尽量免费、无常驻服务器、低维护
-   主要对象：用户有权管理和测试的 VLESS / VMess 及其他兼容代理节点

------------------------------------------------------------------------

## 0. 给 Codex 的项目说明

请将本文档作为项目的初始产品需求和技术设计基线。先检查设计中的技术可行性，再按阶段实现，不要一次性生成一个未经验证的大型系统。

### 必须遵守的设计原则

1.  **Source、Node、Observation 三层分离**：
    -   Source：订阅链接、单节点 URI、上传文件等来源。
    -   Node：去重后的规范化节点资产。
    -   Observation：某次检测对入口、出口、连通性和状态的观测结果。
2.  同一节点出现在多个订阅中，只建立一份 Node 资产；通过 `node_sources`
    关联多个来源；每天只检测一次。
3.  节点名称不是唯一标识。使用带密钥的 HMAC 指纹去重。
4.  原始 URI、订阅 URL、UUID、密码、Reality
    参数等敏感信息不得写入日志、Git 仓库或明文导出日志。
5.  不进行下载速度测试。核心检测只包括配置解析、入口 DNS/IP/ASN、入口
    TCP（适用时）、代理握手、轻量 HTTPS 请求、出口 IP/地区/ASN。
6.  不得仅凭入口与出口国家不同，就推断 IPLC、IEPL、CN2
    等线路类型。无法证实的线路类型必须为 `UNKNOWN`。
7.  检测任务失败与节点失效必须区分。Runner、DNS 服务、数据库或测试 Echo
    服务出现环境故障时，不得把整批节点标记为 DOWN。
8.  检测仅针对用户明确导入且有权使用的节点及其配置端点；不得实现任意 IP
    段扫描、端口枚举或通用网络扫描功能。
9.  所有批量任务必须幂等，支持中断恢复，不能因重试重复创建节点或检测记录。
10. 第一版优先可维护性和结果正确性，不要提前引入
    Redis、Kubernetes、ClickHouse 或多云架构。

### 建议的开发顺序

-   M1：格式导入、解析、标准化、指纹去重、数据库。
-   M2：Mihomo 单节点健康检测、入口/出口识别。
-   M3：GitHub Actions 分片任务、每日工作流、失败恢复。
-   M4：Dashboard、命名模板、订阅导出。
-   M5：压测、成本检查、安全审查和文档完善。

每个里程碑都要提供测试和可运行结果。先用脱敏测试数据和 50～100
个用户有权测试的节点验证，不要一开始就导入全部节点。

------------------------------------------------------------------------

# 1. 项目目标与非目标

## 1.1 项目目标

建立一个低成本、尽量零常驻计算资源的节点资产管理平台，支持：

-   混合来源导入：订阅 URL、VLESS/VMess 单节点 URI、Base64
    订阅、Clash/Mihomo YAML、sing-box JSON、上传的文本/配置文件。
-   定时同步订阅，检测订阅内容是否变化。
-   解析、规范化、去重。
-   维护稳定的节点 ID 和来源关系。
-   每天对所有启用节点执行一次完整健康检测。
-   检测入口 DNS、解析 IP、IP 地区、ASN、适用时的 TCP 连通性。
-   通过代理请求轻量 HTTPS Echo
    接口，验证代理是否能实际访问公网，并获得出口 IP。
-   查询出口地区和 ASN。
-   自动生成规范化节点名称。
-   维护 UP / DOWN / DEGRADED / UNKNOWN 等状态和检测历史。
-   导出可用节点订阅和 JSON/CSV 报表。
-   提供简单的 Web Dashboard。
-   检测任务结束后释放计算资源，不维护常驻 Worker。

## 1.2 非目标（第一版不做）

-   下载速度测试、大文件测速、持续带宽测试。
-   对任意公网 IP 或网段进行扫描。
-   自动证明 IPLC、IEPL、CN2 等专线类型。
-   还原代理服务端内部的完整转发路径。
-   多区域网络体验测试。
-   实时秒级监控。
-   Kubernetes、Redis、ClickHouse、多云容灾。
-   AI 自动判断线路类型。
-   自动删除长期失效节点。

## 1.3 核心检测定义

"节点可用"不能只表示入口 TCP 端口开放。建议至少分为：

1.  配置可解析。
2.  入口域名可解析。
3.  入口端点可连接（仅对适用的传输类型）。
4.  Mihomo 能否建立该节点的代理连接。
5.  通过该代理能否完成 HTTPS Echo 请求。
6.  是否成功获取出口 IP。

只有代理请求成功，才将节点判定为 `UP`。入口 TCP
成功但代理握手失败，不算节点可用。

------------------------------------------------------------------------

# 2. 推荐总体架构

## 2.1 首选架构：GitHub Actions + Neon + Cloudflare

--------------------------------------------------------------------------------------------
  层                      产品/技术                职责
----------------------- ------------------------ -------------------------------------------
  批量计算                GitHub                   每日导入、检测、汇总
                          Actions（GitHub-hosted
                          Linux Runner）

  数据库                  Neon PostgreSQL Free     Source、Node、任务和检测结果

  前端                    Cloudflare Pages         静态 Dashboard

  轻量 API                Cloudflare Workers /     Dashboard API、鉴权、轻量操作
                          Pages Functions

  代理检测                Mihomo Core              实际代理连接与 HTTP 测试

  解析                    Python                   URI、Base64、YAML、JSON 解析

  GeoIP                   MaxMind GeoLite2         本地入口 IP GeoIP/ASN 查询

  出口识别                自建 Cloudflare Worker   通过代理请求，返回观察到的公网出口
                          Echo Endpoint            IP/国家/ASN（可用字段以实际运行环境验证）

  密钥                    GitHub Actions           数据库凭证、加密密钥
                          Secrets、Cloudflare
                          Worker Secrets
  --------------------------------------------------------------------------------------------

### 为什么采用这套架构

-   GitHub Actions Runner 是临时计算环境，任务结束后销毁。
-   公共 GitHub 仓库使用标准 GitHub-hosted Runner 通常不消耗私有仓库的
    Actions 分钟额度；私有仓库额度依赖账户计划。
-   Neon 提供托管 PostgreSQL，避免维护数据库服务器。
-   Cloudflare Pages 可托管静态前端。
-   Cloudflare Workers 只负责轻量 API，不运行 Mihomo。
-   Mihomo 运行在 GitHub Actions 的 Linux Runner 中。
-   每天一次的批处理不需要常驻服务器或实时队列。

### 免费额度注意事项

本项目目标是"尽量免费"，不保证所有账户、所有使用量、所有地区都能永久保持
\$0。

部署前需要重新检查官方价格和配额，尤其是：

-   GitHub Actions：公共仓库与私有仓库计费不同；私有仓库额度取决于计划。
-   Neon：Free 计划的计算、存储、网络额度可能调整。
-   Cloudflare Workers/Pages：免费计划有请求、CPU、构建或其他限制。
-   MaxMind GeoLite2：需要注册并遵守其许可与更新要求。
-   公网出口流量：云厂商可能有流量或网络策略限制。

**不要把具体免费额度写死在业务代码中。**
将额度、运行时间和实际用量放在部署说明中，部署时重新核实官方文档。

## 2.2 运行流程

每日流水线：

``` text
GitHub Actions schedule / workflow_dispatch
                  |
                  v
             Import Job
                  |
                  v
     拉取启用的订阅与单节点来源
                  |
                  v
    计算内容 Hash，增量解析、去重
                  |
                  v
      创建当天 scan_run 和 scan_items
                  |
                  v
       生成动态 GitHub Actions Matrix
                  |
                  v
          Distributed Check
          /       |        \
      Shard 0   Shard 1   Shard N
          \       |        /
                  |
                  v
        写入检测结果（幂等）
                  |
                  v
             Finalizer
                  |
                  v
  更新状态、命名、统计、生成订阅/报表
                  |
                  v
             Dashboard
```

## 2.3 可选触发方式

第一版使用 GitHub Actions `schedule` 和 `workflow_dispatch` 即可。

需要注意：

-   Scheduled workflow 可能延迟，不应把它当成准点调度服务。
-   必须保留手动运行入口。
-   需要防止同一天重复启动产生重复任务。
-   如以后需要更可靠的触发，可以增加 Cloudflare Cron Worker 调用 GitHub
    `workflow_dispatch` API；这只是触发器，不承担检测。
-   不要同时启用多个触发器却没有幂等锁。

------------------------------------------------------------------------

# 3. 输入来源与导入流程

## 3.1 支持的输入类型

  输入                处理
------------------- ------------------------
  `vless://`          URI parser
  `vmess://`          Base64 解码后解析 JSON
  `trojan://`         URI parser
  `ss://`             URI/Base64 parser
  Base64 订阅         解码后逐行识别
  Clash/Mihomo YAML   YAML parser
  sing-box JSON       JSON parser
  多行文本            逐行识别 URI
  远程订阅 URL        定时拉取
  上传文件            按内容类型识别

第一版可以优先实现 VLESS、VMess、Clash YAML、sing-box
JSON；其他协议采用适配器逐步增加。解析成功不代表 Mihomo
一定支持该节点配置，必须把 `parse_status` 与 `runtime_support_status`
分开。

## 3.2 Source 类型

建议：

-   `SUBSCRIPTION_URL`
-   `SINGLE_URI`
-   `UPLOADED_FILE`
-   `RAW_TEXT`

每个 Source 有独立的启用状态、同步周期、最近同步时间、内容
Hash、错误信息。

## 3.3 增量导入

每次获取订阅内容后计算 SHA-256：

``` text
fetch source
   |
   v
compute content_hash
   |
   +-- hash unchanged --> skip full parsing
   |
   +-- hash changed ----> parse and normalize
                            |
                            v
                         upsert nodes
                            |
                            v
                       update source links
```

注意：

-   即使订阅内容未变化，仍应更新 `last_checked_at`。
-   订阅拉取失败不能等同于订阅中所有节点消失。
-   某节点从一个订阅消失，但仍存在于其他来源时，不能禁用该节点。
-   Source 失效时保留历史，不要立即删除关联和节点资产。
-   对订阅下载设置大小上限、超时、重定向次数限制和允许的 URL scheme。
-   防止 SSRF：订阅 URL 不应允许访问 localhost、私网、云 metadata
    地址等内部目标；如果允许用户提交 URL，需要实现 DNS/IP
    解析后的目标地址校验，并防止重定向绕过。

------------------------------------------------------------------------

# 4. 节点标准化与去重

## 4.1 Node 标准字段

建议至少包含：

-   `id`：UUID，永久稳定。
-   `short_id`：用于显示的稳定编号，例如 `N000127`。
-   `fingerprint`：HMAC-SHA256 指纹。
-   `protocol`：vless/vmess/trojan/ss 等。
-   `server_host`
-   `server_port`
-   `transport`：tcp/ws/grpc/http 等。
-   `security`：tls/reality/none 等。
-   `sni`
-   `host_header`
-   `path`
-   `service_name`
-   `flow`
-   `alpn`
-   `fingerprint_tls`（如客户端 TLS fingerprint 参数，避免与资产
    fingerprint 混淆，建议字段命名为 `tls_fingerprint`）
-   `original_name`
-   `normalized_name`
-   `config_encrypted`
-   `enabled`
-   `first_seen_at`
-   `last_seen_at`

协议解析器应保留未知字段，避免未来协议扩展时丢失信息。

## 4.2 指纹

使用带密钥的 HMAC-SHA256：

``` python
fingerprint = HMAC_SHA256(fingerprint_secret, canonical_json(connection_identity))
```

规范化身份字段应包含会影响连接身份的参数，例如：

-   协议
-   服务器地址和端口
-   UUID/密码（参与 HMAC，不明文输出）
-   传输方式
-   TLS/Reality 关键参数
-   SNI
-   WS Host/Path
-   gRPC service name
-   VLESS Flow
-   其他影响连接行为的参数

不要包含：

-   节点显示名称
-   来源名称
-   订阅 URL
-   导入时间
-   节点排序

需要明确：不同客户端对参数默认值的解释可能不同。规范化时不能随意把"未提供"和"默认值"合并，除非确认两者语义等价。指纹算法应有版本字段，例如
`fingerprint_version=1`，以后修改算法时可迁移。

## 4.3 安全存储

-   `config_encrypted` 使用应用层 AES-256-GCM 加密。
-   `url_encrypted`、原始单节点 URI、订阅凭证也加密。
-   加密密钥放 GitHub Actions Secrets 和 Cloudflare Worker Secrets。
-   HMAC 指纹密钥与加密密钥分开。
-   数据库日志和应用日志不得打印明文 URI、UUID、密码、订阅 URL。
-   不将真实节点数据、数据库导出、`.env`、测试订阅提交到 Git。
-   公开仓库只放代码和脱敏 fixture。
-   订阅导出链接视为凭证，必须鉴权或使用随机高熵 token。

------------------------------------------------------------------------

# 5. 检测设计

## 5.1 单节点检测流程

``` text
Load encrypted node config
          |
          v
Decrypt in memory
          |
          v
Parse/runtime validation
          |
          v
Resolve entry hostname
          |
          v
Record DNS IPs + GeoIP/ASN
          |
          v
TCP connect (when applicable)
          |
          v
Start/use isolated Mihomo instance
          |
          v
Test proxy handshake / HTTP delay
          |
          v
Request HTTPS Echo through this node
          |
          v
Record observed exit IP
          |
          v
GeoIP/ASN lookup
          |
          v
Persist result, redact logs, clear temp files
```

## 5.2 入口检测（Entry）

记录：

-   配置中的入口 Host。
-   入口 Port。
-   DNS A/AAAA 结果。
-   DNS 查询时间。
-   解析 IP 的 Country/City/ASN/Organization。
-   适用时的 TCP 连接结果和耗时。

重要边界：

-   `server_host` 是配置中的连接目标。
-   SNI 不等于入口 IP。
-   WS Host 不等于入口 IP。
-   Reality `serverName` 不等于入口 IP。
-   如果域名经过 CDN/Anycast，DNS 返回的可能是边缘 IP，不一定是源站 IP。
-   因此字段应命名为 `entry_resolved_ip` 或
    `entry_observed_ip`，不能直接声称是物理服务器真实 IP。
-   对 UDP/特殊传输类型，TCP 测试可能不适用，必须记录
    `NOT_APPLICABLE`，不能判失败。

## 5.3 代理有效性检测

使用 Mihomo 作为运行时检测引擎：

-   解析后的节点配置转换为 Mihomo 可识别的 proxy 配置。
-   启动 Mihomo 时使用临时目录和随机本地端口。
-   API Controller 只绑定 `127.0.0.1`，设置随机 Secret。
-   不启用 TUN、不需要特权容器。
-   每个 Worker 使用独立 Mihomo 实例。
-   第一版每个 Worker 对节点按顺序执行出口测试，避免多个任务切换同一个
    selector 导致出口 IP 归属错乱。
-   可用 Mihomo 单节点 delay API 测 HTTP 延迟。
-   出口测试时，先明确选择目标节点，再经本地代理端口请求 Echo endpoint。
-   每个节点完成后清理或重置代理选择状态。

不要把入口 TCP 成功当成代理可用。只有代理请求成功才是 `UP`。

## 5.4 出口检测（Exit）

优先方案：自建一个极轻量的 Cloudflare Worker Echo Endpoint。

它通过 Cloudflare Worker 请求上下文返回服务端观察到的连接 IP
和可用地理信息，例如：

``` json
{
  "ip": "198.51.100.20",
  "country": "JP",
  "asn": 64501
}
```

上述 IP 为文档示意。

实现要求：

-   Worker 只返回请求来源 IP 和必要的 Geo 信息。
-   不记录调用者 IP，不设置缓存。
-   不接受任意 URL 参数或转发请求。
-   通过代理访问 Echo endpoint。
-   以 Worker 实际可读取的 Cloudflare request metadata 为准；部署时验证
    country、ASN 等字段是否可用。
-   如果 Worker 无法提供 ASN，使用 Python Worker 本地 GeoLite2 ASN
    数据库查询。
-   需要时使用第二个可信 Echo endpoint
    做交叉验证，但不要每次都依赖多个第三方 API。
-   保存出口 IP 的观测时间和来源。

出口 IP 代表该代理请求到达 Echo
服务时被观察到的公网来源地址，不保证等于服务商宣传的"物理落地服务器
IP"。

## 5.5 GeoIP / ASN

-   入口 IP：使用本地 MaxMind GeoLite2 City/ASN MMDB 查询。
-   出口 IP：优先用 Echo 返回信息；缺少字段时用本地 MMDB 查询。
-   GeoIP 数据库定期更新。
-   对同一个 IP 的查询结果做缓存。
-   记录数据库版本和查询时间。
-   地理位置只能作为估计，不保证精确到城市。
-   ASN/组织信息不等于线路质量或专线证明。

## 5.6 线路识别边界

系统可以自动观测：

-   入口与出口 IP 是否相同。
-   入口与出口国家/地区是否不同。
-   入口/出口 ASN。
-   检测机到入口的部分路由信息（视权限和网络环境而定）。

系统通常无法仅凭客户端配置和出口 IP 还原服务端内部路径。

以下标签不得仅凭 IP 国家差异自动生成：

-   IPLC
-   IEPL
-   CN2
-   专线
-   原生 IP
-   家宽

线路类型字段建议：

-   `UNKNOWN`
-   `PROVIDER_DECLARED`
-   `MANUAL_VERIFIED`
-   `OBSERVED_EVIDENCE`

其中 `OBSERVED_EVIDENCE` 只记录证据，不等同于已证明某条专线。

## 5.7 延迟定义

不进行下载速度测试。

记录：

-   `dns_duration_ms`
-   `tcp_connect_ms`（适用时）
-   `proxy_handshake_ms`（如果实现可可靠测量）
-   `http_duration_ms`

`http_duration_ms` 是通过代理完成轻量 HTTPS 请求的总耗时，不等同于 ICMP
Ping。

------------------------------------------------------------------------

# 6. 状态模型与失败处理

## 6.1 状态

  状态                  含义
--------------------- --------------------------------------
  `UP`                  代理请求成功，Echo 返回有效出口 IP
  `DOWN`                经复测仍无法建立代理或完成请求
  `DEGRADED`            代理可用，但响应异常或超过可配置阈值
  `UNKNOWN`             未检测、数据不完整或无法判定
  `UNSUPPORTED`         配置可解析，但当前检测核心不支持
  `STALE`               最近一次成功检测已超过有效期
  `ENVIRONMENT_ERROR`   Runner、Echo、数据库或检测环境故障

不要把 `ENVIRONMENT_ERROR` 转成 `DOWN`。

## 6.2 失败复测

建议：

-   首次失败后等待 10～30 秒复测一次。
-   对 DNS、入口连接、代理握手、HTTP Echo 分别记录错误阶段。
-   两次失败后可标记 `DOWN`，但保留错误分类。
-   如果 Echo endpoint 或 Runner
    全局异常，则本批次标记环境错误，不更新节点 DOWN 状态。
-   新节点首次失败应标记 `SUSPECT` 或 `UNKNOWN`，完成复测后再决定。
-   节点恢复后记录 `DOWN -> UP` 状态变化。

## 6.3 检测新鲜度

导出订阅时，不能只检查历史上曾经 `UP`。

建议规则：

-   `UP` 且最近成功检测在 36 小时内：允许进入可用订阅。
-   超过 36 小时：标记 `STALE` 或从可用订阅排除。
-   手动禁用节点始终排除。
-   `UNSUPPORTED`、`UNKNOWN`、`DOWN` 不进入可用订阅。

36 小时是初始配置，后续可在 Dashboard 调整。

------------------------------------------------------------------------

# 7. 每日任务与分片算法

## 7.1 推荐参数

  参数                                                     初始值
---------------------------- ----------------------------------
  每日完整检测                                               1 次
  每个 Shard                                             250 节点
  1,000 节点                                             4 Shards
  5,000 节点                                            20 Shards
  GitHub Actions 最大并行                   4～8，先从 4 开始压测
  每个 Worker 的 Mihomo                                      1 个
  每个 Worker 内出口测试并发        1（串行，保证节点与出口对应）
  单节点普通超时                             5～10 秒，按阶段设置
  失败复测                                                   1 次
  单 Job 超时                    依据实测设置，建议先 30～60 分钟

这些是初始参数，不是性能保证。GitHub 账户的并行 Job 限制、Runner
规格和网络环境需要实际验证。

## 7.2 Shard 数量

``` python
shard_count = ceil(node_count / batch_size)
```

其中 `batch_size=250`。

例如：

    节点数   Shard 数
-------- ----------
     1,000          4
     2,000          8
     3,000         12
     4,000         16
     5,000         20

## 7.3 分配算法

为每个节点计算稳定的分片 Hash：

``` python
shard_no = int.from_bytes(hmac_sha256(shard_key, node_fingerprint)[:8], "big") % shard_count
```

然后按 `shard_no` 分组。分片内按 fingerprint 排序，形成该次 scan
的不可变快照。

注意：

-   每次 scan 创建自己的 `scan_items`。
-   每个 node 在同一个 scan 中只出现一次。
-   `shard_count` 变化时，节点可能被分配到不同 shard，这是允许的。
-   任务执行过程中不再动态改变本次 scan 的分片。
-   不使用巨大 SQL OFFSET 分页。
-   Worker 根据 `scan_run_id + shard_no` 读取自己的节点清单。

## 7.4 GitHub Actions Matrix

建议由 prepare job 输出动态 matrix：

``` yaml
jobs:
  prepare:
    # 创建 scan_run、scan_items，并输出 shard matrix

  check:
    needs: prepare
    strategy:
      fail-fast: false
      max-parallel: 4
      matrix:
        shard: ${{ fromJson(needs.prepare.outputs.shards) }}
    # 每个 matrix job 负责一个 shard

  finalize:
    needs: [prepare, check]
    if: always()
    # 只有检查所有 shard 状态后才决定完整完成或部分完成
```

具体 YAML 由 Codex 根据实际实现补全。

## 7.5 幂等与恢复

-   `scan_items` 以 `(scan_run_id, node_id)` 为唯一键。
-   `test_results` 以 `(scan_run_id, node_id, attempt_no)` 为唯一键。
-   Worker 批量写入结果。
-   Worker 退出后，未完成的 scan item 保持 `PENDING` 或 `RETRYABLE`。
-   重新运行时只处理未完成项。
-   `finalize` 不得在仍有未完成 shard 时宣称完整成功。
-   同一日期重复触发时，先检查是否已有进行中的 scan，避免重复运行。
-   使用数据库事务或 advisory lock 防止重复创建每日 scan。

## 7.6 时间估算

假设单节点平均耗时 1～3 秒，5,000 节点，8 个并行
Worker，理想检测时间约：

``` text
5000 * 1～3 秒 / 8
≈ 10～31 分钟
```

实际时间还包括 Runner 启动、Mihomo
启动、DNS、超时、失败复测和数据库写入。大量节点超时时可能明显变长。先用
50～100 个样本压测，不承诺固定耗时。

------------------------------------------------------------------------

# 8. 数据库设计

使用 PostgreSQL。第一版不需要 Redis、ClickHouse 或分库。

## 8.1 核心表

### `sources`

保存订阅和单节点来源。

字段：

-   `id UUID PRIMARY KEY`
-   `name TEXT`
-   `type TEXT`
-   `url_encrypted BYTEA`
-   `payload_encrypted BYTEA`
-   `enabled BOOLEAN`
-   `content_hash TEXT`
-   `last_checked_at TIMESTAMPTZ`
-   `last_synced_at TIMESTAMPTZ`
-   `last_error_code TEXT`
-   `created_at TIMESTAMPTZ`

### `nodes`

保存唯一节点资产。

字段：

-   `id UUID PRIMARY KEY`
-   `short_id TEXT UNIQUE`
-   `fingerprint BYTEA UNIQUE`
-   `fingerprint_version INTEGER`
-   `protocol TEXT`
-   `server_host TEXT`
-   `server_port INTEGER`
-   `transport TEXT`
-   `security TEXT`
-   `sni TEXT`
-   `original_name TEXT`
-   `normalized_name TEXT`
-   `config_encrypted BYTEA`
-   `line_type TEXT DEFAULT 'UNKNOWN'`
-   `line_evidence TEXT`
-   `enabled BOOLEAN`
-   `first_seen_at TIMESTAMPTZ`
-   `last_seen_at TIMESTAMPTZ`

### `node_sources`

节点与来源的多对多关系。

字段：

-   `node_id UUID`
-   `source_id UUID`
-   `source_item_key TEXT`
-   `original_name TEXT`
-   `first_seen_at TIMESTAMPTZ`
-   `last_seen_at TIMESTAMPTZ`

主键建议 `(node_id, source_id, source_item_key)`。

### `scan_runs`

每次每日完整检测的批次。

字段：

-   `id UUID PRIMARY KEY`
-   `scan_date DATE`
-   `status TEXT`
-   `node_count INTEGER`
-   `shard_count INTEGER`
-   `started_at TIMESTAMPTZ`
-   `finished_at TIMESTAMPTZ`
-   `error_summary JSONB`

### `scan_shards`

分片任务状态。

字段：

-   `scan_run_id UUID`
-   `shard_no INTEGER`
-   `status TEXT`
-   `planned_count INTEGER`
-   `completed_count INTEGER`
-   `failed_count INTEGER`
-   `started_at TIMESTAMPTZ`
-   `finished_at TIMESTAMPTZ`
-   `last_heartbeat_at TIMESTAMPTZ`
-   `error_summary JSONB`

### `scan_items`

每个 scan 中每个节点的任务状态。

字段：

-   `scan_run_id UUID`
-   `node_id UUID`
-   `shard_no INTEGER`
-   `status TEXT`
-   `attempts INTEGER`
-   `last_error_code TEXT`
-   `updated_at TIMESTAMPTZ`

主键 `(scan_run_id, node_id)`。

### `test_results`

检测历史。

字段：

-   `id BIGSERIAL PRIMARY KEY`
-   `scan_run_id UUID`
-   `node_id UUID`
-   `attempt_no INTEGER`
-   `checked_at TIMESTAMPTZ`
-   `parse_ok BOOLEAN`
-   `dns_status TEXT`
-   `entry_ips JSONB`
-   `entry_country TEXT`
-   `entry_asn BIGINT`
-   `tcp_status TEXT`
-   `proxy_status TEXT`
-   `http_status TEXT`
-   `exit_ip INET`
-   `exit_country TEXT`
-   `exit_city TEXT`
-   `exit_asn BIGINT`
-   `dns_duration_ms INTEGER`
-   `tcp_duration_ms INTEGER`
-   `http_duration_ms INTEGER`
-   `status TEXT`
-   `error_code TEXT`
-   `error_detail_redacted TEXT`

唯一约束 `(scan_run_id, node_id, attempt_no)`。

### `node_current_status`

每个节点最新状态。

字段：

-   `node_id UUID PRIMARY KEY`
-   `status TEXT`
-   `last_checked_at TIMESTAMPTZ`
-   `last_success_at TIMESTAMPTZ`
-   `last_error_code TEXT`
-   `consecutive_failures INTEGER`
-   `last_exit_ip INET`
-   `last_exit_country TEXT`
-   `last_exit_asn BIGINT`
-   `last_http_duration_ms INTEGER`

### `node_daily_stats`

每日汇总，可用率等。

字段：

-   `node_id UUID`
-   `stat_date DATE`
-   `scheduled_count INTEGER`
-   `successful_count INTEGER`
-   `failed_count INTEGER`
-   `availability_ratio NUMERIC`
-   `avg_http_duration_ms INTEGER`

主键 `(node_id, stat_date)`。

### `export_artifacts`

导出记录。

字段：

-   `id UUID PRIMARY KEY`
-   `format TEXT`
-   `filter_spec JSONB`
-   `created_at TIMESTAMPTZ`
-   `expires_at TIMESTAMPTZ`
-   `storage_key TEXT`
-   `status TEXT`

## 8.2 索引

至少创建：

``` sql
CREATE INDEX idx_nodes_enabled ON nodes(enabled);
CREATE INDEX idx_nodes_protocol ON nodes(protocol);
CREATE INDEX idx_node_sources_source ON node_sources(source_id, last_seen_at);
CREATE INDEX idx_scan_items_shard ON scan_items(scan_run_id, shard_no, status);
CREATE INDEX idx_test_results_node_time ON test_results(node_id, checked_at DESC);
CREATE INDEX idx_scan_runs_date ON scan_runs(scan_date DESC);
```

## 8.3 数据保留

建议：

-   节点资产：长期保留，软删除。
-   原始配置：节点仍保留时加密保存。
-   详细检测结果：保留 30～90 天。
-   每日统计：保留 365 天。
-   订阅版本：保留最近 10～20 个版本，或只保留 Hash 和必要元数据。
-   失效节点：保留，不立即删除。

5,000 节点每天一条检测结果，30 天约 150,000 条，不需要为此引入
ClickHouse。

------------------------------------------------------------------------

# 9. 自动命名规则

## 9.1 默认模板

``` text
{ENTRY_COUNTRY} → {EXIT_COUNTRY} | {PROTOCOL}-{TRANSPORT}-{SECURITY} | {SHORT_ID}
```

示例：

``` text
🇸🇬 SG → 🇯🇵 JP | VLESS-TCP-REALITY | N000127
🇭🇰 HK → 🇺🇸 US | VMESS-WS-TLS | N000128
🇯🇵 JP → 🇯🇵 JP | VLESS-GRPC-TLS | N000129
🇸🇬 SG → UNK | VLESS-TCP-TLS | N000130
```

## 9.2 命名规则

-   `ENTRY_COUNTRY`：根据入口解析 IP 的 GeoIP 结果。
-   `EXIT_COUNTRY`：根据出口 IP 的 GeoIP 结果。
-   `PROTOCOL`：配置解析结果。
-   `TRANSPORT`：配置解析结果。
-   `SECURITY`：配置解析结果。
-   `SHORT_ID`：创建节点时生成，永久稳定。
-   未知值统一用 `UNK`。
-   城市名作为可选字段，避免名称过长。
-   节点名称不是资产 ID。
-   修改命名模板不应改变 Node ID 或 fingerprint。

线路类型默认不放入自动名称，除非有可靠证据或人工标注。

------------------------------------------------------------------------

# 10. Dashboard 与 API

## 10.1 Dashboard 页面

1.  **Overview**
    -   节点总数
    -   UP / DOWN / UNKNOWN / UNSUPPORTED 数量
    -   最近完整扫描时间
    -   扫描进度和错误摘要
    -   国家/地区分布
2.  **Sources**
    -   添加/编辑订阅
    -   添加单节点 URI
    -   上传文件
    -   启用/暂停来源
    -   最近同步时间
    -   内容 Hash 和解析错误
3.  **Nodes**
    -   搜索节点
    -   按入口、出口、协议、传输、安全类型、ASN、状态筛选
    -   批量重命名
    -   手动禁用/启用
    -   查看来源数量
4.  **Node Detail**
    -   原始名称（脱敏或受保护）
    -   规范名称
    -   入口信息
    -   出口信息
    -   最近检测结果
    -   历史状态变化
    -   来源关系
5.  **Scans**
    -   每日扫描批次
    -   每个 shard 状态
    -   成功/失败/待处理数量
    -   环境错误
    -   重试入口
6.  **Naming Rules**
    -   模板配置
    -   预览
    -   批量应用
    -   名称变更历史
7.  **Exports**
    -   Mihomo YAML
    -   sing-box JSON
    -   VLESS/VMess URI
    -   CSV / JSON
    -   仅可用节点
    -   按国家/协议筛选

## 10.2 API 建议

``` text
GET    /api/health
GET    /api/overview
GET    /api/sources
POST   /api/sources
PATCH  /api/sources/{id}
POST   /api/sources/{id}/sync

GET    /api/nodes
GET    /api/nodes/{id}
PATCH  /api/nodes/{id}
POST   /api/nodes/import

GET    /api/scans
POST   /api/scans
GET    /api/scans/{id}

GET    /api/naming-rules
PUT    /api/naming-rules

GET    /api/exports
POST   /api/exports
GET    /api/exports/{id}
```

订阅导出必须鉴权，不能公开暴露包含节点认证信息的 URL。

------------------------------------------------------------------------

# 11. 安全要求

1.  不将节点 URI、UUID、密码、订阅 URL 写入日志。
2.  GitHub Secrets 保存数据库连接串、加密密钥、指纹密钥。
3.  Cloudflare Worker Secrets 保存 API 所需密钥。
4.  公开 GitHub 仓库不得包含真实节点数据或真实订阅 URL。
5.  不要配置 `pull_request` 工作流来执行需要生产 Secrets 的任务。
6.  GitHub Actions 仅对受信任的默认分支运行定时任务和手动任务。
7.  使用最小权限 `GITHUB_TOKEN`。
8.  使用 `concurrency` 防止每日任务重叠。
9.  Mihomo Controller 只绑定 localhost，设置随机 Secret。
10. Worker 使用临时目录，任务结束清理临时配置。
11. 数据库加密密钥和 HMAC 密钥分开管理。
12. 定期备份数据库；备份也必须加密。
13. Dashboard 应启用访问控制，优先考虑 Cloudflare Access
    或可靠的单管理员认证。
14. 导出链接使用高熵随机 Token，可撤销、可过期。
15. 订阅抓取要限制 URL、重定向、文件大小和超时，防止 SSRF。
16. 检测范围限制在用户明确导入且有权使用的节点端点。

------------------------------------------------------------------------

# 12. 成本控制策略

目标是尽量使用免费额度，不承诺永久 \$0。

## 12.1 主要成本来源

  成本             优化
---------------- ---------------------------------------------
  GitHub Actions   公共仓库标准 Runner；私有仓库先核算分钟额度
  Neon             Free 计划、批量写入、限制连接、清理历史
  Cloudflare       静态 Pages、轻量 Worker API
  GeoIP            本地 MMDB、按 IP 缓存
  网络流量         不做下载测速，只请求小型 Echo
  Runner 并发      从 4 个 Worker 开始压测，不盲目开高并发
  数据库请求       每批写入，避免每节点多次往返
  订阅解析         内容 Hash 未变时跳过解析

## 12.2 免费方案限制

-   GitHub 公共仓库代码公开；节点数据必须留在私有数据库和 Secrets 中。
-   私有仓库 GitHub Actions 免费分钟数有限，需按账户计划核算。
-   GitHub-hosted Runner 使用共享、动态公网出口
    IP，某些节点服务可能无法从该网络访问。
-   GitHub schedule 不是严格准点调度，必须支持手动触发和运行状态告警。
-   Neon/Cloudflare 免费额度可能调整，部署时重新核实。
-   若 GitHub Runner 出口被节点服务商限制，先判断是否为服务商策略或
    Runner 网络问题；不要直接把所有节点标记 DOWN。
-   如果免费 Runner 不可用，再评估 Cloud Run Jobs
    或其他按需容器服务，不要提前增加付费基础设施。

## 12.3 成本监控

Dashboard 或日志至少记录：

-   每次 Action 总运行分钟数。
-   每个 Shard 执行时间。
-   节点平均检测耗时。
-   数据库存储增长。
-   数据库连接错误。
-   Echo 请求数量。
-   订阅下载字节数。
-   失败率和环境错误率。

------------------------------------------------------------------------

# 13. 项目目录结构

建议：

``` text
node-monitor/
├── .github/
│   └── workflows/
│       ├── daily-check.yml
│       └── manual-check.yml
│
├── app/
│   ├── cli.py
│   ├── config.py
│   │
│   ├── parsers/
│   │   ├── base.py
│   │   ├── vless.py
│   │   ├── vmess.py
│   │   ├── trojan.py
│   │   ├── shadowsocks.py
│   │   ├── base64_subscription.py
│   │   ├── clash_yaml.py
│   │   └── singbox_json.py
│   │
│   ├── ingestion/
│   │   ├── fetcher.py
│   │   ├── source_sync.py
│   │   └── normalizer.py
│   │
│   ├── fingerprint/
│   │   └── generator.py
│   │
│   ├── checker/
│   │   ├── mihomo_manager.py
│   │   ├── entry_checker.py
│   │   ├── proxy_checker.py
│   │   ├── exit_checker.py
│   │   ├── echo_client.py
│   │   └── geoip.py
│   │
│   ├── naming/
│   │   ├── template.py
│   │   └── renderer.py
│   │
│   ├── scheduler/
│   │   ├── scan_creator.py
│   │   ├── shard_planner.py
│   │   └── finalizer.py
│   │
│   ├── database/
│   │   ├── models.py
│   │   ├── repository.py
│   │   └── migrations/
│   │
│   ├── exporters/
│   │   ├── mihomo.py
│   │   ├── singbox.py
│   │   ├── uri.py
│   │   └── csv_json.py
│   │
│   └── security/
│       ├── encryption.py
│       ├── redaction.py
│       └── url_validation.py
│
├── cloudflare/
│   ├── echo-worker/
│   │   └── src/index.ts
│   └── api-worker/
│       └── src/index.ts
│
├── web/
│   └── dashboard/
│
├── scripts/
│   ├── create_admin.py
│   ├── import_local_file.py
│   └── verify_environment.py
│
├── tests/
│   ├── fixtures/
│   │   ├── sample_vless.txt
│   │   ├── sample_vmess.txt
│   │   ├── sample_clash.yaml
│   │   └── sample_singbox.json
│   ├── test_parsers.py
│   ├── test_fingerprint.py
│   ├── test_sharding.py
│   ├── test_naming.py
│   └── test_status.py
│
├── Dockerfile
├── pyproject.toml
├── .env.example
├── .gitignore
└── README.md
```

第一版可以先不实现完整 Dashboard，只提供 CLI、数据库和 GitHub
Actions，确认检测链路稳定后再开发前端。

------------------------------------------------------------------------

# 14. 开发与部署阶段

## M1：数据资产库

交付：

-   PostgreSQL schema/migrations。
-   Source CRUD。
-   单节点 URI 导入。
-   订阅 URL 导入。
-   VLESS/VMess parser。
-   Clash YAML / sing-box JSON parser。
-   HMAC fingerprint。
-   AES-GCM 加密。
-   节点去重和来源关联。
-   自动命名模板。
-   Parser 单元测试。

验收：

-   同一节点从多个来源导入只生成一个 Node。
-   名称不同但连接参数一致的节点可以去重。
-   不同认证参数的节点不会误去重。
-   日志和数据库普通查询不暴露明文认证信息。
-   订阅内容未变化时跳过完整解析。

## M2：单节点检测

交付：

-   Mihomo 启动和关闭管理。
-   单节点代理检测。
-   Entry DNS/IP/ASN。
-   适用时的 TCP 检测。
-   Echo endpoint。
-   Exit IP/GeoIP/ASN。
-   状态分类。
-   超时和复测。
-   检测结果写入数据库。

验收：

-   至少覆盖 VLESS TCP/TLS、VLESS Reality、VMess WS/TLS
    等实际存在的配置类型。
-   能区分入口 TCP 成功但代理不可用的情况。
-   Echo 请求确实通过指定节点发出。
-   入口与出口 IP 不会串号。
-   Echo/Runner 环境故障不会批量误判节点 DOWN。

## M3：批量和每日自动化

交付：

-   scan_runs。
-   scan_items。
-   scan_shards。
-   稳定分片算法。
-   GitHub Actions 动态 Matrix。
-   最大并发控制。
-   幂等写入。
-   失败恢复。
-   每日 schedule。
-   手动 workflow_dispatch。

验收：

-   100 个脱敏/授权测试节点能完成一轮检测。
-   中途杀掉一个 Worker 后可以只重试未完成分片。
-   重复启动不会产生重复节点和重复结果。
-   全部 Shard 成功才标记 scan 为完整完成。

## M4：导出和 Dashboard

交付：

-   Overview。
-   Sources 管理。
-   Nodes 列表和筛选。
-   Node Detail。
-   Scan 历史。
-   Naming Rules。
-   Mihomo YAML 导出。
-   sing-box JSON 导出。
-   CSV/JSON 导出。
-   仅可用节点订阅。

验收：

-   导出仅包含最近成功检测且未手动禁用的节点。
-   导出文件不包含内部数据库字段或敏感调试信息。
-   导出链接受鉴权且可撤销。

## M5：规模与成本验证

测试规模：

-   100 节点。
-   1,000 节点。
-   5,000 节点。

记录：

-   总运行时间。
-   单节点平均检测耗时。
-   超时率。
-   Runner 失败率。
-   数据库连接和存储增长。
-   Actions 使用分钟数。
-   实际公网流量。

不要在未实测前承诺固定运行时间或零成本。

------------------------------------------------------------------------

# 15. 第一版推荐配置

  项目                     建议值
------------------------ ---------------------------------------
  节点目标                 1,000～5,000
  完整检测                 每天一次
  Shard size               250
  最大并行                 初始 4，压测后可升到 8
  每 Worker Mihomo         1 个
  每 Worker 出口测试并发   1
  单节点阶段超时           DNS 3s、TCP 5s、HTTP 8～10s（可配置）
  失败复测                 1 次
  详细检测历史             30～90 天
  每日统计                 365 天
  数据库                   Neon PostgreSQL
  计算                     GitHub Actions
  前端                     Cloudflare Pages
  API                      Cloudflare Worker（可后置）
  下载测速                 不做

以上为初始配置，必须通过真实节点样本压测后调整。

------------------------------------------------------------------------

# 16. 需要在开发前验证的风险

1.  **GitHub Runner 网络可达性**：部分服务商可能限制共享云出口
    IP。先用少量授权节点验证。
2.  **协议兼容性**：Mihomo
    对不同协议和参数的支持范围要用真实脱敏样本确认。
3.  **Reality/TLS 参数**：解析器必须保留必要字段，不得只提取
    server/port/UUID。
4.  **Echo endpoint**：验证 Cloudflare Worker 实际返回的来源
    IP、国家、ASN 字段。
5.  **出口归属正确性**：测试必须保证某个节点的出口 IP
    不会被记到另一个节点名下。
6.  **订阅格式差异**：同一个协议可能存在多种 URI 编码和 YAML
    写法，必须使用 fixture 测试。
7.  **数据库免费额度**：监控 Neon 的计算、存储和网络额度。
8.  **GitHub schedule 可靠性**：提供手动触发和运行失败提示。
9.  **订阅 URL 安全**：防止 SSRF、重定向和超大响应。
10. **免费方案不是永久承诺**：平台价格和额度可能调整，需保留替换计算平台的能力。

------------------------------------------------------------------------

# 17. 给 Codex 的第一条开发指令

建议将本文档放入仓库根目录，命名为 `PROJECT_SPEC.md`，然后向 Codex
提出：

>

------------------------------------------------------------------------

# 18. 最终原则

这个系统的核心不是"尽可能多地运行测速任务"，而是：

-   一个节点只维护一份资产。
-   一个节点每天只需要完整检测一次。
-   一个节点可以关联多个订阅来源。
-   每次检测都有可追溯记录。
-   入口与出口是观测数据，不是猜测。
-   线路标签必须有证据。
-   检测失败不等于节点永久失效。
-   计算任务结束后不保留常驻 Worker。
-   免费额度不足时能够替换计算平台，而不需要重写业务逻辑。

**建议先实现一个可靠的 100 节点版本，再扩展到 5,000 节点。**
