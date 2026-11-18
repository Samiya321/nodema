import { api, badge, date, empty, errorText, h, table } from "../core.js";
import {
  LINEAGE_PAGE_SIZE, copyPageLink, lineagePager, nodeHref, pageHref, readPage, sourceHref, sourceKind,
  sourcePath, sourceState, tabs,
} from "../lineage.js";

const RELATIONS = [["present", "上游仍包含", "present_count"], ["current", "当前可用", "up_count"],
  ["stale", "通过但已过期", "stale_up_count"], ["history", "全部关联", "node_count"]];

export async function renderSourceDetail(root, { params, go, refresh, refreshStrip }) {
  const id = params.get("source");
  const pageIndex = readPage(params);
  const query = new URLSearchParams({ offset: pageIndex * LINEAGE_PAGE_SIZE, limit: LINEAGE_PAGE_SIZE });
  if (params.has("relation")) query.set("relation", params.get("relation"));
  const data = await api(`/sources/${encodeURIComponent(id)}/lineage?${query}`);
  const { chain, page, relation } = data;
  const item = chain.at(-1);
  const sourceTab = item.effective_kind === "SUBSTORE" ? "substore" : item.effective_kind === "AIRPORT" ? "airport" : "all";
  const sections = data.child_count || sourceTab === "substore"
    ? [["children", "直接子来源", "child_count"], ...RELATIONS] : RELATIONS;
  if (data.reference_count || sourceTab === "substore")
    sections.splice(1, 0, ["references", "引用已有来源", "reference_count"]);
  const changePage = (index) => {
    const next = new URLSearchParams(params);
    next.set("relation", relation);
    if (index) next.set("page", index);
    else next.delete("page");
    go("sources", next);
  };
  const isReference = relation === "references";
  const rows = relation === "children" || isReference ? table([
    { label: isReference ? "引用的来源" : "子来源", render: (s) => h("a", { href: sourceHref(s.id, s.effective_kind === "SUBSTORE" ? "children" : null) }, s.ref_label || s.origin_label || s.name) },
    { label: "类别", render: sourceKind },
    { label: "状态", render: sourceState },
    { label: "上级索引", render: (s) => {
      const presence = isReference ? s.ref_present : s.in_parent;
      return presence == null ? "待确认" : presence ? "仍包含" : "已移除，保留记录";
    } },
    { label: "同步", render: (s) => badge(s.last_sync_status) },
    { label: "最近成功", render: (s) => date(s.last_success_at) },
  ], page.items, { empty: isReference ? empty("还没有收录的引用") : empty("还没有直接子来源", "同步上级来源后，这里会列出拆分得到的条目。") })
    : table([
      { label: "节点", render: (n) => h("a", { href: nodeHref(n.id) }, n.name || n.short_id) },
      { label: "关联", render: (n) => n.is_present ? "上游仍包含" : "上游已移除" },
      { label: "状态", render: (n) => n.enabled ? badge(n.status) : "已停用" },
      { label: "首次收录", render: (n) => date(n.first_seen_at) },
      { label: "最近出现", render: (n) => date(n.last_seen_at) },
    ], page.items, { empty: empty("此范围无节点") });
  const edit = !item.deleted_at && h("button", { type: "button", onclick: async () => {
    const [{ editSource }, source] = await Promise.all([import("./sources.js"), api(`/sources/${encodeURIComponent(id)}`)]);
    editSource(source, () => { refresh(); refreshStrip(); });
  } }, item.type === "SUBSCRIPTION_URL" ? "编辑或续期" : "编辑来源");
  root.append(
    h("a", { class: "return-link", href: pageHref("sources", sourceTab === "all" ? {} : { tab: sourceTab }) }, "返回来源列表"),
    h("header", { class: "title-row" }, h("h1", { class: "page-title" }, item.name), h("div", { class: "row wrap" }, edit, copyPageLink(location.hash))),
    h("section", { class: "panel stack" }, h("h2", {}, "来源路径"), sourcePath(chain, { current: true }),
      h("dl", { class: "pairs" },
        h("dt", {}, "来源类别"), h("dd", {}, sourceKind(item)),
        h("dt", {}, "来源状态"), h("dd", {}, sourceState(item)),
        item.parent_source_id ? [h("dt", {}, "上级索引"), h("dd", {}, item.in_parent == null ? "待确认" : item.in_parent ? "仍包含" : "已移除，保留记录")] : null,
        h("dt", {}, "上游"), h("dd", {}, item.url_host || item.origin_label || (item.type === "RAW_TEXT" ? "录入的节点文本" : "本地输入")),
        item.provider_id ? [h("dt", {}, "机场分组"), h("dd", {}, h("a", {
          href: pageHref("sources", { tab: "airport", provider: item.provider_id }),
        }, item.provider_name || "查看分组"))] : null,
        h("dt", {}, "最近同步"), h("dd", {}, badge(item.last_sync_status), " ", date(item.last_checked_at)),
        item.last_success_at ? [h("dt", {}, "最近成功"), h("dd", {}, date(item.last_success_at))] : null,
        item.last_error_code ? [h("dt", {}, "同步问题"), h("dd", {}, errorText(item.last_error_code))] : null,
      ),
    ),
    data.references.length ? h("section", { class: "panel stack" },
      h("h2", {}, "其他上游引用"),
      data.references.map((ref) => h("div", { class: "stack" }, sourcePath(ref.chain),
        h("p", { class: "muted small" }, ref.label, ref.is_present ? " · 索引仍包含" : " · 已移除",
          ` · 最近出现 ${date(ref.last_seen_at)}`),
      )),
    ) : null,
    tabs("来源关联", sections.map(([key, label, count]) => [key, `${label} ${data[count]}`, sourceHref(id, key)]), relation),
    rows,
    lineagePager(pageIndex, page.total, changePage),
  );
}
