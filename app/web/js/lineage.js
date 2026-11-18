import { dialog, h, pager, toast } from "./core.js";

export function pageHref(name, params = {}) {
  const query = new URLSearchParams(params).toString();
  return "#/" + name + (query ? "?" + query : "");
}

export const sourceHref = (id, relation) =>
  pageHref("sources", { source: id, ...(relation ? { relation } : {}) });
export const nodeHref = (id, vantage) =>
  pageHref("nodes", { node: id, ...(vantage ? { vantage } : {}) });
export const exportHref = (id) => pageHref("exports", { subscription: id });
export const scanHref = (id) => pageHref("ops", { scan: id });

export function tabs(label, choices, current) {
  return h("nav", { class: "subnav segmented", "aria-label": label },
    choices.map(([key, text, href]) =>
      h("a", { class: "seg", href, "aria-current": key === current ? "page" : null }, text)));
}

export function copyPageLink(href) {
  const url = new URL(href, location.href).href;
  return h("button", { type: "button", onclick: async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast("已复制详情链接。", "ok");
    } catch {
      const input = h("input", { readonly: true, value: url, "aria-label": "详情链接" });
      dialog("详情链接", input);
      input.focus();
      input.select();
    }
  } }, "复制详情链接");
}

const KIND = { SUBSTORE: "Sub-Store", AIRPORT: "机场订阅", SELF_HOSTED: "自建来源" };

export const sourceKind = (source) => KIND[source.effective_kind] || "来源";
export const sourceState = (source) => source.deleted_at ? "已删除" : source.enabled ? "启用" : "暂停";

export const LINEAGE_PAGE_SIZE = 50;
export function readPage(params) {
  const page = Number(params.get("page") || 0);
  return Number.isSafeInteger(page) && page >= 0 && page <= Math.floor(2147483647 / LINEAGE_PAGE_SIZE) ? page : 0;
}

export function lineagePager(page, total, follow) {
  const pages = Math.max(1, Math.ceil(total / LINEAGE_PAGE_SIZE));
  return page >= pages
    ? h("button", { type: "button", onclick: () => follow(0) }, "返回第一页")
    : pager(page, pages, follow);
}

export function sourcePath(chain, { current = false } = {}) {
  return h("ol", { class: "source-path", "aria-label": "来源路径" }, chain.map((item, i) => {
    const last = current && i === chain.length - 1;
    return h("li", {},
      h("span", { class: "muted small" }, i === 0 && !item.parent_source_id ? "根来源" : last ? "当前来源" : "来源"),
      last ? h("strong", { "aria-current": "page" }, item.name)
        : h("a", { href: sourceHref(item.id, item.effective_kind === "SUBSTORE" ? "children" : null) }, item.name),
      item.deleted_at ? h("span", { class: "tag" }, "已删除") : null);
  }));
}
