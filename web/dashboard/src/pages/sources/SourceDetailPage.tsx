import { useState } from "react";
import { ArrowLeft, Pencil } from "lucide-react";
import { api, useApiQuery } from "../../api/client";
import {
  CopyPageLinkButton,
  EmptyState,
  ErrorState,
  Pagination,
  SkeletonBlock,
  SourcePathCrumbs,
  StatusBadge,
  SubTabs,
} from "../../components/ui";
import { errorText } from "../../lib/errors";
import { formatDate, sourceKindText, sourceStateText } from "../../lib/format";
import {
  LINEAGE_PAGE_SIZE,
  nodeHref,
  pageHref,
  readPageParam,
  sourceHref,
  type PageName,
} from "../../lib/router";
import { useApp } from "../../state/AppContext";
import type { SourceItem, SourceLineageResponse } from "../../types/api";
import { EditSourceModal } from "./SourceModals";

const NODE_RELATIONS: ReadonlyArray<[string, string, keyof SourceLineageResponse]> = [
  ["present", "上游仍包含", "present_count"],
  ["current", "当前可用", "up_count"],
  ["stale", "通过但已过期", "stale_up_count"],
  ["history", "全部关联", "node_count"],
];

export function SourceDetailPage({
  params,
  go,
}: {
  params: URLSearchParams;
  go: (name: PageName, params?: URLSearchParams | Record<string, string>) => void;
}) {
  const { fail, refreshPipeline } = useApp();
  const id = params.get("source") || "";
  const pageIndex = readPageParam(params);
  const relationParam = params.get("relation");

  const query = new URLSearchParams({
    offset: String(pageIndex * LINEAGE_PAGE_SIZE),
    limit: String(LINEAGE_PAGE_SIZE),
  });
  if (relationParam) query.set("relation", relationParam);

  const { data, error, loading, refetch } = useApiQuery<SourceLineageResponse>(
    `/sources/${encodeURIComponent(id)}/lineage?${query.toString()}`,
    { cached: false, keepPrevious: false },
  );

  const [editSource, setEditSource] = useState<SourceItem | null>(null);
  const [editLoading, setEditLoading] = useState(false);

  const openEdit = async () => {
    setEditLoading(true);
    try {
      const full = await api<SourceItem>(`/sources/${encodeURIComponent(id)}`);
      setEditSource(full);
    } catch (err) {
      fail(err);
    } finally {
      setEditLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="page">
        <a href="#/sources" className="back-link">
          <ArrowLeft size={15} /> 返回来源列表
        </a>
        <section className="card">
          <SkeletonBlock lines={6} />
        </section>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="page">
        <a href="#/sources" className="back-link">
          <ArrowLeft size={15} /> 返回来源列表
        </a>
        <section className="card">
          <ErrorState message={errorText(error?.code || "OPERATION_FAILED")} onRetry={refetch} />
        </section>
      </div>
    );
  }

  const item = data.chain[data.chain.length - 1];
  const sourceTab =
    item.effective_kind === "SUBSTORE"
      ? "substore"
      : item.effective_kind === "AIRPORT"
        ? "airport"
        : "all";

  const sections: Array<[string, string, keyof SourceLineageResponse]> =
    data.child_count || sourceTab === "substore"
      ? [["children", "直接子来源", "child_count"], ...NODE_RELATIONS]
      : [...NODE_RELATIONS];
  if (data.reference_count || sourceTab === "substore") {
    sections.splice(1, 0, ["references", "引用已有来源", "reference_count"]);
  }

  const isSourceRelation = data.relation === "children" || data.relation === "references";
  const isReference = data.relation === "references";
  const pages = Math.max(1, Math.ceil(data.page.total / LINEAGE_PAGE_SIZE));

  const changePage = (idx: number) => {
    const next = new URLSearchParams(params);
    next.set("relation", data.relation);
    if (idx > 0) next.set("page", String(idx));
    else next.delete("page");
    go("sources", next);
  };

  return (
    <div className="page">
      <a
        className="back-link"
        href={pageHref("sources", sourceTab === "all" ? {} : { tab: sourceTab })}
      >
        <ArrowLeft size={15} />
        <span>返回来源列表</span>
      </a>

      <header className="page-header">
        <div>
          <h1 className="page-title">{item.name}</h1>
        </div>
        <div className="page-actions">
          {!item.deleted_at && (
            <button
              type="button"
              className="btn"
              disabled={editLoading}
              onClick={() => void openEdit()}
            >
              <Pencil size={14} />
              <span>{item.type === "SUBSCRIPTION_URL" ? "编辑或续期" : "编辑来源"}</span>
            </button>
          )}
          <CopyPageLinkButton href={window.location.hash} />
        </div>
      </header>

      <section className="card">
        <div className="card-head">
          <h2>来源路径与详情</h2>
        </div>
        <SourcePathCrumbs chain={data.chain} current />
        <dl className="kv-list">
          <dt>来源类别</dt>
          <dd>{sourceKindText(item)}</dd>
          <dt>来源状态</dt>
          <dd>{sourceStateText(item)}</dd>
          {item.parent_source_id && (
            <>
              <dt>上级索引</dt>
              <dd>
                {item.in_parent == null
                  ? "待确认"
                  : item.in_parent
                    ? "仍包含"
                    : "已移除，保留记录"}
              </dd>
            </>
          )}
          <dt>上游</dt>
          <dd>
            {item.url_host ||
              item.origin_label ||
              (item.type === "RAW_TEXT" ? "录入的节点文本" : "本地输入")}
          </dd>
          {item.provider_id && (
            <>
              <dt>机场分组</dt>
              <dd>
                <a href={pageHref("sources", { tab: "airport", provider: item.provider_id })}>
                  {item.provider_name || "查看分组"}
                </a>
              </dd>
            </>
          )}
          <dt>最近同步</dt>
          <dd className="row-inline">
            <StatusBadge status={item.last_sync_status} />
            <span className="muted small">{formatDate(item.last_checked_at)}</span>
          </dd>
          {item.last_success_at && (
            <>
              <dt>最近成功</dt>
              <dd>{formatDate(item.last_success_at)}</dd>
            </>
          )}
          {item.last_error_code && (
            <>
              <dt>同步问题</dt>
              <dd className="bad-text">{errorText(item.last_error_code)}</dd>
            </>
          )}
        </dl>
      </section>

      {data.references.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2>其他上游引用</h2>
          </div>
          <div className="stack">
            {data.references.map((ref, idx) => (
              <div key={idx} className="stack-xs">
                <SourcePathCrumbs chain={ref.chain} />
                <p className="muted tiny">
                  {ref.label} · {ref.is_present ? "索引仍包含" : "已移除"} · 最近出现{" "}
                  {formatDate(ref.last_seen_at)}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      <SubTabs
        label="来源关联"
        current={data.relation}
        items={sections.map(([key, label, countKey]) => ({
          key,
          text: label,
          count: Number(data[countKey] || 0),
          href: sourceHref(id, key),
        }))}
      />

      {data.page.items.length === 0 ? (
        <div className="card">
          <EmptyState
            title={
              isReference
                ? "还没有收录的引用"
                : isSourceRelation
                  ? "还没有直接子来源"
                  : "此范围无节点"
            }
            hint={
              isSourceRelation && !isReference
                ? "同步上级来源后，这里会列出拆分得到的条目。"
                : undefined
            }
          />
        </div>
      ) : (
        <div className="table-card">
          <div className="table-wrap table-wrap-flush">
            {isSourceRelation ? (
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">{isReference ? "引用的来源" : "子来源"}</th>
                    <th scope="col">类别</th>
                    <th scope="col">状态</th>
                    <th scope="col">上级索引</th>
                    <th scope="col">同步</th>
                    <th scope="col">最近成功</th>
                  </tr>
                </thead>
                <tbody>
                  {data.page.items.map((raw) => {
                    const s = raw as Record<string, unknown>;
                    const presence = isReference ? s.ref_present : s.in_parent;
                    return (
                      <tr key={String(s.id)}>
                        <td data-label="来源">
                          <a
                            href={sourceHref(
                              String(s.id),
                              s.effective_kind === "SUBSTORE" ? "children" : null,
                            )}
                          >
                            {String(s.ref_label || s.origin_label || s.name)}
                          </a>
                        </td>
                        <td data-label="类别">
                          {sourceKindText({ effective_kind: String(s.effective_kind || "") })}
                        </td>
                        <td data-label="状态">
                          {sourceStateText({
                            deleted_at: s.deleted_at as string | null,
                            enabled: Boolean(s.enabled),
                          })}
                        </td>
                        <td data-label="上级索引">
                          {presence == null
                            ? "待确认"
                            : presence
                              ? "仍包含"
                              : "已移除，保留记录"}
                        </td>
                        <td data-label="同步">
                          <StatusBadge status={String(s.last_sync_status || "")} />
                        </td>
                        <td data-label="最近成功">{formatDate(s.last_success_at as string)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">节点</th>
                    <th scope="col">关联</th>
                    <th scope="col">状态</th>
                    <th scope="col">首次收录</th>
                    <th scope="col">最近出现</th>
                  </tr>
                </thead>
                <tbody>
                  {data.page.items.map((raw) => {
                    const n = raw as Record<string, unknown>;
                    return (
                      <tr key={String(n.id)}>
                        <td data-label="节点">
                          <a href={nodeHref(String(n.id))}>
                            {String(n.name || n.short_id)}
                          </a>
                        </td>
                        <td data-label="关联">
                          {n.is_present ? "上游仍包含" : "上游已移除"}
                        </td>
                        <td data-label="状态">
                          {n.enabled ? (
                            <StatusBadge status={String(n.status || "")} />
                          ) : (
                            <span className="muted">已停用</span>
                          )}
                        </td>
                        <td data-label="首次收录">{formatDate(n.first_seen_at as string)}</td>
                        <td data-label="最近出现">{formatDate(n.last_seen_at as string)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          {pages > 1 && (
            <footer className="table-footer">
              <span className="table-range">
                第 {pageIndex + 1} / {pages} 页，共 {data.page.total} 条
              </span>
              <Pagination page={pageIndex} pages={pages} onPage={changePage} />
            </footer>
          )}
        </div>
      )}

      {editSource && (
        <EditSourceModal
          source={editSource}
          onClose={() => setEditSource(null)}
          onSaved={() => {
            refetch();
            void refreshPipeline();
          }}
        />
      )}
    </div>
  );
}
