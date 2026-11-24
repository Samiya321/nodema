import { KIND, SCAN_KIND, ago, badge, bytes, date, daysUntil, errorText, flag, h, readAPI } from "../core.js";
import { distribution, gradeBadge, vantageName, vantageSwitch } from "../grades.js";
import { pageHref, scanHref, sourceHref } from "../lineage.js";

const PROBE_ERRORS = { NETWORK: "无法连接 Globalping", TIMEOUT: "测量超时", INVALID_RESPONSE: "Globalping 返回异常" };

function qualityPanel(status, vantage, go) {
  const counts = status?.grades || {};
  const link = (g) => `#/nodes?vantage=${vantage}&g=${g}`;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return h(
    "section",
    { class: "panel" },
    h("header", { class: "panel-head" }, h("h2", {}, "质量分布 · " + vantageName(vantage)), vantageSwitch(vantage, (v) => go("overview", new URLSearchParams({ vantage: v })))),
    total
      ? h(
          "div",
          { class: "stack" },
          distribution(counts, { link }),
          h(
            "ul",
            { class: "tally" },
            ["S", "A", "B", "C", "D", "PENDING"].map((g) =>
              h("li", {}, h("a", { href: link(g) }, gradeBadge(g, vantage, { withVantage: false })), h("strong", {}, counts[g] || 0)),
            ),
          ),
          h("p", { class: "muted small" }, `只统计当前可用的节点；定档于 ${ago(status.graded_at)}。`),
          status.coverage_total != null ? h("p", { class: "muted small" }, `当前可用 ${status.coverage_total} 个 · 有接入参考或实测 ${status.coverage_measured} 个 · 端点已确认 ${status.coverage_endpoint_verified} 个 · CF 落地排除 ${status.coverage_excluded} 个。`) : null,
        )
      : h("p", { class: "muted" }, "还没有定档。完成至少 3 天检测后出现等级；接入测量每小时运行一次。"),
  );
}

const GROUPS = ["SELF_HOSTED", "AIRPORT"];

function groupPanel(key, data) {
  const statuses = data?.statuses || {};
  const up = (statuses.UP || 0) + (statuses.DEGRADED || 0);
  const total = data?.total || 0;
  const rows = [
    ["可用", up, "ok", "AVAILABLE"],
    ["不可用", statuses.DOWN || 0, "bad", "DOWN"],
    ["未检测", statuses.UNKNOWN || 0, "mute", "UNKNOWN"],
    ["结果过期", statuses.STALE || 0, "mute", "STALE"],
    ["不支持", statuses.UNSUPPORTED || 0, "mute", "UNSUPPORTED"],
  ];
  return h(
    "section",
    { class: "panel group-panel" },
    h(
      "header",
      { class: "panel-head" },
      h("h2", {}, KIND[key] + "节点"),
      h("a", { href: `#/nodes?node_group=${key}&status=ALL` }, "查看全部"),
    ),
    h(
      "p",
      { class: "big-figure" },
      h("span", { class: "figure" }, format(up)),
      h("span", { class: "of" }, ` / ${format(total)} 可用`),
    ),
    h(
      "ul",
      { class: "tally" },
      rows.map(([label, n, tone, status]) =>
        h(
          "li",
          {},
          h("a", { href: `#/nodes?node_group=${key}&status=${status}` }, h("span", { class: "dot " + tone }), label),
          h("strong", {}, format(n)),
        ),
      ),
    ),
    h("p", { class: "muted small" }, `参与检测 ${format(data?.eligible || 0)} 个`),
  );
}

const format = (n) => Number(n).toLocaleString("zh-CN");
const usage = pageHref("ops", { tab: "usage" });
const probes = pageHref("ops", { tab: "probes" });
const settings = pageHref("settings");
const sourceProblems = (params = {}) => pageHref("sources", { status: "FAILED", active: "1", ...params });
const timestamp = (value) => value ? h("time", { datetime: value, title: date(value) }, ago(value)) : "暂无记录";
const olderThan = (value, hours, observed = Date.now()) => !value || observed - Date.parse(value) > hours * 3600000;

