// Country view of the node list: exit countries on a rail; the chosen country's nodes
// grouped by landing ASN, so "which networks does this country have, and which nodes
// are on each" reads at a glance. Works on the already loaded set: no extra queries.
import { flag, h, ms } from "../core.js";
import { GRADES, distribution, isCarrier, vantageName } from "../grades.js";
import {
  BUCKETS,
  bucketOf,
  collator,
  countryName,
  headRow,
  nodeRow,
  operatorOf,
  rowVantage,
  sortNodes,
} from "./node-rows.js";

export const UNKNOWN = "UNK";
const CLOUDFLARE = 13335;
const ROWS_SHOWN = 10; // rows per group before "显示其余"
const OPEN_GROUPS = 4; // groups expanded when a country has many

const countryOf = (n) => n.exit_country || UNKNOWN;
const countryLabel = (code) =>
  code === UNKNOWN ? "落地未知" : countryName(code);
const rank = (n) => BUCKETS.indexOf(bucketOf(n));
const count = (n) => n.toLocaleString("zh-CN");

function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    groups.set(key, [...(groups.get(key) || []), item]);
  }
  return groups;
}

// Most nodes first; unknown last.
export function countryList(items) {
  return [...groupBy(items, countryOf)]
    .map(([code, nodes]) => ({
      code,
      nodes,
      asns: new Set(nodes.map((n) => n.exit_asn || 0)).size,
    }))
    .sort(
      (a, b) =>
        (a.code === UNKNOWN) - (b.code === UNKNOWN) ||
        b.nodes.length - a.nodes.length ||
        collator.compare(countryLabel(a.code), countryLabel(b.code)),
    );
}

// Best grade first, then size; Cloudflare (not tested) and unknown networks last.
function asnGroups(nodes) {
  const tail = (g) => (g.asn === CLOUDFLARE ? 2 : g.asn === 0 ? 1 : 0);
  return [...groupBy(nodes, (n) => n.exit_asn || 0)]
    .map(([asn, members]) => ({
      asn,
      nodes: members,
      best: Math.min(...members.map(rank)),
      name: operatorOf(members.find((n) => operatorOf(n)) || members[0]),
    }))
    .sort(
      (a, b) =>
        tail(a) - tail(b) ||
        a.best - b.best ||
        b.nodes.length - a.nodes.length ||
        a.asn - b.asn,
    );
}

const gradeCounts = (nodes) =>
  Object.fromEntries(
    GRADES.map((g) => [g, nodes.filter((n) => n.quality_grade === g).length]),
  );

function fastest(nodes) {
  const values = nodes
    .filter((n) => n.quality_grade && !n.unreachable && n.peak_rtt_ms != null)
    .map((n) => n.peak_rtt_ms);
  return values.length ? Math.min(...values) : null;
}

function rail(list, current, onCountry) {
  return h(
    "nav",
    { class: "country-rail", "aria-label": "落地国家" },
    list.map(({ code, nodes, asns }) =>
      h(
        "button",
        {
          type: "button",
          class: "country-item",
          "aria-pressed": String(code === current),
          onclick: () => onCountry(code),
        },
        h(
          "span",
          { class: "country-flag", "aria-hidden": "true" },
          code === UNKNOWN ? "·" : flag(code),
        ),
        h(
          "span",
          { class: "country-name" },
          countryLabel(code),
          code === UNKNOWN ? null : h("span", { class: "country-code" }, code),
        ),
        h(
          "span",
          { class: "country-n", title: `${asns} 个 ASN` },
          count(nodes.length),
        ),
      ),
    ),
  );
}

