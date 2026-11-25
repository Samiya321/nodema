import { KIND, api, busy, date, dialog, field, h, select, toast } from "../core.js";

const LABELS = {
  AIRPORT_SOURCE: "机场订阅",
  HISTORICAL_AIRPORT: "历史机场",
  SHARED_CREDENTIAL: "共享推定",
  UNCONFIRMED: "归属待确认",
};

const REASONS = {
  AIRPORT_SOURCE: "当前至少有一个机场来源仍包含此节点。",
  HISTORICAL_AIRPORT: "机场来源的旧关联仍可追溯，当前已没有机场订阅包含此节点。",
  SHARED_CREDENTIAL: "同一凭据达到多入口或单入口多地区的分组门槛，现按机场组检测。",
  UNCONFIRMED: "目前缺少可确认归属的来源证据，暂按自建组检测。",
  MANUAL: "使用管理员为此节点确认的归属。",
};

export function classificationLabel(node) {
  if (node.classification_basis === "MANUAL") return "已确认" + KIND[node.node_group];
  return LABELS[node.classification_basis] || KIND[node.node_group];
}

function editClassification(node, refresh) {
  const current = node.classification;
  const group = select("group", [["", "自动判断"], ["SELF_HOSTED", "确认自建"], ["AIRPORT", "确认机场"]], current.classification_override || "");
  const note = h("input", {
    name: "note", maxlength: 160, autocomplete: "off",
    value: current.classification_note || "", disabled: !group.value,
  });
  group.addEventListener("change", () => { note.disabled = !group.value; });
  const submit = h("button", { type: "submit", class: "primary" }, "保存归属");
  const form = h("form", { class: "stack" },
    field("节点归属", group),
    field("确认依据（选填）", note, "可填写管理或来源说明。"),
    h("p", { class: "hint" }, "保存后会影响后续检测分组和导出筛选。选择「自动判断」可撤销人工确认。"),
    h("div", { class: "row end" }, submit),
  );
  const box = dialog("编辑节点归属", form);
  box.classList.add("node-classification-dialog");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void busy(submit, async () => {
      await api(`/nodes/${encodeURIComponent(node.id)}/classification`, {
        method: "PATCH",
        body: { group: group.value || null, note: group.value ? note.value.trim() || null : null },
      });
      window.dispatchEvent(new CustomEvent("nodema:nodes-changed"));
      box.close();
      toast("归属已保存。", "ok");
      await refresh();
    });
  });
}

export function classificationSection(node, refresh) {
  const c = node.classification;
  if (!c) return null;
  return h("section", { class: "panel stack tight" },
    h("header", { class: "panel-head" },
      h("h2", {}, "归属依据"),
      h("button", { type: "button", onclick: () => editClassification(node, refresh) }, "编辑归属"),
    ),
    h("div", { class: "row wrap" },
      h("strong", {}, classificationLabel(c)),
      h("span", { class: "muted" }, `检测分组 · ${KIND[c.node_group]}`),
      h("span", { class: "muted" }, c.eligible ? "具备检测资格" : "当前不参与检测或导出"),
    ),
    h("p", { class: "hint" }, REASONS[c.classification_basis]),
    c.classification_note ? h("p", {}, c.classification_note) : null,
    c.classification_updated_at ? h("p", { class: "hint" }, `归属更新于 ${date(c.classification_updated_at)}`) : null,
  );
}
