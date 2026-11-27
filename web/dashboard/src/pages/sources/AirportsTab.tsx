import React, { useMemo, useState } from "react";
import { ChevronDown, ExternalLink } from "lucide-react";
import { api, useApiQuery } from "../../api/client";
import {
  EmptyState,
  ErrorState,
  MeterBar,
  Modal,
  SearchField,
  SkeletonBlock,
  StatusBadge,
} from "../../components/ui";
import { errorText } from "../../lib/errors";
import {
  daysUntil,
  formatBytes,
  formatDate,
  formatNumber,
  type Tone,
} from "../../lib/format";
import { sourceHref, type PageName } from "../../lib/router";
import { useApp } from "../../state/AppContext";
import type { AirportSource, AirportsResponse, ProviderItem } from "../../types/api";
import { EditSourceModal, SourceLinkModal } from "./SourceModals";

type AirportStateKey = "ok" | "low" | "soon" | "exhausted" | "expired" | "paused";

const AIRPORT_STATES: Record<AirportStateKey, [string, Tone]> = {
  ok: ["可用", "ok"],
  low: ["即将用尽", "warn"],
  soon: ["即将到期", "warn"],
  exhausted: ["流量用完", "bad"],
  expired: ["已过期", "bad"],
  paused: ["已暂停", "mute"],
};

const AIRPORT_SORTS: ReadonlyArray<[string, string]> = [
  ["up:desc", "可用节点 多→少"],
  ["remaining:asc", "剩余流量 少→多"],
  ["remaining:desc", "剩余流量 多→少"],
  ["expiry:asc", "到期时间 近→远"],
  ["name:asc", "名称"],
];

interface EnrichedAirport extends AirportSource {
  used: number;
  total: number | null;
  remaining: number | null;
  days: number | null;
  state: AirportStateKey;
}

function enrichAirport(s: AirportSource): EnrichedAirport {
  const used = Number(s.traffic_upload || 0) + Number(s.traffic_download || 0);
  const total = s.traffic_total == null ? null : Number(s.traffic_total);
  const remaining = total ? Math.max(0, total - used) : null;
  const days = daysUntil(s.expires_at);
  const expired = Boolean(s.expires_at && new Date(s.expires_at).getTime() <= Date.now());
  let state: AirportStateKey = "ok";
  if (!s.enabled) state = "paused";
  else if (expired) state = "expired";
  else if (total && used >= total) state = "exhausted";
  else if (days !== null && days <= 7) state = "soon";
  else if (total && remaining !== null && remaining / total < 0.1) state = "low";
  return { ...s, used, total, remaining, days, state };
}

function groupRemainingText(list: EnrichedAirport[]): string {
  const known = list.filter((x) => x.usable && x.remaining != null);
  if (!known.length) return list.some((x) => x.usable) ? "未提供总量" : "已不可用";
  return "剩余 " + formatBytes(known.reduce((sum, x) => sum + (x.remaining || 0), 0));
}

