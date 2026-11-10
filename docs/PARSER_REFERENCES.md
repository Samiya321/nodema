# 订阅解析参考与兼容边界

本地上传、粘贴文本和远程 HTTP(S) 订阅取得字节后，都调用 `app.parsers.parse_document`。远程抓取仍经过原有 URL/DNS/重定向、响应大小和时限检查；格式适配器不联网、不执行脚本，也不递归下载配置里的 provider 或远程订阅。

## 参考源码

2026-11-09 对照以下固定提交，避免参考行为随上游更新变化：

| 项目 | 提交 | 对照部分 | 上游许可 |
| --- | --- | --- | --- |
| [Sub-Store](https://github.com/sub-store-org/Sub-Store) | `2888806251d90d45eabf2baf7a7fd4e8be2a4787` | [Loon](https://github.com/sub-store-org/Sub-Store/blob/2888806251d90d45eabf2baf7a7fd4e8be2a4787/backend/src/core/proxy-utils/parsers/peggy/loon.js)、[Surge](https://github.com/sub-store-org/Sub-Store/blob/2888806251d90d45eabf2baf7a7fd4e8be2a4787/backend/src/core/proxy-utils/parsers/peggy/surge.js)、[Quantumult X](https://github.com/sub-store-org/Sub-Store/blob/2888806251d90d45eabf2baf7a7fd4e8be2a4787/backend/src/core/proxy-utils/parsers/peggy/qx.js)、格式识别与 Clash/sing-box/URI 输出 | [AGPL-3.0](https://github.com/sub-store-org/Sub-Store/blob/2888806251d90d45eabf2baf7a7fd4e8be2a4787/LICENSE) |
| [subconverter](https://github.com/tindy2013/subconverter) | `a0d4eab28cb8b6c782d4ce5c3a918de4829b4a72` | [subparser.cpp](https://github.com/tindy2013/subconverter/blob/a0d4eab28cb8b6c782d4ce5c3a918de4829b4a72/src/parser/subparser.cpp) 的类型识别和 Surge/QX 文本入口 | [GPL-3.0](https://github.com/tindy2013/subconverter/blob/a0d4eab28cb8b6c782d4ce5c3a918de4829b4a72/LICENSE) |

本次依据公开格式独立实现 Python 适配器；没有复制上游源码、启动上游服务或引入 Node/C++ 解析运行时。参考工作副本位于忽略目录 `private/reference/`，不属于项目发行内容。

格式细节另对照 [Surge VMess 文档](https://manual.nssurge.com/policies/vmess.html) 与 [Loon 官方配置样例](https://github.com/Loon0x00/LoonExampleConfig/blob/master/example.conf)。Surge 的默认 VMess 加密为 `aes-128-gcm`，AEAD 默认关闭；QX 默认 cipher 为 `none`，AEAD 默认开启；Loon 使用位置参数中的 cipher 和显式 alterId，缺省 alterId 为 0。不同客户端的默认值不会混为一谈。

## 新增文本入口

`AUTO` 可识别 Loon、Surge、Quantumult X 的单行、逐行列表及 `[Proxy]` / `[server_local]` 配置段；Base64 包裹的此类文本也走同一入口。现有 URI、Clash YAML 和 sing-box JSON 识别优先，配置里的别名不会抢占结构化格式识别。

- 支持位置式和键值式认证字段、IPv6、引号与转义、QX 未加引号的逗号密码；含 `=` 的密码建议加引号，避免与选项分隔产生歧义。
- 映射 WS path/Host/headers、TLS/SNI、ALPN、证书验证开关、VMess AEAD/alterId、VLESS Reality/flow、UDP/TFO。AnyTLS 空闲会话参数及 Loon Hysteria2 端口范围、跳跃间隔、salamander 和带宽设置复用既有协议适配器。
- 只读取节点声明。规则、策略组、远程 provider 和脚本不会作为节点执行；引用其他代理的依赖返回 `UNSUPPORTED_DEPENDENCY`。
- 仅六种既定协议进入资产库。Snell、SOCKS 等返回逐行 `UNSUPPORTED_PROTOCOL`，保留成功项；不能据此宣称兼容上游的全部协议和处理器。
- 未知参数保留在加密 canonical identity 中并参与 HMAC；运行或导出无法表达时返回 `RUNTIME_UNSUPPORTED`。不删去认证、证书约束或未知行为来强制转换成功。

Sub-Store 的 Clash Reality `_spider-x` 是额外导出元数据。Mihomo 输出合并它时保留原 public-key 和 short-id，不允许扩展覆盖认证字段。Shadowsocks YAML 中显式 `skip-cert-verify: false` 可原样输出；不将明文 SS 的 `true` 误当作可执行 TLS 设置。其他目标格式无法保留该选项时明确拒绝。

文本入口由 `protocols-v3` 引入；当前解析器为 `protocols-v4`，并新增 [Sub-Store API 引用解析](SUBSTORE.md)。旧来源即使内容 hash 没变，下一次同步也会重新解析；不需数据库迁移或更换 AES/HMAC 密钥。针对性测试使用 `tests/fixtures/sample_{loon,surge,quantumult_x}.conf` 人工合成地址和凭据，真实订阅只保存在忽略的私有目录。
