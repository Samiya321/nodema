import React, { useEffect, useRef, useState } from "react";
import { Check, Copy, Link2, RefreshCw, Search, X, AlertTriangle, Inbox } from "lucide-react";
import { STATUS_META, countryFlag, type Tone } from "../lib/format";
import { GRADES, GRADE_HINT, GRADE_TEXT, vantageName } from "../lib/grades";
import { sourceHref } from "../lib/router";
import type { QualityGrade, SourceChainItem } from "../types/api";
import { useApp } from "../state/AppContext";

// ---- Body scroll lock helper (CSP-safe class toggle) ----
let openModalCount = 0;
export function useBodyScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    openModalCount += 1;
    document.body.classList.add("modal-open");
    return () => {
      openModalCount = Math.max(0, openModalCount - 1);
      if (openModalCount === 0) document.body.classList.remove("modal-open");
    };
  }, [active]);
}

// ---- SearchField (debounced change + instant Enter & clear + optional '/' shortcut) ----
export function SearchField({
  value,
  onCommit,
  placeholder,
  ariaLabel,
  name,
  delay = 300,
  hotkey = false,
}: {
  value: string;
  onCommit: (next: string) => void;
  placeholder: string;
  ariaLabel: string;
  name?: string;
  delay?: number;
  hotkey?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const timerRef = useRef<number | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    return () => window.clearTimeout(timerRef.current);
  }, []);

  useEffect(() => {
    if (!hotkey) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (document.activeElement?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (document.body.classList.contains("modal-open")) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hotkey]);

  const flush = (next: string) => {
    window.clearTimeout(timerRef.current);
    onCommit(next.trim());
  };

  return (
    <div className="search-wrap">
      <Search size={15} className="search-icon" aria-hidden="true" />
      <input
        ref={inputRef}
        type="search"
        name={name}
        className="input search-input"
        placeholder={placeholder}
        aria-label={ariaLabel}
        value={draft}
        onChange={(e) => {
          const next = e.target.value;
          setDraft(next);
          window.clearTimeout(timerRef.current);
          if (next === "") {
            onCommit("");
          } else {
            timerRef.current = window.setTimeout(() => onCommit(next.trim()), delay);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            flush(draft);
          } else if (e.key === "Escape" && draft) {
            e.preventDefault();
            setDraft("");
            flush("");
          }
        }}
      />
      {draft ? (
        <button
          type="button"
          className="search-clear"
          aria-label="清空搜索"
          onClick={() => {
            setDraft("");
            flush("");
            inputRef.current?.focus();
          }}
        >
          <X size={13} />
        </button>
      ) : hotkey ? (
        <kbd className="search-kbd" aria-hidden="true">
          /
        </kbd>
      ) : null}
    </div>
  );
}

// ---- Vertical Bar Column (CSP-safe via CSSOM height) ----
export function BarColumn({ ratio, title }: { ratio: number; title?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const clamped = Math.max(6, Math.min(100, Math.round(ratio * 100)));
  useEffect(() => {
    ref.current?.style.setProperty("--bar-h", clamped + "%");
  }, [clamped]);
  return <span ref={ref} className="mini-bar-col" title={title} />;
}

// ---- StatusBadge ----
export function StatusBadge({
  status,
  label,
  tone,
}: {
  status?: string;
  label?: string;
  tone?: Tone;
}) {
  const [defaultText, defaultTone] = (status && STATUS_META[status]) || [status || "—", "mute"];
  const finalTone = tone || defaultTone;
  const finalLabel = label || defaultText;
  return (
    <span className={`badge badge-${finalTone}`}>
      <span className="badge-dot" aria-hidden="true" />
      {finalLabel}
    </span>
  );
}

// ---- GradeBadge ----
export function GradeBadge({
  grade,
  vantage,
  withVantage = true,
}: {
  grade?: QualityGrade | null;
  vantage?: string;
  withVantage?: boolean;
}) {
  if (!grade) return null;
  const label = GRADE_TEXT[grade] || grade;
  return (
    <span
      className={`grade grade-${grade}`}
      title={`${vantageName(vantage)}视角：${GRADE_HINT[grade] || ""}`}
    >
      <strong className="grade-tile">{label}</strong>
      {withVantage && <span className="grade-vantage">{vantageName(vantage)}</span>}
    </span>
  );
}

// ---- MeterBar (CSP-safe: writes width via CSSOM, never inline style attributes) ----
export function MeterBar({
  ratio,
  tone = "ok",
  label,
}: {
  ratio: number;
  tone?: "ok" | "warn" | "bad" | "info";
  label?: string;
}) {
  const fillRef = useRef<HTMLSpanElement>(null);
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));

  useEffect(() => {
    fillRef.current?.style.setProperty("--fill", (clamped * 100).toFixed(1) + "%");
  }, [clamped]);

  return (
    <span
      className="meter"
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      aria-label={label}
    >
      <span ref={fillRef} className={`meter-fill meter-${tone}`} />
    </span>
  );
}

