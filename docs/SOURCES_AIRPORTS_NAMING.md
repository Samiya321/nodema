# 来源分类、机场、Sub-Store、命名与手动流水线

2026-11-11 的用户决策和实现（迁移 `0014_sources_airports_naming`）。覆盖早期“导入即检测”“来源移除即停测”的设计。

## 1. 手动流水线：导入不再启动 Actions

| 操作 | 之前 | 现在 |
| --- | --- | --- |
| 新增/批量导入/编辑/单个“同步”来源 | 立即 dispatch `source-sync.yml`（实际是完整检测流水线） | 只写 `sync_requested_at`，不启动任何 Actions |
| 顶部“同步来源” | — | 先把**全部启用来源**标记为待同步（来源页/Sub-Store 页可只同步所选，Sub-Store 连同其子来源），再 dispatch `source-sync.yml`：只拉取、解析、生成子来源、刷新机场流量，然后发布订阅；不检测 |
| 节点页“检测所选”/详情“检测此节点” | — | 写入带 `node_ids` 的检测请求，单独建一个 MANUAL 批次，只测这些节点 |
| 顶部“检测 · 自建/机场/全部” | 只有一个“开始检测” | dispatch `daily-check.yml`，输入 `scope`；先同步待同步来源，再创建 **MANUAL** 批次 |
| 每日 04:17 定时 | 检测全部 | 读取设置页 `app_settings`：默认 **开启、仅自建**；可关闭或改为机场/全部 |
| 订阅方案保存/重试 | dispatch `export-build.yml` | 不变（用户明确操作） |
| 来源/节点编辑后的订阅重建 | 每次写入都尝试 dispatch | 只在有订阅链接因失效而停止服务时 dispatch；陈旧但仍可用的文件等下一次流水线 |

`source-sync.yml` 与 `export-build.yml` 都有并发组（最多 1 个运行 + 1 个排队），重复点击会合并。

检测请求先写入 `scan_requests` 再 dispatch：GitHub 同一并发组只保留一个排队运行，新的会替换旧的，所以范围不能只靠 workflow 输入。每次 `scan prepare`（手动或定时）都会消费全部未处理请求，每个范围恰好建一个 MANUAL 批次（请求过 ALL 时只建 ALL）；dispatch 失败时请求仍保留，顶部显示“已请求”，由下一次运行执行。

删除/暂停**自建**来源、上游移除节点（`is_present`）不再使订阅失效，也就不会触发订阅重建 Actions；只有机场来源暂停/删除或来源类别变化才会。顶部状态条只在有进行中/已请求的检测，或刚点过按钮的 10 分钟内轮询，空闲标签页不会阻止 Neon 休眠。

本地 FastAPI 只提供 API，不再托管 Dashboard（新页面依赖 Worker 的机场、Sub-Store、流水线等接口）；本地界面开发使用 Worker + Pages dev。

## 2. 检测范围与手动批次

- 节点类别 `node_group`：只要关联到任一“机场”类来源（含已删除的）即为 `AIRPORT`，否则 `SELF_HOSTED`。由视图 `nodema_node_scope` 统一定义，Python 扫描、Worker 目录和导出共用。
- `scan_runs.kind` 新增 `MANUAL`，`scan_runs.scope` 为 `ALL/SELF_HOSTED/AIRPORT`。手动批次总是重测范围内节点，只跳过仍在其他未完成批次中待测的节点；DAILY/SUPPLEMENTAL 仍按“每天每节点一次”。
- `node_daily_stats` 改为取各次结果的最大值合并（同日多批次、先部分后完整发布都幂等；一天中只要成功过一次即算可用）。

## 3. 保留语义（不再盲目用上游覆盖本地）

- 自建节点：来源暂停、删除、拉取失败、上游返回空列表或移除节点，节点都保留并继续检测；`node_sources.is_present=false` 只作为“上游已移除”提示。需要停测时停用节点（节点页支持批量）。
- 机场节点：跟随订阅状态。订阅暂停、删除、到期（`expires_at`）或流量用完（`upload+download >= total`）时不参与检测和导出（`nodema_source_usable`）。订阅续费后下一次同步刷新流量即恢复。
- 删除来源：默认保留节点（用户确认）。删除 Sub-Store 时可选择是否连同子来源。

