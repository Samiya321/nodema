import { pageHref, tabs } from "../lineage.js";

const SECTIONS = [["scans", "节点检测"], ["probes", "接入测量"], ["usage", "用量与备份"]];

export async function render(root, context) {
  const tab = context.params.get("tab");
  const selected = SECTIONS.some(([key]) => key === tab) ? tab : "scans";
  root.append(tabs("运维类别", SECTIONS.map(([key, label]) =>
    [key, label, pageHref("ops", key === "scans" ? {} : { tab: key })]), selected));
  const section = selected === "usage" ? await import("./usage.js") : await import("./scans.js");
  await section.render(root, context);
}