function tile(label, value, description, href) {
  return h("a", { href, class: "overview-tile" }, h("span", {}, label),
    h("strong", {}, value == null ? "—" : format(value)), h("small", {}, description));
}

function statusLine(label, tone, state, detail, href) {
  return h("li", {}, h("a", { href }, h("span", { class: "dot " + tone, "aria-hidden": "true" }), label),
    h("strong", {}, state), h("span", { class: "overview-status-detail" }, detail));
}

function statusPanel(ops, recovery) {
  const observed = Date.parse(ops.observed_at);
  const scan = ops.last_daily;
  const complete = ops.last_complete;
  const behind = olderThan(complete?.finished_at, 30, observed);
  const inProgress = scan?.status === "RUNNING" && scan.lease_active;
  const incomplete = scan && scan.status !== "COMPLETED";
  const lastComplete = complete ? ["上次完整 ", timestamp(complete.finished_at)] : "还没有完整日检";
  const daily = !ops.daily_enabled ? ["mute", "已暂停", "定时检测已关闭"]
    : inProgress ? ["info", "运行中", lastComplete]
    : incomplete || behind ? ["warn", incomplete ? "未完成" : "待检查", lastComplete]
    : ["ok", "正常", lastComplete];
  const probe = ops.probe;
  const probeState = !ops.probe_enabled ? ["mute", "已暂停", "定时测量已关闭"]
    : olderThan(probe?.finished_at, 3, observed) ? ["warn", "待检查", ["最近完成 ", timestamp(probe?.finished_at)]]
    : probe.error_code ? ["warn", "有异常", PROBE_ERRORS[probe.error_code] || "上次测量有错误"]
    : ["ok", "正常", [timestamp(probe.finished_at), ` · ${format(probe.measurements)} 个样本`]];
  const host = ops.host;
  const sampled = !olderThan(host?.taken_at, 0.5, observed);
  const disk = sampled ? Math.round(100 * host.disk_free / host.disk_total) : null;
  const certDays = sampled ? Math.ceil((Date.parse(host.tls_expires_at) - observed) / 86400000) : null;
  const hostState = sampled
    ? [disk < 20 || certDays <= 30 ? "warn" : "ok", disk < 20 ? "磁盘偏低" : certDays <= 30 ? "证书将到期" : "正常",
      `剩余磁盘 ${disk}% · TLS 剩余 ${certDays} 天`]
    : ["mute", "采样待更新", host ? timestamp(host.taken_at) : "暂无容量样本"];
  const backup = recovery?.backup;
  const drill = recovery?.drill;
  const backupLine = !recovery ? ["mute", "查询中", "正在读取备份记录"]
    : !recovery.backup_available ? ["warn", "记录不可用", "无法读取云端备份记录"]
    : !backup ? ["warn", "无可用备份", "没有发现有效备份包"]
    : [olderThan(backup.created_at, 36, observed) ? "warn" : "ok",
      olderThan(backup.created_at, 36, observed) ? "备份较旧" : "已备份", timestamp(backup.created_at)];
  const drillLine = !recovery ? ["mute", "查询中", "正在读取演练记录"]
    : !recovery.drill_available ? ["mute", "记录不可用", "无法读取云端演练记录"]
    : !drill ? ["mute", "待演练", "暂无自动恢复记录"]
    : [drill.result === "success" && !olderThan(drill.finished_at, 38 * 24, observed) ? "ok" : "warn",
      drill.result === "success" ? (olderThan(drill.finished_at, 38 * 24, observed) ? "演练较旧" : "通过") : "未通过", timestamp(drill.finished_at)];
  const ex = ops.exports;
  const exports = !ex.active ? ["mute", "未配置", "尚无生效中的订阅方案"]
    : [ex.unavailable ? "warn" : ex.serving === ex.active ? "ok" : "info",
      ex.unavailable ? "需检查" : ex.serving === ex.active ? "可下载" : "构建中",
      `${format(ex.serving)} / ${format(ex.active)} 可下载${ex.pending ? ` · ${format(ex.pending)} 个待构建` : ""}`];
  return h("ul", { class: "overview-status" },
    statusLine("服务与数据库", "ok", "可用", "页面 API 已连到 PostgreSQL", usage),
    statusLine("每日检测", ...daily, scan ? scanHref(scan.id) : settings),
    statusLine("接入测量", ...probeState, probes),
    statusLine("主机容量", ...hostState, usage),
    statusLine("加密备份", ...backupLine, usage),
    statusLine("恢复演练", ...drillLine, drill?.run_id ? `https://github.com/Samiya321/nodema/actions/runs/${drill.run_id}` : usage),
    statusLine("成品订阅", ...exports, "#/exports"),
  );
}

