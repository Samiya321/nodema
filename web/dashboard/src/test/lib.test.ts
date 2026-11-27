import { describe, expect, it } from "vitest";
import {
  exportSummaryParts,
  legacyBucketsFromParams,
  seedExportFiltersFromParams,
  sortNodeItems,
} from "../lib/filters";
import {
  classificationLabel,
  countryFlag,
  formatBytes,
  formatMs,
  formatPercent,
  operatorOf,
} from "../lib/format";
import { normalizeRoute, pageHref, readPageParam } from "../lib/router";
import { computeAsnStats } from "../pages/nodes/NodeAsnView";
import { usageProjection } from "../pages/OperationsPage";
import type { NodeListItem } from "../types/api";

describe("format helpers", () => {
  it("formats bytes, percentages, ms, flags, and operator labels", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024 * 250)).toBe("250 MB");
    expect(formatPercent(0.953)).toBe("95.3%");
    expect(formatMs(42.6)).toBe("43 ms");
    expect(countryFlag("JP")).toBe("🇯🇵");
    expect(countryFlag("bad")).toBe("🏳");
    expect(operatorOf({ org_label: "Greencloud", asn_label: "xTom" })).toBe("Greencloud|xTom");
    expect(operatorOf({ asn_label: "Cloudflare" })).toBe("Cloudflare");
    expect(
      classificationLabel({ classification_basis: "MANUAL", node_group: "SELF_HOSTED" }),
    ).toBe("已确认自建");
    expect(
      classificationLabel({ classification_basis: "SHARED_CREDENTIAL", node_group: "AIRPORT" }),
    ).toBe("共享推定");
  });
});

describe("router normalization and legacy aliases", () => {
  it("redirects legacy hash routes while preserving parameters", () => {
    const air = normalizeRoute("airports", new URLSearchParams("state=soon"));
    expect(air.name).toBe("sources");
    expect(air.params.get("tab")).toBe("airport");
    expect(air.params.get("state")).toBe("soon");

    const probes = normalizeRoute("scans", new URLSearchParams("tab=probes"));
    expect(probes.name).toBe("ops");
    expect(probes.params.get("tab")).toBe("probes");

    const usage = normalizeRoute("usage", new URLSearchParams("days=90"));
    expect(usage.name).toBe("ops");
    expect(usage.params.get("tab")).toBe("usage");
    expect(usage.params.get("days")).toBe("90");

    expect(pageHref("nodes", { vantage: "CN", g: "S,A" })).toBe("#/nodes?vantage=CN&g=S%2CA");
    expect(readPageParam(new URLSearchParams("page=3"))).toBe(3);
    expect(readPageParam(new URLSearchParams("page=-5"))).toBe(0);
  });
});

describe("filters, sorting, and export summaries", () => {
  const sampleNodes: NodeListItem[] = [
    {
      id: "1",
      short_id: "N001",
      name: "JP-01",
      protocol: "vless",
      status: "UP",
      enabled: true,
      node_group: "SELF_HOSTED",
      quality_grade: "B",
      quality_score: 70,
      endpoint_verified: false,
      peak_rtt_ms: 85,
      udp: "FAILED",
      exit_asn: 100,
      exit_ip: "1.1.1.1",
      exit_country: "JP",
      avail_7d: 5,
      checked_7d: 7,
    },
    {
      id: "2",
      short_id: "N002",
      name: "SG-01",
      protocol: "trojan",
      status: "UP",
      enabled: true,
      node_group: "SELF_HOSTED",
      quality_grade: "S",
      quality_score: 98,
      endpoint_verified: true,
      peak_rtt_ms: 42,
      udp: "SUCCESS",
      udp_ms: 50,
      exit_asn: 200,
      exit_ip: "2.2.2.2",
      exit_country: "SG",
      exit_ip_type: "RESIDENTIAL",
      avail_7d: 7,
      checked_7d: 7,
    },
    {
      id: "3",
      short_id: "N003",
      name: "US-01",
      protocol: "vmess",
      status: "DOWN",
      enabled: true,
      node_group: "AIRPORT",
      quality_grade: null,
      peak_rtt_ms: null,
      exit_asn: 200,
      exit_ip: "2.2.2.3",
      exit_country: "US",
    },
  ];

  it("sorts nodes by grade and rtt keeping nulls last", () => {
    const byGrade = sortNodeItems(sampleNodes, "grade", "asc");
    expect(byGrade.map((n) => n.id)).toEqual(["2", "1", "3"]);

    const byRttDesc = sortNodeItems(sampleNodes, "rtt", "desc");
    expect(byRttDesc.map((n) => n.id)).toEqual(["1", "2", "3"]);
  });

  it("parses legacy bucket params and seeds export filters", () => {
    expect(legacyBucketsFromParams(new URLSearchParams("min_quality_grade=A"))).toEqual(["S", "A"]);
    expect(legacyBucketsFromParams(new URLSearchParams("unreachable=true"))).toEqual(["D"]);

    const seeded = seedExportFiltersFromParams(
      new URLSearchParams("vantage=CN-CT&g=S,A&udp=true&min_avail_7d=95&tags=主力,备用"),
    );
    expect(seeded.vantage).toBe("CN-CT");
    expect(seeded.quality_buckets).toEqual(["S", "A"]);
    expect(seeded.udp).toBe(true);
    expect(seeded.min_avail_7d).toBeCloseTo(0.95);
    expect(seeded.tags).toEqual(["主力", "备用"]);

    expect(exportSummaryParts(seeded)).toContain("电信 S、A");
    expect(exportSummaryParts(seeded)).toContain("UDP 有回包");
  });

  it("computes ASN statistics strictly from endpoint-verified unique exit IPs", () => {
    const stats = computeAsnStats(sampleNodes);
    const as200 = stats.find((s) => s.asn === 200)!;
    expect(as200.ipCount).toBe(2);
    expect(as200.covered).toBe(1);
    expect(as200.good).toBe(1);
    expect(as200.rtt).toBe(42);
  });
});

describe("Neon transfer projection", () => {
  it("projects daily burn rate and exhaustion date accurately", () => {
    const now = Date.parse("2026-11-20T00:00:00Z");
    const periodEnd = "2026-12-01T00:00:00Z";
    const samples = [
      {
        taken_at: "2026-11-18T00:00:00Z",
        table_bytes: 100,
        database_bytes: 200,
        transfer_bytes: 1_000_000_000,
        transfer_period_end: periodEnd,
      },
      {
        taken_at: "2026-11-20T00:00:00Z",
        table_bytes: 100,
        database_bytes: 200,
        transfer_bytes: 2_000_000_000,
        transfer_period_end: periodEnd,
      },
    ];
    const p = usageProjection(
      samples,
      {
        transfer_bytes: 2_000_000_000,
        transfer_limit_bytes: 5_000_000_000,
        transfer_period_end: periodEnd,
        taken_at: "2026-11-20T00:00:00Z",
      },
      now,
    );
    expect(p).not.toBeNull();
    expect(p!.perDay).toBeCloseTo(500_000_000, -4);
    expect(p!.enough).toBe(false);
  });
});
