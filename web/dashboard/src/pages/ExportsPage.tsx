import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  History,
  KeyRound,
  Link2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { ApiError, api, readAPI, useApiQuery } from "../api/client";
import {
  CopyPageLinkButton,
  CopyTextButton,
  EmptyState,
  ErrorState,
  Modal,
  Pagination,
  SkeletonBlock,
  StatusBadge,
} from "../components/ui";
import { errorText } from "../lib/errors";
import {
  ADVANCED_FILTERS,
  BOOL_KEYS,
  EXPORT_BASIC_KEYS,
  EXPORT_FILTER_KEYS,
  EXPORT_SORTS,
  PERCENT_KEYS,
  PROTOCOLS,
  exportSummaryParts,
  seedExportFiltersFromParams,
} from "../lib/filters";
import { formatBytes, formatDate, formatNumber, type Tone } from "../lib/format";
import { BUCKET_TEXT, VANTAGES } from "../lib/grades";
import {
  LINEAGE_PAGE_SIZE,
  exportHref,
  nodeHref,
  readPageParam,
  sourceHref,
  type PageName,
} from "../lib/router";
import { useApp } from "../state/AppContext";
import type {
  ExportFilterSpec,
  ExportFormat,
  ExportMembersResponse,
  ExportProfile,
  ExportVersion,
  GradingPolicyResponse,
  ProviderItem,
  QualityBucket,
  Vantage,
} from "../types/api";

const FORMATS: ReadonlyArray<[ExportFormat, string]> = [
  ["mihomo", "Mihomo / Clash Meta"],
  ["singbox", "sing-box"],
  ["uri", "节点链接（URI）"],
  ["json", "JSON 报告"],
  ["csv", "CSV 报告"],
];

const EXPORT_STATES: Record<string, [string, Tone]> = {
  READY: ["可用", "ok"],
  UPDATING: ["更新中", "info"],
  BUILDING: ["生成中", "info"],
  PENDING: ["等待生成", "mute"],
  FAILED: ["生成失败", "bad"],
  REVOKED: ["已撤销", "mute"],
  EXPIRED: ["已过期", "mute"],
};

function SubscriptionLinkModal({
  id,
  token,
  onClose,
}: {
  id: string;
  token: string;
  onClose: () => void;
}) {
  const url = new URL(`/subscriptions/${id}`, window.location.origin);
  url.searchParams.set("token", token);
  const href = url.href;

  return (
    <Modal title="私有订阅链接" onClose={onClose}>
      <div className="stack">
        <p className="hint">
          这是私有链接，请像密码一样保管。首次生成完成前访问会提示稍后重试。
        </p>
        <input
          type="text"
          readOnly
          className="input mono"
          aria-label="私有订阅链接"
          value={href}
          onFocus={(e) => e.currentTarget.select()}
        />
        <div className="row-wrap">
          <CopyTextButton text={href} label="复制订阅链接" />
        </div>
      </div>
    </Modal>
  );
}

