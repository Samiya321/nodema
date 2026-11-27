import React, { useEffect, useState } from "react";
import { ApiError, api } from "../../api/client";
import { CopyTextButton, Modal, SkeletonBlock } from "../../components/ui";
import { errorText } from "../../lib/errors";
import { KIND_LABEL } from "../../lib/format";
import { useApp } from "../../state/AppContext";
import type { SourceItem, SourceKind } from "../../types/api";

export function SourceLinkModal({
  source,
  onClose,
}: {
  source: Pick<SourceItem, "id" | "name" | "origin_label" | "parent_source_id" | "parent_name">;
  onClose: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api<{ url: string }>(`/sources/${encodeURIComponent(source.id)}/link`).then(
      (res) => {
        if (!cancelled) {
          setUrl(res.url);
          setLoading(false);
        }
      },
      (err) => {
        if (!cancelled) {
          setError(errorText(err instanceof ApiError ? err.code : "OPERATION_FAILED"));
          setLoading(false);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [source.id]);

  return (
    <Modal title={`「${source.origin_label || source.name}」的订阅链接`} onClose={onClose}>
      <div className="stack">
        {source.parent_source_id && (
          <p className="hint">由 Sub-Store「{source.parent_name || "已删除"}」解析得到。</p>
        )}
        {loading ? (
          <SkeletonBlock lines={2} />
        ) : error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : url ? (
          <>
            <input
              type="text"
              readOnly
              spellCheck={false}
              className="input mono"
              aria-label="订阅链接"
              value={url}
              onFocus={(e) => e.currentTarget.select()}
            />
            <p className="hint">链接里包含订阅令牌，不要公开分享。</p>
            <div className="row-wrap">
              <CopyTextButton text={url} label="复制链接" />
            </div>
          </>
        ) : null}
      </div>
    </Modal>
  );
}

export function EditSourceModal({
  source,
  onClose,
  onSaved,
}: {
  source: SourceItem;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast, fail } = useApp();
  const [name, setName] = useState(source.name);
  const [kind, setKind] = useState<SourceKind>(source.kind);
  const [userAgent, setUserAgent] = useState(source.user_agent || "");
  const [enabled, setEnabled] = useState(String(source.enabled));
  const [payload, setPayload] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        name,
        kind,
        enabled: enabled === "true",
      };
      if (source.type === "SUBSCRIPTION_URL") body.user_agent = userAgent || null;
      if (payload) body.payload = payload;
      await api(`/sources/${encodeURIComponent(source.id)}`, { method: "PATCH", body });
      toast(payload ? "已保存，同步后生效。" : "已保存。", "ok");
      onClose();
      onSaved();
    } catch (err) {
      fail(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="编辑来源" onClose={onClose}>
      <form className="stack" onSubmit={handleSubmit}>
        <div className="form-grid-2">
          <label className="field">
            <span className="field-label">名称</span>
            <input
              className="input"
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <label className="field">
            <span className="field-label">类别</span>
            <select
              className="select"
              value={kind}
              onChange={(e) => setKind(e.target.value as SourceKind)}
            >
              <option value="AUTO">
                自动识别（当前：{KIND_LABEL[source.detected_kind] || "未识别"}）
              </option>
              <option value="SELF_HOSTED">自建</option>
              <option value="AIRPORT">机场</option>
            </select>
            <span className="hint">
              机场节点只在检测机场时参与；过期或流量用完会自动停测。
            </span>
          </label>

          {source.type === "SUBSCRIPTION_URL" && (
            <label className="field">
              <span className="field-label">User-Agent</span>
              <input
                className="input"
                placeholder="默认 clash.meta"
                value={userAgent}
                onChange={(e) => setUserAgent(e.target.value)}
              />
              <span className="hint">部分机场只对特定客户端返回流量信息。</span>
            </label>
          )}

          <label className="field">
            <span className="field-label">启用同步</span>
            <select
              className="select"
              value={enabled}
              onChange={(e) => setEnabled(e.target.value)}
            >
              <option value="true">启用</option>
              <option value="false">暂停</option>
            </select>
            <span className="hint">暂停只停止拉取；自建节点继续保留和检测。</span>
          </label>
        </div>

        <label className="field">
          <span className="field-label">
            {source.type === "SUBSCRIPTION_URL" ? "更换链接（留空不变）" : "替换内容（留空不变）"}
          </span>
          <textarea
            className="textarea mono"
            rows={3}
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
          />
          <span className="hint">
            {source.parent_source_id
              ? "此链接来自上级索引。如需长期更换，请先更新上级索引中的条目。"
              : "换链接会保留来源编号及节点历史。"}
          </span>
        </label>

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
