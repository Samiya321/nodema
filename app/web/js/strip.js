// The only place that starts GitHub Actions: sync sources, or test nodes.
import { KIND, ago, api, busy, confirm, dialog, h, meter, toast } from "./core.js";

// Poll only while work is pending or just requested, so an idle tab lets the free
// database suspend. Navigation, focus and actions refresh it otherwise.
let root, timer, last, listening = false, wakeUntil = 0;
const WAKE_MS = 10 * 60 * 1000;
const RUNNING = ["PENDING", "RUNNING"];

export function renderStrip(element) {
  root = element;
  refreshStrip();
  if (listening) return;
  listening = true;
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && root?.isConnected) refreshStrip();
  });
  window.addEventListener("hashchange", () => refreshStrip());
}

let wasWorking = false;

function schedule(busyNow) {
  clearTimeout(timer);
  if (!busyNow && Date.now() > wakeUntil) return;
  timer = setTimeout(() => {
    if (!document.hidden) refreshStrip();
    else schedule(busyNow);
  }, 15000);
}

export async function refreshStrip() {
  try {
    last = await api("/pipeline");
  } catch {
    return;
  }
  draw(last);
  const running = last.active_scans.some((r) => RUNNING.includes(r.status));
  // A test or sync just finished: cached node lists are stale.
  const work = running || last.pending_sources > 0;
  if (wasWorking && !work) window.dispatchEvent(new CustomEvent("nodema:nodes-changed"));
  wasWorking = work;
  schedule(running || (last.requested_scans || []).length > 0);
}

function submitted(result, what) {
  wakeUntil = Date.now() + WAKE_MS;
  setTimeout(refreshStrip, 4000);
  if (result?.dispatched === false)
    toast(`${what}已保存，但提交到 GitHub 失败；下一次同步、检测或定时任务会执行它。`, "bad");
  else toast(`${what}已提交到 GitHub Actions，通常 1 分钟内开始。`, "ok");
}

// Sync chosen sources right away (sources page, Sub-Store page).
export async function syncSources(ids, button) {
  return busy(button, async () => {
    submitted(await api("/pipeline/sync", { method: "POST", body: ids ? { source_ids: ids } : {} }), "同步");
    return true;
  });
}

async function startSync(button) {
  const count = last?.sources_total ?? "全部";
  if (!(await confirm("同步来源", `重新拉取 ${count} 个启用的来源：更新节点、机场流量与 Sub-Store 子来源。只同步，不检测节点。`, { action: "开始同步" })))
    return;
  await busy(button, async () => submitted(await api("/pipeline/sync", { method: "POST" }), "同步"));
}

// Test specific nodes (from the node list) without choosing a scope.
export async function testNodes(ids) {
  if (!ids.length) return false;
  if (!(await confirm("检测所选节点", `检测已选的 ${ids.length} 个节点。正在其他未完成批次中的节点会跳过。`, { action: "开始检测" })))
    return false;
  try {
    submitted(await api("/scans", { method: "POST", body: { node_ids: ids } }), "检测");
    return true;
  } catch (error) {
    toast(error.code || "检测提交失败", "bad");
    return false;
  }
}

export function openTestDialog() {
  const testable = last?.testable || {};
  const options = [
    ["SELF_HOSTED", "自建节点", testable.SELF_HOSTED || 0, "你自己的服务器节点。"],
    ["AIRPORT", "机场节点", testable.AIRPORT || 0, "只含未过期、流量未用完、未暂停的机场订阅。"],
    ["ALL", "全部", (testable.SELF_HOSTED || 0) + (testable.AIRPORT || 0), "自建与机场一起检测。"],
  ];
  const form = h(
    "form",
    { class: "stack" },
    h(
      "fieldset",
      { class: "choices" },
      h("legend", {}, "检测范围"),
      options.map(([value, title, count, hint], index) =>
        h(
          "label",
          { class: "choice" },
          h("input", { type: "radio", name: "scope", value, checked: index === 0 }),
          h("span", { class: "choice-title" }, title, h("span", { class: "muted" }, ` ${count} 个`)),
          h("span", { class: "hint" }, hint),
        ),
      ),
    ),
    last?.pending_sources ? h("p", { class: "hint" }, `开始前会先同步 ${last.pending_sources} 个待同步来源。`) : null,
    h("p", { class: "hint" }, "想只测部分节点：在“节点”页勾选后点“检测所选”。"),
    h("div", { class: "row end" }, h("button", { type: "submit", class: "primary" }, "开始检测")),
  );
  const box = dialog("开始检测", form);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const scope = new FormData(form).get("scope");
    await busy(e.submitter, async () => {
      submitted(await api("/scans", { method: "POST", body: { scope } }), "检测");
      box.close();
    });
  });
}

function runView(run) {
  const done = Number(run.done || 0),
    total = Number(run.node_count || 0);
  const label = run.scope === "ALL" ? "全部" : KIND[run.scope] || "全部";
  if (RUNNING.includes(run.status))
    return h(
      "a",
      { class: "run", href: "#/scans", title: "查看检测记录" },
      h("span", { class: "run-label" }, `检测中 · ${label} ${done}/${total}`),
      meter(total ? done / total : 0, { tone: "info", label: "检测进度" }),
    );
  const resume = h("button", { type: "button", class: "small-button" }, "继续");
  resume.addEventListener("click", () =>
    busy(resume, async () => submitted(await api(`/scans/${run.id}/retry`, { method: "POST" }), "继续检测")),
  );
  return h(
    "p",
    { class: "strip-text" },
    h("span", { class: "warn-dot" }),
    `上次检测中断（${label} ${done}/${total}）`,
    resume,
  );
}

function draw(state) {
  const syncButton = h("button", { type: "button" }, "同步来源");
  syncButton.addEventListener("click", () => startSync(syncButton));
  const testButton = h("button", { type: "button", class: "primary" }, "开始检测");
  testButton.addEventListener("click", openTestDialog);
  const requested = state.requested_scans || [];
  root.replaceChildren(
    h(
      "div",
      { class: "strip-group" },
      syncButton,
      h(
        "p",
        { class: "strip-text muted" },
        `上次同步 ${ago(state.last_synced_at)}`,
        state.pending_sources ? h("strong", { class: "light" }, `，${state.pending_sources} 个待同步`) : "",
        state.failed_sources ? h("a", { href: "#/sources?status=FAILED", class: "bad-text" }, `，${state.failed_sources} 个失败`) : "",
      ),
    ),
    h("div", { class: "strip-group" }, testButton),
    h(
      "div",
      { class: "strip-group runs", "aria-live": "polite" },
      requested.map((r) =>
        h("p", { class: "strip-text", title: "等待 GitHub Actions 开始" }, `已请求：${r.scope === "NODES" ? `所选 ${r.nodes} 个节点` : KIND[r.scope]}`),
      ),
      state.active_scans.slice(0, 2).map(runView),
      !requested.length && !state.active_scans.length ? h("p", { class: "strip-text muted" }, "没有进行中的检测") : null,
    ),
  );
}
