// Shared DOM, API and formatting helpers. Everything is built with DOM APIs
// (never innerHTML), so node names and remote metadata can't inject markup.

const TOKEN_KEY = "nodema.session";

export const session = {
  get token() {
    try {
      return sessionStorage.getItem(TOKEN_KEY) || "";
    } catch {
      return "";
    }
  },
  set token(value) {
    try {
      if (value) sessionStorage.setItem(TOKEN_KEY, value);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* private mode: the token simply isn't remembered across reloads */
    }
  },
};

export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function")
      node.addEventListener(key.slice(2), value);
    else if (key === "value") node.value = value;
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export class ApiError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export async function api(path, { method = "GET", body } = {}) {
  let response;
  try {
    response = await fetch("/api" + path, {
      method,
      headers: {
        Authorization: "Bearer " + session.token,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new ApiError("NETWORK_ERROR", 0);
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    const code = data?.error_code || data?.detail || "OPERATION_FAILED";
    if (response.status === 401) window.dispatchEvent(new CustomEvent("nodema:logout"));
    throw new ApiError(code, response.status);
  }
  return data;
}

export const STATUS = {
  UP: ["可用", "ok"],
  DEGRADED: ["较慢", "warn"],
  DOWN: ["不可用", "bad"],
  UNKNOWN: ["未检测", "mute"],
  STALE: ["结果过期", "mute"],
  UNSUPPORTED: ["不支持", "mute"],
  ENVIRONMENT_ERROR: ["环境异常", "warn"],
  COMPLETED: ["已完成", "ok"],
  PENDING: ["排队中", "mute"],
  RUNNING: ["进行中", "info"],
  PARTIAL: ["部分完成", "warn"],
  FAILED: ["失败", "bad"],
  SUCCESS: ["成功", "ok"],
  NEVER: ["未同步", "mute"],
  RETRYABLE: ["待重试", "warn"],
};

export const KIND = {
  SELF_HOSTED: "自建",
  AIRPORT: "机场",
  SUBSTORE: "Sub-Store",
  AUTO: "自动识别",
  ALL: "全部",
};
export const SCAN_KIND = { DAILY: "每日", SUPPLEMENTAL: "补测", MANUAL: "手动" };

export const ERRORS = {
  AUTHENTICATION_REQUIRED: "管理员密钥不正确。",
  NETWORK_ERROR: "无法连接到服务，请检查网络后重试。",
  INPUT_TOO_LARGE: "内容超过大小上限，请拆分后重试。",
  TOO_MANY_SUBSCRIPTION_LINKS: "每批最多 100 个地址，请分批导入。",
  SUBSCRIPTION_URL_TOO_LONG: "单个地址超过 8 KiB。",
  UNSAFE_SUBSCRIPTION_URL: "需要公开的 HTTP/HTTPS 地址，不支持本地地址或带账号密码的链接。",
  EMPTY_INPUT: "请至少输入一项内容。",
  INVALID_SOURCE_LABEL: "名称不能为空，也不能包含链接或控制字符。",
  INVALID_SOURCE_KIND: "来源类别无效。",
  INVALID_SUBSCRIPTION_USER_AGENT: "User-Agent 只能包含可见 ASCII 字符，最多 512 个。",
  DISPATCH_NOT_CONFIGURED: "还没有配置 GitHub 调度（仓库与令牌）。",
  DISPATCH_FAILED: "提交到 GitHub Actions 失败，请稍后重试；请求已保存。",
  INVALID_SCAN_SCOPE: "检测范围无效。",
  SOURCE_DISABLED: "来源已暂停，请先启用。",
  NO_ENABLED_SOURCES: "所选来源都已暂停或删除，没有可同步的来源。",
  SOURCE_NOT_FOUND: "来源不存在或已删除。",
  PROVIDER_NOT_FOUND: "机场分组不存在。",
  INVALID_PROVIDER_NAME: "分组名称需为 1–80 个字符，且不能包含链接。",
  INVALID_PROVIDER_WEBSITE: "官网需为 http/https 地址。",
  INVALID_ASN_LABEL: "简称需为 1–40 个字符，不能包含 | 或控制字符。",
  INVALID_SELECTION: "请先选择要操作的项目（最多 1000 个）。",
  INVALID_NAME_TEMPLATE: "命名模板无效：只能使用列出的字段，括号要成对。",
  INVALID_NODE_QUERY: "筛选条件无效，请检查字段和数值。",
  INVALID_NODE_SORT: "排序条件无效。",
  INVALID_EXPORT_FILTER: "订阅筛选条件无效。",
  INVALID_EXPORT_NAME: "方案名称需为 1–80 个字符。",
  INVALID_EXPORT_EXPIRY: "有效期需为 1–8760 小时，或长期有效。",
  EXPORT_PENDING: "订阅正在生成，请稍后再试。",
  EXPORT_PROFILE_LIMIT: "订阅方案已达上限，请撤销不用的方案。",
  EXPORT_STORAGE_LIMIT: "订阅总量超出预算，请缩小范围。",
  EXPORT_TOO_LARGE: "单个订阅超过 10 MiB，请缩小范围或设置最多节点数。",
  EXPORT_REVISION_CONFLICT: "方案已被修改，请重新打开编辑。",
  EXPORT_TOKEN_LEGACY: "旧链接无法显示，请更换密钥获取新链接。",
  EXPORT_NOT_AVAILABLE: "链接已过期或被撤销。",
  EXPORT_BUILD_FAILED: "生成失败，请重新生成。",
  QUALITY_POLICY_CONFLICT: "规则已被其他操作更新，请刷新后再编辑。",
  INVALID_QUALITY_POLICY: "参考规则无效，请检查地区、ASN 与数值。",
  INVALID_NODE_ANNOTATION: "人工资料无效。",
  EVIDENCE_REFERENCE_REQUIRED: "选择“有资料”时需要填写依据。",
  SCAN_ARCHIVED: "该批次已归档，不能重试。",
  SCAN_NOT_FOUND: "检测批次不存在。",
  DATABASE_UNAVAILABLE: "数据库暂时无法连接（免费实例可能在休眠），稍后重试。",
  DATABASE_QUERY_FAILED: "数据库请求失败，请稍后重试。",
  ADMIN_TOKEN_REQUIRED: "服务端尚未配置管理员密钥。",
  OPERATION_FAILED: "操作失败，请稍后重试。",
  // Source/scan outcomes shown in tables.
  FETCH_TIMEOUT: "拉取超时",
  FETCH_HTTP_ERROR: "订阅地址返回错误状态",
  FETCH_DNS_FAILED: "订阅域名无法解析",
  FETCH_CONNECT_FAILED: "无法连接订阅地址",
  FETCH_FAILED: "拉取失败",
  PARTIAL_PARSE: "部分内容无法解析，有效节点已保留",
  INVALID_SUBSTORE_RESPONSE: "不是有效的 Sub-Store 响应",
  SUBSTORE_API_ERROR: "Sub-Store 返回错误",
  EMPTY_SUBSTORE_INDEX: "Sub-Store 没有订阅",
  SUBSTORE_DEPTH_LIMIT: "Sub-Store 嵌套过深",
  NO_VALID_NODES: "没有可识别的节点",
  TOO_MANY_ITEMS: "节点数量超过上限",
  ECHO_ENVIRONMENT_ERROR: "检测环境无法访问回显服务",
  RUNNER_NETWORK_ERROR: "检测环境网络异常",
  MIHOMO_START_FAILED: "代理核心启动失败",
  DNS_TIMEOUT: "入口域名解析超时",
  ENTRY_DNS_NOT_FOUND: "入口域名不存在",
  ENTRY_DNS_ERROR: "入口域名解析失败",
  ENTRY_TCP_UNREACHABLE: "入口端口不通",
  ECHO_TIMEOUT: "代理请求超时",
  ECHO_REQUEST_FAILED: "代理请求失败",
  NODE_COOLDOWN: "连续失败，冷却中",
  ENTRY_NETWORK_UNAVAILABLE: "检测环境无此网络（如 IPv6）",
  RUNTIME_UNSUPPORTED: "核心不支持该配置",
};
export const errorText = (code) => ERRORS[code] || code || "未知错误";

export function badge(status) {
  const [text, tone] = STATUS[status] || [status || "—", "mute"];
  return h("span", { class: "badge " + tone }, text);
}

export function flag(country) {
  if (!country || !/^[A-Za-z]{2}$/.test(country)) return "🏳";
  return String.fromCodePoint(
    ...[...country.toUpperCase()].map((c) => 127397 + c.charCodeAt(0)),
  );
}

export function route(entry, exit) {
  const chip = h("span", { class: "route" });
  if (!exit && !entry) chip.append(h("span", { class: "code mute" }, "—"));
  else if (!entry || entry === exit) chip.append(h("span", { class: "code" }, exit || entry));
  else
    chip.append(
      h("span", { class: "code from" }, entry),
      h("span", { class: "arrow", "aria-label": "到" }, "→"),
      h("span", { class: "code" }, exit || "?"),
    );
  return chip;
}

const dateFormat = new Intl.DateTimeFormat("zh-CN", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Asia/Shanghai",
});
export function date(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : dateFormat.format(d);
}
export function ago(value) {
  if (!value) return "从未";
  const seconds = (Date.now() - new Date(value).getTime()) / 1000;
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return Math.floor(seconds / 60) + " 分钟前";
  if (seconds < 86400) return Math.floor(seconds / 3600) + " 小时前";
  return Math.floor(seconds / 86400) + " 天前";
}
export function daysUntil(value) {
  if (!value) return null;
  // Whole days, rounded toward zero: "expired 3 days" right after 3 days have passed.
  return Math.trunc((new Date(value).getTime() - Date.now()) / 86400000);
}
export function bytes(value) {
  if (value === null || value === undefined) return "—";
  let n = Number(value);
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return (i ? n.toFixed(n >= 100 ? 0 : 1) : n) + " " + units[i];
}
export const pct = (value) =>
  value === null || value === undefined ? "—" : (Number(value) * 100).toFixed(1) + "%";
export const ms = (value) =>
  value === null || value === undefined ? "—" : Math.round(Number(value)) + " ms";

let toastTimer;
export function toast(message, tone = "info") {
  const region = document.getElementById("toast");
  region.replaceChildren(h("p", { class: "toast " + tone }, message));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => region.replaceChildren(), tone === "bad" ? 9000 : 5000);
}
export function fail(error) {
  toast(errorText(error?.code || error?.message), "bad");
}

export function dialog(title, content, { wide = false } = {}) {
  const box = h(
    "dialog",
    { class: wide ? "sheet wide" : "sheet", "aria-labelledby": "dialog-title" },
    h(
      "header",
      {},
      h("h2", { id: "dialog-title" }, title),
      h("button", { class: "icon", type: "button", "aria-label": "关闭", onclick: () => box.close() }, "✕"),
    ),
    h("div", { class: "sheet-body" }, content),
  );
  const trigger = document.activeElement;
  box.addEventListener("close", () => {
    box.remove();
    if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
  });
  document.body.append(box);
  box.showModal();
  return box;
}

export function confirm(title, message, { action = "确认", danger = false, extra } = {}) {
  return new Promise((resolve) => {
    let result = false;
    const body = h(
      "div",
      { class: "stack" },
      h("p", {}, message),
      extra,
      h(
        "div",
        { class: "row end" },
        h("button", { type: "button", onclick: () => box.close() }, "取消"),
        h(
          "button",
          {
            type: "button",
            class: danger ? "danger" : "primary",
            onclick: () => {
              result = true;
              box.close();
            },
          },
          action,
        ),
      ),
    );
    const box = dialog(title, body);
    box.addEventListener("close", () => resolve(result));
  });
}

export function empty(title, hint, action) {
  return h("div", { class: "empty" }, h("p", { class: "empty-title" }, title), hint && h("p", {}, hint), action);
}

export function field(label, control, hint) {
  const id = control.id || "f-" + Math.random().toString(36).slice(2, 9);
  control.id = id;
  return h(
    "label",
    { class: "field", for: id },
    h("span", { class: "field-label" }, label),
    control,
    hint && h("span", { class: "hint" }, hint),
  );
}
export function select(name, options, value = "") {
  return h(
    "select",
    { name },
    options.map(([v, text]) => h("option", { value: v, selected: String(v) === String(value) }, text)),
  );
}

// Disable a button while an async action runs; show failures as a toast.
export async function busy(button, work) {
  if (button) button.disabled = true;
  try {
    return await work();
  } catch (error) {
    fail(error);
    return undefined;
  } finally {
    if (button && button.isConnected) button.disabled = false;
  }
}

export function table(columns, rows, { empty: emptyNode, rowClass } = {}) {
  if (!rows.length) return emptyNode || empty("暂无数据");
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      {},
      h("thead", {}, h("tr", {}, columns.map((c) => h("th", { class: c.class, scope: "col" }, c.label)))),
      h(
        "tbody",
        {},
        rows.map((row) =>
          h(
            "tr",
            { class: rowClass?.(row) },
            columns.map((c) =>
              h("td", { class: c.class, "data-label": typeof c.label === "string" ? c.label : undefined }, c.render(row)),
            ),
          ),
        ),
      ),
    ),
  );
}

