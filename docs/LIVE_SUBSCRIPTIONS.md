# 六份授权订阅的本地验证

2026-11-09，使用用户提供的六份订阅，S1–S6 按原消息的链接顺序编号。远程抓取、Python 解析、AES-GCM/HMAC 入库、PostgreSQL 分片检测及导出均实际执行。这里仅保留汇总，订阅地址、原始名称、凭据、入口地址和实际出口 IP 不放入公共报告或 fixtures。

## 导入与检测结果

| 来源 | 内容格式 | 可解析条目 | 唯一资产 | 不支持的协议条目 | UP | DOWN | 运行选项不支持 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| S1 | Loon | 19 | 19 | 2 | 18 | 1 | 0 |
| S2 | Quantumult X | 7 | 7 | 0 | 0 | 7 | 0 |
| S3 | Surge | 19 | 19 | 7 | 18 | 1 | 0 |
| S4 | Clash YAML | 13 | 13 | 0 | 4 | 5 | 4 |
| S5 | sing-box JSON | 203 | 199 | 2 | 0 | 199 | 0 |
| S6 | Clash YAML | 2 | 2 | 0 | 1 | 1 | 0 |
| 合计 | | 263 | 259 | 11 | 41 | 214 | 4 |

S5 的四条重复配置归并至既有资产，没有重复检测；五条 direct/block/dns/策略组等非节点出站被忽略。11 条协议问题来自 SOCKS/Snell，未扩展六协议范围。各来源的本地快照重新解析后，规范化 HMAC 集合与远程导入的数据库资产逐一一致。

检测共 11 个分片，最多四个同时执行，473 次尝试，所有分片与批次正常完成。214 个普通失败节点各复测一次；检测墙钟约 754 秒。Echo 使用 ipify 的小型 HTTPS JSON 响应，UP 必须经代理获取公网出口 IP；没有测速。未配置 MMDB，地区和 ASN 缺失保持未知，不猜线路类型。

DOWN 的最终阶段为：96 个入口 DNS 不存在或没有可用回答；118 个代理 HTTPS 请求失败，其中 81 个入口 TCP 也失败，35 个入口 TCP 成功，2 个 QUIC 节点的 TCP 不适用。此处 DOWN 只代表该时间、开发机网络及指定 Echo 下的结果，不能证明节点在其他地区永久失效。

另抽取 S4 的 Trojan/Hysteria2、S6 的 VLESS 失败节点，用原始 Clash 节点配置直接启动 Mihomo，再与转换后的配置分别请求同一 Echo；两种配置均在相同阶段失败。未通过删除 SNI、关闭验证或去掉认证来制造成功结果。

## 发现并修正的问题

1. 原 AUTO 入口把 Loon、Surge、QX 文本误当成 Base64。新增共用文本适配器，支持配置段、位置认证字段和键值参数，远程与本地走同一实现。
2. 处理 QX 逗号密码、包含 `=` 的引号名称、IPv6、引号转义，以及 Surge 导出中嵌套引号的 `ws-headers`。后者已用真实样本重新核对，fixture 中仅保留合成写法。
3. 按各客户端保留 VMess cipher/AEAD 默认值；显式冲突、重复字段和代理依赖报出固定错误码。
4. Sub-Store Reality `_spider-x` 附加元数据可在 Mihomo YAML 保留，不再使 S6 整体被拒绝；合并时不能覆盖公钥或 short-id。
5. 兼容 SS 中显式 `skip-cert-verify: false` 的原样 Mihomo 输出，并补齐 Python/Worker 一致性测试。SS 中未建立等价语义的其他 TLS 设置仍拒绝转换。

解析器版本为 `protocols-v3`，升级后重新同步会重新解析，即使远程内容 hash 没变；本次不更改数据库结构和密钥。参考源码、固定提交及许可记录见 [PARSER_REFERENCES.md](PARSER_REFERENCES.md)。

## 仍然明确拒绝的组合

S4 的四份配置保留在资产库，但不冒充已完成网络检测：一份 VLESS 带 `block-quic`，一份 Hysteria2 带 `ecn`，两份 SS 的根级 `skip-cert-verify: true` 未建立可靠映射，其中一份还包含 ShadowTLS 和 `udp-port`。这些字段保留在加密身份中；不通过删除它们绕过检查。导入六种协议不等于支持所有客户端私有选项。

Mihomo 私有订阅成功包含 41 个 UP 节点，JSON/CSV 各包含 41 项。全量 sing-box 与 URI 导出遇到不可完整表达的原生字段（包括 UDP 开关和 Reality 附加元数据）返回 `RUNTIME_UNSUPPORTED`，不会静默丢字段，也不会输出一个不完整的成功订阅。因此这两种格式对本批数据尚不能直接全量导出，应使用 Mihomo 格式。

## 回归与本地数据

- Python 188 项测试通过，包含三种新文本格式经上传、粘贴及远程来源进入真实 PostgreSQL 的回归；本地与远程的抓取边界分开测试。
- Worker 20 项测试、类型检查及 Python/TypeScript 转换一致性通过。
- 固定 Mihomo v1.19.33 的 19 个 loopback 真实握手与 HTTPS 用例通过；Ruff、Python 格式及修改的 TypeScript/JS 格式检查通过。
- 参考副本位于忽略目录 `private/reference/`；真实抓取内容仅以 AES-GCM 密文保存于忽略目录 `private/live-validation-abb585e4a271/`，私有运行配置为 0600，父目录为 0700。没有将真实内容复制到测试 fixture 或 Git。
- 数据库另保存为私有 AES-GCM 快照 `database.nma`，加密后已解密比对；如需复查，可在独立 PostgreSQL 中恢复。临时 PostgreSQL 容器 `nodema-live-tests` 已停止并自动移除。交付文件逐项检查，未发现本批真实 URL、主机、UUID、密码或 Reality 公钥。
- 安全汇总数据见 [2026-11-09-subscriptions.json](validations/2026-11-09-subscriptions.json)。本次没有部署或修改 Cloudflare/GitHub/Neon 生产资源。
