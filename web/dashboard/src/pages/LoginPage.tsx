import React, { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, KeyRound, RefreshCw, ShieldCheck } from "lucide-react";
import { ApiError, api } from "../api/client";
import { errorText } from "../lib/errors";
import type { SessionInfo } from "../types/api";

export function LoginPage({
  checking,
  initialMessage,
  canRetry,
  onRetryCheck,
  onAuthenticated,
}: {
  checking: boolean;
  initialMessage: string;
  canRetry: boolean;
  onRetryCheck: () => void;
  onAuthenticated: (session: SessionInfo) => void;
}) {
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(initialMessage);
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setError(initialMessage);
  }, [initialMessage]);

  useEffect(() => {
    if (!checking && !canRetry) {
      inputRef.current?.focus();
    }
  }, [checking, canRetry]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError("");
    setInvalid(false);
    const secret = token;
    setToken("");
    try {
      await api("/session", { method: "POST", authorization: secret });
      const session = await api<SessionInfo>("/session");
      onAuthenticated(session);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "OPERATION_FAILED";
      if (code === "INVALID_ADMIN_TOKEN") setInvalid(true);
      setError(
        code === "AUTHENTICATION_REQUIRED"
          ? "浏览器未保存登录会话，请允许本站 Cookie 后重试。"
          : errorText(code),
      );
      inputRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card" role="main" aria-labelledby="login-title">
        <div className="login-brand">
          <div className="brand-mark brand-mark-lg" aria-hidden="true">
            N
          </div>
          <div>
            <h1 id="login-title" tabIndex={-1}>
              Nodema 节点台
            </h1>
            <p className="login-subtitle">代理节点观测、分级与订阅控制台</p>
          </div>
        </div>

        {checking ? (
          <div className="login-checking" role="status">
            <span className="spinner" aria-hidden="true" />
            <span>正在检查登录状态…</span>
          </div>
        ) : (
          <form className="stack" onSubmit={handleSubmit} aria-busy={submitting || undefined}>
            {error && (
              <div className="callout callout-bad" role="alert">
                {error}
              </div>
            )}

            <input type="text" name="username" value="admin" autoComplete="username" hidden readOnly />

            <div className="field">
              <label className="field-label" htmlFor="login-token">
                管理员密钥
              </label>
              <div className="input-with-action">
                <span className="input-prefix" aria-hidden="true">
                  <KeyRound size={15} />
                </span>
                <input
                  ref={inputRef}
                  id="login-token"
                  type={showToken ? "text" : "password"}
                  className="input has-prefix has-suffix"
                  required
                  minLength={24}
                  autoComplete="current-password"
                  placeholder="输入管理员密钥（至少 24 位）"
                  aria-invalid={invalid || undefined}
                  aria-describedby="login-hint"
                  value={token}
                  onChange={(e) => {
                    setToken(e.target.value);
                    if (invalid) {
                      setInvalid(false);
                      setError("");
                    }
                  }}
                />
                <button
                  type="button"
                  className="input-suffix-btn"
                  aria-label={showToken ? "隐藏密钥" : "显示密钥"}
                  onClick={() => setShowToken((v) => !v)}
                >
                  {showToken ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              <span id="login-hint" className="hint">
                <ShieldCheck size={12} className="inline-icon" aria-hidden="true" /> 会话使用 HttpOnly
                Cookie，有效期 8 小时。
              </span>
            </div>

            <button type="submit" className="btn btn-primary btn-lg" disabled={submitting}>
              {submitting ? "正在登录…" : "登录控制台"}
            </button>

            {canRetry && (
              <button
                type="button"
                className="btn"
                disabled={submitting}
                onClick={onRetryCheck}
              >
                <RefreshCw size={14} />
                重新检查登录状态
              </button>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
