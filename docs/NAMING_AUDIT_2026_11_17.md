# 2026-11-17 节点命名归属审核

结论：名称与当前保存字段的拼接一致，但国家箭头和运营商简称存在明确的语义/归属问题，不能整体认定为已验证的物理路线和运营商。

范围：基线 `ea5d573`，生产 schema `0022_uk_probes`；北京时间 2026-11-17 约 01:54 的只读审核。当前状态表 42,010 行，重点核对 1,391 个启用且 36 小时内可用的节点；资产总数与状态表行数不是同一个指标。SQL 使用只读事务、statement_timeout，仅输出汇总。无生产写入、改名、重新检测或订阅重建。本轮不改变实现，也不部署运行代码。

私密汇总在本机 `private/naming-audit-20261117/`（0600）；本文不含节点名、IP、域名、凭据或订阅。额外外部核验只查公开 ASN 的 PeeringDB/RIR 记录，没有将真实节点 IP 发给新服务。本机 pooled TCP 直连超时后以同一数据库的既有 direct owner 配置完成只读查询；生产认证 readiness 为真。

## 当前名称的实际含义

默认模板：`{FLAG}{ROUTE}|{OPERATOR} {SEQ}{VARIANT}`。

- FLAG：落地国家，不是入口国家。
- ROUTE：入口国家与落地国家不同则拼 `入口->落地`；相同只写一个。入口未知也只写落地，目前两种情况无法从名字区分。
- OPERATOR：`落地 IP 的 org 简称|落地 ASN 的组织简称`，相同时省略 org。它不是“入口运营商|落地运营商”，也不证明机场品牌、上游拓扑或真实中转路径。
- 入口国家/ASN：每日检测 DNS 结果中第一条地址的 MaxMind GeoLite 归属；这不是实际 socket 对端地理位置的测量。当前 1,391 个可用节点没有多国家/多 ASN 的 DNS 集合；全状态集合有 124/163 个，不能假定所有节点始终只有一种入口归属。
- 落地 IP：经代理访问 Echo 后实际观察到的公网来源 IP。国家/ASN/组织优先来自 Cloudflare `request.cf` 元数据，缺失时回退 GeoLite。**实测的是 IP，国家/组织仍是数据库元数据。**
- ip-api 的 org/ISP/AS 缓存用于组织、地区等补充；当前所涉成功缓存均在 30 天内。ip-api 的 `isp`、`org`、`as` 是不同字段，名称没有直接显示 ISP 字段，不能把 org 和 AS 品牌简单等同。

代码入口：`app/checker/health.py:371`（入口）、`:494`（落地归属优先级）、`app/naming.py:39`（路线）、`:81`（OPERATOR）、`app/scans.py:1027`（缺失字段保留）。生产渲染和 ASN/组织缩写在 migration 0014/0016 创建的 SQL 函数中；如实施修正应加新迁移，不能编辑历史 migration。

## 生产发现

各项会重叠，不能相加当成错误节点总数。

| 优先级 | 发现 | 生产证据与判断 |
| --- | --- | --- |
| P1 | 同一 IP 显示两个国家，产生未经证明的跨国箭头 | **91 个节点 / 25 个 IP** 的入口只有一个 IP，且与出口 IP 完全相同，但入口国家和落地国家不同。例：同一 IP 的 GeoLite=GB、Echo=NL、ip-api=NL，涉及 11 个节点；另有 GB/JP/GB，涉及 5 个。国家不一致只能证明归属源冲突，不能据此认定中转。任播/同 IP 也不能证明同一物理机房，正确做法是避免名字声称未测得的路线，详情保留冲突证据。 |
| P1 | ASN 组织文本不能稳定代表该 ASN 的运营商品牌 | **28 个节点 / 10 个 ASN** 被缩成 `Private`（源文本是 `Private Customer`），不是有效品牌。AS141995 的 34 个节点中，24 个叫 Contabo、9 个叫 Private、1 个叫 Cogent；公开网络记录为 Contabo Asia。AS40676 的 ASN 简称目前为 OneProvider（2 个节点），其 PeeringDB 网络记录是 Psychz Networks。数值 ASN 与自由组织文本之间需要独立校验。 |
| P2 | 地理库存在显著分歧，不能宣布其中一方必然正确 | Echo 与 ip-api 的国家归属有 **50 个节点**不一致；Echo 与本次 GeoLite 出口归属有 **143 个节点**不一致。与入口同一 IP 的 91 个包含在这种不一致里。不能盲目用多数票/换一个库宣称已确认机房位置。 |
| P2 | ASN 来源有分歧 | Echo 与 ip-api 的 ASN 有 **16 个节点**不一致。部分确为同集团（如 Google 的 AS19527 与 AS43515），不能把 16 个全部算成“品牌错误”。当前没有发现缺 org 时直接套用不同 ASN 的 ip-api as_org 的实例；但代码存在该未校验 fallback，建议修正时加 ASN 相等条件。 |
| P2 | 入口未知被省略 | **58 个节点**入口国家未知但落地已知；当前渲染结果与“入口落地同国”一样，用户容易把单个国家代码读成两端同国。应显示未知入口或明确标注。 |
| P2 | 老落地身份随最新代理成功继续展示 | **21 个节点**这轮只通过备用探测，却保留历史落地；这 21 个的实际出口 IP 最近观测都早于 36 小时，来自北京时间 11-14 09:16 至 11-15 07:31。保留历史符合既有决策，但需要单独标明归属观测时间，不能让“最近检测”代替出口元数据的新鲜度。 |
| P3 | 缩写规则有信息损失和重复 | org_short 删除泛词、国家词及括号，主要取第一个剩余词；同一品牌分词不同可能形成重复组合。生产如 org 短名 Idea 与 ASN 短名 Ideahost 的组合有 41 个节点。个别人名/客户标识不适合直接显示成运营商品牌。 |

