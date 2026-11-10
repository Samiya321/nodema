# 批量订阅与 GeoIP 数据源

2026-11-11 新增；架构保持 Pages + Worker + Neon + Actions，远程下载、解析、检测均在 Actions 执行，无需常驻服务。

## 批量导入

Dashboard：「订阅与来源 → 批量导入链接」，每行一个普通订阅 URL 或 Sub-Store `/api/subs` 地址，允许混合输入，忽略空行。每批最多 100 个非空行、合计 128 KiB，每个地址最多 8 KiB；更多地址分批导入。默认来源名称为「批量订阅 行号」，可修改名称前缀。不要把凭据放在名称里。

每个地址保存为独立来源，格式为 AUTO。Sub-Store 后续提取其本地、远程与混合订阅，保留原有深度、大小、请求次数和超时限制，不执行上游脚本。批量接口只保存，不在 HTTP 请求内拉取订阅或检测节点。

空库以及同一数据库 schema 中并发的批量导入均有事务锁保护。同批和已有未删除来源中的相同规范化 URL 跳过；协议和主机大小写、默认端口会规范化，但不合并不同 query/token/path。停用来源重复导入时仍保持停用；软删除后可以重新加入。旧的单条添加接口仍允许明确创建独立来源，不对历史重复来源自动合并。

返回逐行 CREATED / DUPLICATE / INVALID、来源 ID、计数和任务状态，不返回 URL 或凭据。输入中的无效行不阻止有效行保存；数据库写入出错会回滚整个有效批次。只在新增来源时派发一次 source-sync 工作流，全为重复或无效时不派发。调度失败仍保存 sync_requested_at，可在来源列表点击同步重试。DNS、所有重定向及最终公网连接在 Actions 拉取时重新检查。

命令行：

```bash
uv run nodema source import-links --input-file private/subscriptions.txt --name-prefix 我的订阅
```

认证接口：`POST /api/sources/bulk`，JSON 格式如下（仅为合成示例）：

```json
{"name_prefix":"我的订阅","urls":"https://subscriptions.example/sub?token=synthetic-demo\nhttps://store.example/api/subs"}
```

## GeoIP

默认 `GEOIP_DOWNLOAD_PROVIDER=auto`：配置完整 MaxMind 账号/许可密钥时使用官方源，否则使用 [P3TERX/GeoLite.mmdb](https://github.com/P3TERX/GeoLite.mmdb) Release。也可显式设置 github、maxmind、disabled。Actions 从仓库同名变量读取；本地使用 `.env`。不引入新服务或付费平台。

GitHub 模式仅下载固定仓库的 City/ASN 两个 MMDB 数据文件，不复制或执行上游 workflow。先获取一次最新稳定 Release 元数据，两个文件固定同一版本，验证 GitHub 提供的 SHA-256、文件大小、MMDB 类型、build_epoch（不早于 30 天且不能明显晚于当前时间），全部通过后才替换文件。下载有来源白名单、公网 DNS 检查、字节和超时上限。SHA-256 验证能发现损坏和文件不匹配，不能证明上游发布者没有被入侵；可切换官方源。GitHub API token 仅发给 api.github.com，不传给下载重定向目标。Actions 使用自身的只读 token，不需要额外创建 PAT。

入口 GeoIP 是可选的资料补充。geoip-pack 下载/校验/加密失败返回 UNAVAILABLE 和脱敏错误码，geoip_ready=false，后续仍做健康检测，不将失败当作节点不可用。显式执行 geoip-update 下载失败则以非零状态退出。disabled 模式不下载。

准备任务只下载一次，再用现有 ENCRYPTION_KEY_B64 加密交给所有分片，artifact 保留一天；不把 MMDB 放入 Git、公开发布包或长期缓存。首次使用本地命令 `uv run nodema geoip-update` 后，设置 GEOIP_CITY_PATH 与 GEOIP_ASN_PATH 指向 private/geoip 中的 City/ASN 文件。

### 数据署名与许可

This product includes GeoLite Data created by MaxMind, available from https://www.maxmind.com.

社区数据源 README 将数据库列为 MaxMind 数据，并链接 [GeoLite EULA](https://www.maxmind.com/en/geolite/eula) 与 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)。数据库受其数据条款约束，上游下载脚本的 MIT 许可不覆盖数据库。Nodema 没有复制上游脚本，也不在源码仓库重新分发 MMDB。页面包含 MaxMind 署名。

IP 地域和 ASN 只是观测资料，不证明物理位置、线路或大陆可达性；不会据此猜测 IPLC/IEPL/CN2。

## 验证记录

- 全量 300 项 Python、33 项 Worker、3 项 Echo 测试通过，包含真实 PostgreSQL 的并发批量去重、重复提交、无效行和调度失败保留请求。
- 本地实际一次保存 100 个合成订阅，浏览器完成混合批量提交、逐项结果、重复提交、390px 布局和弹窗关闭后的焦点恢复。
- 实际获取 GitHub 的 2026.11.10 Release，City/ASN 的 SHA-256、数据库类型与数据日期均校验通过；约 59 MB 加密包的安装及公开 IP 查询通过。数据文件仅留在忽略的 private 目录，未进入源码。
- 本次无数据库结构变更，迁移 head 保持 0013_export_usage。以上验证未使用用户真实订阅或节点。