function attention(summary, ops) {
  const s = ops?.sources;
  const items = [];
  for (const group of summary.groups.filter((g) => g.worked).slice(0, 3)) {
    const title = group.total > 1 ? `${group.name} · ${format(group.total)} 个异常` : group.name;
    items.push(h("li", {}, h("div", {}, h("a", { href: group.total > 1
      ? sourceProblems({ root: group.id, sort: "problems" }) : sourceHref(group.example_id) }, title),
      h("p", {}, [`${format(group.worked)} 个曾同步成功`, ...group.errors.map(errorText),
        group.next_attempt ? `预计重试 ${date(group.next_attempt)}` : null].filter(Boolean).join(" · ")))));
  }
  for (const [risk, label] of [["expired", "已过期"], ["exhausted", "流量已用完"], ["soon", "7 天内到期"], ["low", "流量不足"]]) {
    const match = summary.airports.find((a) => a.risk === risk);
    if (match) items.push(h("li", {}, h("div", {},
      h("a", { href: pageHref("sources", { tab: "airport", state: risk }) }, `${format(match.total)} 个机场${label}`),
      h("p", {}, match.name, risk === "low" ? ` · 剩余 ${bytes(Number(match.traffic_total) - Number(match.used))}`
        : risk === "soon" && daysUntil(match.expires_at) ? ` · ${daysUntil(match.expires_at)} 天后到期` : ""))));
  }
  return h("div", { class: "overview-attention" },
    items.length ? h("ul", {}, items) : h("p", { class: "muted" }, "当前没有曾正常的来源失效或机场异常。"),
    h("div", { class: "row wrap" },
      summary.broken ? h("a", { href: sourceProblems({ history: "worked", sort: "problems" }) }, `曾成功 · ${format(summary.broken)}`) : null,
      summary.never_worked ? h("a", { href: sourceProblems({ history: "never", sort: "problems" }) }, `从未成功 · ${format(summary.never_worked)}`) : null,
      s?.pending ? h("a", { href: pageHref("sources", { status: "NEVER" }) }, `待同步 · ${format(s.pending)}`) : null,
    ));
}

function scanActivity(ops) {
  const latest = ops.latest_scan;
  return h("div", { class: "stack" },
    latest ? h("div", { class: "overview-run" },
      h("div", {}, h("a", { href: scanHref(latest.id) }, `${latest.scan_date} · ${SCAN_KIND[latest.kind] || "检测"}`), " ", badge(latest.status)),
      h("p", {}, `${format(latest.done)} / ${format(latest.node_count)} 已完成 · ${latest.scope === "ALL" ? "全部" : KIND[latest.scope]}`))
      : h("p", { class: "muted" }, "暂无检测批次。"),
    ops.daily_history.length ? h("div", {}, h("h3", {}, "最近 7 个日检批次"),
      h("ol", { class: "overview-history" }, ops.daily_history.map((run) => h("li", {},
        h("a", { href: scanHref(run.id), title: `${run.scan_date} · ${format(run.node_count)} 个节点` },
          h("span", {}, run.scan_date.slice(5)), badge(run.status)))))) : null,
    ops.queued_scan_at ? h("p", { class: "muted" }, "有检测请求正在排队 · ", timestamp(ops.queued_scan_at)) : null);
}

function section(title, href, action, content) {
  return h("section", { class: "panel overview-panel" }, h("header", { class: "panel-head" },
    h("h2", {}, title), href ? h("a", { href }, action) : null), content);
}

function pending(label) {
  return h("div", { class: "overview-slot" }, label);
}

