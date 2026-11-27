import { SubTabs } from "../components/ui";
import { pageHref, type PageName } from "../lib/router";
import { AirportsTab } from "./sources/AirportsTab";
import { SourceDetailPage } from "./sources/SourceDetailPage";
import { SourcesListTab } from "./sources/SourcesListTab";
import { SubStoreTab } from "./sources/SubStoreTab";

const TABS: ReadonlyArray<{ key: "all" | "airport" | "substore"; text: string }> = [
  { key: "all", text: "全部来源" },
  { key: "airport", text: "机场订阅" },
  { key: "substore", text: "Sub-Store" },
];

export function SourcesHubPage({
  params,
  go,
}: {
  params: URLSearchParams;
  go: (name: PageName, params?: URLSearchParams | Record<string, string>) => void;
}) {
  if (params.has("source")) {
    return <SourceDetailPage params={params} go={go} />;
  }

  const rawTab = params.get("tab");
  const activeTab: "all" | "airport" | "substore" =
    rawTab === "airport" || rawTab === "substore" ? rawTab : "all";

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">来源</h1>
          <p className="page-subtitle">管理订阅链接、机场分组与 Sub-Store 上游索引</p>
        </div>
        <SubTabs
          label="来源类别"
          current={activeTab}
          items={TABS.map((t) => ({
            key: t.key,
            text: t.text,
            href: pageHref("sources", t.key === "all" ? {} : { tab: t.key }),
          }))}
        />
      </header>

      {activeTab === "airport" ? (
        <AirportsTab params={params} go={go} />
      ) : activeTab === "substore" ? (
        <SubStoreTab params={params} go={go} />
      ) : (
        <SourcesListTab params={params} go={go} />
      )}
    </div>
  );
}
