import React, { useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw, Save, Search, Sparkles } from "lucide-react";
import { api, invalidateReads, useApiQuery } from "../api/client";
import { ErrorState, SkeletonBlock } from "../components/ui";
import { errorText } from "../lib/errors";
import { formatDate, formatNumber } from "../lib/format";
import { VANTAGES } from "../lib/grades";
import { useApp } from "../state/AppContext";
import { invalidateNodeCaches } from "../state/nodeListStore";
import type {
  AppSettings,
  AsnLabelsResponse,
  GradingBand,
  GradingPolicyData,
  GradingPolicyResponse,
  NamingRules,
  Vantage,
} from "../types/api";

const NAME_TOKENS: ReadonlyArray<[string, string]> = [
  ["{FLAG}", "落地国旗"],
  ["{ROUTE}", "入口->落地，相同时只写一个"],
  ["{OPERATOR}", "IP 归属|ASN，如 Greencloud|xTom；两者相同时只写一个"],
  ["{ASN}", "落地 ASN 简称"],
  ["{ORG}", "落地 IP 归属（org）简称，与 ASN 相同时为空"],
  ["{SEQ}", "落地服务器序号（01、02…），同一落地 IP 共用"],
  ["{VARIANT}", "同服务器多个节点时的协议后缀，如 “ VLESS”"],
  ["{IPTYPE}", "落地 IP 类型：家宽 / 机房 / 移动（ip-api 判断，未知时为空）"],
  ["{ENTRY_FLAG}", "入口国旗"],
  ["{ENTRY_COUNTRY}", "入口地区代码"],
  ["{EXIT_COUNTRY}", "落地地区代码"],
  ["{PROTOCOL}", "协议"],
  ["{SHORT_ID}", "节点编号"],
];

const DEFAULT_TEMPLATE = "{FLAG}{ROUTE}|{OPERATOR} {SEQ}{VARIANT}";
const BAND_NAMES = { S: "优（S）", A: "良（A 起）", B: "中（B 起）" } as const;

type SettingsTab = "schedule" | "naming" | "asn" | "grading";

function ScheduleSection({ settings }: { settings: AppSettings }) {
  const { toast, fail } = useApp();
  const [enabled, setEnabled] = useState(String(settings.daily_scan_enabled));
  const [scope, setScope] = useState(settings.daily_scan_scope);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setEnabled(String(settings.daily_scan_enabled));
    setScope(settings.daily_scan_scope);
  }, [settings]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api("/settings", {
        method: "PUT",
        body: { daily_scan_enabled: enabled === "true", daily_scan_scope: scope },
      });
      toast("已保存定时检测设置。", "ok");
    } catch (err) {
      fail(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>定时检测</h2>
      </div>
      <p className="hint">
        定时任务也会先同步到期的来源。随时可以在顶部控制条手动开始任意范围的检测。
      </p>
      <form className="stack" onSubmit={handleSubmit}>
        <div className="form-grid-2">
          <label className="field">
            <span className="field-label">每日定时检测（北京时间 04:17 左右）</span>
            <select
              className="select"
              value={enabled}
              onChange={(e) => setEnabled(e.target.value)}
            >
              <option value="true">开启</option>
              <option value="false">关闭</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">检测范围</span>
            <select
              className="select"
              value={scope}
              onChange={(e) => setScope(e.target.value as AppSettings["daily_scan_scope"])}
            >
              <option value="SELF_HOSTED">仅自建</option>
              <option value="AIRPORT">仅机场</option>
              <option value="ALL">自建和机场（分开计数，同一批）</option>
            </select>
          </label>
        </div>
        <div className="row-end">
          <button type="submit" className="btn btn-primary" disabled={saving}>
            <Save size={14} />
            {saving ? "保存中…" : "保存设置"}
          </button>
        </div>
      </form>
    </section>
  );
}

