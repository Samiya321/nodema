# 来源分类、机场、Sub-Store、命名与手动流水线

2026-11-11 的用户决策和实现（迁移 `0014_sources_airports_naming`）。覆盖早期“导入即检测”“来源移除即停测”的设计。

## 1. 手动流水线：导入不再启动 Actions

| 操作 | 之前 | 现在 |
| --- | --- | --- |
| 新增/批量导入/编辑/单个“同步”来源 | 立即 dispatch `source-sync.yml`（实际是完整检测流水线） | 只写 `sync_requested_at`，不启动任何 Actions |
| 顶部“同步来源” | — | dispatch `source-sync.yml`：只拉取、解析、生成 Sub-Store 子来源、刷新机场流量，然后发布订阅；不检测 |
| 顶部“检测 · 自建/机场/全部” | 只有一个“开始检测” | dispatch `daily-check.yml`，输入 `scope`；先同步待同步来源，再创建 **MANUAL** 批次 |
| 每日 04:17 定时 | 检测全部 | 读取设置页 `app_settings`：默认 **开启、仅自建**；可关闭或改为机场/全部 |
| 订阅方案保存/重试 | dispatch `export-build.yml` | 不变（用户明确操作） |
| 来源/节点编辑后的订阅重建 | 每次写入都尝试 dispatch | 只在有订阅链接因失效而停止服务时 dispatch；陈旧但仍可用的文件等下一次流水线 |

`source-sync.yml` 与 `export-build.yml` 都有并发组（最多 1 个运行 + 1 个排队），重复点击会合并。

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
- 序号由 `node_names` 持久化：按（入口, 落地, ASN 简称）分组，新成员取组内最大号 + 1，节点失效不重排；节点落地变化时移到新组取新号。保证同组名称唯一（客户端要求代理名唯一）。
- SQL `nodema_render_name()` 是唯一的生产渲染器；Worker 预览与校验都调用 SQL，Python `render_name` 只做本地镜像。迁移把仍是旧默认模板的 `naming_rules` 改为新默认。
- 预留字段：之后可加入线路标注字段；仍不自动推断 IPLC/IEPL/CN2。

## 7. 检测速度与稳定性（同批改动）

- 生产事故 run 42907816991：一个节点入口域名 DNS 超时被当作 Runner 环境故障，整片中止并丢弃全部结果。现在单节点 DNS/核心错误按节点处理（重试一次后 DOWN/UNKNOWN）；只有共享的直连 Echo 探针失败（20 秒缓存）或连续 6 个核心错误才中止分片。
- 滑动窗口替代每 16 个一批的屏障，失败节点在末尾统一重试一次（不再每批 sleep 10 秒）；默认并发 16、分片 100（200 个节点约 2 个 Runner 并行）；单个 Mihomo 崩溃会重启重试一次。
- 结果约 1 秒内提交；批次未完成时先发布已确认的可用结果，失败结果仍等批次完整，避免环境故障误判 DOWN。