## 4. Sub-Store 子来源

同步 `/api/subs`（或任何返回 Sub-Store 索引的地址）时，不再把子订阅合并进父来源，而是“物化”为独立子来源：

- 远程订阅 → `SUBSCRIPTION_URL` 子来源（保留条目的 UA）；本地内容 → `RAW_TEXT` 子来源。`origin_key` 为 URL/条目名的哈希，`(parent_source_id, origin_key)` 唯一。
- 已经直接导入过的同一 URL 不重复创建（计入 `shared`）。
- 之后 Sub-Store 失效、返回错误或删除条目：子来源保持不变并独立同步；缺失的条目列在父来源 `last_parse_summary.children.missing_from_index`。本地内容只在非空且变化时更新。
- `source sync-all` 会在同一次运行中最多跟进 4 轮新生成的子来源。嵌套深度上限 3。
- 父来源在物化后把自己旧的节点关联标为 `is_present=false`（历史保留，节点由子来源重新关联）。
- `SubscriptionResolver` 模块保留（单元测试覆盖），但生产同步不再使用递归合并。

## 5. 机场识别

- 拉取订阅时默认 UA 为 `clash.meta`（可按来源覆盖）。只保留以下响应头：`subscription-userinfo`、`profile-title`（支持 `base64:`）、`profile-web-page-url`（只存 origin，不存可能含 token 的路径）、`content-disposition` 文件名。
- 有 `subscription-userinfo` 即 `detected_kind=AIRPORT`；之后某次没带这个头不会降级。用户可在来源上强制 `kind=AIRPORT/SELF_HOSTED`。
- 机场分组 `providers`：按标题 → 官网主机 → 订阅主机自动归组，可在机场页改名、填官网、把订阅移动到其他或新机场。
- 机场伪节点（剩余流量、到期、官网、公告等）在机场来源中被过滤，计入 `info_nodes`。

## 6. 节点命名

默认模板 `{FLAG}{ROUTE}|{ASN} {SEQ}`，例如 `🇸🇬HK->SG|Webbing 01`、`🇭🇰HK|HKT 01`：

- `FLAG` 落地国旗；`ROUTE` 入口与落地不同时 `HK->SG`，相同时只写一个；`ASN` 落地 ASN 简称；`SEQ` 两位序号。
- ASN 组织名来自 Echo（Cloudflare `asOrganization`，需要部署新版 Echo）或 GeoLite ASN 库（同一 ASN 时）。简称顺序：用户覆盖 → 内置表（AWS、GCP、HKT、HKBN…）→ `nodema_org_short()` 启发式（去掉 Limited/Inc/地区名等，取首词）→ `AS号`。设置页可逐个修改。
- 序号由 `node_names` 持久化：按（落地国家, ASN 简称）分组（`0015` 起入口不再拆分序号，例如 `🇸🇬HK->SG|Webbing 01` 与 `🇸🇬SG|Webbing 02` 同一序列），新成员取组内最大号 + 1，节点失效不重排；节点落地变化时移到新组取新号。从未检测、没有落地信息的节点不编号，名称用节点编号代替（如 `🏳?|Unknown N000123`）。某天 GeoIP/Echo 缺字段时沿用旧值，名称不会因此跳组。导出时若仍出现同名（例如自定义模板去掉了 `{SEQ}`），自动追加节点编号，客户端不会因重名拒绝导入。
- SQL `nodema_render_name()` 是唯一的生产渲染器；Worker 预览与校验都调用 SQL，Python `render_name` 只做本地镜像。迁移把仍是旧默认模板的 `naming_rules` 改为新默认。
- 预留字段：之后可加入线路标注字段；仍不自动推断 IPLC/IEPL/CN2。

## 7. 检测速度与稳定性（同批改动）

