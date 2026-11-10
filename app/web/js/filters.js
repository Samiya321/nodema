// Node filter vocabulary shared by the node list and subscription profiles.
import { h, field, select } from "./core.js";

export const PROTOCOLS = ["shadowsocks", "trojan", "anytls", "hysteria2", "vmess", "vless"];
export const SORTS = [
  ["short_id:asc", "编号"],
  ["name:asc", "名称"],
  ["http_duration_ms:asc", "延迟从低到高"],
  ["lifetime_availability:desc", "累计可用率从高到低"],
  ["available_days:desc", "可用天数从多到少"],
  ["last_checked_at:desc", "最近检测"],
  ["first_seen_at:desc", "最新加入"],
  ["exit_country:asc", "落地地区"],
  ["asn_label:asc", "落地 ASN"],
  ["success_rate:desc", "Runner 成功率"],
  ["grade:asc", "大陆参考等级"],
];
const PERCENT = ["min_success_rate", "max_timeout_rate", "min_lifetime_availability"];

// [key, label, kind, options?]
export const ADVANCED = [
  ["entry_country", "入口地区（如 HK）", "text"],
  ["asn_label", "落地 ASN 简称", "text"],
  ["exit_asn", "落地 ASN 号", "number"],
  ["entry_asn", "入口 ASN 号", "number"],
  ["server_host", "入口主机", "text"],
  ["exit_ip", "出口 IP", "text"],
  ["transport", "传输", "select", [["", "全部"], ["tcp", "TCP"], ["ws", "WS"], ["grpc", "gRPC"], ["quic", "QUIC"]]],
  ["security", "安全层", "select", [["", "全部"], ["none", "无"], ["tls", "TLS"], ["reality", "Reality"]]],
  ["grade", "大陆参考等级", "select", [["", "全部"], ["P1", "P1"], ["P2", "P2"], ["P3", "P3"], ["U", "资料不足"]]],
  ["line_claim", "人工线路声明", "select", [["", "全部"], ["UNKNOWN", "未知"], ["IPLC", "IPLC"], ["IEPL", "IEPL"], ["CN2", "CN2"], ["OTHER", "其他"]]],
  ["tags", "人工标签（逗号分隔）", "text"],
  ["max_http_ms", "延迟至多（ms）", "number"],
  ["min_lifetime_availability", "累计可用率至少（%）", "number"],
  ["min_available_days", "累计可用至少（天）", "number"],
  ["min_age_days", "已收录至少（天）", "number"],
  ["min_success_rate", "Runner 成功率至少（%）", "number"],
  ["max_timeout_rate", "Runner 超时率至多（%）", "number"],
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
    else if (key === "enabled" || key === "eligible") result[key] = raw === "true";
    else result[key] = String(raw).trim();
  }
  return result;
}