内部一致性检查：可用节点的名称 server_key、国家、ASN 简称、org 简称与 SQL 现行命名输入相比，**错位/未更新计数均为 0**；同出口 IP 的当前国家/ASN 冲突组数也为 0。因此主要问题不在字符串拼反或漏调用命名刷新，而在数据源冲突、别名生成和语义表达。

本次可用节点使用的 GeoLite City 构建时间为北京时间 11-10 15:21，ASN 为 11-12 16:15。库按项目现有缓存周期更新，不是实时地理真值。

## 建议的修正顺序（尚未实施）

1. 命名层遇到单一入口 IP=出口 IP 时，不再仅因两套地理库不同就输出跨国箭头；选用明确标注来源的一国展示，并在详情说明归属冲突。不同 IP 的国家差异也只称“入口/出口归属”，不称已证明的中转线路。
2. 对同一数值 ASN 使用稳定、经公开网络/RIR 核对的规范名；`Private Customer` 等泛化描述回退 `AS<number>`，不能作为运营商品牌。AS40676、AS141995 等已有明确证据的别名优先核对。org/ISP/ASN 组织分别展示；不靠模糊词猜网络商。
3. 入口未知与同国分开；落地属性分别附来源和最后观测时间，保留历史资料但标注历史性质。
4. 检查修改对 Python、SQL、Worker、目录筛选和订阅名称的影响。改名前做影响清单和隔离回归，保持节点资产 ID/指纹/订阅 token；不为审核直接批量重命名或覆盖全部 GeoIP 数据。

这次只完成审核和证据归档，未把建议写成用户已经确认的新命名政策。

## 外部核验依据

- [Cloudflare Request 元数据说明](https://developers.cloudflare.com/workers/runtime-apis/request/#incomingrequestcfproperties)：country/asn/asOrganization 是请求元数据；它不提供代理链路内部路径。
- [MaxMind GeoIP 地理准确度说明](https://support.maxmind.com/knowledge-base/articles/maxmind-geolocation-accuracy)：地理库有准确度与粒度局限，不能把国家/城市位置当作物理机房证明。
- [ip-api 字段定义](https://ip-api.com/docs/api:batch)：isp、org、as 分别定义，不应混称。
- [AS40676 Psychz Networks](https://www.peeringdb.com/asn/40676)、[AS141995 Contabo Asia](https://www.peeringdb.com/asn/141995)、[AS3257 GTT](https://www.peeringdb.com/asn/3257)、[AS3356 Lumen](https://www.peeringdb.com/asn/3356)：用于核对品牌，不据注册/设施国家替换 IP 地理数据。
- [ARIN AS63150](https://rdap.arin.net/registry/autnum/63150) 的公开名称为 BAGE；[ARIN AS19527](https://rdap.arin.net/registry/autnum/19527) 与 [RIPE AS43515](https://rdap.db.ripe.net/autnum/43515) 对照说明 ASN 不同不一定是不同运营商集团。


## 后续用户授权与修复

本审核完成后，用户明确要求“你自己想办法修复一下吧”。后续实现见 [归属命名规则](IDENTITY_NAMING.md)，新迁移 `0023_identity_naming`；本文的“未实施/未改名”仅描述原只读审核阶段。发布状态与生产复核见 STATUS/CLOUD_DEPLOYMENT。