// ---- Proportional Bar Segment (CSP-safe via CSSOM flexGrow) ----
export function FlexSegment({
  grow,
  className,
}: {
  grow: number;
  className: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.style.flexGrow = String(grow);
  }, [grow]);
  return <span ref={ref} className={className} />;
}

// ---- GradeDistribution ----
export function GradeDistribution({
  counts,
  link,
  fullWidth = false,
  compact = false,
}: {
  counts: Partial<Record<QualityGrade, number>>;
  link?: (g: QualityGrade) => string;
  fullWidth?: boolean;
  compact?: boolean;
}) {
  const total = GRADES.reduce((sum, g) => sum + (counts[g] || 0), 0);
  const nonZero = GRADES.filter((g) => (counts[g] || 0) > 0);

  return (
    <div className={`grade-dist${fullWidth ? " is-full" : ""}${compact ? " is-compact" : ""}`}>
      {total > 0 && (
        <span className="grade-bar" aria-hidden="true">
          {nonZero.map((g) => (
            <FlexSegment key={g} grow={counts[g] || 0} className={`seg-${g}`} />
          ))}
        </span>
      )}
      {!compact && (
        <span className="grade-counts">
          {nonZero.length > 0 ? (
            nonZero.map((g) =>
              link ? (
                <a key={g} href={link(g)} className="grade-count-link">
                  <span className={`swatch seg-${g}`} aria-hidden="true" />
                  <span>
                    {GRADE_TEXT[g]} <strong>{counts[g]}</strong>
                  </span>
                </a>
              ) : (
                <span key={g} className="grade-count-item">
                  <span className={`swatch seg-${g}`} aria-hidden="true" />
                  <span>
                    {GRADE_TEXT[g]} {counts[g]}
                  </span>
                </span>
              ),
            )
          ) : (
            <span className="muted small">未定档</span>
          )}
        </span>
      )}
    </div>
  );
}

// ---- RouteChip ----
export function RouteChip({
  entry,
  exit,
  withFlags = false,
}: {
  entry?: string | null;
  exit?: string | null;
  withFlags?: boolean;
}) {
  if (!entry && !exit) return <span className="faint">—</span>;
  const fmt = (c?: string | null) =>
    c ? (withFlags ? `${countryFlag(c)} ${c}` : c) : "?";
  if (entry === exit) {
    return (
      <span className="route-chip">
        <span className="route-code route-to">{fmt(exit)}</span>
      </span>
    );
  }
  return (
    <span className="route-chip">
      <span className="route-code route-from">{fmt(entry)}</span>
      <span className="route-arrow" aria-label="到">
        →
      </span>
      <span className="route-code route-to">{fmt(exit)}</span>
    </span>
  );
}

// ---- SourcePathCrumbs ----
export function SourcePathCrumbs({
  chain,
  current = false,
}: {
  chain: SourceChainItem[];
  current?: boolean;
}) {
  return (
    <ol className="source-path" aria-label="来源路径">
      {chain.map((item, idx) => {
        const isLast = current && idx === chain.length - 1;
        const roleLabel =
          idx === 0 && !item.parent_source_id ? "根来源" : isLast ? "当前来源" : "来源";
        return (
          <li key={`${item.id}-${idx}`}>
            <span className="muted tiny">{roleLabel}</span>
            {isLast ? (
              <strong aria-current="page">{item.name}</strong>
            ) : (
              <a
                href={sourceHref(
                  item.id,
                  item.effective_kind === "SUBSTORE" ? "children" : null,
                )}
              >
                {item.name}
              </a>
            )}
            {item.deleted_at && <span className="tag">已删除</span>}
          </li>
        );
      })}
    </ol>
  );
}

