import { api, dialog, errorText, h } from "./core.js";

const MODULE_PX = 6;
// Settings the share link could not carry; set them by hand on the phone.
const OMITTED = {
  SKIP_CERT_VERIFY: "跳过证书验证：导入后在 Shadowrocket 编辑节点，打开“允许不安全”",
  CLIENT_OPTIONS: "客户端附加参数（如 UDP 开关）",
  BANDWIDTH: "Hysteria2 带宽设置",
  HEADERS: "WebSocket 请求头（如 User-Agent），通常不影响连接",
  SESSION_OPTIONS: "AnyTLS 空闲会话参数，客户端用默认值即可",
};
const QUIET = 4; // quiet-zone modules around the code, as scanners expect

// Draw on a canvas: no inline styles or data: images, so the strict CSP stays intact.
async function qrCanvas(text) {
  const { default: qrcode } = await import("./vendor/qrcode.js");
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
export function showShare(node) {
  const body = h("div", { class: "stack share" });
  const box = dialog("节点二维码", body);
  box.classList.add("node-share");
  box.addEventListener("close", () => body.replaceChildren());

  async function load() {
    body.replaceChildren(h("p", { class: "muted", role: "status" }, "正在生成二维码…"));
    try {
      const link = await api(`/nodes/${encodeURIComponent(node.id)}/share`);
      if (!box.open) return;
      await renderLink(link);
    } catch (error) {
      if (!box.open) return;
      body.replaceChildren(
        h("p", { class: "form-error", role: "alert" }, errorText(error.code)),
        h("button", { type: "button", onclick: load }, "重试"),
      );
    }
  }

  async function renderLink(link) {
    if (!link.uri) {
      const reason =
        link.error_code === "SHARE_PENDING"
          ? "分享链接还没生成，下一次“同步来源”后可用。"
          : `这个节点的配置无法用分享链接表示（${errorText(link.error_code)}），请通过订阅导入。`;
      body.replaceChildren(h("p", { class: "hint", role: "status" }, reason));
      return;
    }
    const text = h("textarea", { class: "share-uri", rows: 3, readonly: true, spellcheck: "false", "aria-label": "节点分享链接" }, link.uri);
    const source = h("details", { class: "share-link" }, h("summary", {}, "查看链接"), text);
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
            source.open = true;
            text.focus();
            text.select();
          }
        },
      },
      "复制链接",
    );
    // Version-40 QR codes hold about 2.3 KB; very long links fall back to copying.
    let code;
    try {
      code = await qrCanvas(link.uri);
    } catch {
      code = h("p", { class: "hint" }, "无法生成二维码，可复制链接后从客户端剪贴板导入。");
    }
    if (!box.open) return;
    body.replaceChildren(
      code,
      h("p", { class: "node-name" }, link.name || node.name),
      h("p", { class: "hint" }, "用 Shadowrocket 等兼容客户端扫码。二维码和链接包含节点凭据。"),
      ...(link.omitted?.length ? [
        h("div", { class: "notice warn" }, h("strong", {}, "部分参数需要在客户端配置"), h("ul", {}, link.omitted.map((code) => h("li", {}, OMITTED[code] || code)))),
      ] : []),
      copy,
      source,
    );
  }
  void load();
}
