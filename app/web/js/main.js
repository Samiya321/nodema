import { api, errorText, h, session } from "./core.js";
import { renderStrip, refreshStrip } from "./strip.js";

const PAGES = [
  ["overview", "总览", () => import("./pages/overview.js")],
  ["nodes", "节点", () => import("./pages/nodes.js")],
  ["sources", "来源", () => import("./pages/sources.js")],
  ["airports", "机场", () => import("./pages/airports.js")],
  ["substore", "Sub-Store", () => import("./pages/substore.js")],
  ["scans", "检测记录", () => import("./pages/scans.js")],
  ["exports", "订阅导出", () => import("./pages/exports.js")],
  ["usage", "运行用量", () => import("./pages/usage.js")],
  ["settings", "设置", () => import("./pages/settings.js")],
];

const page = document.getElementById("page");
let rendering = 0;

function currentRoute() {
  const [name, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const known = PAGES.find(([key]) => key === name);
  return { name: known ? name : "overview", params: new URLSearchParams(query) };
}

export function go(name, params) {
  const query = params && [...params].length ? "?" + new URLSearchParams(params) : "";
  location.hash = "#/" + name + query;
}

async function render() {
  const { name, params } = currentRoute();
  const ticket = ++rendering;
  for (const link of document.querySelectorAll("#nav a"))
    link.toggleAttribute("aria-current", link.dataset.page === name);
  const [, title, load] = PAGES.find(([key]) => key === name);
  document.title = title + " · Nodema";
  page.setAttribute("aria-busy", "true");
  try {
    const module = await load();
    const root = h("div", { class: "page" });
    // Pages pass lists and optional (null) sections; flatten them like h() does.
    const append = root.append.bind(root);
    root.append = (...items) => append(...items.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false));
    await module.render(root, { params, go, refresh: render, refreshStrip });
    if (ticket !== rendering) return;
    page.replaceChildren(root);
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
  ...PAGES.map(([key, title]) =>
    h("li", {}, h("a", { href: "#/" + key, dataset: { page: key } }, title)),
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
document.getElementById("logout").addEventListener("click", () => showLogin());
window.addEventListener("nodema:logout", () => showLogin("登录已失效，请重新输入密钥。"));
window.addEventListener("hashchange", () => {
  if (!document.getElementById("app").hidden) render();
});

if (session.token) showApp();
else showLogin();
