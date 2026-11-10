# 明文存储与节点收录、可用天数

生效日期：2026-11-09。用户明确选择数据库明文存储；本页覆盖原规范及历史文档中的数据库 AES 要求。运行时已实现，明文转换迁移为 `0009_plaintext_lifetime`，当前 head 为 `0011_scan_archives`。Actions 异步生成与扫描归档已实现，见 [ASYNC_SUBSCRIPTIONS.md](ASYNC_SUBSCRIPTIONS.md)。

## 日期与可用率

| 字段 | 含义 |
| --- | --- |
| `first_seen_at` | 该连接身份首次入库的时间；跨来源去重、改名、来源消失后再出现均不重置 |
| `age_days` | 已收录天数，按北京时间的日历日计算，首次入库当天为第 1 天；每天查询时派生，无需任务更新 |
| `checked_days` | 已发布的日检测结果中，有明确成功或失败的日期数量；同一天只计一次 |
| `available_days` | 上述日期中，日统计包含成功检测的日期数量，成功包括 UP/DEGRADED |
| `lifetime_availability` | `available_days / checked_days`，API 值为 0–1，页面显示百分比；没有检测样本时为 null |

例如已收录 30 天，其中 20 天有明确检测结果、18 天可用，则显示已收录 30 天、累计检测可用率 90%、可用 18 / 已检测 20 天。未检测、冷却跳过、Runner 能力不足、未知结果和未完成批次不冒充成功或失败。它是按检测日期统计的可用率，不是 24 小时连续在线率，也不代表大陆可达性。

`checked_days` / `available_days` 作为节点上的累计计数保存，由每日统计插入/修改的 PostgreSQL 触发器以差额维护。重复 finalize 和原值更新不会重复计数；清理旧日统计不会扣减累计值。分页、筛选和排序不需要每次扫描全部检测历史。升级时只能回填数据库中仍保留的日统计，已清理的历史不补造。

节点列表、详情及 JSON/CSV 报告均包含上述字段。新增筛选：`min_age_days`、`min_checked_days`、`min_available_days`、`min_lifetime_availability`；新增排序：`age_days`、`checked_days`、`available_days`、`lifetime_availability`，以及既有 `first_seen_at`。与协议、入口/出口、线路声明等条件组合使用。

示例筛选文件（只含非敏感查询条件，可自行保存）：

```json
{"min_age_days":30,"min_checked_days":20,"min_lifetime_availability":0.9}
```

```bash
uv run nodema node list --filters-file private/reliable-filters.json --sort lifetime_availability:desc,checked_days:desc,age_days:desc --with-total
uv run nodema export create --format mihomo --filters-file private/reliable-filters.json --sort lifetime_availability:desc,checked_days:desc --limit 20
```

导出仍只接受当前启用、有有效来源、结果新鲜的 UP 节点；高历史可用率不会使当前失效节点进入订阅。原有最近七天同 Runner 测点成功率继续保留，和本页累计日可用率分开显示。

## 数据库存储

来源 URL/原始内容、Node canonical JSON、来源别名、人工依据、导出成品均改为明文存储，列名改为 `url_data`、`payload_data`、`config_data`、`aliases_data`、`reference_data`。这些列沿用 bytea 保存原始字节或 UTF-8 文本/JSON，保留内容及指纹完全一致；例如可用 `convert_from(config_data,'UTF8')::jsonb` 在 PostgreSQL 中查看节点配置。它们不是加密数据。

Python 普通入库、检测和导出不读取 AES 密钥。Worker 不再配置 AES Secret。HMAC fingerprint 仍用于稳定去重，`FINGERPRINT_KEY_B64` 继续提供给 Python/Actions；管理员认证、订阅 token hash、撤销和有效期继续生效。明文数据库不等于公开 API，普通列表/报告仍不附带认证配置，真实配置不写 Git 或普通日志。

AES 模块仅保留给旧库转换、加密备份和受许可 MMDB 的加密 artifact。数据库改明文不会自动将 GitHub artifacts 改成明文。

## 升级

新空库无需 AES：配置数据库、HMAC 和管理员信息后运行 `uv run alembic upgrade head`。

旧版已有密文时：

1. 暂停来源修改和 Actions 写任务，私下保存数据库备份及原 AES/HMAC 密钥。
2. 在迁移进程私下环境中保留原 `ENCRYPTION_KEY_B64`，执行 `uv run alembic upgrade head`。迁移对数据表加锁、分批解密并改列名，在单事务中完成；错误或缺失密钥会整体回滚，不删除节点或生成替代 ID。
3. 更新 Worker、Pages 和 Python 任务到同一版本，再恢复调度。校验节点数量、原 ID、来源、筛选和导出；Worker 不再需要 AES Secret。
4. 若继续使用数据库加密备份或 MMDB 加密包，Actions 仍保留相应 AES 密钥；否则普通运行不再依赖它。HMAC 密钥保持不变。

回退到旧 schema 时，需要 AES 密钥重新加密现有内容。旧 schema 不支持累计计数；其后重新升级只能从仍保留的日统计回填。不要把 schema 回退当作完整历史恢复。

## 验证范围

使用合成数据验证明文读写、无 AES 的 API 初始化、Python/Worker 互读、日期边界、组合筛选/排序、报告字段、日计数修正/幂等、历史清理后累计值保留、旧密文转换及错误密钥事务回滚。真实 pg_dump/pg_restore 也验证累计计数不会因恢复触发器而加倍。没有修改用户生产数据库或提交真实节点。