// ---- Modal ----
export function Modal({
  title,
  onClose,
  wide = false,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  wide?: boolean;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  useBodyScrollLock(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`modal-card${wide ? " modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-header">
          <h2>{title}</h2>
          <button type="button" className="btn-icon" aria-label="关闭" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

// ---- Drawer ----
export function Drawer({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  useBodyScrollLock(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="drawer-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside className="drawer-panel" role="dialog" aria-modal="true" aria-label={title}>
        <div className="drawer-header">
          <h2>{title}</h2>
          <button type="button" className="btn-icon" aria-label="关闭" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-footer">{footer}</div>}
      </aside>
    </div>
  );
}

// ---- EmptyState ----
export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon" aria-hidden="true">
        <Inbox size={24} />
      </div>
      <p className="empty-title">{title}</p>
      {hint && <p className="empty-hint">{hint}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

// ---- ErrorState ----
export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="empty-state" role="alert">
      <div className="empty-icon is-error" aria-hidden="true">
        <AlertTriangle size={24} />
      </div>
      <p className="empty-title">加载失败</p>
      <p className="empty-hint">{message}</p>
      {onRetry && (
        <div className="empty-action">
          <button type="button" className="btn" onClick={onRetry}>
            <RefreshCw size={14} />
            重新加载
          </button>
        </div>
      )}
    </div>
  );
}

// ---- Skeleton ----
export function SkeletonBlock({ lines = 3 }: { lines?: number }) {
  return (
    <div className="skeleton-stack" aria-busy="true" aria-label="正在加载">
      {Array.from({ length: lines }).map((_, idx) => (
        <div
          key={idx}
          className={`skeleton-line${idx === 0 ? " w-40" : idx === lines - 1 ? " w-70" : ""}`}
        />
      ))}
    </div>
  );
}

// ---- CopyLinkButton ----
export function CopyPageLinkButton({ href }: { href: string }) {
  const { toast } = useApp();
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const url = new URL(href, window.location.href).href;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast("已复制详情链接。", "ok");
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setFallbackUrl(url);
    }
  };

  return (
    <>
      <button type="button" className="btn" onClick={handleCopy}>
        {copied ? <Check size={14} /> : <Link2 size={14} />}
        {copied ? "已复制" : "复制详情链接"}
      </button>
      {fallbackUrl && (
        <Modal title="详情链接" onClose={() => setFallbackUrl(null)}>
          <div className="stack">
            <input
              type="text"
              readOnly
              className="input mono"
              value={fallbackUrl}
              aria-label="详情链接"
              onFocus={(e) => e.currentTarget.select()}
              autoFocus
            />
          </div>
        </Modal>
      )}
    </>
  );
}

// ---- CopyTextButton ----
export function CopyTextButton({
  text,
  label = "复制链接",
  primary = true,
}: {
  text: string;
  label?: string;
  primary?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const { toast } = useApp();

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast("已复制到剪贴板。", "ok");
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast("复制失败，请手动选中复制。", "bad");
    }
  };

  return (
    <button
      type="button"
      className={primary ? "btn btn-primary" : "btn"}
      onClick={onCopy}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {copied ? "已复制" : label}
    </button>
  );
}

// ---- SubTabs (Link navigation tabs) ----
export function SubTabs({
  label,
  items,
  current,
}: {
  label: string;
  items: Array<{ key: string; text: string; href: string; count?: number }>;
  current: string;
}) {
  return (
    <nav className="subtabs" aria-label={label}>
      {items.map((item) => (
        <a
          key={item.key}
          href={item.href}
          className={`subtab${item.key === current ? " is-active" : ""}`}
          aria-current={item.key === current ? "page" : undefined}
        >
          <span>{item.text}</span>
          {item.count !== undefined && <span className="subtab-count">{item.count}</span>}
        </a>
      ))}
    </nav>
  );
}

// ---- Pagination ----
export function Pagination({
  page,
  pages,
  onPage,
}: {
  page: number;
  pages: number;
  onPage: (target: number) => void;
}) {
  if (pages <= 1) return null;
  const wanted = new Set(
    [0, pages - 1, page - 1, page, page + 1].filter((p) => p >= 0 && p < pages),
  );
  const list = [...wanted].sort((a, b) => a - b);

  return (
    <nav className="pagination" aria-label="分页">
      <button
        type="button"
        className="page-btn"
        disabled={page === 0}
        aria-label="上一页"
        onClick={() => onPage(page - 1)}
      >
        ‹
      </button>
      {list.map((p, idx) => (
        <React.Fragment key={p}>
          {idx > 0 && p - list[idx - 1] > 1 && <span className="page-gap">…</span>}
          <button
            type="button"
            className={`page-btn${p === page ? " is-current" : ""}`}
            aria-current={p === page ? "page" : undefined}
            onClick={() => onPage(p)}
          >
            {p + 1}
          </button>
        </React.Fragment>
      ))}
      <button
        type="button"
        className="page-btn"
        disabled={page >= pages - 1}
        aria-label="下一页"
        onClick={() => onPage(page + 1)}
      >
        ›
      </button>
    </nav>
  );
}