function NamingSection({ rules }: { rules: NamingRules }) {
  const { toast, fail } = useApp();
  const [template, setTemplate] = useState(rules.template);
  const [preview, setPreview] = useState<Array<{ name: string }> | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTemplate(rules.template);
  }, [rules.template]);

  const insertToken = (token: string) => {
    const el = inputRef.current;
    if (!el) {
      setTemplate((t) => t + token);
      return;
    }
    const start = el.selectionStart ?? template.length;
    const end = el.selectionEnd ?? template.length;
    const next = template.slice(0, start) + token + template.slice(end);
    setTemplate(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const handlePreview = async () => {
    setPreviewing(true);
    try {
      const names = await api<Array<{ name: string }>>("/naming-rules/preview", {
        method: "POST",
        body: { template },
      });
      setPreview(names);
    } catch (err) {
      fail(err);
    } finally {
      setPreviewing(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api("/naming-rules", { method: "PUT", body: { template } });
      toast("模板已保存，订阅会在下一次生成时使用新名称。", "ok");
    } catch (err) {
      fail(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>节点命名</h2>
      </div>
      <p className="hint">
        之后可加入线路标注等字段；线路类型不会自动推断。例：🇯🇵JP|Greencloud|xTom 01 VLESS。
      </p>
      <form className="stack" onSubmit={handleSave}>
        <label className="field">
          <span className="field-label">命名模板</span>
          <input
            ref={inputRef}
            className="input mono"
            maxLength={200}
            spellCheck={false}
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
          />
          <span className="hint">
            序号按落地服务器（落地 IP）在“落地国家 + 运营商”内递增并保持稳定；同一服务器的多个节点共用序号、用协议区分。
          </span>
        </label>

        <div className="token-chips">
          {NAME_TOKENS.map(([tok, desc]) => (
            <button
              key={tok}
              type="button"
              className="token-chip mono"
              title={desc}
              onClick={() => insertToken(tok)}
            >
              {tok}
            </button>
          ))}
        </div>

        <div className="row-wrap">
          <button
            type="button"
            className="btn"
            disabled={previewing}
            onClick={() => void handlePreview()}
          >
            <Sparkles size={14} />
            {previewing ? "预览中…" : "预览效果"}
          </button>
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => setTemplate(DEFAULT_TEMPLATE)}
          >
            <RotateCcw size={14} />
            恢复默认
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            <Save size={14} />
            {saving ? "保存中…" : "保存模板"}
          </button>
        </div>

        {preview && (
          <div className="preview-box">
            {preview.length === 0 ? (
              <p className="muted small">还没有节点可以预览。</p>
            ) : (
              <ul className="preview-list">
                {preview.map((n, i) => (
                  <li key={i}>{n.name}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </form>
    </section>
  );
}

function AsnLabelsSection({
  data,
  onUpdated,
}: {
  data: AsnLabelsResponse;
  onUpdated: () => void;
}) {
  const { toast, fail } = useApp();
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(20);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [savingAsn, setSavingAsn] = useState<number | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase().replace(/^as/, "");
    return data.observed.filter(
      (o) => !q || `${o.asn} ${o.organization || ""} ${o.label || ""}`.toLowerCase().includes(q),
    );
  }, [data.observed, search]);

  const handleSave = async (asn: number, value: string) => {
    setSavingAsn(asn);
    try {
      if (value.trim()) {
        await api(`/asn-labels/${asn}`, { method: "PUT", body: { label: value } });
      } else {
        await api(`/asn-labels/${asn}`, { method: "DELETE" });
      }
      toast("已更新，节点名称随之刷新。", "ok");
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[asn];
        return next;
      });
      onUpdated();
    } catch (err) {
      fail(err);
    } finally {
      setSavingAsn(null);
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>落地 ASN 简称</h2>
      </div>
      <p className="hint">
        自动从运营商名称提取简称（如 WEBBING HONG KONG LIMITED → Webbing）。不满意可以在这里改，留空恢复自动。按节点数排列。
      </p>

      <div className="search-wrap">
        <Search size={15} className="search-icon" aria-hidden="true" />
        <input
          type="search"
          className="input search-input"
          placeholder="搜索 ASN、运营商或简称…"
          aria-label="搜索 ASN"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {filtered.length === 0 ? (
        <p className="muted small">没有匹配的 ASN</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">ASN</th>
                <th scope="col">运营商名称</th>
                <th scope="col" className="num">
                  节点
                </th>
                <th scope="col">自定义简称</th>
                <th scope="col" className="num">
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, limit).map((o) => {
                const baseline = o.overridden ? o.label : "";
                const currentVal = Object.hasOwn(drafts, o.asn) ? drafts[o.asn] : baseline;
                const dirty = currentVal !== baseline;
                return (
                  <tr key={o.asn}>
                    <td className="mono" data-label="ASN">
                      AS{o.asn}
                    </td>
                    <td data-label="运营商名称">
                      {o.organization || <span className="muted">未知</span>}
                    </td>
                    <td className="num" data-label="节点">
                      {formatNumber(o.nodes)}
                    </td>
                    <td data-label="简称">
                      <input
                        className="input input-sm"
                        aria-label={`AS${o.asn} 简称`}
                        placeholder={o.label}
                        value={currentVal}
                        onChange={(e) =>
                          setDrafts((prev) => ({ ...prev, [o.asn]: e.target.value }))
                        }
                      />
                    </td>
                    <td className="num" data-label="操作">
                      <button
                        type="button"
                        className={dirty ? "btn btn-primary btn-sm" : "btn btn-quiet btn-sm"}
                        disabled={!dirty || savingAsn === o.asn}
                        onClick={() => void handleSave(o.asn, currentVal)}
                      >
                        {savingAsn === o.asn ? "保存中…" : "保存"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {filtered.length > limit && (
        <div>
          <button
            type="button"
            className="btn btn-quiet btn-sm"
            onClick={() => setLimit(Infinity)}
          >
            显示全部 {formatNumber(filtered.length)} 个 ASN
          </button>
        </div>
      )}
    </section>
  );
}

function BandEditorTable({
  prefix,
  bands,
  onChange,
}: {
  prefix: "CN" | "OVERSEAS";
  bands: { S: GradingBand; A: GradingBand; B: GradingBand };
  onChange: (band: "S" | "A" | "B", field: keyof GradingBand, value: string) => void;
}) {
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">档位</th>
            <th scope="col">RTT 至多（ms）</th>
            <th scope="col">丢包至多（%）</th>
            <th scope="col">抖动至多（ms）</th>
            <th scope="col">晚高峰涨幅至多（%）</th>
          </tr>
        </thead>
        <tbody>
          {(["S", "A", "B"] as const).map((band) => (
            <tr key={band}>
              <th scope="row">{BAND_NAMES[band]}</th>
              <td data-label="RTT 至多（ms）">
                <input
                  className="input input-sm num-input"
                  type="number"
                  min={1}
                  step={1}
                  aria-label={`${prefix} ${band} RTT`}
                  value={bands[band].rtt_ms ?? ""}
                  onChange={(e) => onChange(band, "rtt_ms", e.target.value)}
                />
              </td>
              <td data-label="丢包至多（%）">
                <input
                  className="input input-sm num-input"
                  type="number"
                  min={0}
                  step="any"
                  aria-label={`${prefix} ${band} 丢包`}
                  value={bands[band].loss_pct ?? ""}
                  onChange={(e) => onChange(band, "loss_pct", e.target.value)}
                />
              </td>
              <td data-label="抖动至多（ms）">
                <input
                  className="input input-sm num-input"
                  type="number"
                  min={0}
                  step="any"
                  aria-label={`${prefix} ${band} 抖动`}
                  value={bands[band].jitter_ms ?? ""}
                  onChange={(e) => onChange(band, "jitter_ms", e.target.value)}
                />
              </td>
              <td data-label="晚高峰涨幅至多（%）">
                {band === "S" && prefix === "CN" ? (
                  <input
                    className="input input-sm num-input"
                    type="number"
                    min={0}
                    step="any"
                    aria-label="CN S 晚高峰涨幅"
                    value={bands[band].peak_rise_pct ?? ""}
                    onChange={(e) => onChange(band, "peak_rise_pct", e.target.value)}
                  />
                ) : (
                  <span className="faint">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GradingSection({
  data,
  onSaved,
}: {
  data: GradingPolicyResponse;
  onSaved: () => void;
}) {
  const { toast, fail } = useApp();
  const [policy, setPolicy] = useState<GradingPolicyData>(() => structuredClone(data.policy));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setPolicy(structuredClone(data.policy));
  }, [data]);

  const updateBand = (
    region: "CN" | "OVERSEAS",
    band: "S" | "A" | "B",
    field: keyof GradingBand,
    raw: string,
  ) => {
    setPolicy((prev) => {
      const next = structuredClone(prev);
      const target = next.bands[region][band];
      if (raw === "" && (field === "jitter_ms" || field === "peak_rise_pct")) {
        delete target[field];
      } else {
        target[field] = Number(raw);
      }
      return next;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api("/grading-policy", {
        method: "PUT",
        body: { policy, expected_version: data.version },
      });
      invalidateNodeCaches();
      invalidateReads();
      toast("分级规则已保存，下一次测量运行时重新定档。", "ok");
      onSaved();
    } catch (err) {
      fail(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>质量分级规则</h2>
        <span className="meta-pill">v{data.version}</span>
      </div>
      <p className="hint">
        更新于 {formatDate(data.updated_at)}。等级 = 接入档与稳定档中较差的一项；只使用实测数据，不判断线路类型。
      </p>

      <form className="stack" onSubmit={handleSubmit}>
        <div className="form-grid-3">
          <label className="field">
            <span className="field-label">默认视角</span>
            <select
              className="select"
              value={policy.default_vantage}
              onChange={(e) =>
                setPolicy((p) => ({ ...p, default_vantage: e.target.value as Vantage }))
              }
            >
              {VANTAGES.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
            <span className="hint">节点页、总览和新订阅默认按它显示等级</span>
          </label>

          <label className="field">
            <span className="field-label">定档最少检测天数（7 天内）</span>
            <input
              className="input"
              type="number"
              min={1}
              max={7}
              value={policy.min_checked_days}
              onChange={(e) =>
                setPolicy((p) => ({ ...p, min_checked_days: Number(e.target.value) }))
              }
            />
          </label>

          <label className="field">
            <span className="field-label">每家运营商至少探针数</span>
            <input
              className="input"
              type="number"
              min={1}
              max={5}
              value={policy.min_probes}
              onChange={(e) => setPolicy((p) => ({ ...p, min_probes: Number(e.target.value) }))}
            />
            <span className="hint">不足时接入记为样本不足，最高 B</span>
          </label>

          <label className="field">
            <span className="field-label">稳定优（S）7 天可用率至少（%）</span>
            <input
              className="input"
              type="number"
              min={0}
              max={100}
              step="any"
              value={policy.stability_pct.S}
              onChange={(e) =>
                setPolicy((p) => ({
                  ...p,
                  stability_pct: { ...p.stability_pct, S: Number(e.target.value) },
                }))
              }
            />
          </label>

          <label className="field">
            <span className="field-label">稳定良（A）至少（%）</span>
            <input
              className="input"
              type="number"
              min={0}
              max={100}
              step="any"
              value={policy.stability_pct.A}
              onChange={(e) =>
                setPolicy((p) => ({
                  ...p,
                  stability_pct: { ...p.stability_pct, A: Number(e.target.value) },
                }))
              }
            />
          </label>

          <label className="field">
            <span className="field-label">稳定中（B）至少（%）</span>
            <input
              className="input"
              type="number"
              min={0}
              max={100}
              step="any"
              value={policy.stability_pct.B}
              onChange={(e) =>
                setPolicy((p) => ({
                  ...p,
                  stability_pct: { ...p.stability_pct, B: Number(e.target.value) },
                }))
              }
            />
          </label>
        </div>

        <div className="stack-sm">
          <h3>大陆三网接入（晚高峰中位数）</h3>
          <BandEditorTable
            prefix="CN"
            bands={policy.bands.CN}
            onChange={(band, field, val) => updateBand("CN", band, field, val)}
          />
        </div>

        <div className="stack-sm">
          <h3>香港 / 新加坡 / 英国接入（全天中位数）</h3>
          <BandEditorTable
            prefix="OVERSEAS"
            bands={policy.bands.OVERSEAS}
            onChange={(band, field, val) => updateBand("OVERSEAS", band, field, val)}
          />
        </div>

        <label className="check-label">
          <input
            type="checkbox"
            checked={policy.s_requires_clean_exit}
            onChange={(e) =>
              setPolicy((p) => ({ ...p, s_requires_clean_exit: e.target.checked }))
            }
          />
          <span>S 要求落地 IP 没有 ip-api 代理标记</span>
        </label>

        <div className="stack-sm divider-top">
          <h3>接入测量调度</h3>
          <label className="check-label">
            <input
              type="checkbox"
              checked={policy.probe_enabled}
              onChange={(e) => setPolicy((p) => ({ ...p, probe_enabled: e.target.checked }))}
            />
            <span>启用每小时的 Globalping 接入测量</span>
          </label>
          <div className="form-grid-3">
            <label className="field">
              <span className="field-label">晚高峰开始（北京时间）</span>
              <input
                className="input"
                type="time"
                value={policy.peak_start}
                onChange={(e) => setPolicy((p) => ({ ...p, peak_start: e.target.value }))}
              />
            </label>
            <label className="field">
              <span className="field-label">晚高峰结束</span>
              <input
                className="input"
                type="time"
                value={policy.peak_end}
                onChange={(e) => setPolicy((p) => ({ ...p, peak_end: e.target.value }))}
              />
            </label>
            <label className="field">
              <span className="field-label">覆盖范围</span>
              <select
                className="select"
                value={policy.coverage}
                onChange={(e) =>
                  setPolicy((p) => ({
                    ...p,
                    coverage: e.target.value as GradingPolicyData["coverage"],
                  }))
                }
              >
                <option value="ALL">全部可用节点</option>
                <option value="EXPORTS">只覆盖订阅方案里的节点</option>
              </select>
              <span className="hint">额度不够时选后者</span>
            </label>
          </div>
        </div>

        <p className="hint">
          Globalping token 存在 GitHub 仓库 Secret（GLOBALPING_TOKENS，多账户；兼容
          GLOBALPING_TOKEN），不能在这里填写或查看；两者均未配置时使用匿名额度。
        </p>

        <div className="row-end">
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => setPolicy(structuredClone(data.defaults))}
          >
            <RotateCcw size={14} /> 恢复默认值
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            <Save size={14} />
            {saving ? "保存中…" : "保存规则"}
          </button>
        </div>
      </form>
    </section>
  );
}

const SETTINGS_TABS: ReadonlyArray<[SettingsTab, string]> = [
  ["schedule", "定时检测"],
  ["naming", "节点命名"],
  ["asn", "ASN 简称"],
  ["grading", "分级规则"],
];

export function SettingsPage() {
  const [activeTab, setActiveTab] = useState<SettingsTab>("schedule");
  const settingsQ = useApiQuery<AppSettings>("/settings");
  const rulesQ = useApiQuery<NamingRules>("/naming-rules");
  const labelsQ = useApiQuery<AsnLabelsResponse>("/asn-labels");
  const policyQ = useApiQuery<GradingPolicyResponse>("/grading-policy");

  const loading =
    (settingsQ.loading && !settingsQ.data) ||
    (rulesQ.loading && !rulesQ.data) ||
    (labelsQ.loading && !labelsQ.data) ||
    (policyQ.loading && !policyQ.data);
  const err = settingsQ.error || rulesQ.error || labelsQ.error || policyQ.error;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">设置</h1>
          <p className="page-subtitle">定时检测策略、节点命名模板、ASN 别名与质量分级阈值</p>
        </div>
        <div className="segmented" role="tablist" aria-label="设置分组">
          {SETTINGS_TABS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={activeTab === key}
              className={`seg-btn${activeTab === key ? " is-active" : ""}`}
              onClick={() => setActiveTab(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      {loading ? (
        <section className="card">
          <SkeletonBlock lines={6} />
        </section>
      ) : err ? (
        <section className="card">
          <ErrorState
            message={errorText(err.code)}
            onRetry={() => {
              settingsQ.refetch();
              rulesQ.refetch();
              labelsQ.refetch();
              policyQ.refetch();
            }}
          />
        </section>
      ) : (
        <>
          {activeTab === "schedule" && settingsQ.data && (
            <ScheduleSection settings={settingsQ.data} />
          )}
          {activeTab === "naming" && rulesQ.data && <NamingSection rules={rulesQ.data} />}
          {activeTab === "asn" && labelsQ.data && (
            <AsnLabelsSection data={labelsQ.data} onUpdated={labelsQ.refetch} />
          )}
          {activeTab === "grading" && policyQ.data && (
            <GradingSection data={policyQ.data} onSaved={policyQ.refetch} />
          )}
        </>
      )}
    </div>
  );
}
