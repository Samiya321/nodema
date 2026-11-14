// Node filter vocabulary shared by the node list and subscription profiles.
import { h, field, select } from "./core.js";

export const PROTOCOLS = ["shadowsocks", "trojan", "anytls", "hysteria2", "vmess", "vless"];
export const SORTS = [
  ["quality_grade:asc", "等级（当前视角）"],
  ["peak_rtt_ms:asc", "晚高峰延迟从低到高"],
  ["peak_loss:asc", "晚高峰丢包从低到高"],
  ["avail_7d:desc", "7 天可用率从高到低"],
  ["short_id:asc", "编号"],
  ["name:asc", "名称"],
  ["http_duration_ms:asc", "美国 Runner 代理延迟"],
  ["lifetime_availability:desc", "累计可用率从高到低"],
  ["available_days:desc", "可用天数从多到少"],
  ["last_checked_at:desc", "最近检测"],
  ["first_seen_at:desc", "最新加入"],
  ["exit_country:asc", "落地地区"],
  ["asn_label:asc", "落地 ASN"],
];
const PERCENT = ["min_success_rate", "max_timeout_rate", "min_lifetime_availability", "max_peak_loss", "min_avail_7d"];

// [key, label, kind, options?]
export const ADVANCED = [
  ["min_quality_grade", "等级至少（当前视角）", "select", [["", "全部"], ["S", "S"], ["A", "A 及以上"], ["B", "B 及以上"], ["C", "C 及以上"]]],
  ["max_peak_rtt_ms", "晚高峰延迟至多（ms）", "number"],
  ["max_peak_loss", "晚高峰丢包至多（%）", "number"],
  ["min_avail_7d", "7 天可用率至少（%）", "number"],
  ["route_asn", "去程经过 ASN（如 4809）", "number"],
  ["unreachable", "该地区 TCP 不通", "select", [["", "全部"], ["true", "是"], ["false", "否"]]],
  ["cross_border", "入口与落地不同国家", "select", [["", "全部"], ["true", "是"], ["false", "否"]]],
  ["entry_country", "入口地区（如 HK）", "text"],
  ["asn_label", "落地 ASN 简称", "text"],
  ["exit_asn", "落地 ASN 号", "number"],
  ["entry_asn", "入口 ASN 号", "number"],
  ["server_host", "入口主机", "text"],
  ["exit_ip", "出口 IP", "text"],
  ["exit_ip_type", "落地 IP 类型（ip-api 标记）", "select", [["", "全部"], ["RESIDENTIAL", "家宽"], ["HOSTING", "机房"], ["MOBILE", "移动网络"]]],
  ["exit_ip_proxy", "落地 IP 被 ip-api 标记为代理", "select", [["", "全部"], ["false", "否"], ["true", "是"]]],
  ["udp", "UDP 可用（Wi-Fi Calling）", "select", [["", "全部"], ["true", "只要 UDP 可用"], ["false", "UDP 不可用或未测"]]],
  ["transport", "传输", "select", [["", "全部"], ["tcp", "TCP"], ["ws", "WS"], ["grpc", "gRPC"], ["quic", "QUIC"]]],
  ["security", "安全层", "select", [["", "全部"], ["none", "无"], ["tls", "TLS"], ["reality", "Reality"]]],
  ["tags", "标签（逗号分隔）", "text"],
  ["max_http_ms", "美国 Runner 代理延迟至多（ms）", "number"],
  ["min_lifetime_availability", "累计可用率至少（%）", "number"],
  ["min_available_days", "累计可用至少（天）", "number"],
  ["min_age_days", "已收录至少（天）", "number"],
];

export function control(key, kind, options, value) {
  if (kind === "select") return select(key, options, value ?? "");
  return h("input", {
    name: key,
    type: kind === "number" ? "number" : "text",
    min: kind === "number" ? 0 : undefined,
    step: kind === "number" ? "any" : undefined,
    value: value ?? "",
  });
}

export function advancedFields(values = {}) {
  return ADVANCED.map(([key, label, kind, options]) => field(label, control(key, kind, options, display(key, values[key]))));
}

function display(key, value) {
  if (value === undefined || value === null) return "";
  if (PERCENT.includes(key)) return Number(value) * 100;
  if (Array.isArray(value)) return value.join(",");
  return value;
}

// FormData -> API filter object (percent fields become ratios; empties dropped).
export function readFilters(form, keys) {
  const data = new FormData(form),
    result = {};
  for (const key of keys) {
    const raw = data.get(key);
    if (raw === null || raw === "") continue;
    if (PERCENT.includes(key)) result[key] = Number(raw) / 100;
    else if (key === "tags")
      result[key] = String(raw)
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    else if (["enabled", "eligible", "exit_ip_proxy", "unreachable", "cross_border", "best_per_server", "udp"].includes(key)) result[key] = raw === "true";
    else result[key] = String(raw).trim();
  }
  return result;
}