export function render(root, { params, go, refresh, isCurrent }) {
  let ops, recovery, catalog, issues;
  const metrics = h("div", { class: "overview-tiles" });
  const system = pending("正在检查系统状态…");
  const summary = pending("正在汇总来源问题…");
  const scans = pending("正在读取检测记录…");
  const assets = pending("正在统计节点…");
  const grade = pending("正在统计质量分布…");
  const checked = h("p", { class: "page-sub", role: "status" }, "正在检查…");
  const drawTiles = () => metrics.replaceChildren(
    tile("当前可用节点", catalog ? ((catalog.statuses.UP || 0) + (catalog.statuses.DEGRADED || 0)) : null,
      catalog ? `共 ${format(catalog.total)} 个入库节点` : "查看节点", "#/nodes"),
    tile("已登记来源", ops?.sources.total, ops ? `${format(ops.sources.roots)} 个根来源 · ${format(ops.sources.children)} 个子来源` : "查看来源", "#/sources"),
    tile("待检查来源", issues?.broken, issues ? `${format(issues.never_worked)} 个从未成功` : "查看同步失败", sourceProblems({ history: "worked" })),
    tile("成品订阅", ops?.exports.active, ops ? `${format(ops.exports.serving)} 个可下载` : "查看订阅", "#/exports"),
  );
  const hydrate = (request, target, update) => {
    void request.then((value) => {
      if (isCurrent()) update(value);
    }).catch(() => {
      if (isCurrent()) target.replaceChildren(h("p", { class: "muted", role: "status" }, "暂时无法读取，请刷新重试。"));
    });
  };
  const drawStatus = () => {
    if (ops) system.replaceChildren(statusPanel(ops, recovery));
  };
  const drawAttention = () => {
    if (issues) summary.replaceChildren(attention(issues, ops));
  };
  const vantage = params.get("vantage");
  drawTiles();
  root.append(
    h("header", { class: "page-head" }, h("div", {}, h("h1", { class: "page-title" }, "总览"), checked),
      h("button", { type: "button", onclick: refresh }, "刷新")),
    metrics,
    h("div", { class: "overview-top" },
      section("系统状态", "#/ops", "运行记录", system),
      section("待处理事项", sourceProblems(), "来源异常", summary)),
    section("检测动态", "#/ops", "全部检测", scans),
    assets, grade,
  );
  hydrate(readAPI("/overview/status").catch((error) => {
    if (isCurrent()) {
      checked.textContent = "系统状态暂时无法读取";
      scans.replaceChildren(h("p", { class: "muted" }, "检测记录随系统状态更新。"));
    }
    throw error;
  }), system, (data) => {
    ops = data;
    checked.textContent = `状态更新于 ${date(ops.observed_at)}`;
    drawStatus();
    drawAttention();
    drawTiles();
    scans.replaceChildren(scanActivity(ops));
  });
  hydrate(readAPI("/overview/recovery", 60000).catch(() => ({})), system, (data) => {
    recovery = data;
    drawStatus();
  });
  hydrate(readAPI("/overview/attention"), summary, (data) => {
    issues = data;
    drawAttention();
    drawTiles();
  });
  hydrate(readAPI("/overview/catalog"), assets, (data) => {
    catalog = data;
    drawTiles();
    const countries = Object.entries(data.countries || {}).filter(([code]) => code !== "UNK").sort((a, b) => b[1] - a[1]).slice(0, 12);
    assets.replaceChildren(
      h("div", { class: "grid-2" }, GROUPS.map((key) => groupPanel(key, data.groups?.[key]))),
      countries.length ? section("可用节点落地", "#/nodes?by=country", "按国家查看",
        h("ul", { class: "country-list" }, countries.map(([code, n]) => h("li", {},
          h("a", { href: pageHref("nodes", { exit_country: code }) }, flag(code), " ", code, h("strong", {}, format(n))))))) : null);
  });
  hydrate(readAPI(vantage ? "/probe-status?vantage=" + encodeURIComponent(vantage) : "/probe-status"), grade,
    (value) => grade.replaceChildren(qualityPanel(value, value.vantage || vantage || "CN", go)));
}
