import { api, errorText, h, session } from "./core.js";
import { renderStrip, refreshStrip } from "./strip.js";
import { pageHref } from "./lineage.js";

const PAGES = [
  ["overview", "总览", () => import("./pages/overview.js")],
  ["nodes", "节点", () => import("./pages/nodes.js")],
  ["sources", "来源", () => import("./pages/source-hub.js")],
  ["exports", "订阅导出", () => import("./pages/exports.js")],
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
document.querySelector(".skip").addEventListener("click", (event) => {
  event.preventDefault();
  (document.getElementById("app").hidden ? document.getElementById("login-token") : page).focus();
});
let rendering = 0;
let shown = ""; // page name on screen: a new page starts at the top, a re-render keeps its place

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

async function render() {
  const { name, params } = currentRoute();
  const ticket = ++rendering;
  for (const link of document.querySelectorAll(".rail a[data-page]")) {
    if (link.dataset.page === name) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  document.querySelector(".nav-more").dataset.current = String(name === "ops" || name === "settings");
  document.querySelector(".nav-more").open = false;
  const [, title, load] = PAGES.find(([key]) => key === name);
  document.title = title + " · Nodema";
  page.setAttribute("aria-busy", "true");
  try {
    const module = await load();
    const root = h("div", { class: "page" });
    // Pages pass lists and optional (null) sections; flatten them like h() does.
    const append = root.append.bind(root);
    root.append = (...items) => append(...items.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false));
    await module.render(root, { params, go, refresh: render, refreshStrip, isCurrent: () => ticket === rendering });
    if (ticket !== rendering) return;
    page.replaceChildren(root);
    if (shown !== name) {
      window.scrollTo(0, 0);
      page.scrollTop = 0;
    }
    shown = name;
  } catch (error) {
    if (ticket !== rendering) return;
    page.replaceChildren(
      h(
        "div",
        { class: "empty" },
        h("p", { class: "empty-title" }, "页面加载失败"),
        h("p", {}, errorText(error?.code || error?.message)),
        h("button", { type: "button", onclick: render }, "重新加载"),
      ),
    );
  } finally {
    if (ticket === rendering) page.removeAttribute("aria-busy");
  }
}

function showApp() {
  document.getElementById("login").hidden = true;
  document.getElementById("app").hidden = false;
  renderStrip(document.getElementById("strip"));
  render();
}

function showLogin(message = "") {
  session.token = "";
  document.getElementById("app").hidden = true;
  document.getElementById("login").hidden = false;
  document.getElementById("login-error").textContent = message;
  document.getElementById("login-token").focus();
}

document.getElementById("nav").append(
  ...PAGES.filter(([key]) => key !== "settings").map(([key, title]) =>
    h("li", { class: key === "ops" ? "nav-ops" : null }, h("a", { href: "#/" + key, dataset: { page: key } }, title)),
  ),
);
document.getElementById("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.target.querySelector("button");
  button.disabled = true;
  session.token = event.target.elements.token.value;
  try {
    await api("/pipeline");
    event.target.reset();
    showApp();
  } catch (error) {
    showLogin(errorText(error.code));
  } finally {
    button.disabled = false;
  }
});
for (const button of document.querySelectorAll("[data-logout]")) button.addEventListener("click", () => showLogin());
const more = document.querySelector(".nav-more");
more.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && more.open) {
    more.open = false;
    more.querySelector("summary").focus();
  }
});
window.addEventListener("nodema:logout", () => showLogin("登录已失效，请重新输入密钥。"));
window.addEventListener("hashchange", () => {
  if (!document.getElementById("app").hidden) render();
});

if (session.token) showApp();
else showLogin();
