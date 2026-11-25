import { api, errorText, fail, getReadRevision, h, invalidateReads, invalidateSession } from "./core.js";
import { renderStrip, refreshStrip, stopStrip } from "./strip.js";
import { pageHref } from "./lineage.js";

const PAGES = [
  ["overview", "总览", () => import("./pages/overview.js")],
  ["nodes", "节点", () => import("./pages/nodes.js")],
  ["sources", "来源", () => import("./pages/source-hub.js")],
  ["exports", "导出", () => import("./pages/exports.js")],
  ["ops", "运维", () => import("./pages/operations.js")],
  ["settings", "设置", () => import("./pages/settings.js")],
];
const ALIASES = {
  airports: ["sources", "airport"],
  substore: ["sources", "substore"],
  scans: ["ops", "scans"],
  usage: ["ops", "usage"],
};

const page = document.getElementById("page");
const app = document.getElementById("app");
const login = document.getElementById("login");
const loginTitle = document.getElementById("login-title");
const loginForm = document.getElementById("login-form");
const loginToken = document.getElementById("login-token");
const loginError = document.getElementById("login-error");
const loginSubmit = document.getElementById("login-submit");
const sessionStatus = document.getElementById("session-status");
const sessionRetry = document.getElementById("session-retry");
const logoutButtons = document.querySelectorAll("[data-logout]");
const sessions = typeof BroadcastChannel === "function" ? new BroadcastChannel("nodema-session") : null;

document.querySelector(".skip").addEventListener("click", (event) => {
  event.preventDefault();
  const target = loginForm.hidden ? loginTitle : loginToken;
  (app.hidden ? target : page).focus();
});
let expiryTimer;
let activeView;
let nodeList;
history.scrollRestoration = "manual";