- 生产事故 run 42907816991：一个节点入口域名 DNS 超时被当作 Runner 环境故障，整片中止并丢弃全部结果。现在单节点 DNS/核心错误按节点处理（重试一次后 DOWN/UNKNOWN）；只有共享的直连 Echo 探针失败（20 秒缓存）或连续 6 个核心错误才中止分片。
- 滑动窗口替代每 16 个一批的屏障，失败节点在末尾统一重试一次（不再每批 sleep 10 秒）；默认并发 16、分片 100（200 个节点约 2 个 Runner 并行）；单个 Mihomo 崩溃会重启重试一次。
- 结果约 1 秒内提交；批次未完成时先发布已确认的可用结果，失败结果仍等批次完整，避免环境故障误判 DOWN。

## 8. 落地服务器、IP 归属与分享二维码（迁移 `0016_servers_ipinfo_share`）

2026-11-11 用户决策：同一落地 IP 的节点共用序号并加协议后缀；落地 IP 的 org/ISP 用 ip-api.com 查询；节点详情可显示二维码供 Shadowrocket 扫码。

- **默认模板** `{FLAG}{ROUTE}|{OPERATOR} {SEQ}{VARIANT}`，例如 `🇯🇵JP|Greencloud|xTom 01 VLESS`。
  - `{OPERATOR}`：IP 归属（ip-api `org` 的简称）`|` ASN 简称；归属与 ASN 是同一家公司（简称相同，或与 ASN 组织名的简称相同）时只写 ASN，如 `🇯🇵JP|Oracle 01`。
  - `{ORG}`：单独的归属简称（可为空）；`{VARIANT}`：同一服务器有多个节点时为 ` VLESS`/` VMess`/` SS`/` Trojan`/` Hy2`/` AnyTLS`，同协议重复时 `VMess-2`，否则为空。
  - 0014 默认模板自动升级；自定义模板不变。
- **按服务器编号**：`name_servers` 以落地 IP 为键，在（落地国家, 归属, ASN）组内取最大号 + 1，节点失效不重排；节点换了落地 IP 就取新服务器的号。`node_names` 复制服务器的组与号并保存协议后缀。`nodema_assign_names()` 只在结果变化时写 `node_names`，避免无变化时触发订阅重建。0016 上线时全部重新编号一次（订阅中的名称会变化一次）。
- **ip-api**：`daily-check.yml` 的 finalize 之后和 `source-sync.yml` 同步之后都运行 `nodema ipinfo refresh`（`continue-on-error`），只查询新出现或超过 30 天的公网落地 IP（失败的 1 天后重试），每批 100 个、遇到限流即停。免费版只能 HTTP 明文、限非商业用途；落地 IP 会发送给 ip-api。返回的文本去除控制/双向字符并限长；日志只输出计数。设置 `IPINFO_ENABLED=false` 可关闭。ASN 简称仍优先 Cloudflare（Echo）的组织名，缺失时用 ip-api 的 `as` 字段。
- **分享链接**：Python 用订阅导出同一套转换器生成不含名称的 URI，存 `node_share_links`（每个节点一次，`source sync-all` 结束时及 `nodema node share-links` 补齐；URI 无法表示的配置记录原因）。订阅导出仍严格无损；分享链接只用于在手机上试用，严格转换失败时会去掉 URI 表达不了的设置再试，并在 `omitted` 记录：`CLIENT_OPTIONS`（如 Clash `udp`）、`BANDWIDTH`（Hysteria2 带宽）、`SKIP_CERT_VERIFY`（VMess 分享格式没有统一的跳过证书验证字段）。二维码弹窗会列出这些项，提示在 Shadowrocket 里手动设置。用 0016 前的生产备份演练：259 个节点中 257 个能生成链接，其中 61 个省略了上述设置。Worker `GET /api/nodes/:id/share` 只在点击时返回，附上当前名称（VMess 改写 base64 JSON 的 `ps`），`Cache-Control: no-store`。前端用内置的 `qrcode-generator`（MIT，`app/web/js/vendor/qrcode.js`）在 canvas 上绘制，不调用外部二维码服务。
- **界面**：节点页新增“按落地服务器”视图与“同服务器 ×N”标记；节点详情显示落地 IP、地区、IP 归属（org）、ISP、同服务器的其他节点，以及“二维码 / 分享”。
