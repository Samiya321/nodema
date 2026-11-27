import React, { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Drawer } from "../../components/ui";
import {
  AVAILABLE,
  FILTER_SPEC_MAP,
  FOLDED_FILTER_GROUPS,
  GROUP_OPTIONS,
  PANEL_KEYS,
  PROTOCOLS,
  STATUS_OPTIONS,
} from "../../lib/filters";
import { countryName } from "../../lib/format";
import type { ProviderItem } from "../../types/api";

export function NodeFilterDrawer({
  filters,
  providers,
  countries,
  onApply,
  onClose,
}: {
  filters: Record<string, string>;
  providers: ProviderItem[];
  countries: string[];
  onApply: (changes: Record<string, string>) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const k of PANEL_KEYS) initial[k] = filters[k] || "";
    initial.status = filters.status || AVAILABLE;
    return initial;
  });

  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const [title, keys] of FOLDED_FILTER_GROUPS) {
      init[title] = keys.some((k) => Boolean(filters[k]));
    }
    return init;
  });

  const setVal = (key: string, value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const clearAll = () => {
    const next: Record<string, string> = {};
    for (const k of PANEL_KEYS) next[k] = "";
    next.status = AVAILABLE;
    setDraft(next);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const changes: Record<string, string> = {};
    for (const k of PANEL_KEYS) {
      if (k === "status") {
        changes.status = draft.status === AVAILABLE ? "" : draft.status;
      } else {
        changes[k] = (draft[k] || "").trim();
      }
    }
    onApply(changes);
    onClose();
  };

  return (
    <Drawer
      title="筛选节点"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-quiet" onClick={clearAll}>
            全部清空
          </button>
          <button type="submit" form="node-filter-form" className="btn btn-primary">
            应用筛选
          </button>
        </>
      }
    >
      <form id="node-filter-form" className="drawer-form" onSubmit={handleSubmit}>
        <div className="drawer-section">
          <div className="form-grid-2">
            <label className="field">
              <span className="field-label">状态</span>
              <select
                name="status"
                className="select"
                value={draft.status}
                onChange={(e) => setVal("status", e.target.value)}
              >
                {STATUS_OPTIONS.map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span className="field-label">协议</span>
              <select
                name="protocol"
                className="select"
                value={draft.protocol}
                onChange={(e) => setVal("protocol", e.target.value)}
              >
                <option value="">全部</option>
                {PROTOCOLS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span className="field-label">检测分组</span>
              <select
                name="node_group"
                className="select"
                value={draft.node_group}
                onChange={(e) => setVal("node_group", e.target.value)}
              >
                {GROUP_OPTIONS.map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span className="field-label">机场</span>
              <select
                name="provider_id"
                className="select"
                value={draft.provider_id}
                onChange={(e) => setVal("provider_id", e.target.value)}
              >
                <option value="">全部</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span className="field-label">落地国家</span>
              <select
                name="exit_country"
                className="select"
                value={draft.exit_country}
                onChange={(e) => setVal("exit_country", e.target.value)}
              >
                <option value="">全部</option>
                {countries.map((c) => (
                  <option key={c} value={c}>
                    {countryName(c)} {c}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label
            className="check-label drawer-check"
            title="同一台落地服务器只保留当前视角等级最好的一个节点"
          >
            <input
              type="checkbox"
              name="best_per_server"
              checked={draft.best_per_server === "true"}
              onChange={(e) => setVal("best_per_server", e.target.checked ? "true" : "")}
            />
            <span>每台服务器只看最好的</span>
          </label>
        </div>

        {FOLDED_FILTER_GROUPS.map(([title, keys]) => {
          const activeCount = keys.filter((k) => Boolean(draft[k])).length;
          const isOpen = Boolean(openGroups[title]);
          return (
            <div key={title} className="drawer-fold">
              <button
                type="button"
                className="drawer-fold-trigger"
                aria-expanded={isOpen}
                onClick={() => setOpenGroups((prev) => ({ ...prev, [title]: !isOpen }))}
              >
                <span>{title}</span>
                {activeCount > 0 && <span className="count-pill">{activeCount}</span>}
                <ChevronDown
                  size={15}
                  className={`fold-chevron${isOpen ? " is-open" : ""}`}
                  aria-hidden="true"
                />
              </button>
              {isOpen && (
                <div className="form-grid-2 drawer-fold-body">
                  {keys.map((key) => {
                    const spec = FILTER_SPEC_MAP.get(key);
                    if (!spec) return null;
                    return (
                      <label key={key} className="field">
                        <span className="field-label">{spec.label}</span>
                        {spec.kind === "select" ? (
                          <select
                            name={key}
                            className="select"
                            value={draft[key] || ""}
                            onChange={(e) => setVal(key, e.target.value)}
                          >
                            {spec.options?.map(([v, text]) => (
                              <option key={v} value={v}>
                                {text}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            name={key}
                            className="input"
                            type={spec.kind === "number" ? "number" : "text"}
                            min={spec.kind === "number" ? 0 : undefined}
                            step={spec.kind === "number" ? "any" : undefined}
                            value={draft[key] || ""}
                            onChange={(e) => setVal(key, e.target.value)}
                          />
                        )}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </form>
    </Drawer>
  );
}
