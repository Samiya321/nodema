// The only place that starts GitHub Actions: sync sources, or test one node group.
import { KIND, SCAN_KIND, api, busy, confirm, h, meter, toast } from "./core.js";

let root, timer, last, listening = false;

export function renderStrip(element) {
  root = element;
  refreshStrip();
  if (listening) return;
  listening = true;
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && root?.isConnected) refreshStrip();
  });
}

function schedule(active) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (!document.hidden) refreshStrip();
    else schedule(active);
  }, active ? 15000 : 60000);
}

export async function refreshStrip() {
  try {
    last = await api("/pipeline");
  } catch {
    schedule(false);
    return;
  }
  draw(last);
  schedule(last.active_scans.length > 0);
}

async function startSync(button) {
  await busy(button, async () => {
    await api("/pipeline/sync", { method: "POST" });
    toast("已提交同步。GitHub Actions 通常在 1 分钟内开始，只拉取来源，不检测节点。", "ok");
  });
}

async function startTest(button, scope) {
  const testable = last?.testable?.[scope] ?? (scope === "ALL" ? undefined : 0);
  const pending = last?.pending_sources ?? 0;
  const message =
    `将检测${KIND[scope]}节点` +
    (testable !== undefined ? `（当前约 ${testable} 个可检测）` : "") +
    "。" +
    (pending ? `开始前会先同步 ${pending} 个待同步来源。` : "") +
    "同一节点若已在未完成的批次中会被跳过。";
  if (!(await confirm("开始检测", message, { action: "开始检测" }))) return;
  await busy(button, async () => {
    await api("/scans", { method: "POST", body: { scope } });
    toast("检测已提交，进度会显示在顶部。", "ok");
    setTimeout(refreshStrip, 4000);
  });
}

function progress(run) {
  const done = Number(run.done || 0),
    total = Number(run.node_count || 0);
  const ratio = total ? Math.min(1, done / total) : 0;
  return h(
    "a",
    {
      class: "run",
      href: "#/scans",
      title: `${SCAN_KIND[run.kind] || run.kind}检测：${done}/${total}`,
    },
    h("span", { class: "run-label" }, `${KIND[run.scope] || "全部"} ${done}/${total}`),
    meter(ratio, { tone: "info", label: "检测进度" }),
  );
}

function draw(state) {
  const testable = state.testable || {};
  const pending = state.pending_sources || 0;
  const syncButton = h("button", { type: "button", class: pending ? "primary" : "" }, "同步来源");
  syncButton.addEventListener("click", () => startSync(syncButton));
  const testButtons = ["SELF_HOSTED", "AIRPORT", "ALL"].map((scope) => {
    const label = scope === "ALL" ? "全部" : KIND[scope];
    const count = scope === "ALL" ? (testable.SELF_HOSTED || 0) + (testable.AIRPORT || 0) : testable[scope] || 0;
    const button = h("button", { type: "button", class: "seg" }, label, h("span", { class: "count" }, count));
    button.addEventListener("click", () => startTest(button, scope));
    return button;
  });
  root.replaceChildren(
    h(
      "div",
      { class: "strip-group" },
      h(
        "p",
        { class: "strip-text" },
        pending ? h("strong", {}, pending) : "没有",
        " 个来源待同步",
        state.failed_sources
          ? h("a", { href: "#/sources?status=FAILED", class: "bad-text" }, `，${state.failed_sources} 个失败`)
          : "",
      ),
      syncButton,
    ),
    h(
      "div",
      { class: "strip-group" },
      h("p", { class: "strip-text" }, "检测"),
      h("div", { class: "segmented", role: "group", "aria-label": "选择检测范围并开始" }, testButtons),
    ),
    h(
      "div",
      { class: "strip-group runs", "aria-live": "polite" },
      state.active_scans.length
        ? state.active_scans.slice(0, 3).map(progress)
        : h("p", { class: "strip-text muted" }, "没有进行中的检测"),
    ),
  );
}
