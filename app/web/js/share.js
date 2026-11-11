import { api, busy, dialog, errorText, h } from "./core.js";
import qrcode from "./vendor/qrcode.js";

const MODULE_PX = 6;
// Settings the share link could not carry; set them by hand on the phone.
const OMITTED = {
  SKIP_CERT_VERIFY: "跳过证书验证：导入后在 Shadowrocket 编辑节点，打开“允许不安全”",
  CLIENT_OPTIONS: "客户端附加参数（如 UDP 开关）",
  BANDWIDTH: "Hysteria2 带宽设置",
};
const QUIET = 4; // quiet-zone modules around the code, as scanners expect

// Draw on a canvas: no inline styles or data: images, so the strict CSP stays intact.
export function qrCanvas(text) {
  const code = qrcode(0, "M");
  code.addData(text, "Byte");
  code.make();
  const count = code.getModuleCount();
  const size = (count + QUIET * 2) * MODULE_PX;
  const canvas = h("canvas", { width: size, height: size, class: "qr", role: "img", "aria-label": "节点分享二维码" });
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#000000";
  for (let r = 0; r < count; r += 1)
    for (let c = 0; c < count; c += 1)
      if (code.isDark(r, c)) ctx.fillRect((c + QUIET) * MODULE_PX, (r + QUIET) * MODULE_PX, MODULE_PX, MODULE_PX);
  return canvas;
}

// The link carries the node's credentials: fetch it only on an explicit click.
export async function showShare(node, button) {
  await busy(button, async () => {
    const link = await api(`/nodes/${node.id}/share`);
    if (!link.uri) {
      const reason =
        link.error_code === "SHARE_PENDING"
          ? "分享链接还没生成，下一次“同步来源”后可用。"
          : `这个节点的配置无法用分享链接表示（${errorText(link.error_code)}），请通过订阅导入。`;
      dialog("分享节点", h("p", { class: "hint" }, reason));
      return;
    }
    const text = h("textarea", { class: "share-uri", rows: 3, readonly: true, spellcheck: "false" }, link.uri);
    const copy = h(
      "button",
      {
        type: "button",
        class: "primary",
        onclick: async (e) => {
          try {
            await navigator.clipboard.writeText(link.uri);
            e.target.textContent = "已复制";
          } catch {
            text.select();
          }
        },
      },
      "复制链接",
    );
    // Version-40 QR codes hold about 2.3 KB; very long links fall back to copying.
    let code;
    try {
      code = qrCanvas(link.uri);
    } catch {
      code = h("p", { class: "hint" }, "链接太长，无法生成二维码，请复制后在 Shadowrocket 中“从剪贴板导入”。");
    }
    dialog(
      "分享到手机",
      h(
        "div",
        { class: "stack share" },
        h("p", { class: "hint" }, "用 Shadowrocket 扫码添加（首页右上角扫码图标）。二维码包含节点密码，不要截图外传。"),
        code,
        h("p", { class: "node-name" }, link.name),
        link.omitted?.length
          ? h("div", { class: "notice warn" }, h("strong", {}, "分享链接没有包含："), h("ul", {}, link.omitted.map((code) => h("li", {}, OMITTED[code] || code))))
          : null,
        text,
        h("div", { class: "row" }, copy),
      ),
    );
  });
}