function currentRoute() {
  const [name, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const route = normalize(name, new URLSearchParams(query));
  if (Object.hasOwn(ALIASES, name)) history.replaceState(history.state, "", pageHref(route.name, route.params));
  return route;
}

function normalize(name, params) {
  if (Object.hasOwn(ALIASES, name)) {
    const [target, tab] = ALIASES[name];
    if (!(name === "scans" && params.get("tab") === "probes")) params.set("tab", tab);
    return { name: target, params };
  }
  return { name: PAGES.some(([key]) => key === name) ? name : "overview", params };
}

export function go(name, params) {
  const route = normalize(name, new URLSearchParams(params));
  location.hash = pageHref(route.name, route.params);
}

function saveNodeList(view) {
  return {
    view,
    focus: view.root?.contains(document.activeElement) ? document.activeElement : null,
    x: window.scrollX,
    y: window.scrollY,
    tables: Array.from(view.root?.querySelectorAll(".table-wrap") || [],
      (table) => [table, table.scrollLeft]),
  };
}

function restoreNodeList(saved) {
  for (const [table, x] of saved.tables) table.scrollLeft = x;
  window.scrollTo(saved.x, saved.y);
  saved.focus?.focus({ preventScroll: true });
}

async function render() {
  if (app.hidden) return;
  const { name, params } = currentRoute();
  const href = pageHref(name, params);
  const isDetail = name === "nodes" && params.has("node");
  const isNodeList = name === "nodes" && !isDetail;
  const previous = activeView;
  let returnTo = isDetail ? history.state?.nodemaNodeList : null;
  if (isDetail && previous?.isNodeList) {
    nodeList = saveNodeList(previous);
    returnTo ||= { href: previous.href, direct: true };
  } else if (isDetail && !returnTo && previous?.returnTo) {
    returnTo = { href: previous.returnTo.href, direct: false };
  }
  if (returnTo && !history.state?.nodemaNodeList) {
    history.replaceState({ ...history.state, nodemaNodeList: returnTo }, "");
  }
  const saved = isNodeList && previous?.returnTo?.href === href && nodeList?.view.href === href ? nodeList : null;
  if (isNodeList) nodeList = null;
  for (const link of document.querySelectorAll(".rail a[data-page]")) {
    if (link.dataset.page === name) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  document.querySelector(".nav-more").dataset.current = String(name === "ops" || name === "settings");
  document.querySelector(".nav-more").open = false;
  const [, title, loadPage] = PAGES.find(([key]) => key === name);
  const load = isDetail ? () => import("./pages/node-detail.js") : loadPage;
  const screen = [name, ...["tab", "node", "source", "subscription", "scan"].map((key) => params.get(key))].join("/");
  document.title = title + " · Nodema";
  if (saved?.view.ready && saved.view.revision === getReadRevision()) {
    activeView = saved.view;
    page.replaceChildren(activeView.root);
    page.removeAttribute("aria-busy");
    restoreNodeList(saved);
    return;
  }
  const view = { href, screen, isNodeList, returnTo, revision: getReadRevision() };
  activeView = view;
  const isCurrent = () => activeView === view;
  const refresh = () => {
    if (!isCurrent()) return;
    invalidateReads();
    return render();
  };
  page.setAttribute("aria-busy", "true");
  const sameScreen = previous?.screen === screen;
  const pending = h("p", { class: "page-loading", role: "status" }, h("span", {}, sameScreen ? "正在更新…" : "正在加载…"));
  if (!sameScreen) {
    page.replaceChildren(h("div", { class: "page" }, h("h1", { class: "page-title" }, title), pending));
    window.scrollTo(0, 0);
    page.scrollTop = 0;
  } else {
    page.querySelector(".page-loading")?.remove();
    page.prepend(pending);
  }
  const root = h("div", { class: "page" });
  try {
    const module = await load();
    if (!isCurrent()) return;
    // Pages pass lists and optional (null) sections; flatten them like h() does.
    const append = root.append.bind(root);
    root.append = (...items) => append(...items.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false));
    const work = module.render(root, {
      params, go, refresh, refreshStrip, isCurrent, returnTo,
    });
    if (!sameScreen && root.childNodes.length) {
      root.append(pending);
      page.replaceChildren(root);
    }
    await work;
    if (!isCurrent()) return;
    view.root = root;
    view.ready = true;
    if (root.parentNode !== page) page.replaceChildren(root);
    if (saved) restoreNodeList(saved);
  } catch (error) {
    if (!isCurrent()) return;
    if (previous?.href === href && previous.ready) {
      activeView = previous;
      page.removeAttribute("aria-busy");
      fail(error);
      return;
    }
    const failure = h("div", { class: "empty", role: "alert" },
      h("p", { class: "empty-title" }, "页面加载失败"),
      h("p", {}, errorText(error?.code || error?.message)),
      h("button", { type: "button", onclick: refresh }, "重新加载"),
    );
    if (root.parentNode === page && pending.parentNode === root) pending.replaceWith(failure);
    else page.replaceChildren(failure);
  } finally {
    pending.remove();
    if (isCurrent()) page.removeAttribute("aria-busy");
  }
}

const expiredMessage = "登录已失效，请重新输入密钥。";

function showApp(session) {
  if (session?.authenticated !== true || !Number.isInteger(session.expires_in) || session.expires_in <= 0)
    throw new Error();
  loginToken.value = "";
  login.hidden = true;
  app.hidden = false;
  expiryTimer = setTimeout(() => showLogin(expiredMessage), session.expires_in * 1000);
  renderStrip(document.getElementById("strip"));
  render();
  page.focus();
}

function showLogin(message = "", retry = false) {
  clearTimeout(expiryTimer);
  if (!app.hidden) {
    app.hidden = true;
    invalidateSession();
    activeView = nodeList = undefined;
    page.removeAttribute("aria-busy");
    page.replaceChildren();
    stopStrip();
    document.querySelectorAll("dialog.sheet").forEach((box) => {
      box.close();
      box.remove();
    });
    document.getElementById("toast").replaceChildren();
    window.dispatchEvent(new CustomEvent("nodema:nodes-changed"));
    document.title = "Nodema 节点台";
  }
  login.hidden = false;
  sessionStatus.hidden = true;
  loginForm.hidden = false;
  sessionRetry.hidden = !retry;
  loginError.textContent = message;
  (retry ? sessionRetry : loginToken).focus();
}

async function checkSession() {
  loginForm.hidden = true;
  sessionStatus.hidden = false;
  loginError.textContent = "";
  loginToken.removeAttribute("aria-invalid");
  try {
    showApp(await api("/session"));
  } catch (error) {
    if (error.status === 401) showLogin();
    else showLogin("无法检查登录状态。" + errorText(error.code || "OPERATION_FAILED"), true);
  }
}

function railIcon(key) {
  const ns = "http://www.w3.org/2000/svg";
  const icon = document.createElementNS(ns, "svg");
  icon.setAttribute("class", "rail-icon");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  const use = document.createElementNS(ns, "use");
  use.setAttribute("href", "#rail-" + key);
  icon.append(use);
  return icon;
}

document.getElementById("nav").append(
  ...PAGES.filter(([key]) => key !== "settings").map(([key, title]) =>
    h("li", { class: key === "ops" ? "nav-ops" : null },
      h("a", { class: "rail-item", href: "#/" + key, dataset: { page: key }, title },
        railIcon(key), h("span", { class: "rail-label" }, title))),
  ),
);
const railToggle = document.querySelector(".rail-toggle");
const railPreference = "nodema.sidebarCollapsed";

function setRailCollapsed(collapsed) {
  app.classList.toggle("rail-collapsed", collapsed);
  const label = collapsed ? "展开侧栏" : "收起侧栏";
  railToggle.setAttribute("aria-expanded", String(!collapsed));
  railToggle.setAttribute("aria-label", label);
  railToggle.title = label;
}

try {
  setRailCollapsed(localStorage.getItem(railPreference) === "true");
} catch {
  // The sidebar still works when storage is unavailable.
}
railToggle.addEventListener("click", () => {
  const collapsed = !app.classList.contains("rail-collapsed");
  setRailCollapsed(collapsed);
  try {
    localStorage.setItem(railPreference, String(collapsed));
  } catch {
    // The current tab already reflects the new preference.
  }
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (loginSubmit.disabled) return;
  loginForm.setAttribute("aria-busy", "true");
  loginError.textContent = "";
  loginToken.removeAttribute("aria-invalid");
  loginSubmit.disabled = sessionRetry.disabled = true;
  loginSubmit.textContent = "正在登录…";
  try {
    const request = api("/session", { method: "POST", authorization: loginToken.value });
    loginToken.value = "";
    await request;
    showApp(await api("/session"));
  } catch (error) {
    if (error.code === "INVALID_ADMIN_TOKEN") loginToken.setAttribute("aria-invalid", "true");
    loginError.textContent = error.code === "AUTHENTICATION_REQUIRED"
      ? "浏览器未保存登录会话，请允许本站 Cookie 后重试。"
      : errorText(error.code || "OPERATION_FAILED");
    loginToken.focus();
  } finally {
    loginForm.removeAttribute("aria-busy");
    loginSubmit.disabled = sessionRetry.disabled = false;
    loginSubmit.textContent = "登录";
  }
});
loginToken.addEventListener("input", () => {
  if (!loginToken.hasAttribute("aria-invalid")) return;
  loginToken.removeAttribute("aria-invalid");
  loginError.textContent = "";
});
sessionRetry.addEventListener("click", checkSession);
for (const button of logoutButtons) button.addEventListener("click", async () => {
  for (const control of logoutButtons) control.disabled = true;
  try {
    await api("/session", { method: "DELETE" });
    sessions?.postMessage("logout");
    showLogin();
  } catch (error) {
    fail(error);
  } finally {
    for (const control of logoutButtons) control.disabled = false;
  }
});
sessions?.addEventListener("message", (event) => {
  if (event.data === "logout" && !app.hidden) showLogin("已退出，请重新登录。");
});
const more = document.querySelector(".nav-more");
more.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && more.open) {
    more.open = false;
    more.querySelector("summary").focus();
  }
});
window.addEventListener("nodema:session-expired", () => {
  if (!app.hidden) showLogin(expiredMessage);
});
window.addEventListener("hashchange", () => {
  document.querySelector("dialog.node-share")?.close();
  render();
});

try {
  sessionStorage.removeItem("nodema.session");
} catch {
  // Storage may be disabled.
}
checkSession();