function safeHost(url?: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function AirportsTab({
  params,
  go,
}: {
  params: URLSearchParams;
  go: (name: PageName, params?: URLSearchParams | Record<string, string>) => void;
}) {
  const { toast, fail, confirm, refreshPipeline } = useApp();
  const { data, error, loading, refetch } = useApiQuery<AirportsResponse>("/airports");

  const stateFilter = params.get("state") || "";
  const providerFilter = params.get("provider") || "";
  const sort = params.get("sort") || "up:desc";
  const q = (params.get("q") || "").toLowerCase();

  const [linkTarget, setLinkTarget] = useState<AirportSource | null>(null);
  const [editTarget, setEditTarget] = useState<AirportSource | null>(null);
  const [moveTarget, setMoveTarget] = useState<AirportSource | null>(null);
  const [moveProviderId, setMoveProviderId] = useState("");
  const [newProviderName, setNewProviderName] = useState("");
  const [providerEdit, setProviderEdit] = useState<ProviderItem | null>(null);
  const [providerName, setProviderName] = useState("");
  const [providerWebsite, setProviderWebsite] = useState("");
  const [saving, setSaving] = useState(false);

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    next.set("tab", "airport");
    if (v) next.set(k, v);
    else next.delete(k);
    go("sources", next);
  };

  const reload = () => {
    refetch();
    void refreshPipeline();
  };

  const derived = useMemo(() => {
    if (!data) return null;
    const all = data.sources.map(enrichAirport);
    const usable = all.filter((s) => s.usable);
    const remainingTotal = usable.reduce((sum, s) => sum + (s.remaining || 0), 0);

    const filtered = all.filter(
      (s) =>
        (!stateFilter || (stateFilter === "usable" ? s.usable : s.state === stateFilter)) &&
        (!providerFilter ||
          (providerFilter === "none" ? !s.provider_id : s.provider_id === providerFilter)) &&
        (!q ||
          `${s.name} ${s.origin_label || ""} ${s.parent_name || ""} ${s.url_host || ""} ${s.profile_title || ""}`
            .toLowerCase()
            .includes(q)),
    );

    const [key, direction] = sort.split(":");
    const pickVal = (s: EnrichedAirport): number | string => {
      if (key === "remaining") return s.remaining ?? Infinity;
      if (key === "expiry") return s.expires_at ? new Date(s.expires_at).getTime() : Infinity;
      if (key === "name") return s.profile_title || s.origin_label || s.name;
      return s.up_count;
    };
    filtered.sort((a, b) => {
      const x = pickVal(a);
      const y = pickVal(b);
      return (x < y ? -1 : x > y ? 1 : 0) * (direction === "desc" ? -1 : 1);
    });

    const groups = new Map<string, { provider: ProviderItem | null; items: EnrichedAirport[] }>([
      ...data.providers.map((p): [string, { provider: ProviderItem | null; items: EnrichedAirport[] }] => [
        p.id,
        { provider: p, items: [] },
      ]),
      ["none", { provider: null, items: [] }],
    ]);
    for (const s of filtered) {
      const gid = s.provider_id && groups.has(s.provider_id) ? s.provider_id : "none";
      groups.get(gid)!.items.push(s);
    }

    const upByProvider = new Map(
      (data.provider_counts || []).map((p) => [p.provider_id || "none", p.up_count]),
    );
    const upOf = (provider: ProviderItem | null) => upByProvider.get(provider?.id || "none") || 0;

    const ordered = [...groups.values()]
      .filter((g) => g.items.length > 0)
      .sort(
        (a, b) =>
          Number(b.items.some((x) => x.usable)) - Number(a.items.some((x) => x.usable)) ||
          upOf(b.provider) - upOf(a.provider),
      );

    return { all, usable, remainingTotal, filtered, ordered, upOf };
  }, [data, stateFilter, providerFilter, sort, q]);

  const toggleSource = async (s: EnrichedAirport) => {
    try {
      await api("/sources/batch", {
        method: "POST",
        body: { ids: [s.id], action: s.enabled ? "disable" : "enable" },
      });
      toast(s.enabled ? "已暂停订阅。" : "已启用订阅。", "ok");
      reload();
    } catch (err) {
      fail(err);
    }
  };

  const deleteSource = async (s: EnrichedAirport) => {
    const res = await confirm({
      title: "删除订阅",
      message: `删除「${s.name}」？它的节点将不再检测和导出。`,
      action: "删除",
      danger: true,
    });
    if (!res.confirmed) return;
    try {
      await api("/sources/batch", {
        method: "POST",
        body: { ids: [s.id], action: "delete" },
      });
      toast("已删除订阅。", "ok");
      reload();
    } catch (err) {
      fail(err);
    }
  };

  const submitMove = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!moveTarget || !moveProviderId || saving) return;
    setSaving(true);
    try {
      const body =
        moveProviderId === "new"
          ? { provider_id: "new", provider_name: newProviderName }
          : { provider_id: moveProviderId };
      await api(`/sources/${encodeURIComponent(moveTarget.id)}`, { method: "PATCH", body });
      toast("已移动到目标机场分组。", "ok");
      setMoveTarget(null);
      reload();
    } catch (err) {
      fail(err);
    } finally {
      setSaving(false);
    }
  };

  const submitProvider = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!providerEdit || saving) return;
    setSaving(true);
    try {
      await api(`/providers/${encodeURIComponent(providerEdit.id)}`, {
        method: "PATCH",
        body: { name: providerName, website: providerWebsite || null },
      });
      toast("已更新机场信息。", "ok");
      setProviderEdit(null);
      reload();
    } catch (err) {
      fail(err);
    } finally {
      setSaving(false);
    }
  };

  if (loading && !data) {
    return (
      <section className="card">
        <SkeletonBlock lines={6} />
      </section>
    );
  }

  if (error || !derived || !data) {
    return (
      <section className="card">
        <ErrorState message={errorText(error?.code || "OPERATION_FAILED")} onRetry={refetch} />
      </section>
    );
  }

  const openByDefault = derived.ordered.length <= 6 || Boolean(q || stateFilter || providerFilter);

  return (
    <div className="stack">
      {/* KPI Stats */}
      <dl className="stat-strip">
        <div>
          <dt>可用订阅</dt>
          <dd>
            {formatNumber(derived.usable.length)} / {formatNumber(derived.all.length)}
          </dd>
        </div>
        <div>
          <dt>可用剩余流量</dt>
          <dd>{formatBytes(derived.remainingTotal)}</dd>
        </div>
        <div>
          <dt>7 天内到期</dt>
          <dd>{formatNumber(derived.all.filter((s) => s.state === "soon").length)}</dd>
        </div>
        <div>
          <dt>已过期或用完</dt>
          <dd>
            {formatNumber(
              derived.all.filter((s) => s.state === "expired" || s.state === "exhausted").length,
            )}
          </dd>
        </div>
      </dl>

      {/* Filters */}
      <div className="control-panel">
        <div className="toolbar">
          <SearchField
            value={params.get("q") || ""}
            onCommit={(v) => setParam("q", v)}
            placeholder="搜索订阅或机场…"
            ariaLabel="搜索机场订阅"
            hotkey
          />

          <select
            className="select"
            aria-label="机场订阅状态"
            value={stateFilter}
            onChange={(e) => setParam("state", e.target.value)}
          >
            <option value="">全部状态</option>
            <option value="usable">仍可使用</option>
            {Object.entries(AIRPORT_STATES).map(([k, [label]]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>

          <select
            className="select"
            aria-label="机场分组"
            value={providerFilter}
            onChange={(e) => setParam("provider", e.target.value)}
          >
            <option value="">全部机场</option>
            {data.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value="none">未分组</option>
          </select>

          <select
            className="select"
            aria-label="机场排序"
            value={sort}
            onChange={(e) => setParam("sort", e.target.value)}
          >
            {AIRPORT_SORTS.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <p className="hint">
        过期、流量用完或暂停的订阅，其节点不会参与检测和导出。同一机场的多条订阅会按官网或名称自动归组，也可以手动移动。
      </p>

      {/* Provider Groups */}
      {derived.ordered.length === 0 ? (
        <div className="card">
          {derived.all.length > 0 ? (
            <EmptyState title="没有符合条件的订阅" hint="请调整上方筛选条件。" />
          ) : (
            <EmptyState
              title="还没有机场订阅"
              hint="在“全部来源”添加订阅链接并同步；响应里带流量信息的订阅会自动出现在这里。"
            />
          )}
        </div>
      ) : (
        <div className="stack">
          {derived.ordered.map(({ provider, items }) => {
            const problems = items.filter((x) =>
              ["expired", "exhausted", "soon", "low"].includes(x.state),
            ).length;
            const host = safeHost(provider?.website);

            return (
              <details
                key={provider?.id || "none"}
                className="card airport-group"
                open={openByDefault}
              >
                <summary className="airport-group-head">
                  <ChevronDown size={15} className="group-chevron" aria-hidden="true" />
                  <h2 className="airport-group-name">{provider ? provider.name : "未分组"}</h2>
                  <span className="muted small">
                    {items.filter((x) => x.usable).length}/{items.length} 条可用 ·{" "}
                    {groupRemainingText(items)} · 组内 {formatNumber(derived.upOf(provider))} 个可用节点
                  </span>
                  {problems > 0 && (
                    <span className="badge badge-warn">{problems} 条需注意</span>
                  )}
                </summary>

                <div className="airport-group-body">
                  {provider && (
                    <div className="airport-provider-bar">
                      {provider.website && host && (
                        <a
                          href={provider.website}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="inline-link small"
                        >
                          {host}
                          <ExternalLink size={12} />
                        </a>
                      )}
                      <button
                        type="button"
                        className="btn btn-quiet btn-sm"
                        onClick={() => {
                          setProviderEdit(provider);
                          setProviderName(provider.name);
                          setProviderWebsite(provider.website || "");
                        }}
                      >
                        编辑机场
                      </button>
                    </div>
                  )}

                  <ul className="airport-list">
                    {items.map((s) => {
                      const [stateLabel, stateTone] = AIRPORT_STATES[s.state];
                      const ratio = s.total ? s.used / s.total : 0;
                      const meterTone = ratio >= 1 ? "bad" : ratio >= 0.9 ? "warn" : "ok";
                      const expText = !s.expires_at
                        ? s.userinfo_at
                          ? "长期"
                          : "—"
                        : s.state === "expired"
                          ? s.days !== null && s.days < 0
                            ? `已过期 ${-s.days} 天`
                            : "今天已过期"
                          : s.days === 0
                            ? "今天到期"
                            : `剩 ${s.days} 天`;

                      return (
                        <li
                          key={s.id}
                          className={`airport-row${s.state !== "ok" ? ` is-${s.state}` : ""}`}
                        >
                          <div className="cell-stack">
                            <a href={sourceHref(s.id)} className="row-title" title={s.name}>
                              {s.profile_title || s.origin_label || s.name}
                            </a>
                            <span className="muted tiny">
                              {s.parent_source_id ? (
                                <a
                                  href={sourceHref(s.parent_source_id, "children")}
                                  className="muted-link"
                                >
                                  上级来源 {s.parent_name || "查看记录"}
                                </a>
                              ) : (
                                "直接导入"
                              )}
                              {s.url_host ? ` · ${s.url_host}` : ""}
                            </span>
                          </div>

                          <div>
                            <StatusBadge label={stateLabel} tone={stateTone} />
                          </div>

                          <div className="airport-gauge">
                            {s.total ? (
                              <>
                                <MeterBar
                                  ratio={ratio}
                                  tone={meterTone}
                                  label={`已用 ${(ratio * 100).toFixed(0)}%`}
                                />
                                <span className="tiny">
                                  <strong>{formatBytes(s.remaining)}</strong> 剩余 / 共{" "}
                                  {formatBytes(s.total)}
                                </span>
                              </>
                            ) : (
                              <span
                                className="muted tiny"
                                title="订阅返回的总流量为 0 或缺失，按不限量处理"
                              >
                                {s.userinfo_at
                                  ? s.used
                                    ? `已用 ${formatBytes(s.used)} · 未提供总量`
                                    : "未提供总量（按不限量）"
                                  : "未获取流量信息"}
                              </span>
                            )}
                          </div>

                          <div className="cell-stack">
                            <span
                              className={
                                s.state === "expired"
                                  ? "bad-text small"
                                  : s.days !== null && s.days <= 7
                                    ? "warn-text small"
                                    : "small"
                              }
                            >
                              {expText}
                            </span>
                            {s.expires_at && (
                              <span className="muted tiny">{formatDate(s.expires_at)}</span>
                            )}
                          </div>

                          <div className="cell-stack">
                            <a href={sourceHref(s.id, "current")} className="small strong">
                              {formatNumber(s.up_count)} 可用
                            </a>
                            <a href={sourceHref(s.id, "history")} className="tiny muted-link">
                              {formatNumber(s.node_count)} 全部关联
                            </a>
                            {(s.stale_up_count || 0) > 0 && (
                              <a href={sourceHref(s.id, "stale")} className="tiny muted-link">
                                {formatNumber(s.stale_up_count)} 已过期
                              </a>
                            )}
                          </div>

                          <div className="cell-stack">
                            <StatusBadge status={s.last_sync_status} />
                            {s.last_error_code && (
                              <span className="tiny bad-text">{errorText(s.last_error_code)}</span>
                            )}
                          </div>

                          <div className="row-actions">
                            <button
                              type="button"
                              className="btn btn-quiet btn-sm"
                              onClick={() => setLinkTarget(s)}
                            >
                              链接
                            </button>
                            <button
                              type="button"
                              className="btn btn-quiet btn-sm"
                              onClick={() => {
                                setMoveTarget(s);
                                setMoveProviderId("");
                                setNewProviderName("");
                              }}
                            >
                              移动
                            </button>
                            <button
                              type="button"
                              className="btn btn-quiet btn-sm"
                              onClick={() => setEditTarget(s)}
                            >
                              编辑
                            </button>
                            <button
                              type="button"
                              className="btn btn-quiet btn-sm"
                              onClick={() => void toggleSource(s)}
                            >
                              {s.enabled ? "暂停" : "启用"}
                            </button>
                            <button
                              type="button"
                              className="btn btn-quiet btn-sm bad-text"
                              onClick={() => void deleteSource(s)}
                            >
                              删除
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </details>
            );
          })}
        </div>
      )}

      {/* Modals */}
      {linkTarget && (
        <SourceLinkModal source={linkTarget} onClose={() => setLinkTarget(null)} />
      )}
      {editTarget && (
        <EditSourceModal
          source={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={reload}
        />
      )}
      {moveTarget && (
        <Modal title={`移动「${moveTarget.name}」`} onClose={() => setMoveTarget(null)}>
          <form className="stack" onSubmit={submitMove}>
            <label className="field">
              <span className="field-label">移到机场</span>
              <select
                className="select"
                required
                value={moveProviderId}
                onChange={(e) => setMoveProviderId(e.target.value)}
              >
                <option value="">— 选择 —</option>
                {data.providers
                  .filter((p) => p.id !== moveTarget.provider_id)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                <option value="new">新建机场…</option>
              </select>
            </label>
            {moveProviderId === "new" && (
              <label className="field">
                <span className="field-label">新机场名称</span>
                <input
                  className="input"
                  required
                  maxLength={80}
                  value={newProviderName}
                  onChange={(e) => setNewProviderName(e.target.value)}
                />
              </label>
            )}
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setMoveTarget(null)}>
                取消
              </button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? "移动中…" : "移动"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {providerEdit && (
        <Modal title="编辑机场" onClose={() => setProviderEdit(null)}>
          <form className="stack" onSubmit={submitProvider}>
            <label className="field">
              <span className="field-label">名称</span>
              <input
                className="input"
                required
                maxLength={80}
                value={providerName}
                onChange={(e) => setProviderName(e.target.value)}
              />
            </label>
            <label className="field">
              <span className="field-label">官网</span>
              <input
                className="input"
                type="url"
                placeholder="https://"
                value={providerWebsite}
                onChange={(e) => setProviderWebsite(e.target.value)}
              />
            </label>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setProviderEdit(null)}>
                取消
              </button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? "保存中…" : "保存"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
