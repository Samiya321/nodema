// The node list's one "筛选" panel: everyday conditions first, the rest folded away.
// Every value lives in the URL; the panel only reads and writes those parameters.
import { field, h, select } from "../core.js";
import { ADVANCED, PROTOCOLS, control, readFilters } from "../filters.js";
import { countryName } from "./node-rows.js";

// Without a status the page lists available nodes (UP + DEGRADED, fetched as two
// queries): the whole library is ~4x the rows, and each row is metered transfer.
export const AVAILABLE = "AVAILABLE";
export const ALL = "ALL";
export const STATUS = [
  [AVAILABLE, "可用节点"],
  [ALL, "全部状态"],
  ["UP", "只看正常"],
  ["DEGRADED", "只看较慢"],
  ["DOWN", "不可用"],
  ["UNKNOWN", "未检测"],
  ["STALE", "结果过期"],
  ["UNSUPPORTED", "不支持"],
];
export const GROUPS = [["", "全部"], ["SELF_HOSTED", "自建"], ["AIRPORT", "机场"]];
export const PERCENT = ["min_success_rate", "max_timeout_rate", "min_lifetime_availability", "max_peak_loss", "min_avail_7d"];

const EXTRA = [
  ["eligible", "参与检测", "select", [["", "全部"], ["true", "是"], ["false", "否"]]],
  ["enabled", "启用", "select", [["", "全部"], ["true", "已启用"], ["false", "已停用"]]],
];
export const SPECS = new Map([...ADVANCED, ...EXTRA].map((spec) => [spec[0], spec]));
const FOLDED = [
  ["接入质量", ["max_peak_rtt_ms", "max_peak_loss", "min_avail_7d", "route_asn", "cross_border"]],
  ["落地", ["asn_label", "exit_asn", "exit_ip", "exit_ip_type", "exit_ip_proxy"]],
  ["入口", ["entry_country", "entry_asn", "server_host", "transport", "security"]],
  ["历史与标签", ["max_http_ms", "min_lifetime_availability", "min_available_days", "min_age_days", "tags", "eligible", "enabled"]],
];
const FOLDED_KEYS = FOLDED.flatMap(([, keys]) => keys);
export const COMMON_KEYS = ["status", "protocol", "node_group", "provider_id", "exit_country", "best_per_server"];
export const PANEL_KEYS = [...COMMON_KEYS, ...FOLDED_KEYS];
// Database filters (sent to the API); grade buckets, quick toggles, sort and page are local.
export const API_KEYS = ["q", "source_id", ...PANEL_KEYS];

export function display(key, value) {
  if (value === undefined || value === "") return "";
  if (key === "status") return STATUS.find(([v]) => v === value)?.[1] || value;
  if (key === "node_group") return GROUPS.find(([v]) => v === value)?.[1] || value;
  if (key === "exit_country") return countryName(value);
  if (key === "best_per_server") return "每台服务器只看最好的";
  const spec = SPECS.get(key);
  if (spec?.[2] === "select") return spec[3].find(([v]) => v === value)?.[1] || value;
  if (PERCENT.includes(key)) return value + "%";
  if (key.endsWith("_ms")) return value + " ms";
  return value;
}

const LABELS = { status: "状态", protocol: "协议", node_group: "类别", provider_id: "机场", exit_country: "落地", source_id: "来源", best_per_server: "去重" };
export const label = (key) => LABELS[key] || SPECS.get(key)?.[1].replace(/（.*?）/g, "") || key;

// Opens the panel; onApply receives {key: value|""} for every panel key.
export function openPanel({ filters, providers, countries, onApply }) {
  const form = h("form", { class: "panel-form", id: "filter-panel-form" });
  const common = h(
    "div",
    { class: "panel-common" },
    field("状态", select("status", STATUS, filters.status || AVAILABLE)),
    field("协议", select("protocol", [["", "全部"], ...PROTOCOLS.map((p) => [p, p])], filters.protocol || "")),
    field("类别", select("node_group", GROUPS, filters.node_group || "")),
    field("机场", select("provider_id", [["", "全部"], ...providers.map((p) => [p.id, p.name])], filters.provider_id || "")),
    field("落地国家", select("exit_country", [["", "全部"], ...countries.map((c) => [c, `${countryName(c)} ${c}`])], filters.exit_country || "")),
    h(
      "label",
      { class: "check panel-check", title: "同一台落地服务器只保留当前视角等级最好的一个节点" },
      h("input", { type: "checkbox", name: "best_per_server", value: "true", checked: filters.best_per_server === "true" }),
      "每台服务器只看最好的",
    ),
  );
  form.append(common);
  for (const [title, keys] of FOLDED) {
    const set = keys.filter((k) => filters[k]).length;
    form.append(
      h(
        "details",
        { class: "panel-group", open: set > 0 },
        h("summary", {}, title, set ? h("span", { class: "pill-n" }, set) : null),
        h(
          "div",
          { class: "panel-fields" },
          keys.map((key) => {
            const [, text, kind, options] = SPECS.get(key);
            return field(text, control(key, kind, options, filters[key] ?? ""));
          }),
        ),
      ),
    );
  }
  const box = h(
    "dialog",
    { class: "drawer", "aria-labelledby": "panel-title" },
    h("header", {}, h("h2", { id: "panel-title" }, "筛选"), h("button", { type: "button", class: "icon", "aria-label": "关闭", onclick: () => box.close() }, "✕")),
    form,
    h(
      "footer",
      {},
      h(
        "button",
        {
          type: "button",
          class: "quiet",
          onclick: () => {
            for (const el of form.elements) {
              if (el.type === "checkbox") el.checked = false;
              else if (el.name) el.value = el.name === "status" ? AVAILABLE : "";
            }
          },
        },
        "全部清空",
      ),
      h("button", { type: "submit", class: "primary", form: "filter-panel-form" }, "应用"),
    ),
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const values = readFilters(form, FOLDED_KEYS);
    const changes = Object.fromEntries(PANEL_KEYS.map((k) => [k, ""]));
    for (const [k, v] of Object.entries(values)) changes[k] = PERCENT.includes(k) ? String(v * 100) : Array.isArray(v) ? v.join(",") : String(v);
    const data = new FormData(form);
    for (const key of ["protocol", "node_group", "provider_id", "exit_country"]) changes[key] = data.get(key) || "";
    changes.status = data.get("status") === AVAILABLE ? "" : data.get("status");
    changes.best_per_server = data.get("best_per_server") ? "true" : "";
    box.close();
    onApply(changes);
  });
  box.addEventListener("close", () => box.remove());
  box.addEventListener("click", (e) => e.target === box && box.close()); // backdrop
  document.body.append(box);
  box.showModal();
}