function ExportFormModal({
  providers,
  profile,
  fallbackVantage,
  seed,
  onClose,
  onSaved,
}: {
  providers: ProviderItem[];
  profile: ExportProfile | null;
  fallbackVantage: Vantage;
  seed: ExportFilterSpec;
  onClose: () => void;
  onSaved: (result: ExportProfile) => void;
}) {
  const { fail } = useApp();
  const initialSpec = profile?.filter_spec || seed;

  const [name, setName] = useState(profile?.name || "我的订阅");
  const [format, setFormat] = useState<ExportFormat>(profile?.format || "mihomo");
  const [expiry, setExpiry] = useState(profile?.expires_at ? "keep" : "");
  const [nodeGroup, setNodeGroup] = useState<string>(initialSpec.node_group || "");
  const [providerId, setProviderId] = useState<string>(initialSpec.provider_id || "");
  const [exitCountry, setExitCountry] = useState<string>(initialSpec.exit_country || "");
  const [protocol, setProtocol] = useState<string>(initialSpec.protocol || "");
  const [q, setQ] = useState<string>(initialSpec.q || "");
  const [vantage, setVantage] = useState<Vantage>(initialSpec.vantage || fallbackVantage);
  const [minGrade, setMinGrade] = useState<string>(initialSpec.min_quality_grade || "");
  const [buckets, setBuckets] = useState<Set<QualityBucket>>(
    () => new Set(initialSpec.quality_buckets || []),
  );
  const [sourceId, setSourceId] = useState<string>(initialSpec.source_id || "");
  const [bestPerServer, setBestPerServer] = useState<boolean>(Boolean(initialSpec.best_per_server));
  const [sort, setSort] = useState<string>((initialSpec.sort || "quality_grade:asc").split(",")[0]);
  const [limit, setLimit] = useState<string>(
    initialSpec.limit && initialSpec.limit < 100000 ? String(initialSpec.limit) : "",
  );
  const [enabledFilter, setEnabledFilter] = useState<string>(
    initialSpec.enabled == null ? "" : String(initialSpec.enabled),
  );

  // Advanced filter string state
  const extraAdvSpecs = useMemo(
    () => ADVANCED_FILTERS.filter((s) => !(EXPORT_BASIC_KEYS as readonly string[]).includes(s.key)),
    [],
  );

  const [advValues, setAdvValues] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const s of extraAdvSpecs) {
      const val = initialSpec[s.key];
      if (val === undefined || val === null) out[s.key] = "";
      else if (typeof val === "boolean") out[s.key] = String(val);
      else if (PERCENT_KEYS.has(s.key)) out[s.key] = String(Number(val) * 100);
      else if (Array.isArray(val)) out[s.key] = val.join(",");
      else out[s.key] = String(val);
    }
    return out;
  });

  const hasInitialAdv = extraAdvSpecs.some((s) => Object.hasOwn(initialSpec, s.key));

  // Build API filter payload cleanly
  const buildFilters = useCallback((): ExportFilterSpec => {
    // Preserve unknown keys from older API clients when editing
    const preserved: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(initialSpec)) {
      if (!EXPORT_FILTER_KEYS.includes(k) && !["quality_buckets", "sort", "limit"].includes(k)) {
        preserved[k] = v;
      }
    }
    const f: ExportFilterSpec = { ...preserved };
    if (nodeGroup) f.node_group = nodeGroup as "SELF_HOSTED" | "AIRPORT";
    if (providerId) f.provider_id = providerId;
    if (exitCountry.trim()) f.exit_country = exitCountry.trim();
    if (protocol) f.protocol = protocol;
    if (q.trim()) f.q = q.trim();
    if (vantage) f.vantage = vantage;
    if (minGrade) f.min_quality_grade = minGrade as ExportFilterSpec["min_quality_grade"];
    if (buckets.size > 0) f.quality_buckets = [...buckets];
    if (sourceId) f.source_id = sourceId;
    if (bestPerServer) f.best_per_server = true;
    if (enabledFilter === "true" || enabledFilter === "false") {
      f.enabled = enabledFilter === "true";
    }
    for (const s of extraAdvSpecs) {
      const raw = (advValues[s.key] || "").trim();
      if (!raw) continue;
      if (PERCENT_KEYS.has(s.key)) f[s.key] = Number(raw) / 100;
      else if (s.key === "tags")
        f[s.key] = raw
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
      else if (BOOL_KEYS.has(s.key)) f[s.key] = raw === "true";
      else f[s.key] = raw;
    }
    f.sort = sort;
    if (limit.trim()) f.limit = Number(limit);
    return f;
  }, [
    initialSpec,
    nodeGroup,
    providerId,
    exitCountry,
    protocol,
    q,
    vantage,
    minGrade,
    buckets,
    sourceId,
    bestPerServer,
    enabledFilter,
    extraAdvSpecs,
    advValues,
    sort,
    limit,
  ]);

  // Auto-debounced preview so user always sees live matching count and can submit in ONE click!
  const [previewText, setPreviewText] = useState("正在估算节点数…");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const previewSeqRef = useRef(0);

  const runPreview = useCallback(async () => {
    const seq = ++previewSeqRef.current;
    setPreviewBusy(true);
    setPreviewText("正在估算节点数…");
    try {
      const res = await api<{ count: number }>("/exports/preview", {
        method: "POST",
        body: { format, filters: buildFilters() },
      });
      if (seq !== previewSeqRef.current) return;
      setPreviewText(`预计符合条件 ${formatNumber(res.count)} 个节点`);
    } catch (err) {
      if (seq !== previewSeqRef.current) return;
      setPreviewText(errorText(err instanceof ApiError ? err.code : "OPERATION_FAILED"));
    } finally {
      if (seq === previewSeqRef.current) setPreviewBusy(false);
    }
  }, [format, buildFilters]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void runPreview();
    }, 380);
    return () => window.clearTimeout(timer);
  }, [runPreview]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        format,
        filters: buildFilters(),
      };
      if (expiry !== "keep") body.expires_in_hours = expiry ? Number(expiry) : null;
      if (profile) body.expected_revision = profile.request_revision;
      const result = await api<ExportProfile>(
        profile ? `/exports/${encodeURIComponent(profile.id)}` : "/exports",
        { method: profile ? "PATCH" : "POST", body },
      );
      onSaved(result);
    } catch (err) {
      fail(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={profile ? "编辑订阅方案" : "新建订阅方案"} wide onClose={onClose}>
      <form className="stack" onSubmit={handleSubmit}>
        <div className="form-grid-3">
          <label className="field">
            <span className="field-label">方案名称</span>
            <input
              className="input"
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">格式</span>
            <select
              className="select"
              value={format}
              onChange={(e) => setFormat(e.target.value as ExportFormat)}
            >
              {FORMATS.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">链接有效期</span>
            <select className="select" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
              {profile?.expires_at && <option value="keep">保持现有到期时间</option>}
              <option value="">长期有效（可撤销）</option>
              <option value="24">24 小时</option>
              <option value="168">7 天</option>
              <option value="720">30 天</option>
            </select>
          </label>

          <label className="field">
            <span className="field-label">节点类别</span>
            <select
              className="select"
              value={nodeGroup}
              onChange={(e) => setNodeGroup(e.target.value)}
            >
              <option value="">自建与机场</option>
              <option value="SELF_HOSTED">仅自建</option>
              <option value="AIRPORT">仅机场</option>
            </select>
          </label>

          <label className="field">
            <span className="field-label">机场</span>
            <select
              className="select"
              value={providerId}
              onChange={(e) => setProviderId(e.target.value)}
            >
              <option value="">全部机场</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="field-label">落地地区</span>
            <input
              className="input"
              placeholder="如 SG"
              value={exitCountry}
              onChange={(e) => setExitCountry(e.target.value)}
            />
          </label>

          <label className="field">
            <span className="field-label">协议</span>
            <select
              className="select"
              value={protocol}
              onChange={(e) => setProtocol(e.target.value)}
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
            <span className="field-label">搜索匹配</span>
            <input
              className="input"
              placeholder="名称、编号或主机"
              autoComplete="off"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </label>

          <label className="field">
            <span className="field-label">等级视角</span>
            <select
              className="select"
              value={vantage}
              onChange={(e) => setVantage(e.target.value as Vantage)}
            >
              {VANTAGES.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="field-label">等级至少</span>
            <select
              className="select"
              value={minGrade}
              onChange={(e) => setMinGrade(e.target.value)}
            >
              <option value="">不限</option>
              <option value="S">S</option>
              <option value="A">A 及以上</option>
              <option value="B">B 及以上</option>
              <option value="C">C 及以上</option>
            </select>
          </label>

          <label className="field">
            <span className="field-label">排序</span>
            <select className="select" value={sort} onChange={(e) => setSort(e.target.value)}>
              {EXPORT_SORTS.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="field-label">最多节点数</span>
            <input
              className="input"
              type="number"
              min={1}
              max={100000}
              placeholder="留空不限"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
            />
          </label>
        </div>

        <fieldset className="check-box-group">
          <legend>指定等级（留空不限）</legend>
          <div className="check-row-wrap">
            {(Object.entries(BUCKET_TEXT) as Array<[QualityBucket, string]>).map(([key, label]) => (
              <label key={key} className="check-label">
                <input
                  type="checkbox"
                  checked={buckets.has(key)}
                  onChange={(e) => {
                    setBuckets((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(key);
                      else next.delete(key);
                      return next;
                    });
                  }}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {sourceId && (
          <div className="callout callout-info row-between">
            <a href={sourceHref(sourceId)} onClick={onClose}>
              已限定特定上游来源（点此查看）
            </a>
            <button
              type="button"
              className="btn btn-quiet btn-sm"
              onClick={() => setSourceId("")}
            >
              取消来源限定
            </button>
          </div>
        )}

        <label className="check-label">
          <input
            type="checkbox"
            checked={bestPerServer}
            onChange={(e) => setBestPerServer(e.target.checked)}
          />
          <span>每台落地服务器只保留等级最好的一个节点</span>
        </label>

        <details className="nested-details" open={hasInitialAdv}>
          <summary>更多筛选条件</summary>
          <div className="form-grid-3">
            <label className="field">
              <span className="field-label">启用状态</span>
              <select
                className="select"
                value={enabledFilter}
                onChange={(e) => setEnabledFilter(e.target.value)}
              >
                <option value="">不限</option>
                <option value="true">已启用</option>
                <option value="false">已停用</option>
              </select>
            </label>
            {extraAdvSpecs.map((spec) => (
              <label key={spec.key} className="field">
                <span className="field-label">{spec.label}</span>
                {spec.kind === "select" ? (
                  <select
                    className="select"
                    value={advValues[spec.key] || ""}
                    onChange={(e) =>
                      setAdvValues((prev) => ({ ...prev, [spec.key]: e.target.value }))
                    }
                  >
                    {spec.options?.map(([v, text]) => (
                      <option key={v} value={v}>
                        {text}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="input"
                    type={spec.kind === "number" ? "number" : "text"}
                    min={spec.kind === "number" ? 0 : undefined}
                    step={spec.kind === "number" ? "any" : undefined}
                    value={advValues[spec.key] || ""}
                    onChange={(e) =>
                      setAdvValues((prev) => ({ ...prev, [spec.key]: e.target.value }))
                    }
                  />
                )}
              </label>
            ))}
          </div>
        </details>

        <p className="hint">
          订阅包含参与检测、最近检测正常的节点。估算按当前数据，生成时可能跳过格式不兼容的节点。
        </p>

        <div className="export-form-footer">
          <div className="preview-pill" role="status">
            <span>{previewText}</span>
            <button
              type="button"
              className="btn-icon"
              aria-label="刷新估算"
              disabled={previewBusy}
              onClick={() => void runPreview()}
            >
              <RefreshCw size={13} className={previewBusy ? "spin" : undefined} />
            </button>
          </div>
          <div className="row-wrap">
            <button type="button" className="btn" onClick={onClose}>
              取消
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? "保存中…" : profile ? "保存修改" : "创建订阅"}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function ExportDetailView({
  params,
  go,
}: {
  params: URLSearchParams;
  go: (name: PageName, params?: URLSearchParams | Record<string, string>) => void;
}) {
  const id = params.get("subscription") || "";
  const page = readPageParam(params);
  const versionParam = params.get("version");

  const membersQuery = new URLSearchParams({
    limit: String(LINEAGE_PAGE_SIZE),
    offset: String(page * LINEAGE_PAGE_SIZE),
  });
  if (versionParam) membersQuery.set("version", versionParam);

  const profileQ = useApiQuery<ExportProfile>(`/exports/${encodeURIComponent(id)}`, {
    cached: false,
    keepPrevious: false,
  });
  const membersQ = useApiQuery<ExportMembersResponse>(
    `/exports/${encodeURIComponent(id)}/members?${membersQuery.toString()}`,
    { cached: false, keepPrevious: false },
  );

  if (profileQ.loading || membersQ.loading) {
    return (
      <div className="page">
        <a href="#/exports" className="back-link">
          <ArrowLeft size={15} /> 返回导出
        </a>
        <section className="card">
          <SkeletonBlock lines={5} />
        </section>
      </div>
    );
  }

  if (profileQ.error || membersQ.error || !profileQ.data || !membersQ.data) {
    return (
      <div className="page">
        <a href="#/exports" className="back-link">
          <ArrowLeft size={15} /> 返回导出
        </a>
        <section className="card">
          <ErrorState
            message={errorText(profileQ.error?.code || membersQ.error?.code)}
            onRetry={() => {
              profileQ.refetch();
              membersQ.refetch();
            }}
          />
        </section>
      </div>
    );
  }

  const profile = profileQ.data;
  const members = membersQ.data;
  const pages = Math.max(1, Math.ceil(members.total / LINEAGE_PAGE_SIZE));

  return (
    <div className="page">
      <a href="#/exports" className="back-link">
        <ArrowLeft size={15} />
        <span>返回导出</span>
      </a>

      <header className="page-header">
        <div>
          <h1 className="page-title">{profile.name}</h1>
        </div>
        <CopyPageLinkButton href={exportHref(id)} />
      </header>

      <section className="card">
        <div className="card-head">
          <h2>最近一次生成</h2>
        </div>
        {members.version ? (
          <p>
            <strong>v{members.version}</strong> · {formatDate(members.built_at)} ·{" "}
            {formatNumber(members.total)} 个成员
            {!members.serving && <span className="muted"> · 当前未提供下载</span>}
          </p>
        ) : (
          <p className="muted">首次生成完成后可查看成员。</p>
        )}
        <p className="hint">
          点开成员可追到直接来源和上级来源。成员对应最近成品，节点详情显示目前保留的来源记录。
        </p>
      </section>

      {members.changed ? (
        <div className="callout callout-info row-between">
          <span>订阅已生成新版本。</span>
          <a href={exportHref(id)} className="btn btn-sm">
            查看最新成员
          </a>
        </div>
      ) : members.items.length === 0 ? (
        <div className="card">
          <EmptyState title="没有可显示的成员" />
        </div>
      ) : (
        <div className="table-card">
          <div className="table-wrap table-wrap-flush">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">节点</th>
                  <th scope="col">编号</th>
                  <th scope="col">当前状态</th>
                </tr>
              </thead>
              <tbody>
                {members.items.map((n) => (
                  <tr key={n.id}>
                    <td data-label="节点">
                      <a href={nodeHref(n.id)}>{n.name || n.short_id}</a>
                    </td>
                    <td className="mono" data-label="编号">
                      {n.short_id}
                    </td>
                    <td data-label="当前状态">
                      <StatusBadge status={n.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <footer className="table-footer">
              <span className="table-range">
                第 {page + 1} / {pages} 页，共 {formatNumber(members.total)} 个成员
              </span>
              <Pagination
                page={page}
                pages={pages}
                onPage={(idx) => {
                  const next = new URLSearchParams({
                    subscription: id,
                    version: String(members.version),
                  });
                  if (idx > 0) next.set("page", String(idx));
                  go("exports", next);
                }}
              />
            </footer>
          )}
        </div>
      )}
    </div>
  );
}

export function ExportsPage({
  params,
  go,
}: {
  params: URLSearchParams;
  go: (name: PageName, params?: URLSearchParams | Record<string, string>) => void;
}) {
  if (params.has("subscription")) {
    return <ExportDetailView params={params} go={go} />;
  }

  return <ExportsListView params={params} go={go} />;
}

function ExportsListView({
  params,
  go,
}: {
  params: URLSearchParams;
  go: (name: PageName, params?: URLSearchParams | Record<string, string>) => void;
}) {
  const { toast, fail, confirm } = useApp();
  const { data: profiles, error, loading, refetch } = useApiQuery<ExportProfile[]>("/exports");

  const [formState, setFormState] = useState<{
    providers: ProviderItem[];
    profile: ExportProfile | null;
    fallbackVantage: Vantage;
    seed: ExportFilterSpec;
  } | null>(null);
  const [openingForm, setOpeningForm] = useState(false);
  const [linkInfo, setLinkInfo] = useState<{ id: string; token: string } | null>(null);
  const [versionsModal, setVersionsModal] = useState<{
    name: string;
    versions: ExportVersion[];
  } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const openEditor = useCallback(
    async (profileId?: string) => {
      setOpeningForm(true);
      try {
        const [providers, policy, profileData] = await Promise.all([
          readAPI<ProviderItem[]>("/providers"),
          readAPI<GradingPolicyResponse>("/grading-policy").catch(() => null),
          profileId ? api<ExportProfile>(`/exports/${encodeURIComponent(profileId)}`) : null,
        ]);
        const seed = !profileId && params.get("new") === "1" ? seedExportFiltersFromParams(params) : {};
        setFormState({
          providers,
          profile: profileData,
          fallbackVantage: policy?.policy?.default_vantage || "CN",
          seed,
        });
      } catch (err) {
        fail(err);
      } finally {
        setOpeningForm(false);
      }
    },
    [params, fail],
  );

  // Auto-open creation modal when navigated from Nodes page ("用当前筛选创建订阅")
  const openedNewRef = useRef(false);
  useEffect(() => {
    if (params.get("new") === "1" && !openedNewRef.current) {
      openedNewRef.current = true;
      void openEditor();
    } else if (params.get("new") !== "1") {
      openedNewRef.current = false;
    }
  }, [params, openEditor]);

  const showLink = async (id: string) => {
    setBusyId(id);
    try {
      const res = await api<{ id: string; token: string }>(`/exports/${encodeURIComponent(id)}/link`);
      setLinkInfo(res);
    } catch (err) {
      fail(err);
    } finally {
      setBusyId(null);
    }
  };

  const rebuild = async (id: string) => {
    setBusyId(id);
    try {
      await api(`/exports/${encodeURIComponent(id)}/retry`, { method: "POST" });
      toast("已提交重新生成。", "ok");
      refetch();
    } catch (err) {
      fail(err);
    } finally {
      setBusyId(null);
    }
  };

  const rotateToken = async (p: ExportProfile) => {
    const res = await confirm({
      title: "更换密钥",
      message: "旧链接会立即失效，客户端需要更新为新链接。",
      action: "更换",
    });
    if (!res.confirmed) return;
    setBusyId(p.id);
    try {
      const rotated = await api<{ id: string; token: string }>(
        `/exports/${encodeURIComponent(p.id)}/token`,
        { method: "POST" },
      );
      setLinkInfo(rotated);
    } catch (err) {
      fail(err);
    } finally {
      setBusyId(null);
    }
  };

  const showVersions = async (p: ExportProfile) => {
    setBusyId(p.id);
    try {
      const versions = await api<ExportVersion[]>(
        `/exports/${encodeURIComponent(p.id)}/versions`,
      );
      setVersionsModal({ name: p.name, versions });
    } catch (err) {
      fail(err);
    } finally {
      setBusyId(null);
    }
  };

  const revoke = async (p: ExportProfile) => {
    const res = await confirm({
      title: "撤销订阅",
      message: `撤销「${p.name}」？链接会立即失效且无法恢复。`,
      action: "撤销",
      danger: true,
    });
    if (!res.confirmed) return;
    setBusyId(p.id);
    try {
      await api(`/exports/${encodeURIComponent(p.id)}`, { method: "DELETE" });
      toast("已撤销订阅方案。", "ok");
      refetch();
    } catch (err) {
      fail(err);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">导出</h1>
          <p className="page-subtitle">
            按条件预生成 Mihomo / sing-box / URI / JSON / CSV 固定私有订阅链接
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={openingForm}
          onClick={() => void openEditor()}
        >
          <Plus size={15} />
          <span>新建订阅</span>
        </button>
      </header>

      {loading && !profiles ? (
        <section className="card">
          <SkeletonBlock lines={5} />
        </section>
      ) : error && !profiles ? (
        <section className="card">
          <ErrorState message={errorText(error.code)} onRetry={refetch} />
        </section>
      ) : !profiles || profiles.length === 0 ? (
        <section className="card">
          <EmptyState
            title="还没有订阅方案"
            hint="新建一个方案，按等级、类别、地区等条件生成固定的私有订阅链接。"
            action={
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void openEditor()}
              >
                <Plus size={14} /> 新建订阅
              </button>
            }
          />
        </section>
      ) : (
        <div className="table-card">
          <div className="table-wrap table-wrap-flush">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">方案</th>
                  <th scope="col">条件</th>
                  <th scope="col">状态</th>
                  <th scope="col" className="num">
                    节点
                  </th>
                  <th scope="col">最近生成</th>
                  <th scope="col">有效期</th>
                  <th scope="col" className="num">
                    操作
                  </th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((p) => {
                  const active = p.status !== "REVOKED" && p.status !== "EXPIRED";
                  const [stLabel, stTone] = EXPORT_STATES[p.status] || [p.status, "mute"];
                  const parts = exportSummaryParts(p.filter_spec);
                  const isBusy = busyId === p.id;
                  return (
                    <tr key={p.id} className={!active ? "is-dim" : undefined}>
                      <td className="export-name-cell" data-label="方案">
                        <div className="cell-stack">
                          <a href={exportHref(p.id)} className="row-title">
                            {p.name}
                          </a>
                          <span className="muted tiny">
                            {FORMATS.find(([k]) => k === p.format)?.[1] || p.format}
                          </span>
                        </div>
                      </td>
                      <td data-label="条件">
                        <div className="summary-pills">
                          {parts.length > 0 ? (
                            parts.map((part, i) => (
                              <span key={i} className="meta-pill">
                                {part}
                              </span>
                            ))
                          ) : (
                            <span className="muted small">全部可用节点</span>
                          )}
                        </div>
                      </td>
                      <td data-label="状态">
                        <div className="cell-stack">
                          <StatusBadge label={stLabel} tone={stTone} />
                          {p.error_code && (
                            <span className="tiny bad-text">{errorText(p.error_code)}</span>
                          )}
                        </div>
                      </td>
                      <td className="num" data-label="节点">
                        {p.serving
                          ? `${formatNumber(p.node_count)}（${formatBytes(p.payload_bytes)}）`
                          : "—"}
                      </td>
                      <td className="muted small" data-label="最近生成">
                        {p.current_version ? `v${p.current_version} · ${formatDate(p.built_at)}` : "尚未生成"}
                      </td>
                      <td className="muted small" data-label="有效期">
                        {p.expires_at ? formatDate(p.expires_at) : "长期"}
                      </td>
                      <td className="num" data-label="操作">
                        <div className="row-actions">
                          {active && (
                            <>
                              <button
                                type="button"
                                className="btn btn-quiet btn-sm"
                                disabled={isBusy}
                                onClick={() => void showLink(p.id)}
                              >
                                <Link2 size={13} /> 链接
                              </button>
                              <button
                                type="button"
                                className="btn btn-quiet btn-sm"
                                disabled={isBusy}
                                onClick={() => void openEditor(p.id)}
                              >
                                <Pencil size={13} /> 编辑
                              </button>
                              {p.status !== "BUILDING" && (
                                <button
                                  type="button"
                                  className="btn btn-quiet btn-sm"
                                  disabled={isBusy}
                                  onClick={() => void rebuild(p.id)}
                                >
                                  <RefreshCw size={13} /> 重建
                                </button>
                              )}
                              <button
                                type="button"
                                className="btn btn-quiet btn-sm"
                                disabled={isBusy}
                                onClick={() => void rotateToken(p)}
                              >
                                <KeyRound size={13} /> 换密钥
                              </button>
                            </>
                          )}
                          {p.current_version > 0 && (
                            <button
                              type="button"
                              className="btn btn-quiet btn-sm"
                              disabled={isBusy}
                              onClick={() => void showVersions(p)}
                            >
                              <History size={13} /> 版本
                            </button>
                          )}
                          {active && (
                            <button
                              type="button"
                              className="btn btn-quiet btn-sm bad-text"
                              disabled={isBusy}
                              onClick={() => void revoke(p)}
                            >
                              <Trash2 size={13} /> 撤销
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {formState && (
        <ExportFormModal
          providers={formState.providers}
          profile={formState.profile}
          fallbackVantage={formState.fallbackVantage}
          seed={formState.seed}
          onClose={() => {
            setFormState(null);
            if (params.has("new")) go("exports");
          }}
          onSaved={(result) => {
            const wasNew = !formState.profile && params.has("new");
            setFormState(null);
            if (result.token) setLinkInfo({ id: result.id, token: result.token });
            toast(
              result.pipeline?.dispatched ? "已保存，正在生成。" : "已保存，等待下一次生成。",
              "ok",
            );
            if (wasNew) go("exports");
            else refetch();
          }}
        />
      )}

      {linkInfo && (
        <SubscriptionLinkModal
          id={linkInfo.id}
          token={linkInfo.token}
          onClose={() => setLinkInfo(null)}
        />
      )}

      {versionsModal && (
        <Modal
          title={`「${versionsModal.name}」版本记录`}
          onClose={() => setVersionsModal(null)}
        >
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">版本</th>
                  <th scope="col">生成时间</th>
                  <th scope="col" className="num">
                    节点
                  </th>
                  <th scope="col" className="num">
                    大小
                  </th>
                </tr>
              </thead>
              <tbody>
                {versionsModal.versions.map((v) => (
                  <tr key={v.version_no}>
                    <td data-label="版本">v{v.version_no}</td>
                    <td data-label="生成时间">{formatDate(v.created_at)}</td>
                    <td className="num" data-label="节点">
                      {formatNumber(v.node_count)}
                    </td>
                    <td className="num" data-label="大小">
                      {formatBytes(v.payload_bytes)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}
    </div>
  );
}
