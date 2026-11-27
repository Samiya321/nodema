export type Tone = "ok" | "warn" | "bad" | "info" | "mute";

export const STATUS_META: Record<string, [string, Tone]> = {
  UP: ["可用", "ok"],
  DEGRADED: ["较慢", "warn"],
  DOWN: ["不可用", "bad"],
  UNKNOWN: ["未检测", "mute"],
  STALE: ["结果过期", "mute"],
  UNSUPPORTED: ["不支持", "mute"],
  ENVIRONMENT_ERROR: ["环境异常", "warn"],
  COMPLETED: ["已完成", "ok"],
  PENDING: ["排队中", "mute"],
  RUNNING: ["进行中", "info"],
  PARTIAL: ["部分完成", "warn"],
  FAILED: ["失败", "bad"],
  SUCCESS: ["成功", "ok"],
  CANCELLED: ["已取消", "mute"],
  NEVER: ["未同步", "mute"],
  RETRYABLE: ["待重试", "warn"],
};

export const KIND_LABEL: Record<string, string> = {
  SELF_HOSTED: "自建",
  AIRPORT: "机场",
  SUBSTORE: "Sub-Store",
  AUTO: "自动识别",
  ALL: "全部",
};

export const SOURCE_KIND_LONG: Record<string, string> = {
  SUBSTORE: "Sub-Store",
  AIRPORT: "机场订阅",
  SELF_HOSTED: "自建来源",
};

export const SOURCE_TYPE_LABEL: Record<string, string> = {
  SUBSCRIPTION_URL: "订阅链接",
  RAW_TEXT: "节点文本",
  UPLOADED_FILE: "上传文件",
  SINGLE_URI: "单个节点",
};

export const IP_TYPE_LABEL: Record<string, string> = {
  RESIDENTIAL: "家宽",
  HOSTING: "机房",
  MOBILE: "移动网络",
};

export const SCAN_KIND_LABEL: Record<string, string> = {
  DAILY: "每日",
  SUPPLEMENTAL: "补测",
  MANUAL: "手动",
};

export const CLASSIFICATION_LABELS: Record<string, string> = {
  AIRPORT_SOURCE: "机场订阅",
  HISTORICAL_AIRPORT: "历史机场",
  SHARED_CREDENTIAL: "共享推定",
  UNCONFIRMED: "归属待确认",
};

export const CLASSIFICATION_REASONS: Record<string, string> = {
  AIRPORT_SOURCE: "当前至少有一个机场来源仍包含此节点。",
  HISTORICAL_AIRPORT: "机场来源的旧关联仍可追溯，当前已没有机场订阅包含此节点。",
  SHARED_CREDENTIAL: "同一凭据达到多入口或单入口多地区的分组门槛，现按机场组检测。",
  UNCONFIRMED: "目前缺少可确认归属的来源证据，暂按自建组检测。",
  MANUAL: "使用管理员为此节点确认的归属。",
};

export function classificationLabel(node: {
  classification_basis?: string | null;
  node_group: string;
}): string {
  if (node.classification_basis === "MANUAL") {
    return "已确认" + (KIND_LABEL[node.node_group] || node.node_group);
  }
  return (
    (node.classification_basis ? CLASSIFICATION_LABELS[node.classification_basis] : undefined) ||
    KIND_LABEL[node.node_group] ||
    node.node_group
  );
}

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Asia/Shanghai",
});

const regionDisplay = new Intl.DisplayNames(["zh-CN"], { type: "region" });
export const zhCollator = new Intl.Collator("zh-CN", { numeric: true });

export function countryName(code?: string | null): string {
  if (!code) return "未知";
  try {
    return regionDisplay.of(code) || code;
  } catch {
    return code;
  }
}

export function countryFlag(country?: string | null): string {
  if (!country || !/^[A-Za-z]{2}$/.test(country)) return "🏳";
  return String.fromCodePoint(
    ...[...country.toUpperCase()].map((c) => 127397 + c.charCodeAt(0)),
  );
}

export function operatorOf(node: { org_label?: string | null; asn_label?: string | null }): string {
  return node.org_label
    ? `${node.org_label}|${node.asn_label || "Unknown"}`
    : node.asn_label || "";
}

export function formatDate(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : dateFormatter.format(d);
}

export function formatAgo(value?: string | null): string {
  if (!value) return "从未";
  const seconds = (Date.now() - new Date(value).getTime()) / 1000;
  if (Number.isNaN(seconds)) return "—";
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return Math.floor(seconds / 60) + " 分钟前";
  if (seconds < 86400) return Math.floor(seconds / 3600) + " 小时前";
  return Math.floor(seconds / 86400) + " 天前";
}

export function daysUntil(value?: string | null): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return null;
  return Math.trunc((t - Date.now()) / 86400000);
}

export function formatBytes(value?: number | null): string {
  if (value === null || value === undefined) return "—";
  let n = Number(value);
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return (i ? n.toFixed(n >= 100 ? 0 : 1) : String(n)) + " " + units[i];
}

export function formatGB(value: number): string {
  return (value / 1e9).toFixed(2) + " GB";
}

export function formatPercent(value?: number | null, digits = 1): string {
  if (value === null || value === undefined) return "—";
  return (Number(value) * 100).toFixed(digits) + "%";
}

export function formatMs(value?: number | null): string {
  if (value === null || value === undefined) return "—";
  return Math.round(Number(value)) + " ms";
}

export function formatNumber(value?: number | null): string {
  if (value === null || value === undefined) return "—";
  return Number(value).toLocaleString("zh-CN");
}

export function formatDuration(startedAt?: string | null, finishedAt?: string | null): string {
  if (!startedAt || !finishedAt) return "—";
  const seconds = (new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000;
  if (Number.isNaN(seconds) || seconds < 0) return "—";
  return seconds < 90 ? Math.round(seconds) + " 秒" : Math.round(seconds / 60) + " 分钟";
}

export function sourceKindText(source: { effective_kind?: string }): string {
  return (source.effective_kind ? SOURCE_KIND_LONG[source.effective_kind] : undefined) || "来源";
}

export function sourceStateText(source: { deleted_at?: string | null; enabled?: boolean }): string {
  if (source.deleted_at) return "已删除";
  return source.enabled ? "启用" : "暂停";
}
