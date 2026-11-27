import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "../App";
import { invalidateSession } from "../api/client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createMockApi({ authenticated = true }: { authenticated?: boolean } = {}) {
  let authed = authenticated;
  const calls: string[] = [];

  const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method || "GET").toUpperCase();
    calls.push(`${method} ${url}`);

    if (url === "/api/session") {
      if (method === "GET") {
        return authed
          ? jsonResponse({ authenticated: true, expires_in: 28800 })
          : jsonResponse({ error_code: "AUTHENTICATION_REQUIRED" }, 401);
      }
      if (method === "POST") {
        const auth = new Headers(init?.headers).get("Authorization");
        if (auth === "Bearer valid-synthetic-admin-token-123456") {
          authed = true;
          return jsonResponse({ authenticated: true, expires_in: 28800 });
        }
        return jsonResponse({ error_code: "INVALID_ADMIN_TOKEN" }, 401);
      }
      if (method === "DELETE") {
        authed = false;
        return jsonResponse({ ok: true });
      }
    }

    if (!authed) return jsonResponse({ error_code: "AUTHENTICATION_REQUIRED" }, 401);

    if (url.startsWith("/api/pipeline")) {
      return jsonResponse({
        sources_total: 12,
        last_synced_at: new Date().toISOString(),
        pending_sources: 1,
        failed_sources: 2,
        broken_sources: 1,
        active_scans: [],
        requested_scans: [],
        testable: { SELF_HOSTED: 120, AIRPORT: 40 },
      });
    }

    if (url === "/api/overview/status") {
      return jsonResponse({
        observed_at: new Date().toISOString(),
        daily_enabled: true,
        probe_enabled: true,
        last_daily: { id: "scan-1", status: "COMPLETED", scan_date: "2026-11-28" },
        last_complete: { id: "scan-1", finished_at: new Date().toISOString() },
        latest_scan: {
          id: "scan-1",
          scan_date: "2026-11-28",
          kind: "DAILY",
          scope: "SELF_HOSTED",
          status: "COMPLETED",
          done: 120,
          node_count: 120,
        },
        daily_history: [
          { id: "scan-1", scan_date: "2026-11-28", status: "COMPLETED", node_count: 120 },
        ],
        probe: { finished_at: new Date().toISOString(), measurements: 48 },
        host: {
          taken_at: new Date().toISOString(),
          disk_free: 20_000_000_000,
          disk_total: 40_000_000_000,
          mem_available: 1_500_000_000,
          tls_expires_at: "2027-02-01T00:00:00Z",
        },
        sources: { total: 12, roots: 4, children: 8, pending: 1 },
        exports: { active: 2, serving: 2, pending: 0, unavailable: 0 },
      });
    }

    if (url === "/api/overview/recovery") {
      return jsonResponse({
        backup_available: true,
        drill_available: true,
        backup: { created_at: new Date().toISOString() },
        drill: { result: "success", finished_at: new Date().toISOString(), run_id: 999 },
      });
    }

    if (url === "/api/overview/attention") {
      return jsonResponse({
        broken: 1,
        never_worked: 1,
        groups: [],
        airports: [],
      });
    }

    if (url === "/api/overview/catalog") {
      return jsonResponse({
        total: 160,
        statuses: { UP: 95, DEGRADED: 5, DOWN: 60 },
        groups: {
          SELF_HOSTED: { total: 120, eligible: 120, statuses: { UP: 80, DEGRADED: 2, DOWN: 38 } },
          AIRPORT: { total: 40, eligible: 40, statuses: { UP: 15, DEGRADED: 3, DOWN: 22 } },
        },
        countries: { JP: 42, SG: 33, HK: 25 },
      });
    }

    if (url.startsWith("/api/probe-status")) {
      return jsonResponse({
        vantage: "CN",
        grades: { S: 12, A: 28, B: 40, C: 10, D: 5, PENDING: 5 },
        graded_at: new Date().toISOString(),
        coverage_total: 100,
        coverage_measured: 90,
        coverage_endpoint_verified: 45,
        coverage_excluded: 5,
        tests_today: 180,
        tests_7d: 1200,
        prefixes_graded: 80,
        prefixes_peak: 70,
        traces: 35,
        daily: [{ date: "2026-11-28", tests: 180 }],
        runs: [],
      });
    }

    if (url.startsWith("/api/nodes?")) {
      return jsonResponse({
        total: 1,
        vantage: "CN",
        fields: [
          "id",
          "short_id",
          "name",
          "protocol",
          "status",
          "enabled",
          "node_group",
          "classification_basis",
          "quality_grade",
          "quality_score",
          "endpoint_verified",
          "peak_rtt_ms",
          "peak_loss",
          "udp",
          "udp_ms",
          "avail_7d",
          "checked_7d",
          "entry_country",
          "exit_country",
          "exit_asn",
          "asn_label",
          "present_source_count",
          "last_checked_at",
        ],
        items: [
          [
            "node-1",
            "N00001",
            "🇯🇵JP|xTom 01 VLESS",
            "vless",
            "UP",
            true,
            "SELF_HOSTED",
            "UNCONFIRMED",
            "S",
            96,
            true,
            38,
            0,
            "SUCCESS",
            45,
            7,
            7,
            "JP",
            "JP",
            3258,
            "xTom",
            1,
            new Date().toISOString(),
          ],
        ],
        facets: {
          total: 1,
          available: 1,
          exportable: 1,
          udp: 1,
          home: 0,
          buckets: { S: 1, A: 0, B: 0, C: 0, D: 0, PENDING: 0, NONE: 0, OFF: 0 },
          countries: ["JP"],
        },
      });
    }

    if (url === "/api/nodes/node-1?vantage=CN") {
      return jsonResponse({
        id: "node-1",
        short_id: "N00001",
        name: "🇯🇵JP|xTom 01 VLESS",
        protocol: "vless",
        server_host: "jp.example.invalid",
        server_port: 443,
        status: "UP",
        enabled: true,
        eligible: true,
        node_group: "SELF_HOSTED",
        classification_basis: "UNCONFIRMED",
        vantage: "CN",
        quality_grade: "S",
        sources: [],
        exports: [],
        history: [],
      });
    }

    if (url === "/api/nodes/node-1/share") {
      return jsonResponse({
        name: "🇯🇵JP|xTom 01 VLESS",
        uri: "vless://00000000-0000-0000-0000-000000000000@example.invalid:443#JP-01",
        omitted: [],
      });
    }

    if (url === "/api/providers") {
      return jsonResponse([{ id: "prov-1", name: "测试机场" }]);
    }

    if (url === "/api/exports") {
      return jsonResponse([
        {
          id: "exp-1",
          name: "日本主力订阅",
          format: "mihomo",
          status: "READY",
          filter_spec: { exit_country: "JP", vantage: "CN", min_quality_grade: "A" },
          serving: true,
          node_count: 18,
          payload_bytes: 12400,
          current_version: 3,
          built_at: new Date().toISOString(),
          expires_at: null,
        },
      ]);
    }

    if (url === "/api/exports/preview") {
      return jsonResponse({ count: 18 });
    }

    return jsonResponse({ error_code: "NOT_FOUND" }, 404);
  });

  vi.stubGlobal("fetch", mockFetch);
  return { mockFetch, calls };
}

