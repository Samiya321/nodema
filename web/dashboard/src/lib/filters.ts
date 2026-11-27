import type { ExportFilterSpec, NodeListItem, QualityBucket } from "../types/api";
import { countryName, operatorOf, zhCollator } from "./format";
import { BUCKETS, BUCKET_TEXT, GRADE_TEXT, bucketOfNode, vantageName } from "./grades";

export const PROTOCOLS = ["shadowsocks", "trojan", "anytls", "hysteria2", "vmess", "vless"] as const;

export const AVAILABLE = "AVAILABLE";
export const ALL = "ALL";

export const STATUS_OPTIONS: ReadonlyArray<[string, string]> = [
  [AVAILABLE, "可用节点"],
  [ALL, "全部状态"],
  ["UP", "只看正常"],
  ["DEGRADED", "只看较慢"],
  ["DOWN", "不可用"],
  ["UNKNOWN", "未检测"],
  ["STALE", "结果过期"],
  ["UNSUPPORTED", "不支持"],
];

export const GROUP_OPTIONS: ReadonlyArray<[string, string]> = [
  ["", "全部"],
  ["SELF_HOSTED", "自建"],
  ["AIRPORT", "机场"],
];

export const EXPORT_SORTS: ReadonlyArray<[string, string]> = [
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

export const PERCENT_KEYS = new Set([
  "min_success_rate",
  "max_timeout_rate",
  "min_lifetime_availability",
  "max_peak_loss",
  "min_avail_7d",
]);

export const BOOL_KEYS = new Set([
  "enabled",
  "eligible",
  "exit_ip_proxy",
  "unreachable",
  "cross_border",
  "best_per_server",
  "endpoint_verified",
  "stable_exit",
  "udp",
]);

export interface FilterSpec {
  key: string;
  label: string;
  kind: "select" | "number" | "text";
  options?: ReadonlyArray<[string, string]>;
}

export const ADVANCED_FILTERS: readonly FilterSpec[] = [
  {
    key: "min_quality_grade",
    label: "等级至少（当前视角）",
    kind: "select",
    options: [
      ["", "全部"],
      ["S", "S"],
      ["A", "A 及以上"],
      ["B", "B 及以上"],
      ["C", "C 及以上"],
    ],
  },
  {
    key: "endpoint_verified",
    label: "端点实测证据",
    kind: "select",
    options: [
      ["", "不限"],
      ["true", "已确认"],
      ["false", "未确认"],
    ],
  },
  { key: "max_peak_rtt_ms", label: "晚高峰延迟至多（ms）", kind: "number" },
  { key: "max_peak_loss", label: "晚高峰丢包至多（%）", kind: "number" },
  { key: "min_avail_7d", label: "7 天可用率至少（%）", kind: "number" },
  { key: "route_asn", label: "去程经过 ASN（如 4809）", kind: "number" },
  {
    key: "unreachable",
    label: "该视角入口重复失败",
    kind: "select",
    options: [
      ["", "全部"],
      ["true", "是"],
      ["false", "否"],
    ],
  },
  {
    key: "cross_border",
    label: "入口与落地不同国家",
    kind: "select",
    options: [
      ["", "全部"],
      ["true", "是"],
      ["false", "否"],
    ],
  },
  { key: "entry_country", label: "入口地区（如 HK）", kind: "text" },
  { key: "asn_label", label: "落地 ASN 简称", kind: "text" },
  { key: "exit_asn", label: "落地 ASN 号", kind: "number" },
  { key: "entry_asn", label: "入口 ASN 号", kind: "number" },
  { key: "server_host", label: "入口主机", kind: "text" },
  { key: "exit_ip", label: "出口 IP", kind: "text" },
  {
    key: "stable_exit",
    label: "近 7 天出口稳定",
    kind: "select",
    options: [
      ["", "不限"],
      ["true", "至少 5 天有观测，IP 一致"],
      ["false", "未达到稳定条件"],
    ],
  },
  {
    key: "exit_ip_type",
    label: "落地 IP 类型（ip-api 标记）",
    kind: "select",
    options: [
      ["", "全部"],
      ["RESIDENTIAL", "家宽"],
      ["HOSTING", "机房"],
      ["MOBILE", "移动网络"],
    ],
  },
  {
    key: "exit_ip_proxy",
    label: "落地 IP 被 ip-api 标记为代理",
    kind: "select",
    options: [
      ["", "全部"],
      ["false", "否"],
      ["true", "是"],
    ],
  },
  {
    key: "udp",
    label: "UDP 可用（Wi-Fi Calling）",
    kind: "select",
    options: [
      ["", "全部"],
      ["true", "只要 UDP 可用"],
      ["false", "UDP 不可用或未测"],
    ],
  },
  {
    key: "transport",
    label: "传输",
    kind: "select",
    options: [
      ["", "全部"],
      ["tcp", "TCP"],
      ["ws", "WS"],
      ["grpc", "gRPC"],
      ["quic", "QUIC"],
    ],
  },
  {
    key: "security",
    label: "安全层",
    kind: "select",
    options: [
      ["", "全部"],
      ["none", "无"],
      ["tls", "TLS"],
      ["reality", "Reality"],
    ],
  },
  { key: "tags", label: "标签（逗号分隔）", kind: "text" },
  { key: "max_http_ms", label: "美国 Runner 代理延迟至多（ms）", kind: "number" },
  { key: "min_lifetime_availability", label: "累计可用率至少（%）", kind: "number" },
  { key: "min_available_days", label: "累计可用至少（天）", kind: "number" },
  { key: "min_age_days", label: "已收录至少（天）", kind: "number" },
];

const EXTRA_NODE_FILTERS: readonly FilterSpec[] = [
  {
    key: "eligible",
    label: "参与检测",
    kind: "select",
    options: [
      ["", "全部"],
      ["true", "是"],
      ["false", "否"],
    ],
  },
  {
    key: "enabled",
    label: "启用",
    kind: "select",
    options: [
      ["", "全部"],
      ["true", "已启用"],
      ["false", "已停用"],
    ],
  },
];

export const FILTER_SPEC_MAP = new Map<string, FilterSpec>(
  [...ADVANCED_FILTERS, ...EXTRA_NODE_FILTERS].map((s) => [s.key, s]),
);

export const FOLDED_FILTER_GROUPS: ReadonlyArray<[string, readonly string[]]> = [
  ["接入质量", ["endpoint_verified", "max_peak_rtt_ms", "max_peak_loss", "min_avail_7d", "route_asn", "cross_border"]],
  ["落地", ["asn_label", "exit_asn", "exit_ip", "stable_exit", "exit_ip_type", "exit_ip_proxy"]],
  ["入口", ["entry_country", "entry_asn", "server_host", "transport", "security"]],
  ["历史与标签", ["max_http_ms", "min_lifetime_availability", "min_available_days", "min_age_days", "tags", "eligible", "enabled"]],
];

export const FOLDED_KEYS = FOLDED_FILTER_GROUPS.flatMap(([, keys]) => [...keys]);
export const COMMON_PANEL_KEYS = [
  "status",
  "protocol",
  "node_group",
  "provider_id",
  "exit_country",
  "best_per_server",
] as const;
export const PANEL_KEYS = [...COMMON_PANEL_KEYS, ...FOLDED_KEYS];
export const API_NODE_KEYS = ["q", "source_id", ...PANEL_KEYS];

const CHIP_LABELS: Record<string, string> = {
  status: "状态",
  protocol: "协议",
  node_group: "检测分组",
  provider_id: "机场",
  exit_country: "落地",
  source_id: "来源",
  best_per_server: "去重",
};

export function filterLabel(key: string): string {
  return CHIP_LABELS[key] || FILTER_SPEC_MAP.get(key)?.label.replace(/（.*?）/g, "") || key;
}

export function displayFilterValue(key: string, value: string): string {
  if (!value) return "";
  if (key === "status") return STATUS_OPTIONS.find(([v]) => v === value)?.[1] || value;
  if (key === "node_group") return GROUP_OPTIONS.find(([v]) => v === value)?.[1] || value;
  if (key === "exit_country") return countryName(value);
  if (key === "best_per_server") return "每台服务器只看最好的";
  const spec = FILTER_SPEC_MAP.get(key);
  if (spec?.kind === "select") return spec.options?.find(([v]) => v === value)?.[1] || value;
  if (PERCENT_KEYS.has(key)) return value + "%";
  if (key.endsWith("_ms")) return value + " ms";
  return value;
}

export function legacyBucketsFromParams(params: URLSearchParams): QualityBucket[] {
  const min = params.get("min_quality_grade");
  if (min) {
    const idx = BUCKETS.indexOf(min as QualityBucket);
    if (idx >= 0) return BUCKETS.slice(0, idx + 1);
  }
  const exact = params.get("quality_grade");
  if (exact && BUCKETS.includes(exact as QualityBucket)) return [exact as QualityBucket];
  if (params.get("unreachable") === "true") return ["D"];
  return [];
}

// ---- Node sorting (shared between List SQL mapping & Country client-side sort) ----
export type NodeSortKey = "name" | "grade" | "rtt" | "udp" | "avail" | "route" | "operator" | "checked";
export type SortDir = "asc" | "desc";

export const NODE_SQL_SORT: Record<NodeSortKey, readonly string[]> = {
  name: ["name"],
  grade: ["quality_grade"],
  rtt: ["peak_rtt_ms"],
  udp: ["udp_state", "udp_ms"],
  avail: ["avail_7d", "checked_7d"],
  route: ["entry_country", "exit_country"],
  operator: ["operator_label"],
  checked: ["last_checked_at"],
};

const rankOf = (n: NodeListItem) => BUCKETS.indexOf(bucketOfNode(n));
const nullsLast = <T,>(a: T | null | undefined, b: T | null | undefined, cmp: (x: T, y: T) => number) =>
  Number(a == null) - Number(b == null) || (a == null || b == null ? 0 : cmp(a, b));
const numCmp = (pick: (n: NodeListItem) => number | null | undefined) => (a: NodeListItem, b: NodeListItem) =>
  nullsLast(pick(a), pick(b), (x, y) => x - y);
const textCmp = (pick: (n: NodeListItem) => string | null | undefined) => (a: NodeListItem, b: NodeListItem) =>
  nullsLast(pick(a) || null, pick(b) || null, zhCollator.compare);
const availRatio = (n: NodeListItem) => (n.checked_7d ? (n.avail_7d || 0) / n.checked_7d : null);
const UDP_RANK: Record<string, number> = { SUCCESS: 0, FAILED: 1, NOT_SUPPORTED: 2 };
const udpRank = (n: NodeListItem) => (n.udp ? (UDP_RANK[n.udp] ?? 3) : 3);

export const NODE_COLUMNS: Record<
  NodeSortKey,
  { label: string; compare: (a: NodeListItem, b: NodeListItem) => number; defaultDir: SortDir }
> = {
  name: { label: "节点", compare: textCmp((n) => n.name), defaultDir: "asc" },
  grade: {
    label: "等级",
    compare: (a, b) =>
      rankOf(a) - rankOf(b) ||
      Number(Boolean(b.endpoint_verified)) - Number(Boolean(a.endpoint_verified)) ||
      (b.quality_score ?? -1) - (a.quality_score ?? -1),
    defaultDir: "asc",
  },
  rtt: { label: "入口 RTT", compare: numCmp((n) => n.peak_rtt_ms), defaultDir: "asc" },
  udp: {
    label: "UDP",
    compare: (a, b) => udpRank(a) - udpRank(b) || (a.udp_ms ?? 1e9) - (b.udp_ms ?? 1e9),
    defaultDir: "asc",
  },
  avail: {
    label: "7 天可用",
    compare: (a, b) =>
      nullsLast(availRatio(a), availRatio(b), (x, y) => x - y) || (a.checked_7d ?? 0) - (b.checked_7d ?? 0),
    defaultDir: "desc",
  },
  route: {
    label: "入口 / 落地",
    compare: textCmp((n) => (n.entry_country || "") + (n.exit_country || "")),
    defaultDir: "asc",
  },
  operator: { label: "落地运营商", compare: textCmp(operatorOf), defaultDir: "asc" },
  checked: { label: "最近检测", compare: textCmp((n) => n.last_checked_at), defaultDir: "desc" },
};

export function sortNodeItems(items: NodeListItem[], key: NodeSortKey, dir: SortDir): NodeListItem[] {
  const { compare } = NODE_COLUMNS[key] || NODE_COLUMNS.grade;
  const sign = dir === "desc" ? -1 : 1;
  return [...items].sort((a, b) => {
    const value = compare(a, b);
    const missing = key === "rtt" ? Number(a.peak_rtt_ms == null) - Number(b.peak_rtt_ms == null) : 0;
    return missing || sign * value || zhCollator.compare(a.name, b.name);
  });
}

// ---- Exports helpers ----
export const EXPORT_BASIC_KEYS = [
  "node_group",
  "provider_id",
  "exit_country",
  "protocol",
  "vantage",
  "min_quality_grade",
  "best_per_server",
] as const;

export const EXPORT_FILTER_KEYS: readonly string[] = [
  "q",
  "source_id",
  "enabled",
  ...EXPORT_BASIC_KEYS,
  ...ADVANCED_FILTERS.map((f) => f.key).filter((k) => !(EXPORT_BASIC_KEYS as readonly string[]).includes(k)),
];

export function seedExportFiltersFromParams(params: URLSearchParams): ExportFilterSpec {
  const result: ExportFilterSpec = {};
  for (const key of EXPORT_FILTER_KEYS) {
    const val = params.get(key);
    if (!val) continue;
    if (PERCENT_KEYS.has(key)) result[key] = Number(val) / 100;
    else if (BOOL_KEYS.has(key)) result[key] = val === "true";
    else if (key === "tags")
      result[key] = val
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    else result[key] = val;
  }
  const g = (params.get("g") || "")
    .split(",")
    .filter((item): item is QualityBucket => Object.hasOwn(BUCKET_TEXT, item));
  if (g.length) result.quality_buckets = g;
  return result;
}

export function exportSummaryParts(spec: ExportFilterSpec = {}): string[] {
  const parts: string[] = [];
  if (spec.min_quality_grade) {
    parts.push(`${vantageName(spec.vantage || "CN")} ≥ ${GRADE_TEXT[spec.min_quality_grade]}`);
  }
  if (spec.quality_buckets?.length) {
    const grades = spec.quality_buckets.map((g) => BUCKET_TEXT[g] || g).join("、");
    parts.push(`${vantageName(spec.vantage || "CN")} ${grades}`);
  } else if (!spec.min_quality_grade && spec.vantage) {
    parts.push(`视角 ${vantageName(spec.vantage)}`);
  }
  if (spec.node_group) parts.push(spec.node_group === "AIRPORT" ? "仅机场" : "仅自建");
  if (spec.exit_country) parts.push(spec.exit_country);
  if (spec.protocol) parts.push(spec.protocol);
  if (spec.best_per_server) parts.push("每服务器 1 个");
  if (spec.udp === true) parts.push("UDP 有回包");
  if (spec.exit_ip_type === "RESIDENTIAL") parts.push("家宽 IP");
  if (spec.endpoint_verified === true) parts.push("端点实测已确认");
  if (spec.stable_exit === true) parts.push("近 7 天出口稳定");
  if (spec.limit && spec.limit < 100000) parts.push(`前 ${spec.limit} 个`);
  return parts;
}
