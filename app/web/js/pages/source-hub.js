import { pageHref, tabs } from "../lineage.js";
import { renderSourceDetail } from "./source-detail.js";

const SECTIONS = {
  all: ["全部来源", () => import("./sources.js")],
  airport: ["机场订阅", () => import("./airports.js")],
  substore: ["Sub-Store", () => import("./substore.js")],
};

export async function render(root, context) {
  const { params } = context;
  if (params.has("source")) return renderSourceDetail(root, context);
  const key = params.get("tab");
  const selected = Object.hasOwn(SECTIONS, key) ? key : "all";
  root.append(tabs("来源类别", Object.entries(SECTIONS).map(([id, [label]]) =>
    [id, label, pageHref("sources", id === "all" ? {} : { tab: id })]), selected));
  const section = await SECTIONS[selected][1]();
  await section.render(root, context);
}