// Checkbox selection shared by list pages; returns helpers for header/rows/bar.
export function selection(onChange) {
  const ids = new Set();
  const changed = () => onChange(ids);
  return {
    ids,
    refresh: changed,
    clear() {
      ids.clear();
      changed();
    },
    box(id) {
      return h("input", {
        type: "checkbox",
        "aria-label": "选择",
        checked: ids.has(id),
        onchange: (e) => {
          if (e.target.checked) ids.add(id);
          else ids.delete(id);
          changed();
        },
      });
    },
    all(list) {
      return h("input", {
        type: "checkbox",
        "aria-label": "全选本页",
        checked: list.length > 0 && list.every((id) => ids.has(id)),
        onchange: (e) => {
          for (const id of list) e.target.checked ? ids.add(id) : ids.delete(id);
          changed();
          e.target.closest("table")
            ?.querySelectorAll("tbody input[type=checkbox]")
            .forEach((box) => (box.checked = e.target.checked));
        },
      });
    },
  };
}

export function debounce(fn, wait = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

// CSP forbids inline style attributes; CSSOM writes are allowed.
export function meter(ratio, { tone = "", label } = {}) {
  const fill = h("span", { class: "fill " + tone });
  fill.style.setProperty("--fill", (Math.max(0, Math.min(1, ratio || 0)) * 100).toFixed(1) + "%");
  return h(
    "span",
    {
      class: "meter",
      role: "meter",
      "aria-valuemin": 0,
      "aria-valuemax": 100,
      "aria-valuenow": Math.round((ratio || 0) * 100),
      "aria-label": label,
    },
    fill,
  );
}
