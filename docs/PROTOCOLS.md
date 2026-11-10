# 协议支持范围

六种协议均已接入 Source 导入、HMAC 去重、AES-GCM 存储、Mihomo 检测、Dashboard 筛选和私有导出。

| 协议 | 分享链接 | Mihomo / Clash YAML | sing-box JSON | 检测传输 |
| --- | --- | --- | --- | --- |
| Shadowsocks | `ss://`，SIP002 与旧式完整 Base64 | `type: ss` | `type: shadowsocks` | TCP；支持列表中的加密方法和插件 |
| Trojan | `trojan://` | `type: trojan` | `type: trojan` | TCP / WS / gRPC，TLS；已映射的 Reality 参数 |
| AnyTLS | `anytls://` | `type: anytls` | `type: anytls` | TCP / TLS |
| Hysteria2 | `hysteria2://`、`hy2://` | `type: hysteria2` | `type: hysteria2` | UDP / QUIC / TLS |
| VMess | `vmess://` JSON/Base64 | `type: vmess` | `type: vmess` | TCP / WS / gRPC，明文或 TLS |
| VLESS | `vless://` | `type: vless` | `type: vless` | TCP / WS / gRPC，明文、TLS 或已映射的 Reality 参数 |

Base64 编码的订阅列表可以混合这六种协议。JSON/CSV 报告支持六种协议，只输出安全元数据。分享链接、Mihomo 和 sing-box 配置属于敏感凭据。

## Shadowsocks

- 保留不透明密码，支持特殊字符、Unicode、IPv6 地址、Base64URL userinfo 和旧式完整 Base64。
- 支持 `aes-128-gcm`、`aes-192-gcm`、`aes-256-gcm`、`chacha20-ietf-poly1305`、`xchacha20-ietf-poly1305`、三种 `2022-blake3-*` 方法及显式 `none`。这些方法均通过固定版本 Mihomo 的本地真实握手。
- 2022 分享导出使用明文 method 与百分号编码密码，遵循 [SIP002](https://shadowsocks.org/doc/sip002.html)。Base64 只是链接编码，不是密码加密。
- 支持内置 obfs（`obfs-local` / `simple-obfs` 别名，http/tls、host）和 v2ray-plugin（WebSocket、TLS、host/path、mux）已映射参数。不执行用户提供的命令或下载外部插件。
- 其他插件或未知参数会保留在加密身份中，转换时返回 UNSUPPORTED，不会静默移除。

## Trojan / AnyTLS

Trojan 支持密码、SNI、ALPN、验证开关、客户端指纹、WS path/Host/headers、gRPC service name 和已映射的 Reality 字段。带额外 headers 的配置不能导出到无法表达它们的 URI。

AnyTLS 支持密码、SNI、ALPN、验证开关、客户端指纹，以及空闲会话检查间隔、超时、最小保留数量和显式 client metadata。会话参数在 Mihomo 与 sing-box 间转换时保持秒数；不主动添加客户端标识。AnyTLS + Reality 不在运行支持范围内。[Mihomo AnyTLS](https://wiki.metacubex.one/en/config/proxies/anytls/)、[sing-box AnyTLS](https://sing-box.sagernet.org/configuration/outbound/anytls/) 提供相应字段定义。

[官方 AnyTLS URI](https://github.com/anytls/anytls-go/blob/main/docs/uri_scheme.md) 只定义基础连接参数。显式会话调优无法完整放入该 URI 时，会拒绝 URI 导出；使用 Mihomo 或 sing-box 格式可保留这些参数。

## Hysteria2

- 支持 `hy2` 别名、缺省 443 端口、百分号编码认证信息和 `username:password` 认证组合。
- 支持 SNI、ALPN、TLS 验证开关、salamander 混淆及其密码。
- 支持 URI 多端口/范围或 `mport`、Mihomo `ports`、sing-box `server_ports`；统一规范化后转换各格式的范围分隔符。
- 支持配置中的 up/down Mbps 和固定跳跃间隔。它们是用户输入的连接参数，不会启动测速或测量带宽。
- 检测跳过入口 TCP 探测，记录 `NOT_APPLICABLE`；仍必须通过代理完成轻量 HTTPS Echo 才能 UP。

带 up/down 或显式跳跃间隔的配置无法完整放入标准分享链接时，URI 导出会拒绝，Mihomo / sing-box 导出会保留。Gecko、Realm、ECH、证书 pinning、随机跳跃间隔等尚未建立可靠映射的扩展不保证运行；相关字段不会被丢弃或被当作普通密码。参见 [Hysteria2 URI](https://v2.hysteria.network/docs/developers/URI-Scheme/)、[Mihomo](https://wiki.metacubex.one/en/config/proxies/hysteria2/) 和 [sing-box](https://sing-box.sagernet.org/configuration/outbound/hysteria2/)。

## 安全与兼容

UUID 只用于 VMess / VLESS；其余四种使用独立的 password 字段，均只在加密 canonical identity 中保存。密码、混淆密钥、插件参数和其他连接字段参与 HMAC；别名不参与。现有 VMess / VLESS 的规范化身份、UUID、short_id、密文和 fingerprint version 不变。

升级前保持现有 AES/HMAC 密钥不变，执行 `uv run alembic upgrade head` 到 `0007_execution_efficiency`，再更新 Worker。协议扩展由 `0004_password_protocols` 引入，新版解析器版本为 `protocols-v4`；重新同步会解析旧来源中的新协议、文本格式及 Sub-Store API。Loon / Surge / Quantumult X 入口及默认值见 [解析参考](PARSER_REFERENCES.md)，聚合订阅见 [Sub-Store 导入](SUBSTORE.md)。包含新协议资产时，降级迁移会拒绝操作，避免丢失资产。

sing-box 未显式启用 TLS 的输入不会被自动改成 TLS。未知或无法等价转换的连接选项会显示 UNSUPPORTED；不会为了得到 UP 删除认证、证书检查、混淆或传输设置。

## 验证方法

```bash
uv run python scripts/install_mihomo.py
uv run python scripts/smoke_protocols.py
```

脚本在 loopback 启动临时 Mihomo 协议服务端、客户端和带随机 nonce 的本地 HTTPS Echo，测试六种协议、SS 加密方法，以及 VLESS Reality / Vision 的实际握手。Reality 临时 X25519 密钥由脚本生成，回落目标也只在 loopback。证书与配置仅存在权限受限的临时目录，进程结束后清理，不连接公网代理、不使用真实节点、不测下载速度。Echo 的出口元数据是测试占位数据，不代表测得公网出口。

Python 和 TypeScript 的转换对照测试覆盖三种配置导出、URI 重新解析、扩展拒绝和参数保留；真实 PostgreSQL 集成测试覆盖六协议导入去重、加密、扫描发布与五种订阅/报告导出。实际运营商节点、Reality 特殊组合和云端 Runner 的连通性仍需生产验收。