function groupCard(group, { open, sortKey, sortDir, onSort, onPick, scope }) {
  const sorted = sortNodes(group.nodes, sortKey, sortDir);
  const box = h("input", {
    type: "checkbox",
    "aria-label": `选择 AS${group.asn} 的全部节点`,
  });
  box.addEventListener("change", () =>
    onPick(
      sorted.map((n) => n.id),
      box.checked,
    ),
  );
  scope.push({ box, ids: sorted.map((n) => n.id) });
  const tbody = h(
    "tbody",
    {},
    sorted.slice(0, ROWS_SHOWN).map((n) => nodeRow(n, false, onPick)),
  );
  const rest = sorted.length - ROWS_SHOWN;
  const more =
    rest > 0
      ? h(
          "button",
          {
            type: "button",
            class: "quiet group-more",
            onclick: (e) => {
              tbody.append(
                ...sorted
                  .slice(ROWS_SHOWN)
                  .map((n) => nodeRow(n, false, onPick)),
              );
              e.target.remove();
              onPick([], true);
            },
          },
          `显示其余 ${count(rest)} 个`,
        )
      : null;
  const best = fastest(group.nodes);
  const cf = group.asn === CLOUDFLARE;
  const details = h(
    "details",
    { class: "asn-group" + (cf ? " cf" : ""), open: open && !cf },
    h(
      "summary",
      {},
      h("span", { class: "asn-chevron", "aria-hidden": "true" }),
      h("span", { class: "asn-id" }, group.asn ? "AS" + group.asn : "ASN 未知"),
      h(
        "span",
        { class: "asn-name", title: group.name },
        cf
          ? "Cloudflare（落地不测、不分级）"
          : group.name && group.name !== "AS" + group.asn
            ? group.name
            : "",
      ),
      h(
        "span",
        { class: "asn-dist" },
        cf ? null : distribution(gradeCounts(group.nodes)),
      ),
      h(
        "span",
        {
          class: "asn-best",
          title: `${vantageName(rowVantage())}${isCarrier(rowVantage()) ? "晚高峰" : ""}最低延迟`,
        },
        best == null ? "" : ms(best),
      ),
      h("span", { class: "asn-n" }, `${count(group.nodes.length)} 个`),
    ),
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        { class: "nodes" },
        headRow(sortKey, sortDir, onSort, box),
        tbody,
      ),
    ),
    more,
  );
  return details;
}

// Returns the view plus the nodes it covers (for selection) and per-group checkboxes.
export function countryView(
  items,
  { country, onCountry, sortKey, sortDir, onSort, onPick },
) {
  const list = countryList(items);
  const chosen = list.find((c) => c.code === country) || list[0];
  const scope = [];
  if (!chosen) return { element: null, nodes: [], scope };
  const groups = asnGroups(chosen.nodes);
  const openAll = groups.length <= OPEN_GROUPS + 2;
  const cards = groups.map((group, i) =>
    groupCard(group, {
      open: openAll || i < OPEN_GROUPS,
      sortKey,
      sortDir,
      onSort,
      onPick,
      scope,
    }),
  );
  const toggleAll = h("button", { type: "button", class: "quiet" });
  const sync = () =>
    (toggleAll.textContent = cards.every((c) => c.open)
      ? "全部收起"
      : "全部展开");
  toggleAll.addEventListener("click", () => {
    const open = !cards.every((c) => c.open);
    for (const card of cards) card.open = open;
    sync();
  });
  for (const card of cards) card.addEventListener("toggle", sync);
  sync();
  const head = h(
    "header",
    { class: "country-head" },
    h(
      "span",
      { class: "country-flag big", "aria-hidden": "true" },
      chosen.code === UNKNOWN ? "·" : flag(chosen.code),
    ),
    h(
      "div",
      { class: "country-title" },
      h(
        "h2",
        {},
        countryLabel(chosen.code),
        chosen.code === UNKNOWN
          ? null
          : h("span", { class: "country-code" }, chosen.code),
      ),
      h(
        "p",
        { class: "muted" },
        `${count(chosen.nodes.length)} 个节点 · ${groups.length} 个 ASN`,
      ),
    ),
    h(
      "span",
      { class: "country-dist" },
      distribution(gradeCounts(chosen.nodes)),
    ),
    toggleAll,
  );
  const element = h(
    "div",
    { class: "country-view" },
    rail(list, chosen.code, onCountry),
    h(
      "section",
      { class: "country-main", "aria-label": countryLabel(chosen.code) },
      head,
      cards,
    ),
  );
  return { element, nodes: chosen.nodes, scope };
}

// Bring the chosen country into the rail's own scroll area (never scrolls the page).
export function revealCountry(root) {
  const rail = root.querySelector(".country-rail");
  const item = rail?.querySelector('[aria-pressed="true"]');
  if (!item) return;
  rail.scrollLeft = item.offsetLeft - (rail.clientWidth - item.offsetWidth) / 2;
  rail.scrollTop = item.offsetTop - (rail.clientHeight - item.offsetHeight) / 2;
}
