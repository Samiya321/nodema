import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { ApiError, api } from "../api/client";
import { errorText } from "../lib/errors";
import type { NodeShareLink } from "../types/api";
import { CopyTextButton, Modal } from "./ui";

const MODULE_PX = 6;
const QUIET = 4;

const OMITTED_HINTS: Record<string, string> = {
  SKIP_CERT_VERIFY: "跳过证书验证：导入后在 Shadowrocket 编辑节点，打开“允许不安全”",
  CLIENT_OPTIONS: "客户端附加参数（如 UDP 开关）",
  BANDWIDTH: "Hysteria2 带宽设置",
  HEADERS: "WebSocket 请求头（如 User-Agent），通常不影响连接",
  SESSION_OPTIONS: "AnyTLS 空闲会话参数，客户端用默认值即可",
};

function QrCanvas({ text }: { text: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [qrFailed, setQrFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setQrFailed(false);

    void import("../vendor/qrcode.js")
      .then(({ default: qrcode }) => {
        if (cancelled) return;
        const code = qrcode(0, "M");
        code.addData(text, "Byte");
        code.make();
        const count = code.getModuleCount();
        const size = (count + QUIET * 2) * MODULE_PX;
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, size, size);
        ctx.fillStyle = "#000000";
        for (let r = 0; r < count; r += 1) {
          for (let c = 0; c < count; c += 1) {
            if (code.isDark(r, c)) {
              ctx.fillRect((c + QUIET) * MODULE_PX, (r + QUIET) * MODULE_PX, MODULE_PX, MODULE_PX);
            }
          }
        }
      })
      .catch(() => {
        if (!cancelled) setQrFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [text]);

  if (qrFailed) {
    return <p className="hint">无法生成二维码，可复制链接后从客户端剪贴板导入。</p>;
  }
  return <canvas ref={canvasRef} className="qr-canvas" role="img" aria-label="节点分享二维码" />;
}

export function ShareQrModal({
  node,
  onClose,
}: {
  node: { id: string; name: string };
  onClose: () => void;
}) {
  const [link, setLink] = useState<NodeShareLink | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setLink(null);
    try {
      const data = await api<NodeShareLink>(`/nodes/${encodeURIComponent(node.id)}/share`);
      setLink(data);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "OPERATION_FAILED";
      setError(errorText(code));
    } finally {
      setLoading(false);
    }
  }, [node.id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Modal title="节点二维码" onClose={onClose}>
      <div className="share-box">
        {loading && (
          <p className="muted" role="status">
            正在生成二维码…
          </p>
        )}

        {!loading && error && (
          <div className="stack center">
            <p className="form-error" role="alert">
              {error}
            </p>
            <button type="button" className="btn" onClick={() => void load()}>
              <RefreshCw size={14} />
              重试
            </button>
          </div>
        )}

        {!loading && !error && link && !link.uri && (
          <p className="hint" role="status">
            {link.error_code === "SHARE_PENDING"
              ? "分享链接还没生成，下一次“同步来源”后可用。"
              : `这个节点的配置无法用分享链接表示（${errorText(link.error_code)}），请通过订阅导入。`}
          </p>
        )}

        {!loading && !error && link?.uri && (
          <>
            <div className="qr-frame">
              <QrCanvas text={link.uri} />
            </div>
            <p className="share-node-name">{link.name || node.name}</p>
            <p className="hint">用 Shadowrocket 等兼容客户端扫码。二维码和链接包含节点凭据。</p>

            {link.omitted && link.omitted.length > 0 && (
              <div className="callout callout-warn share-notice">
                <div className="callout-title">
                  <AlertTriangle size={14} />
                  <span>部分参数需要在客户端配置</span>
                </div>
                <ul>
                  {link.omitted.map((code) => (
                    <li key={code}>{OMITTED_HINTS[code] || code}</li>
                  ))}
                </ul>
              </div>
            )}

            <CopyTextButton text={link.uri} label="复制分享链接" />

            <details className="share-raw">
              <summary>查看原始链接</summary>
              <textarea
                className="textarea mono share-uri"
                rows={3}
                readOnly
                spellCheck={false}
                aria-label="节点分享链接"
                value={link.uri}
                onFocus={(e) => e.currentTarget.select()}
              />
            </details>
          </>
        )}
      </div>
    </Modal>
  );
}