describe("Nodema Dashboard App", () => {
  beforeEach(() => {
    invalidateSession();
    window.location.hash = "#/overview";
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows login form when unauthenticated and logs in with valid key", async () => {
    createMockApi({ authenticated: false });
    render(<App />);

    const input = await screen.findByLabelText("管理员密钥");
    fireEvent.change(input, { target: { value: "wrong-key-of-sufficient-length-123456" } });
    fireEvent.click(screen.getByRole("button", { name: "登录控制台" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("管理员密钥有误");

    fireEvent.change(input, { target: { value: "valid-synthetic-admin-token-123456" } });
    fireEvent.click(screen.getByRole("button", { name: "登录控制台" }));

    expect(await screen.findByRole("heading", { name: "总览" })).toBeInTheDocument();
  });

  it("renders overview metrics and navigates to nodes list and share QR modal", async () => {
    createMockApi({ authenticated: true });
    render(<App />);

    expect(await screen.findByRole("heading", { name: "总览" })).toBeInTheDocument();
    expect(await screen.findByText("当前可用节点")).toBeInTheDocument();
    expect(await screen.findByText("100")).toBeInTheDocument();

    window.location.hash = "#/nodes";
    fireEvent(window, new HashChangeEvent("hashchange"));

    expect(await screen.findByText("🇯🇵JP|xTom 01 VLESS")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /二维码 ·/ }));
    expect(await screen.findByRole("dialog", { name: "节点二维码" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "复制分享链接" })).toBeInTheDocument();
  });

  it("renders exports list and opens creation modal with live preview", async () => {
    createMockApi({ authenticated: true });
    window.location.hash = "#/exports";
    render(<App />);

    expect(await screen.findByText("日本主力订阅")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "新建订阅" }));

    expect(await screen.findByRole("dialog", { name: "新建订阅方案" })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText(/预计符合条件 18 个节点/)).toBeInTheDocument();
    });
  });

  it("preserves filtered node list URL when navigating to node detail", async () => {
    const { calls } = createMockApi({ authenticated: true });
    window.location.hash = "#/nodes?g=S&udp=1";
    render(<App />);

    const link = await screen.findByRole("link", { name: /🇯🇵JP\|xTom 01 VLESS/ });
    expect(calls.filter((c) => c.startsWith("GET /api/nodes?")).length).toBe(1);

    fireEvent.click(link);
    window.location.hash = "#/nodes?node=node-1&vantage=CN";
    fireEvent(window, new HashChangeEvent("hashchange"));

    const backLink = await screen.findByRole("link", { name: "返回节点列表" });
    expect(backLink).toHaveAttribute("href", "#/nodes?g=S&udp=1");
  });
});
