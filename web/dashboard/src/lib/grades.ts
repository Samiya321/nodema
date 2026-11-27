import type { QualityBucket, QualityGrade, Vantage } from "../types/api";

export const VANTAGES: ReadonlyArray<[Vantage, string]> = [
  ["CN", "三网"],
  ["CN-CT", "电信"],
  ["CN-CU", "联通"],
  ["CN-CM", "移动"],
  ["HK", "香港"],
  ["SG", "新加坡"],
  ["GB", "英国"],
];

export function vantageName(v?: string | null): string {
  if (!v) return "三网";
  return VANTAGES.find(([k]) => k === v)?.[1] ?? v;
}

export function isCarrierVantage(v?: string | null): boolean {
  return String(v || "").startsWith("CN");
}

export const ACCESS_EVIDENCE_LABEL: Record<string, string> = {
  ENDPOINT: "端点实测",
  PREFIX: "网段参考",
  CF_SHARED: "CF 共享参考",
  ICMP: "UDP 入口间接参考",
};

export const GRADES: readonly QualityGrade[] = ["S", "A", "B", "C", "D", "PENDING"];
export const BUCKETS: readonly QualityBucket[] = [...GRADES, "NONE", "OFF"];

export const GRADE_TEXT: Record<QualityGrade, string> = {
  S: "S",
  A: "A",
  B: "B",
  C: "C",
  D: "D",
  PENDING: "待定",
};

export const BUCKET_TEXT: Record<QualityBucket, string> = {
  ...GRADE_TEXT,
  D: "D 重复失败",
  NONE: "不分级",
  OFF: "不可用",
};

export const BUCKET_HINT: Record<QualityBucket, string> = {
  S: "端点接入与稳定性均优，且达到跨日样本门槛",
  A: "端点接入与稳定性均至少为良",
  B: "接入、稳定都至少中（未测接入时最高 B）",
  C: "能用，但接入或稳定有一项差",
  D: "该视角近 48 小时对同一端点跨探针、跨时段重复失败",
  PENDING: "检测天数不足 3 天，暂不定档",
  NONE: "当前可用但不分级：落地是 Cloudflare，或等下次计算",
  OFF: "当前不可用、未检测或结果过期",
};

export const GRADE_HINT: Record<QualityGrade, string> = {
  S: BUCKET_HINT.S,
  A: BUCKET_HINT.A,
  B: "接入、稳定都至少中（未测接入时最高 B）",
  C: "可用，但接入或稳定有一项差",
  D: "该视角入口重复失败",
  PENDING: "检测天数不足，暂不定档",
};

export const BAND_LABEL: Record<string, string> = {
  S: "优",
  A: "良",
  B: "中",
  C: "差",
};

export function isAvailableStatus(status?: string | null): boolean {
  return status === "UP" || status === "DEGRADED";
}

export function bucketOfNode(node: {
  quality_grade?: QualityGrade | null;
  status?: string | null;
}): QualityBucket {
  if (node.quality_grade) return node.quality_grade;
  return isAvailableStatus(node.status) ? "NONE" : "OFF";
}
