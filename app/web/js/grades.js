// Node quality grades: vantage vocabulary, badges and the shared default vantage.
// Every grade is shown with its vantage ("A · 电信") so a screenshot can't be misread.
import { api, h, ms } from "./core.js";

export const VANTAGES = [
  ["CN", "三网"],
  ["CN-CT", "电信"],
  ["CN-CU", "联通"],
  ["CN-CM", "移动"],
  ["HK", "香港"],
  ["SG", "新加坡"],
];
export const vantageName = (v) => VANTAGES.find(([k]) => k === v)?.[1] || v;
// Carrier vantages (and the three-carrier view) read the evening peak; HK/SG a median.
export const isCarrier = (v) => String(v).startsWith("CN");
export const GRADES = ["S", "A", "B", "C", "D", "PENDING"];
export const GRADE_TEXT = { S: "S", A: "A", B: "B", C: "C", D: "D", PENDING: "待定" };
// Buckets of the node list's grade bar: the grades plus two ungraded states.
export const BUCKET_TEXT = { ...GRADE_TEXT, D: "D 不通", NONE: "不分级", OFF: "不可用" };
export const BUCKET_HINT = {
  S: "接入优 + 稳定优",
  A: "接入、稳定都至少良",
  B: "接入、稳定都至少中（未测接入时最高 B）",
  C: "能用，但接入或稳定有一项差",
  D: "这个地区的探针 TCP 连不上入口",
  PENDING: "检测天数不足 3 天，暂不定档",
  NONE: "当前可用但不分级：落地是 Cloudflare，或等下次计算",
  OFF: "当前不可用、未检测或结果过期",
};
const GRADE_HINT = {
  S: "接入优 + 稳定优",
  A: "接入、稳定都至少良",
  B: "接入、稳定都至少中（未测接入时最高 B）",
  C: "可用，但接入或稳定有一项差",
  D: "该地区 TCP 不通",
  PENDING: "检测天数不足，暂不定档",
};

export function gradeBadge(grade, vantage, { withVantage = true } = {}) {
  if (!grade) return null;
  const label = GRADE_TEXT[grade] || grade;
  return h(
    "span",
    { class: "grade g-" + grade, title: `${vantageName(vantage)}视角：${GRADE_HINT[grade] || ""}` },
    h("strong", {}, label),
    withVantage ? h("span", { class: "grade-v" }, vantageName(vantage)) : null,
  );
}

// "45 ms · 丢包 0.0%" for the list; carriers use the evening peak median.
export function accessText(n) {
  if (n.unreachable) return "TCP 不通";
  if (n.peak_rtt_ms === null || n.peak_rtt_ms === undefined) return n.icmp_only ? "未测（UDP）" : "未测";
  const loss = n.peak_loss === null || n.peak_loss === undefined ? "" : ` · 丢包 ${(n.peak_loss * 100).toFixed(1)}%`;
  return ms(n.peak_rtt_ms) + loss;
}

let policyPromise = null;
export function gradingPolicy() {
  if (!policyPromise) policyPromise = api("/grading-policy").catch((error) => {
    policyPromise = null;
    throw error;
  });
  return policyPromise;
}
export const forgetGradingPolicy = () => (policyPromise = null);

export async function defaultVantage() {
  try {
    return (await gradingPolicy()).policy.default_vantage || "CN";
  } catch {
    return "CN";
  }
}

export function vantageSwitch(current, onChange) {
  return h(
    "div",
    { class: "segmented vantage", role: "group", "aria-label": "等级视角" },
    VANTAGES.map(([key, text]) =>
      h("button", { type: "button", class: "seg", "aria-pressed": String(current === key), onclick: () => onChange(key) }, text),
    ),
  );
}

// Thin stacked bar + counts: "S 3 · A 12 · B 40".
export function distribution(counts, { link } = {}) {
  const total = GRADES.reduce((n, g) => n + (counts[g] || 0), 0);
  const bar = h("span", { class: "grade-bar", "aria-hidden": "true" });
  for (const g of GRADES) {
    if (!counts[g]) continue;
    // CSSOM, not a style attribute: the page CSP forbids inline style attributes.
    const part = h("span", { class: "g-" + g });
    part.style.flexGrow = String(counts[g]);
    bar.append(part);
  }
  const text = GRADES.filter((g) => counts[g]).map((g) =>
    link ? h("a", { href: link(g), class: "grade-count" }, `${GRADE_TEXT[g]} ${counts[g]}`) : h("span", { class: "grade-count" }, `${GRADE_TEXT[g]} ${counts[g]}`),
  );
  return h("span", { class: "grade-dist" }, total ? bar : null, h("span", { class: "grade-counts" }, text.length ? text : "未定档"));
}
