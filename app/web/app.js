"use strict";
let credential = "",
  page = "overview",
  offset = 0,
  pendingMutations = 0,
  usageDays = 30,
  dialogTrigger = null;
const $ = (id) => document.getElementById(id);
const content = $("page-content");
const titles = {
  overview: "总览",
  nodes: "节点资产",
  sources: "订阅与来源",
  scans: "检测记录",
  naming: "命名规则",
  exports: "订阅导出",
  usage: "运行与用量",
  quality: "大陆参考规则",
};
const labels = {
  UP: "可用",
  DOWN: "不可用",
  DEGRADED: "响应较慢",
  UNKNOWN: "待检测",
  UNSUPPORTED: "暂不支持",
  STALE: "结果已过期",
  ENVIRONMENT_ERROR: "环境异常",
  COMPLETED: "已完成",
  PENDING: "等待执行",
  RUNNING: "检测中",
  PARTIAL: "部分完成",
  FAILED: "失败",
  SUCCESS: "成功",
  NEVER: "未同步",
  RETRYABLE: "等待重试",
  DAILY: "每日检测",
  SUPPLEMENTAL: "新增节点补测",
  JOB: "任务网络采样",
  CHECK: "检测执行",
  SOURCE: "来源同步",
  SUBSCRIPTION: "订阅下载",
  UNCHANGED: "内容未变",
  CONFLICT: "并发修改",
  INTERRUPTED: "执行中断",
  NOT_APPLICABLE: "不适用",
  P1: "P1 优先尝试",
  P2: "P2 普通候选",
  P3: "P3 备用候选",
  U: "U 资料不足",
  LOW: "低",
  MEDIUM: "中",
  GENERAL: "通用",
  CT: "电信",
  CU: "联通",
  CM: "移动",
};
const errors = {
  AUTHENTICATION_REQUIRED: "管理员密钥不正确，请重新输入。",
  INPUT_TOO_LARGE: "内容超过大小上限，请缩小后重试。",
  TOO_MANY_SUBSCRIPTION_LINKS: "每批最多导入 100 个地址，请分批导入。",
  SUBSCRIPTION_URL_TOO_LONG: "地址超过 8 KiB，请检查该行。",
  UNSAFE_SUBSCRIPTION_URL:
    "请使用公开 HTTP/HTTPS 地址，不支持本地地址、用户名密码或片段。",
  EMPTY_INPUT: "请输入至少一个地址。",
  INVALID_SOURCE_LABEL:
    "来源名称不能为空、不能包含链接或控制字符；批量前缀最多 60 字。",
  PARTIAL_PARSE: "部分配置无法解析；有效节点已保留。",
  DISPATCH_NOT_CONFIGURED:
    "尚未配置 GitHub 任务，请按部署说明配置仓库和调度密钥。",
  DISPATCH_FAILED: "提交任务失败，请点击同步重试；待处理请求已保留。",
  RUNTIME_UNSUPPORTED: "部分配置无法完整转换，请选择其他导出格式。",
  EXPORT_TOO_LARGE: "导出超过 10 MiB，请缩小筛选范围或设置最多节点数。",
  STORED_DATA_INVALID: "节点配置数据无效，请重新同步来源。",
  INVALID_EXPORT_FORMAT: "请选择支持的导出格式。",
  INVALID_EXPORT_FILTER: "导出筛选条件无效，请检查后重试。",
  EXPORT_REVISION_CONFLICT: "方案已被其他操作修改，请重新打开编辑。",
  EXPORT_PENDING: "订阅正在生成或等待更新，请稍后重试。",
  EXPORT_TOKEN_LEGACY: "旧链接无法恢复明文密钥，请使用更换密钥重新获取链接。",
  EXPORT_PROFILE_LIMIT: "已达到订阅方案上限，请撤销不用的方案。",
  EXPORT_STORAGE_LIMIT: "订阅文件或成员总量超过预算，请缩小筛选范围。",
  EXPORT_BUILD_FAILED: "生成失败，请检查任务状态后重试。",
  INVALID_EXPORT_NAME: "请填写 1–80 字符的方案名称。",
  INVALID_EXPORT_EXPIRY: "有效期应为 1–8760 小时，或长期有效。",
  SCAN_ARCHIVED: "旧检测批次已归档，不能重新执行。",
  EXPORT_NOT_AVAILABLE: "导出已过期或撤销，请重新生成。",
  SOURCE_CHANGED_RETRY: "来源已被其他操作更新，请重新同步。",
  INVALID_REQUEST: "输入内容不符合要求，请检查后重试。",
  INVALID_NODE_QUERY: "筛选条件不符合要求，请检查字段和数值。",
  INVALID_NODE_SORT: "排序字段或方向不符合要求。",
  INVALID_QUALITY_POLICY: "参考规则不符合要求，请检查地区、ASN 和数值范围。",
  INVALID_NODE_ANNOTATION: "人工标签或资料不符合要求，请检查后重试。",
  EVIDENCE_REFERENCE_REQUIRED: "选择已有资料时，请填写依据或保留已存依据。",
  QUALITY_POLICY_CONFLICT: "规则已被其他操作更新，请刷新后重新编辑。",
  MIGRATION_REQUIRED: "数据库尚未升级，请先运行 alembic upgrade head。",
  DATABASE_UNAVAILABLE: "数据库暂时无法连接，请检查数据库状态。",
  DATABASE_QUERY_FAILED: "数据库请求未完成，请检查连接与迁移版本。",
  DATABASE_OR_SCHEMA_UNAVAILABLE:
    "无法读取数据库版本，请检查数据库连接并运行迁移。",
  KEY_MISMATCH:
    "加密密钥无法解密已有数据，请核对两端密钥和 ENCRYPTION_KEY_ID。",
};
function el(tag, text, cls) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}
function notice(message, error = false) {
  $("notice").textContent = message;
  $("notice").className = "notice" + (error ? " error" : "");
}
function pipelineNotice(result) {
  const pipeline = result.pipeline || result;
  if (pipeline.dispatched)
    notice("已提交同步与检测任务。导入后会自动检测新增节点，结果将定期刷新。");
  else if (pipeline.reason)
    notice(
      "来源已保存。" +
        (errors[pipeline.reason] || "任务尚未提交，请点击同步重试。"),
      true,
    );
  else notice("来源已保存。可通过本地任务同步和检测。");
}
function date(value) {
  return value
    ? new Date(value).toLocaleString("zh-CN", { hour12: false })
    : "尚无记录";
}
function badge(value) {
  return el(
    "span",
    labels[value] || value || "—",
    "badge " + String(value || "").toLowerCase(),
  );
}
function button(text, action, data = {}, cls = "secondary") {
  const b = el("button", text, cls);
  b.type = "button";
  b.dataset.action = action;
  Object.assign(b.dataset, data);
  return b;
}
function empty(title, help) {
  const n = el("div", undefined, "empty");
  n.append(el("p", title), el("p", help));
  return n;
}
async function api(path, options = {}) {
  const response = await fetch("/api" + path, {
    ...options,
    headers: {
      Authorization: "Bearer " + credential,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error_code || data.detail || "OPERATION_FAILED");
  return data;
}
function table(headers, rows) {
  const wrap = el("div", undefined, "table-wrap"),
    t = el("table"),
    head = el("thead"),
    tr = el("tr");
  if (headers.includes("操作")) t.classList.add("has-actions");
  headers.forEach((x) => {
    const th = el("th", x);
    th.scope = "col";
    tr.append(th);
  });
  head.append(tr);
  t.append(head);
  const body = el("tbody");
  rows.forEach((cells) => {
    const row = el("tr");
    cells.forEach((value) => {
      const cell = el("td");
      if (value instanceof Node) cell.append(value);
      else cell.textContent = value ?? "—";
      row.append(cell);
    });
    body.append(row);
  });
  t.append(body);
  wrap.append(t);
  return wrap;
}
function field(label, name, type = "text", value = "", options) {
  const l = el("label", label);
  let input;
  if (options) {
    input = el("select");
    options.forEach(([value, text]) => {
      const o = el("option", text);
      o.value = value;
      input.append(o);
    });
  } else {
    input = el(type === "textarea" ? "textarea" : "input");
    if (type !== "textarea") input.type = type;
  }
  input.name = name;
  input.value = value;
  l.append(input);
  return l;
}
function dialog(title, node) {
  $("detail-title").textContent = title;
  $("detail-content").replaceChildren(node);
  if (!$("detail").open) $("detail").showModal();
  $("close-detail").focus({ preventScroll: true });
}
async function overview() {
  const data = await api("/overview"),
    dl = el("dl", undefined, "metrics");
  [
    ["节点资产", data.total],
    ["启用且有来源", data.eligible],
    ["可用节点", data.statuses.UP || 0],
    ["不可用", data.statuses.DOWN || 0],
    ["响应较慢", data.statuses.DEGRADED || 0],
    ["不支持的配置", data.statuses.UNSUPPORTED || 0],
    ["待检测", data.statuses.UNKNOWN || 0],
    ["结果过期", data.statuses.STALE || 0],
  ].forEach(([k, v]) => {
    const d = el("div");
    d.append(el("dt", k), el("dd", v));
    dl.append(d);
  });
  content.append(dl);
  const split = el("div", undefined, "split"),
    recent = el("section", undefined, "panel"),
    countries = el("section", undefined, "panel");
  recent.append(el("h2", "最近一次检测"));
  if (data.latest_scan) {
    const r = data.latest_scan;
    recent.append(
      badge(r.status),
      el("p", date(r.started_at)),
      el("p", `${r.node_count} 个节点 · ${r.shard_count} 个分片`),
      el(
        "p",
        `已完成 ${r.items?.DONE || 0} / ${r.node_count}，待处理 ${r.node_count - (r.items?.DONE || 0)}`,
      ),
      el(
        "p",
        "最近完整每日检测：" + date(data.latest_completed_scan?.finished_at),
      ),
      button("查看检测记录", "navigate", { page: "scans" }),
    );
    const codes = [
      ...new Set(
        (r.shards || []).map((x) => x.error_summary?.code).filter(Boolean),
      ),
    ];
    if (codes.length)
      recent.append(el("p", "执行错误：" + codes.join("、"), "error"));
  } else recent.append(empty("还没有检测记录", "添加来源后会自动同步与检测。"));
  countries.append(el("h2", "出口地区"));
  const ul = el("ul", undefined, "country-list");
  Object.entries(data.countries)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .forEach(([k, v]) => {
      const li = el("li");
      li.append(el("span", k === "UNK" ? "尚未识别" : k), el("strong", v));
      ul.append(li);
    });
  countries.append(
    ul.childElementCount ? ul : el("p", "检测完成后显示出口地区。", "help"),
  );
  split.append(recent, countries);
  content.append(split);
}
const reasonLabels = {
  NOT_CURRENTLY_AVAILABLE: "当前结果不可用或已过期",
  INSUFFICIENT_SAMPLES: "同测点样本不足",
  RUNNER_SCOPE_UNKNOWN: "缺少检测环境信息",
  RUNNER_HISTORY_UNSTABLE: "Runner 历史稳定性较低",
  MISSING_METADATA: "入口或出口资料不完整",
  PREFERRED_ENTRY_COUNTRY: "符合入口地区偏好",
  PREFERRED_EXIT_COUNTRY: "符合出口地区偏好",
  PREFERRED_ENTRY_ASN: "符合入口 ASN 偏好",
  PREFERRED_EXIT_ASN: "符合出口 ASN 偏好",
  PREFERRED_PROTOCOL: "符合协议偏好",
  MANUAL_PREFERENCE: "人工指定候选优先级",
  DOCUMENTED_REFERENCE: "有适用且未过期的人工资料",
  RUNNER_AVAILABLE: "Runner 实测可用",
  UNVERIFIED_SOURCE_CLAIM: "仅有未核实声明",
  REFERENCE_EXPIRED_OR_NOT_APPLICABLE: "资料已过期或不适用于所选运营商",
  NO_MAINLAND_MEASUREMENT: "尚无大陆实测",
};
const protocolOptions = [
  ["", "全部协议"],
  ["shadowsocks", "Shadowsocks"],
  ["trojan", "Trojan"],
  ["anytls", "AnyTLS"],
  ["hysteria2", "Hysteria2"],
  ["vless", "VLESS"],
  ["vmess", "VMess"],
];
const sortOptions = [
  ["short_id:asc", "编号升序"],
  ["grade:asc", "参考优先级"],
  ["age_days:desc", "已收录天数降序"],
  ["first_seen_at:desc", "最新加入优先"],
  ["lifetime_availability:desc", "累计检测可用率降序"],
  ["available_days:desc", "累计可用天数降序"],
  ["checked_days:desc", "已检测天数降序"],
  ["success_rate:desc", "Runner 成功率降序"],
  ["http_p95_ms:asc", "Runner P95 耗时升序"],
  ["http_duration_ms:asc", "最近 HTTPS 耗时升序"],
  ["last_success_at:desc", "最近成功优先"],
  ["exit_country:asc", "出口地区"],
  ["entry_country:asc", "入口地区"],
  ["protocol:asc", "协议"],
];
function numberField(label, name, value = "", min = 0, max, step = 1) {
  const f = field(label, name, "number", value),
    i = f.querySelector("input");
  i.min = min;
  if (max !== undefined) i.max = max;
  i.step = step;
  return f;
}
async function filterFields(form, { exporting = false } = {}) {
  const sources = await api("/sources");
  form.append(
    field("搜索", "q"),
    field("协议", "protocol", "", "", protocolOptions),
    field("入口地区（如 HK）", "entry_country"),
    field("出口地区（如 JP）", "exit_country"),
    field(
      "大陆参考规则",
      "operator",
      "",
      "GENERAL",
      Object.entries(labels)
        .filter(([k]) => ["GENERAL", "CT", "CU", "CM"].includes(k))
        .map(([k, v]) => [k, v]),
    ),
    field("参考等级", "grade", "", "", [
      ["", "全部等级"],
      ...["P1", "P2", "P3", "U"].map((k) => [k, labels[k]]),
    ]),
    field("排序", "sort", "", "short_id:asc", sortOptions),
    field("再排序", "then_sort", "", "", [
      ["", "默认稳定顺序"],
      ...sortOptions,
    ]),
  );
  if (!exporting)
    form.append(
      field("状态", "status", "", "", [
        ["", "全部状态"],
        ...["UP", "DOWN", "DEGRADED", "UNKNOWN", "UNSUPPORTED", "STALE"].map(
          (k) => [k, labels[k]],
        ),
      ]),
    );
  else
    form.append(numberField("最多节点数（留空不限）", "limit", "", 1, 100000));
  const advanced = el("details", undefined, "advanced-filters"),
    grid = el("div", undefined, "filter-grid");
  advanced.append(el("summary", "更多筛选条件"), grid);
  grid.append(
    field("来源", "source_id", "", "", [
      ["", "全部来源"],
      ...sources.map((r) => [r.id, r.name]),
    ]),
    field("入口主机", "server_host"),
    numberField("入口端口", "server_port", "", 1, 65535),
    field("入口解析 IP", "entry_ip"),
    field("出口 IP", "exit_ip"),
    field("出口城市", "exit_city"),
    numberField("入口 ASN", "entry_asn", "", 0, 4294967295),
    numberField("出口 ASN", "exit_asn", "", 0, 4294967295),
    field("传输", "transport", "", "", [
      ["", "全部传输"],
      ...["tcp", "ws", "grpc", "quic"].map((k) => [k, k.toUpperCase()]),
    ]),
    field("安全层", "security", "", "", [
      ["", "全部安全层"],
      ["none", "无 TLS"],
      ["tls", "TLS"],
      ["reality", "Reality"],
    ]),
    field("标签（逗号分隔，全部匹配）", "tags"),
    field("人工线路声明", "line_claim", "", "", [
      ["", "全部声明"],
      ...["UNKNOWN", "IPLC", "IEPL", "CN2", "OTHER"].map((k) => [
        k,
        k === "UNKNOWN" ? "未知" : k,
      ]),
    ]),
    field("资料置信度", "confidence", "", "", [
      ["", "全部置信度"],
      ["LOW", "低"],
      ["MEDIUM", "中"],
      ["UNKNOWN", "未知"],
    ]),
    field("资料类型", "evidence_level", "", "", [
      ["", "全部资料"],
      ["NONE", "无"],
      ["DECLARED", "未核实声明"],
      ["DOCUMENTED", "有人工维护的资料"],
    ]),
    numberField("Runner 成功率至少（%）", "min_success_rate", "", 0, 100, 0.1),
    numberField("Runner 超时率至多（%）", "max_timeout_rate", "", 0, 100, 0.1),
    numberField("同测点样本至少", "min_samples"),
    numberField("已收录至少（天）", "min_age_days"),
    numberField("已检测至少（天）", "min_checked_days"),
    numberField("累计可用至少（天）", "min_available_days"),
    numberField(
      "累计检测可用率至少（%）",
      "min_lifetime_availability",
      "",
      0,
      100,
      0.1,
    ),
    numberField("HTTPS 耗时至多（ms）", "max_http_ms"),
    numberField("P95 耗时至多（ms）", "max_http_p95_ms"),
    field("Runner 测点", "probe_key"),
    field("最近检查晚于", "last_checked_after", "datetime-local"),
    field("最近成功晚于", "last_success_after", "datetime-local"),
  );
  if (!exporting)
    grid.prepend(
      field("资产启用状态", "enabled", "", "", [
        ["", "全部状态"],
        ["true", "已启用"],
        ["false", "已停用"],
      ]),
      field("启用且有有效来源", "eligible", "", "", [
        ["", "全部资产"],
        ["true", "是"],
        ["false", "否"],
      ]),
    );
  form.append(advanced);
}
function readFilters(form) {
  const data = Object.fromEntries(new FormData(form)),
    result = {};
  for (const [k, v] of Object.entries(data)) {
    if (!v || ["format", "then_sort", "name", "expires_in_hours"].includes(k))
      continue;
    if (
      [
        "min_success_rate",
        "max_timeout_rate",
        "min_lifetime_availability",
      ].includes(k)
    )
      result[k] = Number(v) / 100;
    else if (k.endsWith("_after")) result[k] = new Date(v).toISOString();
    else if (k === "tags")
      result[k] = v
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    else if (["enabled", "eligible"].includes(k)) result[k] = v === "true";
    else if (k === "limit") result[k] = Number(v);
    else result[k] = v;
  }
  if (data.then_sort) result.sort += "," + data.then_sort;
  return result;
}
async function nodes() {
  const filters = el("form", undefined, "toolbar");
  filters.id = "node-filters";
  await filterFields(filters);
  const submit = el("button", "筛选", "primary");
  submit.type = "submit";
  filters.append(submit);
  content.append(
    filters,
    el(
      "p",
      "已收录天数从首次加入起计算；累计可用率按有明确结果的检测日期统计，未检测不计入。参考等级用于缩小候选范围；Runner 指标只代表对应检测环境。",
      "help",
    ),
  );
  const result = el("div");
  result.id = "node-results";
  content.append(result);
  await loadNodes();
}
async function loadNodes() {
  const values = readFilters($("node-filters")),
    params = new URLSearchParams({ offset: String(offset), limit: "50" });
  for (const [k, v] of Object.entries(values)) params.set(k, String(v));
  const data = await api("/nodes?" + params),
    target = $("node-results");
  target.replaceChildren();
  if (!data.items.length)
    target.append(
      empty("没有符合条件的节点", "调整筛选条件，或到“订阅与来源”导入节点。"),
    );
  else
    target.append(
      table(
        [
          "节点",
          "状态",
          "已收录 / 首次加入",
          "累计检测可用率",
          "入口端点",
          "入口 / 出口",
          "HTTPS 耗时",
          "大陆参考 / 置信度",
          "近7天 Runner 成功率 / 样本",
          "Runner P95",
          "最近检测",
          "当前 / 历史来源",
          "操作",
        ],
        data.items.map((n) => {
          const title = el("div");
          title.append(el("strong", n.name), el("small", n.short_id));
          const age = el("div"),
            lifetime = el("div");
          age.append(
            el("strong", `${n.age_days} 天`),
            el(
              "small",
              "首次 " +
                new Date(n.first_seen_at).toLocaleDateString("zh-CN", {
                  timeZone: "Asia/Shanghai",
                }),
            ),
          );
          lifetime.append(
            el("strong", ratio(n.lifetime_availability)),
            el("small", `可用 ${n.available_days} / 已测 ${n.checked_days} 天`),
          );
          const actions = el("div", undefined, "actions");
          actions.append(
            button("详情", "node-detail", { id: n.id }),
            button(n.enabled ? "暂停" : "启用", "node-toggle", {
              id: n.id,
              enabled: String(!n.enabled),
            }),
          );
          return [
            title,
            badge(n.status),
            age,
            lifetime,
            el("span", `${n.server_host}:${n.server_port}`, "mono"),
            `${n.entry_country || "UNK"} / ${n.exit_country || "UNK"}`,
            n.http_duration_ms == null ? "—" : n.http_duration_ms + " ms",
            `${labels[n.grade] || "资料不足"} / ${labels[n.confidence] || "未知"}`,
            `${ratio(n.success_rate)} / ${n.sample_count || 0}`,
            n.http_p95_ms == null ? "—" : Math.round(n.http_p95_ms) + " ms",
            date(n.last_checked_at),
            `${n.present_source_count} / ${n.source_count}`,
            actions,
          ];
        }),
      ),
    );
  const p = el("div", undefined, "pagination");
  p.append(el("span", `共 ${data.total} 个节点`));
  const controls = el("div", undefined, "actions"),
    prev = button("上一页", "prev"),
    next = button("下一页", "next");
  prev.disabled = offset === 0;
  next.disabled = offset + 50 >= data.total;
  controls.append(prev, next);
  p.append(controls);
  target.append(p);
}
async function nodeDetail(id) {
  const data = await api("/nodes/" + id),
    body = el("div"),
    dl = el("dl", undefined, "details");
  Object.entries({
    稳定编号: data.short_id,
    当前状态: labels[data.status] || data.status,
    首次加入: date(data.first_seen_at),
    已收录天数: `${data.age_days} 天（加入当天为第 1 天）`,
    累计检测可用率: ratio(data.lifetime_availability),
    "累计可用 / 已检测天数": `${data.available_days} / ${data.checked_days} 天（未检测不计入）`,
    入口端点: `${data.server_host}:${data.server_port}`,
    "入口解析 IP":
      data.published_observation?.entry_ips?.join("、") ||
      "暂无已发布的入口 IP",
    "最近入口地区 / ASN": `${data.entry_country || "未知"} / ${data.entry_asn ?? "未知"}`,
    "出口 ASN": data.exit_asn ?? "未知",
    "传输 / 安全": `${data.transport || "未知"} / ${data.security || "未知"}`,
    "出口 IP": data.exit_ip || "未知",
    出口地区: data.exit_country || "未知",
    出口城市估计: data.published_observation?.exit_city || "未知",
    "出口本地 GeoIP ASN / 组织": `${data.published_observation?.geoip_metadata?.exit?.asn ?? "未知"} / ${data.published_observation?.geoip_metadata?.exit?.organization || "未知"}`,
    线路真实类型: "未知（不自动推断）",
    人工线路声明: data.line_claim || "UNKNOWN",
    大陆参考优先级: `${labels[data.grade] || "资料不足"} · ${labels[data.confidence] || "未知"}置信度`,
    分级理由: (data.reasons || []).map((k) => reasonLabels[k] || k).join("；"),
    参考规则: `版本 ${data.rule_version} · ${labels[data.operator] || "通用"}`,
    大陆可达性: "未知（无大陆实测）",
    人工标签: (data.tags || []).join("、") || "无",
    资料维护时间: date(data.evidence_updated_at),
    资料年龄:
      data.evidence_age_days == null
        ? "无资料"
        : data.evidence_age_days + " 天",
    参考计算时间: date(data.evaluated_at),
    Runner测点: data.probe_key || "未知",
    Runner样本数: data.sample_count || 0,
    本次检测方式:
      { FULL: "完整代理验证", PREFLIGHT: "入口预检", SKIPPED: "本轮跳过" }[
        data.measurement_kind
      ] || "未知",
    预检决策: data.precheck_metadata?.decision || "—",
    下次完整复查: date(data.next_full_check_at),
    Runner成功率: ratio(data.success_rate),
    Runner超时率: ratio(data.timeout_rate),
    Runner耗时中位数:
      data.http_p50_ms == null ? "未知" : Math.round(data.http_p50_ms) + " ms",
    Runner耗时P95:
      data.http_p95_ms == null ? "未知" : Math.round(data.http_p95_ms) + " ms",
    来源数量: data.sources.length,
    最近成功: date(data.last_success_at),
  }).forEach(([k, v]) => {
    const d = el("div");
    d.append(el("dt", k), el("dd", v));
    dl.append(d);
  });
  const aliases = el("div");
  aliases.id = "protected-aliases";
  body.append(
    dl,
    button("编辑人工标签与资料", "node-annotate", { id }),
    ...(data.has_evidence
      ? [button("查看受保护的依据", "node-evidence", { id })]
      : []),
    el("pre", "", "protected-reference"),
    button("显示受保护的原始别名", "node-aliases", { id }),
    el("p", "原始别名可能含有私密信息，仅在当前详情中显示。", "help"),
    aliases,
    el("h3", "入口 GeoIP 估计"),
    data.published_observation?.geoip_metadata?.entry?.length
      ? table(
          ["解析 IP", "地区 / 城市", "ASN / 组织", "查询时间"],
          data.published_observation.geoip_metadata.entry.map((geo) => [
            geo.ip,
            `${geo.country || "未知"} / ${geo.city || "未知"}`,
            `${geo.asn ?? "未知"} / ${geo.organization || "未知"}`,
            date(geo.queried_at),
          ]),
        )
      : el("p", "尚无入口 GeoIP 记录。", "help"),
    el("h3", "来源关系"),
    table(
      ["来源", "当前关系", "来源状态", "首次发现", "最近发现"],
      data.sources.map((source) => [
        source.deleted
          ? source.name || source.source_id
          : button(source.name || source.source_id, "source-detail", {
              id: source.source_id,
            }),
        source.is_present ? "存在" : "已移除",
        source.deleted ? "已删除" : source.enabled ? "启用" : "暂停",
        date(source.first_seen_at),
        date(source.last_seen_at),
      ]),
    ),
    el("h3", "最近检测历史"),
  );
  body.append(
    data.history.length
      ? table(
          ["检测时间", "状态", "DNS", "TCP", "代理 / HTTPS", "耗时", "错误码"],
          data.history.map((r) => [
            date(r.checked_at),
            badge(r.status),
            r.dns_status,
            r.tcp_status,
            `${r.proxy_status} / ${r.http_status}`,
            r.http_duration_ms == null ? "—" : r.http_duration_ms + " ms",
            r.error_code || "—",
          ]),
        )
      : empty("尚无观测结果", "检测完成后可查看入口、出口和失败阶段。"),
  );
  dialog(data.name, body);
}
async function sources() {
  const data = await api("/sources"),
    actions = el("div", undefined, "actions");
  actions.append(
    button("批量导入链接", "source-bulk", {}, "primary"),
    button("添加来源", "source-add"),
  );
  content.append(actions);
  if (!data.length) {
    content.append(
      empty(
        "添加你的第一个来源",
        "支持订阅 URL、Sub-Store /api/subs、单节点 URI、Clash YAML 和 sing-box JSON。",
      ),
    );
    return;
  }
  content.append(
    el(
      "p",
      "保存后自动同步并检测新增节点。同步失败或部分成功时，已有资产关联会继续保留。",
      "help",
    ),
    table(
      ["来源", "类型", "启用", "最近检查", "同步结果", "操作"],
      data.map((s) => {
        const a = el("div", undefined, "actions");
        a.append(
          button("详情", "source-detail", { id: s.id }),
          button("同步", "source-sync", { id: s.id }),
          button("编辑", "source-edit", { id: s.id }),
          button(s.enabled ? "暂停" : "启用", "source-toggle", {
            id: s.id,
            enabled: String(!s.enabled),
          }),
          button("删除", "source-delete", { id: s.id }, "danger"),
        );
        const b = el("div");
        b.append(
          badge(
            s.enabled && s.sync_requested_at ? "PENDING" : s.last_sync_status,
          ),
          el("small", s.last_error_code || ""),
        );
        return [
          s.name,
          s.type,
          s.enabled ? "启用" : "暂停",
          date(s.last_checked_at),
          b,
          a,
        ];
      }),
    ),
  );
}
async function sourceDetail(id) {
  const data = await api("/sources/" + id),
    body = el("div"),
    details = el("dl", undefined, "details");
  for (const [key, value] of Object.entries({
    来源类型: data.type,
    内容格式: data.format_hint,
    同步状态: labels[data.last_sync_status] || data.last_sync_status,
    "同步周期（秒）": data.sync_interval_seconds,
    "当前 / 历史关联节点": `${data.present_nodes} / ${data.linked_nodes}`,
    当前启用节点: data.enabled_nodes,
    最近检查: date(data.last_checked_at),
    最近完整同步: date(data.last_synced_at),
    "内容 SHA-256": data.content_hash || "尚未获取",
    "已完整应用 SHA-256": data.applied_hash || "尚未完整应用",
    最近完整应用解析器版本: data.parser_version || "尚未完整应用",
    安全错误码: data.last_error_code || "无",
  })) {
    const item = el("div");
    item.append(el("dt", key), el("dd", value));
    details.append(item);
  }
  const summary = data.last_parse_summary || {};
  body.append(
    details,
    el("h3", "解析摘要"),
    el(
      "p",
      `有效 ${summary.valid ?? "—"}，忽略 ${summary.ignored ?? "—"}，错误 ${summary.issue_count || 0}`,
    ),
  );
  if (summary.subscription?.kind === "substore") {
    const s = summary.subscription;
    body.append(
      el("h3", "Sub-Store 提取摘要"),
      el(
        "p",
        `订阅定义 ${s.subscriptions}：本地 ${s.local}，远程 ${s.remote}，混合 ${s.mixed}，无效 ${s.invalid_entries}。`,
      ),
      el(
        "p",
        `远程引用 ${s.remote_references}：解析完成 ${s.resolved_references}，失败 ${s.failed_references}。`,
      ),
      el(
        "p",
        "按原始内容导入；Sub-Store 的处理器、过滤规则和脚本未应用。",
        "help",
      ),
    );
  }
  if (summary.issues?.length)
    body.append(
      table(
        ["条目序号", "错误码"],
        summary.issues.map((issue) => [issue.ordinal ?? "—", issue.code]),
      ),
    );
  else body.append(el("p", "没有记录到解析错误。", "help"));
  if (summary.issue_count > (summary.issues?.length || 0))
    body.append(el("p", "界面保留前 100 条错误；原始输入仍加密保存。", "help"));
  dialog(data.name, body);
}
async function sourceForm(id) {
  const current = id ? await api("/sources/" + id) : null,
    form = el("form", undefined, "form-grid");
  form.id = "source-form";
  if (id) form.dataset.id = id;
  const name = field(
    "来源名称（请勿填写凭据）",
    "name",
    "text",
    current?.name || "",
  );
  name.querySelector("input").required = true;
  form.append(name);
  if (!current)
    form.append(
      field("来源类型", "type", "", "SUBSCRIPTION_URL", [
        ["SUBSCRIPTION_URL", "订阅 URL / Sub-Store API"],
        ["SINGLE_URI", "单节点 URI"],
        ["UPLOADED_FILE", "上传配置文件"],
        ["RAW_TEXT", "多行配置文本"],
      ]),
    );
  form.append(
    field("内容格式", "format_hint", "", current?.format_hint || "AUTO", [
      ["AUTO", "自动识别"],
      ["URI", "节点 URI"],
      ["BASE64", "Base64 订阅"],
      ["CLASH", "Clash / Mihomo YAML"],
      ["SINGBOX", "sing-box JSON"],
    ]),
  );
  const payload = field(
    current ? "替换内容（留空保留现有内容）" : "订阅 URL 或配置内容",
    "payload",
    "textarea",
  );
  payload.className = "wide";
  payload.querySelector("textarea").required = !current;
  form.append(payload);
  const file = field("或选择本地配置文件", "upload", "file");
  file.className = "wide";
  file.querySelector("input").accept = ".txt,.yaml,.yml,.json";
  form.append(file);
  const payloadHelp = el(
    "p",
    "原始内容按你的设置明文保存。Sub-Store /api/subs 链接请选择自动识别，会提取本地、远程与混合订阅的原始节点。保存后自动同步并检测新增节点。",
    "help wide",
  );
  payloadHelp.id = "source-payload-help";
  payload
    .querySelector("textarea")
    .setAttribute("aria-describedby", payloadHelp.id);
  form.append(payloadHelp);
  const formError = el("p", "", "error wide form-error");
  formError.id = "source-form-error";
  formError.setAttribute("role", "alert");
  form.append(formError);
  payload
    .querySelector("textarea")
    .setAttribute("aria-describedby", "source-payload-help source-form-error");
  const submit = el("button", "保存来源", "primary");
  submit.type = "submit";
  form.append(submit);
  dialog(current ? "编辑来源" : "添加来源", form);
}
function sourceBulkForm() {
  const form = el("form", undefined, "form-grid");
  form.id = "source-bulk-form";
  const prefix = field(
    "来源名称前缀（请勿填写凭据）",
    "name_prefix",
    "text",
    "批量订阅",
  );
  prefix.querySelector("input").required = true;
  prefix.querySelector("input").maxLength = 60;
  prefix
    .querySelector("input")
    .setAttribute("aria-describedby", "source-bulk-error");
  const urls = field(
    "订阅 URL / Sub-Store API（一行一个）",
    "urls",
    "textarea",
  );
  urls.className = "wide";
  const input = urls.querySelector("textarea");
  input.required = true;
  input.rows = 10;
  input.spellcheck = false;
  input.setAttribute(
    "aria-describedby",
    "source-bulk-help source-bulk-error source-bulk-results",
  );
  const help = el(
    "p",
    "每批最多 100 个地址、合计 128 KiB。普通订阅和 Sub-Store /api/subs 可以混合粘贴；空行忽略，重复地址跳过。有效来源统一提交一次同步任务，随后自动补测新增节点。",
    "help wide",
  );
  help.id = "source-bulk-help";
  const error = el("p", "", "error wide form-error");
  error.id = "source-bulk-error";
  error.setAttribute("role", "alert");
  const submit = el("button", "批量保存并同步", "primary");
  submit.type = "submit";
  const results = el("div", undefined, "wide");
  results.id = "source-bulk-results";
  form.append(prefix, urls, help, error, submit, results);
  dialog("批量导入订阅链接", form);
}
async function scans() {
  const data = await api("/scans");
  content.append(
    button("同步并补测新增节点", "scan-create", {}, "primary"),
    el(
      "p",
      "每天完整检测一次；当天新导入节点自动补测，重试只处理未完成任务。",
      "help",
    ),
  );
  if (!data.length) {
    content.append(empty("尚无检测批次", "添加来源后会自动创建检测批次。"));
    return;
  }
  content.append(
    table(
      ["日期 / 类型", "状态", "节点 / 分片", "开始时间", "结束时间", "操作"],
      data.map((r) => {
        const a = el("div", undefined, "actions");
        a.append(button("查看进度", "scan-detail", { id: r.id }));
        if (r.status !== "COMPLETED" && !r.archived_at)
          a.append(button("重试未完成任务", "scan-retry", { id: r.id }));
        return [
          `${r.scan_date} · ${labels[r.kind] || "每日检测"}`,
          r.archived_at
            ? "已归档 · " + (labels[r.status] || r.status)
            : badge(r.status),
          `${r.node_count} / ${r.shard_count}`,
          date(r.started_at),
          r.finished_at ? date(r.finished_at) : "—",
          a,
        ];
      }),
    ),
  );
}
async function scanDetail(id) {
  const r = await api("/scans/" + id),
    body = el("div");
  body.append(
    el(
      "p",
      `计划 ${r.node_count} 个节点；批次状态：${labels[r.status] || r.status}`,
    ),
  );
  if (r.archived_at)
    body.append(
      el(
        "p",
        "详细结果已按保留周期清理；计划节点数、批次摘要及累计检测可用率仍保留。",
        "help",
      ),
      table(
        ["结果", "节点数"],
        Object.entries(r.items || {}).map(([key, count]) => [
          labels[key] || key,
          count,
        ]),
      ),
    );
  body.append(
    table(
      [
        "分片",
        "状态",
        "完成 / 计划",
        "失效节点",
        "开始",
        "结束",
        "最近进度",
        "错误码",
      ],
      r.shards.map((s) => [
        s.shard_no,
        badge(s.status),
        `${s.completed_count} / ${s.planned_count}`,
        s.failed_count,
        date(s.started_at),
        s.finished_at ? date(s.finished_at) : "—",
        date(s.last_heartbeat_at),
        s.error_summary.code || "—",
      ]),
    ),
  );
  dialog("检测进度", body);
}
async function naming() {
  const data = await api("/naming-rules"),
    form = el("form", undefined, "panel form-grid");
  form.id = "naming-form";
  const fieldEl = field("统一命名模板", "template", "text", data.template);
  fieldEl.className = "wide";
  fieldEl.querySelector("input").required = true;
  form.append(
    fieldEl,
    el(
      "p",
      "可用字段：{ENTRY_COUNTRY}、{EXIT_COUNTRY}、{PROTOCOL}、{TRANSPORT}、{SECURITY}、{SHORT_ID}。未知地区显示 UNK。",
      "help wide",
    ),
  );
  const save = el("button", "应用到全部节点", "primary");
  save.type = "submit";
  form.append(save, button("预览", "naming-preview"));
  content.append(form);
  const preview = el("div");
  preview.id = "name-preview";
  content.append(preview);
  if (data.history.length) {
    content.append(
      el("h2", "模板变更记录"),
      table(
        ["时间", "模板"],
        data.history.map((r) => [date(r.created_at), r.template]),
      ),
    );
  }
}
const exportStates = {
  PENDING: "等待生成",
  BUILDING: "正在生成",
  UPDATING: "等待更新",
  READY: "可以使用",
  FAILED: "生成失败",
  REVOKED: "已撤销",
  EXPIRED: "已过期",
};
function showExportLink(result) {
  const url = new URL(`/subscriptions/${result.id}`, location.origin);
  url.searchParams.set("token", result.token);
  const box = el("section", undefined, "panel");
  box.append(
    el("h2", "固定私有订阅链接"),
    el(
      "p",
      "首次生成前或节点资格变化后，下载可能暂时返回等待状态。链接可在列表中重新查看，请按凭据保管。",
      "help",
    ),
  );
  const input = field("订阅地址", "url", "text", url.href);
  input.querySelector("input").readOnly = true;
  const link = el("a", "下载当前版本", "export-link");
  link.href = url.href;
  link.referrerPolicy = "no-referrer";
  box.append(input, link);
  $("export-result").replaceChildren(box);
}
async function loadExportProfiles() {
  const data = await api("/exports"),
    target = $("export-profiles");
  if (!target) return;
  target.replaceChildren(
    data.length
      ? table(
          [
            "名称 / 格式",
            "状态",
            "当前文件",
            "版本 / 生成时间",
            "有效期",
            "操作",
          ],
          data.map((e) => {
            const actions = el("div", undefined, "actions"),
              active = !["REVOKED", "EXPIRED"].includes(e.status);
            if (active) {
              actions.append(
                button("查看链接", "export-link", { id: e.id }),
                button("编辑方案", "export-edit", { id: e.id }),
              );
              if (e.status !== "BUILDING")
                actions.append(
                  button("重新生成", "export-retry", { id: e.id }),
                );
              actions.append(
                button("更换密钥", "export-token", { id: e.id }),
                button("撤销", "export-revoke", { id: e.id }, "danger"),
              );
            }
            if (e.current_version)
              actions.append(
                button("版本记录", "export-versions", { id: e.id }),
              );
            return [
              `${e.name} · ${e.format}`,
              `${exportStates[e.status] || e.status}${e.error_code ? " · " + (errors[e.error_code] || e.error_code) : ""}`,
              e.serving
                ? `${e.node_count} 节点 · ${bytes(e.payload_bytes)}`
                : "等待可用文件",
              e.current_version
                ? `v${e.current_version} · ${date(e.built_at)}`
                : "尚未生成",
              e.expires_at ? date(e.expires_at) : "长期有效（可撤销）",
              actions,
            ];
          }),
        )
      : empty(
          "还没有订阅方案",
          "保存筛选条件后，GitHub Actions 会生成订阅文件。",
        ),
  );
}
async function exportsPage() {
  const form = el("form", undefined, "panel form-grid");
  form.id = "export-form";
  form.append(
    field("方案名称", "name", "text", "我的订阅"),
    field("链接有效期", "expires_in_hours", "", "", [
      ["", "长期有效（可撤销）"],
      ["24", "24 小时"],
      ["168", "7 天"],
      ["720", "30 天"],
    ]),
    field("导出格式", "format", "", "mihomo", [
      ["mihomo", "Mihomo YAML"],
      ["singbox", "sing-box JSON"],
      ["uri", "节点 URI（六种协议）"],
      ["json", "JSON 报告"],
      ["csv", "CSV 报告"],
    ]),
    el(
      "p",
      "仅收录启用、有有效来源、检测成功且未过期的节点。保存后异步生成；后续检测和来源变动会更新同一链接。",
      "help wide",
    ),
  );
  await filterFields(form, { exporting: true });
  const submit = el("button", "保存并生成订阅", "primary");
  submit.type = "submit";
  form.append(submit);
  const cancel = button("取消编辑", "export-cancel");
  cancel.hidden = true;
  cancel.id = "export-cancel";
  form.append(cancel);
  form.elements.name.required = true;
  form.elements.name.maxLength = 80;
  formError(form);
  content.append(form);
  const out = el("div");
  out.id = "export-result";
  out.setAttribute("aria-live", "polite");
  content.append(out);
  const profiles = el("div");
  profiles.id = "export-profiles";
  content.append(profiles);
  await loadExportProfiles();
}
async function editExport(id) {
  const profile = await api("/exports/" + id),
    form = $("export-form");
  form.reset();
  form.dataset.id = id;
  form.dataset.revision = String(profile.request_revision);
  form.dataset.originalFilters = JSON.stringify(profile.filter_spec);
  const values = {
    ...profile.filter_spec,
    name: profile.name,
    format: profile.format,
  };
  if (profile.expires_at)
    values.expires_in_hours = String(
      Math.max(
        1,
        Math.ceil((new Date(profile.expires_at) - Date.now()) / 3600000),
      ),
    );
  const expiry = form.elements.expires_in_hours;
  if (
    values.expires_in_hours &&
    !Array.from(expiry.options).some((o) => o.value === values.expires_in_hours)
  )
    expiry.add(new Option("保留现有到期时间", values.expires_in_hours));
  for (const [key, raw] of Object.entries(values)) {
    const input = form.elements.namedItem(key);
    if (!input) continue;
    let value = raw;
    if (
      [
        "min_success_rate",
        "max_timeout_rate",
        "min_lifetime_availability",
      ].includes(key)
    )
      value = Number(raw) * 100;
    else if (key === "tags") value = raw.join(",");
    else if (key.endsWith("_after")) {
      const at = new Date(raw);
      value = new Date(at - at.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16);
    } else if (key === "sort") {
      const sorts = String(raw).split(",");
      value = sorts[0];
      const secondary = sorts.slice(1).join(","),
        select = form.elements.then_sort;
      if (
        secondary &&
        !Array.from(select.options).some((o) => o.value === secondary)
      )
        select.add(new Option("已保存：" + secondary, secondary));
      select.value = secondary;
    }
    if (
      input instanceof HTMLSelectElement &&
      !Array.from(input.options).some((o) => o.value === String(value))
    )
      input.add(new Option("已保存：" + value, String(value)));
    input.value = String(value);
  }
  form.dataset.expiry = expiry.value;
  form.querySelector("button[type=submit]").textContent = "保存方案更新";
  $("export-cancel").hidden = false;
  form.elements.name.focus();
}
function bytes(value) {
  if (value == null) return "—";
  const number = Number(value);
  if (number < 1024) return number.toLocaleString() + " B";
  const power = Math.min(3, Math.floor(Math.log(number) / Math.log(1024)));
  return (
    (number / 1024 ** power).toFixed(2) + [" B", " KiB", " MiB", " GiB"][power]
  );
}

function formError(form, helpId) {
  const error = el("p", "", "error wide form-error");
  error.id = form.id + "-error";
  error.setAttribute("role", "alert");
  form.append(error);
  for (const input of form.querySelectorAll("input,select,textarea"))
    input.setAttribute(
      "aria-describedby",
      [helpId, error.id].filter(Boolean).join(" "),
    );
}

function checkboxes(label, name, options, selected = []) {
  const group = el("fieldset", undefined, "checkbox-group");
  group.append(el("legend", label));
  for (const [value, title] of options) {
    const row = field(title, name, "checkbox", value);
    row.querySelector("input").checked = selected.includes(value);
    group.append(row);
  }
  return group;
}

async function annotationForm(id) {
  const data = await api(`/nodes/${id}/annotations`),
    form = el("form", undefined, "form-grid");
  form.id = "annotation-form";
  form.dataset.id = id;
  const help = el(
    "p",
    "人工声明和资料用于参考排序，不代表已经测得大陆线路。已保存的依据不在表单中回显；留空保留。",
    "help wide",
  );
  help.id = "annotation-help";
  form.append(
    help,
    field("人工标签（逗号分隔）", "tags", "text", data.tags.join(",")),
    field(
      "线路声明",
      "line_claim",
      "",
      data.line_claim,
      ["UNKNOWN", "IPLC", "IEPL", "CN2", "OTHER"].map((k) => [
        k,
        k === "UNKNOWN" ? "未知" : k + "（人工声明）",
      ]),
    ),
    field("资料类型", "evidence_level", "", data.evidence_level, [
      ["NONE", "无"],
      ["DECLARED", "仅有声明，未核实"],
      ["DOCUMENTED", "有人工维护的资料"],
    ]),
    field("人工候选优先级", "manual_priority", "", data.manual_priority, [
      ["NONE", "按参考规则计算"],
      ...["P1", "P2", "P3"].map((k) => [k, labels[k]]),
    ]),
    checkboxes(
      "资料适用范围",
      "operators",
      ["GENERAL", "CT", "CU", "CM"].map((k) => [k, labels[k]]),
      data.operators,
    ),
    field(
      data.has_evidence ? "替换受保护依据（留空保留）" : "资料依据（加密保存）",
      "reference",
      "textarea",
    ),
  );
  if (data.has_evidence)
    form.append(
      checkboxes("已保存的依据", "clear_reference", [["yes", "移除已存依据"]]),
    );
  formError(form, help.id);
  const save = el("button", "保存人工资料", "primary");
  save.type = "submit";
  form.append(save);
  dialog("人工标签与参考资料", form);
}

async function qualityPage() {
  const data = await api("/quality-policy"),
    policy = data.policy,
    form = el("form", undefined, "panel form-grid");
  form.id = "quality-policy-form";
  form.dataset.version = data.version;
  const help = el(
    "p",
    `当前规则版本 ${data.version}。P1/P2/P3/U 是大陆使用参考优先级；Runner 稳定性独立统计，任何等级都不证明大陆可达或专线类型。`,
    "help wide",
  );
  help.id = "quality-policy-help";
  form.append(
    help,
    numberField(
      "近七天同测点最少样本数",
      "min_samples",
      policy.min_samples,
      1,
      7,
    ),
    numberField(
      "Runner 成功率低于此值列为备用（%）",
      "poor_success_rate",
      policy.poor_success_rate * 100,
      0,
      100,
      0.1,
    ),
    numberField(
      "人工资料有效期（天）",
      "evidence_max_age_days",
      policy.evidence_max_age_days,
      1,
      365,
    ),
  );
  for (const op of ["GENERAL", "CT", "CU", "CM"]) {
    const prefs =
        op === "GENERAL" ? policy : policy.operator_preferences[op] || {},
      section = el("details", undefined, "wide preference-section"),
      grid = el("div", undefined, "form-grid");
    section.open = op === "GENERAL";
    section.append(el("summary", labels[op] + "偏好"), grid);
    if (op !== "GENERAL")
      grid.append(
        el(
          "p",
          "留空沿用通用偏好；运营商名称仅表示选择的参考规则。",
          "help wide",
        ),
      );
    for (const [key, label] of [
      ["preferred_entry_countries", "优先入口地区（如 HK,JP）"],
      ["preferred_exit_countries", "优先出口地区（如 JP,US）"],
      ["preferred_entry_asns", "优先入口 ASN（逗号分隔）"],
      ["preferred_exit_asns", "优先出口 ASN（逗号分隔）"],
    ])
      grid.append(
        field(label, op + "_" + key, "text", (prefs[key] || []).join(",")),
      );
    grid.append(
      checkboxes(
        "优先协议",
        op + "_preferred_protocols",
        protocolOptions.slice(1),
        prefs.preferred_protocols || [],
      ),
    );
    form.append(section);
  }
  formError(form, help.id);
  const save = el("button", "保存参考规则", "primary");
  save.type = "submit";
  form.append(save);
  content.append(
    form,
    el("h2", "规则版本记录"),
    table(
      ["版本", "保存时间", "最少样本"],
      data.history.map((r) => [
        r.version,
        date(r.created_at),
        r.policy.min_samples,
      ]),
    ),
  );
}
function ratio(value) {
  return value == null ? "—" : (Number(value) * 100).toFixed(1) + "%";
}
async function usage() {
  const data = await api("/usage?days=" + usageDays),
    form = el("form", undefined, "actions");
  form.id = "usage-form";
  form.append(
    field("统计范围", "days", "", String(usageDays), [
      ["7", "近 7 天"],
      ["30", "近 30 天"],
      ["90", "近 90 天"],
      ["365", "近 365 天"],
    ]),
  );
  const submit = el("button", "更新范围", "secondary");
  submit.type = "submit";
  form.append(submit);
  content.append(form);
  const totals = data.totals,
    metrics = el("dl", undefined, "metrics");
  for (const [label, value] of [
    ["检测尝试", data.health.attempts],
    [
      "完整代理验证 / 抽样复查",
      `${totals.full_checks} / ${totals.full_samples}`,
    ],
    [
      "入口门控 / 冷却跳过",
      `${totals.preflight_skips} / ${totals.cooldown_skips}`,
    ],
    [
      "DNS 查询 / 缓存命中",
      `${totals.dns_requests} / ${totals.dns_cache_hits}`,
    ],
    ["TCP 预检 / 缓存命中", `${totals.tcp_probes} / ${totals.tcp_cache_hits}`],
    ["核心启动 / 重载", `${totals.runtime_starts} / ${totals.runtime_reloads}`],
    [
      "平均单次尝试耗时",
      data.health.mean_check_ms == null
        ? "—"
        : data.health.mean_check_ms + " ms",
    ],
    ["含超时的检测尝试", ratio(data.health.timeout_ratio)],
    ["执行失败率", ratio(data.executions.failure_ratio)],
    [
      "环境异常检测尝试",
      ratio(
        data.health.attempts
          ? data.health.environment_attempts / data.health.attempts
          : null,
      ),
    ],
    ["Echo 请求 / 失败", `${totals.echo_requests} / ${totals.echo_failures}`],
    ["业务工作流 Runner 分钟", Number(data.runner_minutes).toFixed(2)],
    ["订阅下载", totals.subscription_downloads],
    ["订阅响应载荷", bytes(totals.subscription_bytes)],
    ["来源响应载荷", bytes(totals.source_response_bytes)],
  ]) {
    const item = el("div");
    item.append(el("dt", label), el("dd", value));
    metrics.append(item);
  }
  content.append(
    metrics,
    el(
      "p",
      "按 UTC 日期统计。载荷字节不包含 TLS、协议头或依赖下载，不是运营商账单流量；Runner 分钟来自完成的业务工作流 Job 时间，不等同于计费分钟。",
      "help",
    ),
  );
  content.append(
    el(
      "p",
      totals.network_samples
        ? `已采样 ${totals.network_samples} 个任务；Runner 默认路由接口接收 ${bytes(totals.network_rx_bytes)}，发送 ${bytes(totals.network_tx_bytes)}。包含依赖下载和任务网络流量，不是代理专属流量。`
        : "尚无 Runner 网络接口采样。缺少采样不表示网络流量为零。",
      "help",
    ),
  );
  content.append(el("h2", "数据库容量"));
  const latest = data.database_samples[0];
  content.append(
    latest
      ? el(
          "p",
          `采样 ${date(latest.taken_at)}；项目表与索引 ${bytes(latest.table_bytes)}；数据库 ${bytes(latest.database_bytes)}；连接 ${latest.connections}；窗口内项目增长 ${bytes(data.database_growth_bytes)}`,
        )
      : empty(
          "尚无容量采样",
          "运行 usage sample，或等待业务工作流结束后的用量采集。",
        ),
  );
  content.append(
    el("h2", "每日记录"),
    data.daily.length
      ? table(
          [
            "UTC 日期",
            "检查次数",
            "Echo 请求",
            "Echo 失败",
            "Echo 响应",
            "来源请求 / 响应",
            "订阅次数 / 响应",
          ],
          data.daily.map((day) => [
            day.day,
            day.check_count,
            day.echo_requests,
            day.echo_failures,
            bytes(day.echo_response_bytes),
            `${day.source_requests} / ${bytes(day.source_response_bytes)}`,
            `${day.subscription_downloads} / ${bytes(day.subscription_bytes)}`,
          ]),
        )
      : empty("尚无用量记录", "完成同步、检测或下载后显示。"),
  );
  content.append(
    el("h2", "Actions 执行记录"),
    data.action_runs.length
      ? table(
          [
            "Run / Attempt",
            "工作流",
            "结果",
            "开始",
            "结束",
            "Runner 分钟",
            "Job / 失败 / 未测时",
          ],
          data.action_runs.map((run) => [
            `${run.run_id} / ${run.attempt}`,
            run.workflow,
            run.conclusion,
            date(run.started_at),
            date(run.finished_at),
            (run.runner_ms / 60000).toFixed(2),
            `${run.job_count} / ${run.failed_jobs} / ${run.unmeasured_jobs}`,
          ]),
        )
      : empty(
          "尚无 Actions 采样",
          "部署 usage 工作流后，完成的业务执行会自动采集。",
        ),
  );
  content.append(
    el("h2", "最近执行与下载"),
    data.recent.length
      ? table(
          [
            "类型",
            "开始",
            "状态",
            "检查 / 超时",
            "Echo 请求 / 失败",
            "订阅响应",
          ],
          data.recent.map((run) => [
            labels[run.kind] || run.kind,
            date(run.started_at),
            badge(run.outcome),
            `${run.check_count} / ${run.timeout_checks}`,
            `${run.echo_requests} / ${run.echo_failures}`,
            bytes(run.subscription_bytes),
          ]),
        )
      : el("p", "尚无记录。", "help"),
  );
}
async function render({ silent = false } = {}) {
  page = titles[location.hash.slice(1)] ? location.hash.slice(1) : "overview";
  if (!credential) return;
  $("page-title").textContent = titles[page];
  document.querySelectorAll("nav a").forEach((a) => {
    if (a.dataset.page === page) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  content.setAttribute("aria-busy", "true");
  content.replaceChildren(el("p", "正在读取资产…", "loading"));
  if (!silent) notice("");
  try {
    content.replaceChildren();
    await {
      overview,
      nodes,
      sources,
      scans,
      naming,
      exports: exportsPage,
      usage,
      quality: qualityPage,
    }[page]();
  } catch (e) {
    notice(errors[e.message] || "读取失败，请检查连接后重试。", true);
  } finally {
    content.setAttribute("aria-busy", "false");
  }
}
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  credential = $("admin-token").value;
  try {
    const readiness = await api("/readiness");
    if (![true, "OK"].includes(readiness.checks.schema))
      throw new Error("MIGRATION_REQUIRED");
    if (
      readiness.checks.encryption === false ||
      (readiness.checks.stored_keys && readiness.checks.stored_keys !== "OK")
    )
      throw new Error("KEY_MISMATCH");
    await api("/overview");
    $("login").hidden = true;
    $("workspace").hidden = false;
    $("admin-token").value = "";
    $("login-error").textContent = "";
    await render();
    if (!readiness.ready) {
      const names = {
        database: "数据库",
        schema: "数据库迁移",
        encryption: "加密密钥",
        keys: "加密密钥",
        stored_keys: "已有数据密钥",
        dispatch: "GitHub 调度",
      };
      notice(
        "部署配置待完成：" +
          Object.keys(readiness.checks)
            .filter(
              (k) =>
                readiness.checks[k] !== true && readiness.checks[k] !== "OK",
            )
            .map((k) => names[k] || k)
            .join("、") +
          "。请查看部署说明。",
        true,
      );
    }
    $("main").focus({ preventScroll: true });
  } catch (error) {
    credential = "";
    $("login-error").textContent =
      errors[error.message] || "无法登录，请检查密钥和连接。";
    $("admin-token").setAttribute("aria-invalid", "true");
  }
});
$("logout").addEventListener("click", () => {
  credential = "";
  content.replaceChildren();
  $("detail").close();
  $("detail-content").replaceChildren();
  $("workspace").hidden = true;
  $("login").hidden = false;
  $("admin-token").focus();
});
$("refresh").addEventListener("click", render);
$("close-detail").addEventListener("click", () => $("detail").close());
$("detail").addEventListener("close", () => {
  const target = dialogTrigger?.isConnected ? dialogTrigger : $("main");
  dialogTrigger = null;
  target.focus({ preventScroll: true });
});
window.addEventListener("hashchange", () => {
  offset = 0;
  render();
});
let refreshing = false;
window.setInterval(async () => {
  if (
    !credential ||
    document.hidden ||
    $("detail").open ||
    refreshing ||
    content.getAttribute("aria-busy") === "true" ||
    pendingMutations > 0 ||
    (page !== "exports" &&
      content.contains(document.activeElement) &&
      document.activeElement?.matches("button,a,input,textarea,select")) ||
    (page === "exports" &&
      $("export-profiles")?.contains(document.activeElement)) ||
    !["overview", "sources", "scans", "nodes", "usage", "exports"].includes(
      page,
    )
  )
    return;
  refreshing = true;
  try {
    if (page === "nodes") await loadNodes();
    else if (page === "exports") await loadExportProfiles();
    else await render({ silent: true });
  } catch {
    // Keep the last visible result during a transient polling failure.
  } finally {
    refreshing = false;
  }
}, 15000);
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-action]");
  if (!b) return;
  const { id, action } = b.dataset;
  const restoreButtonFocus = document.activeElement === b;
  if (
    !$("detail").open &&
    [
      "node-detail",
      "node-annotate",
      "source-detail",
      "source-add",
      "source-bulk",
      "source-edit",
      "scan-detail",
      "export-versions",
    ].includes(action)
  )
    dialogTrigger = b;
  b.disabled = true;
  pendingMutations += 1;
  try {
    if (action === "navigate") {
      location.hash = b.dataset.page;
      return;
    }
    if (action === "node-detail") await nodeDetail(id);
    if (action === "node-annotate") await annotationForm(id);
    if (action === "node-evidence") {
      const data = await api(`/nodes/${id}/evidence`);
      $("detail-content").querySelector(".protected-reference").textContent =
        data.reference || "暂无依据";
    }
    if (action === "node-aliases") {
      const aliases = await api(`/nodes/${id}/aliases`);
      $("protected-aliases").replaceChildren(
        table(
          ["来源", "原始别名", "当前关联"],
          aliases.map((a) => [
            a.source_name,
            a.aliases.join("、"),
            a.is_present ? "存在" : "已移除",
          ]),
        ),
      );
    }
    if (action === "node-toggle") {
      await api("/nodes/" + id, {
        method: "PATCH",
        body: JSON.stringify({ enabled: b.dataset.enabled === "true" }),
      });
      await loadNodes();
    }
    if (action === "source-detail") await sourceDetail(id);
    if (action === "source-add") await sourceForm();
    if (action === "source-bulk") sourceBulkForm();
    if (action === "source-edit") await sourceForm(id);
    if (action === "source-sync") {
      const r = await api(`/sources/${id}/sync`, { method: "POST" });
      await render();
      notice(
        r.status === "QUEUED"
          ? "同步与检测任务已提交，导入后自动补测新增节点。"
          : r.reason
            ? errors[r.reason] || "请求已保存，请稍后点击同步重试。"
            : r.status === "PARTIAL"
              ? "已导入有效节点，部分配置需要处理。"
              : r.status === "FAILED"
                ? "同步失败，已有节点和关联已保留。"
                : "来源已同步。",
        r.status === "FAILED" || Boolean(r.reason),
      );
    }
    if (action === "source-toggle") {
      const r = await api("/sources/" + id, {
        method: "PATCH",
        body: JSON.stringify({ enabled: b.dataset.enabled === "true" }),
      });
      await render();
      if (r.pipeline) pipelineNotice(r);
    }
    if (
      action === "source-delete" &&
      confirm("删除此来源？节点资产和历史将继续保留。")
    ) {
      await api("/sources/" + id, { method: "DELETE" });
      await render();
    }
    if (action === "scan-create") {
      const r = await api("/scans", { method: "POST" });
      await render();
      notice(r.dispatched ? "检测任务已提交。" : "检测批次已创建，等待执行。");
    }
    if (action === "scan-detail") await scanDetail(id);
    if (action === "scan-retry") {
      const r = await api(`/scans/${id}/retry`, { method: "POST" });
      notice(
        r.dispatched
          ? "重试任务已提交。"
          : errors[r.reason] || "当前无需重试。",
      );
    }
    if (action === "naming-preview") {
      const template = new FormData($("naming-form")).get("template"),
        items = await api("/naming-rules/preview", {
          method: "POST",
          body: JSON.stringify({ template }),
        });
      $("name-preview").replaceChildren(
        table(
          ["预览名称"],
          items.map((n) => [n.name]),
        ),
      );
    }
    if (
      action === "export-revoke" &&
      confirm("撤销这个订阅链接？客户端将不能继续使用它。")
    ) {
      await api("/exports/" + id, { method: "DELETE" });
      await loadExportProfiles();
      notice("订阅链接已撤销。");
    }
    if (action === "export-link")
      showExportLink(await api(`/exports/${id}/link`));
    if (
      action === "export-token" &&
      confirm("更换密钥会立即使旧链接失效。继续？")
    )
      showExportLink(await api(`/exports/${id}/token`, { method: "POST" }));
    if (action === "export-retry") {
      const result = await api(`/exports/${id}/retry`, { method: "POST" });
      await loadExportProfiles();
      notice(
        result.pipeline.dispatched
          ? "已提交订阅生成任务。"
          : "生成请求已保存。" +
              (errors[result.pipeline.reason] || "稍后定时任务会自动处理。"),
        !result.pipeline.dispatched,
      );
    }
    if (action === "export-edit") await editExport(id);
    if (action === "export-cancel") {
      const form = $("export-form");
      form.reset();
      delete form.dataset.id;
      delete form.dataset.revision;
      form.querySelector("button[type=submit]").textContent = "保存并生成订阅";
      b.hidden = true;
    }
    if (action === "export-versions") {
      const versions = await api(`/exports/${id}/versions`);
      dialog(
        "订阅版本记录",
        table(
          ["版本", "生成时间", "节点数", "大小", "格式"],
          versions.map((v) => [
            v.version_no,
            date(v.created_at),
            v.node_count,
            bytes(v.payload_bytes),
            v.format,
          ]),
        ),
      );
    }
    if (action === "prev" || action === "next") {
      offset += action === "prev" ? -50 : 50;
      await loadNodes();
    }
  } catch (error) {
    notice(errors[error.message] || "操作未完成，请检查后重试。", true);
  } finally {
    b.disabled = false;
    if (
      restoreButtonFocus &&
      b.isConnected &&
      document.activeElement === document.body &&
      (!$("detail").open || $("detail").contains(b))
    )
      b.focus({ preventScroll: true });
    pendingMutations -= 1;
  }
});
document.addEventListener("change", async (e) => {
  if (e.target.name === "upload" && e.target.files[0]) {
    const f = e.target.files[0];
    if (f.size > 10485760) {
      notice("文件超过 10 MiB，请缩小后重试。", true);
      return;
    }
    $("source-form").elements.payload.value = await f.text();
  }
});
document.addEventListener("submit", async (e) => {
  if (
    ![
      "source-form",
      "source-bulk-form",
      "node-filters",
      "naming-form",
      "export-form",
      "usage-form",
      "quality-policy-form",
      "annotation-form",
    ].includes(e.target.id)
  )
    return;
  e.preventDefault();
  const form = e.target,
    submit = form.querySelector("button[type=submit]");
  if (submit) submit.disabled = true;
  pendingMutations += 1;
  try {
    const data = Object.fromEntries(new FormData(form));
    if (form.id === "source-bulk-form") {
      form.querySelector(".form-error").textContent = "";
      form.elements.name_prefix.removeAttribute("aria-invalid");
      const input = form.elements.urls;
      input.removeAttribute("aria-invalid");
      const result = await api("/sources/bulk", {
        method: "POST",
        body: JSON.stringify(data),
      });
      const summary = el(
        "p",
        `新增 ${result.created} 个，重复 ${result.duplicates} 个，无效 ${result.invalid} 个。` +
          (result.created
            ? result.pipeline.dispatched
              ? "同步任务已提交。"
              : "来源已保存，待处理请求已保留；可在来源列表点击同步重试。"
            : "未提交新的同步任务。"),
      );
      summary.setAttribute("role", "status");
      summary.tabIndex = -1;
      $("source-bulk-results").replaceChildren(
        summary,
        table(
          ["行号", "结果", "来源 / 原因"],
          result.items.map((item) => [
            item.line,
            { CREATED: "已新增", DUPLICATE: "重复，已跳过", INVALID: "无效" }[
              item.status
            ],
            item.status === "INVALID"
              ? errors[item.error_code] || "地址无效，请检查该行。"
              : item.name,
          ]),
        ),
      );
      if (result.invalid) input.setAttribute("aria-invalid", "true");
      await render();
      dialogTrigger = content.querySelector('[data-action="source-bulk"]');
      summary.focus();
    }
    if (form.id === "source-form") {
      delete data.upload;
      if (form.dataset.id && !data.payload) delete data.payload;
      const result = await api(
        form.dataset.id ? "/sources/" + form.dataset.id : "/sources",
        {
          method: form.dataset.id ? "PATCH" : "POST",
          body: JSON.stringify(data),
        },
      );
      form.reset();
      $("detail").close();
      await render();
      pipelineNotice(result);
    }
    if (form.id === "quality-policy-form") {
      const policy = {
        min_samples: Number(data.min_samples),
        poor_success_rate: Number(data.poor_success_rate) / 100,
        evidence_max_age_days: Number(data.evidence_max_age_days),
        operator_preferences: {},
      };
      for (const op of ["GENERAL", "CT", "CU", "CM"]) {
        const prefs = {};
        for (const key of [
          "preferred_entry_countries",
          "preferred_exit_countries",
          "preferred_entry_asns",
          "preferred_exit_asns",
          "preferred_protocols",
        ]) {
          const values =
            key === "preferred_protocols"
              ? new FormData(form).getAll(op + "_" + key)
              : String(data[op + "_" + key] || "")
                  .split(",")
                  .map((v) => v.trim())
                  .filter(Boolean);
          if (op === "GENERAL" || values.length)
            prefs[key] = key.endsWith("asns")
              ? values.map(Number)
              : key.endsWith("countries")
                ? values.map((v) => v.toUpperCase())
                : values;
        }
        if (op === "GENERAL") Object.assign(policy, prefs);
        else if (Object.keys(prefs).length)
          policy.operator_preferences[op] = prefs;
      }
      await api("/quality-policy", {
        method: "PUT",
        body: JSON.stringify({
          policy,
          expected_version: Number(form.dataset.version),
        }),
      });
      await render();
      notice("参考规则已更新；列表和导出将使用新版本。");
    }
    if (form.id === "annotation-form") {
      const payload = {
        tags: data.tags
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean),
        line_claim: data.line_claim,
        evidence_level: data.evidence_level,
        manual_priority: data.manual_priority,
        operators: new FormData(form).getAll("operators"),
      };
      if (data.reference) payload.reference = data.reference;
      if (data.clear_reference) payload.reference = null;
      await api(`/nodes/${form.dataset.id}/annotations`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      await nodeDetail(form.dataset.id);
      notice("人工资料已保存；线路真实类型仍保持未知。");
    }
    if (form.id === "usage-form") {
      usageDays = Number(data.days);
      await render();
    }
    if (form.id === "node-filters") {
      offset = 0;
      await loadNodes();
    }
    if (form.id === "naming-form") {
      await api("/naming-rules", { method: "PUT", body: JSON.stringify(data) });
      await render();
      notice("全部节点的展示名称已更新。");
    }
    if (form.id === "export-form") {
      const filters = readFilters(form),
        editing = Boolean(form.dataset.id);
      if (editing)
        for (const [key, value] of Object.entries(
          JSON.parse(form.dataset.originalFilters || "{}"),
        ))
          if (!form.elements.namedItem(key)) filters[key] = value;
      const payload = { name: data.name, format: data.format, filters };
      if (editing) payload.expected_revision = Number(form.dataset.revision);
      // Retain the absolute expiry while editing unless the user changes its control.
      if (!editing || data.expires_in_hours !== form.dataset.expiry)
        payload.expires_in_hours = data.expires_in_hours
          ? Number(data.expires_in_hours)
          : null;
      const result = await api(
        editing ? "/exports/" + form.dataset.id : "/exports",
        { method: editing ? "PATCH" : "POST", body: JSON.stringify(payload) },
      );
      if (result.token) showExportLink(result);
      delete form.dataset.id;
      delete form.dataset.revision;
      form.querySelector("button[type=submit]").textContent = "保存并生成订阅";
      $("export-cancel").hidden = true;
      await loadExportProfiles();
      notice(
        result.pipeline.dispatched
          ? "方案已保存，生成任务已提交。"
          : "方案已保存。" +
              (errors[result.pipeline.reason] || "等待任务处理。"),
        !result.pipeline.dispatched,
      );
    }
  } catch (error) {
    const message = errors[error.message] || "保存失败，请检查输入后重试。";
    const inline = form.querySelector(".form-error");
    if (inline) inline.textContent = message;
    if (form.id === "source-bulk-form") {
      const invalid =
        error.message === "INVALID_SOURCE_LABEL"
          ? form.elements.name_prefix
          : form.elements.urls;
      invalid.setAttribute("aria-invalid", "true");
    }
    notice(message, true);
  } finally {
    if (submit) submit.disabled = false;
    pendingMutations -= 1;
  }
});
