import React, { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, invalidateSession } from "./api/client";
import { AppShell } from "./components/AppShell";
import { ErrorState } from "./components/ui";
import { errorText } from "./lib/errors";
import { PAGE_TITLES, useRouter } from "./lib/router";
import { ExportsPage } from "./pages/ExportsPage";
import { LoginPage } from "./pages/LoginPage";
import { NodeDetailPage } from "./pages/NodeDetailPage";
import { NodesPage } from "./pages/NodesPage";
import { OperationsPage } from "./pages/OperationsPage";
import { OverviewPage } from "./pages/OverviewPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SourcesHubPage } from "./pages/SourcesHubPage";
import { AppProvider } from "./state/AppContext";
import { invalidateNodeCaches } from "./state/nodeListStore";
import type { SessionInfo } from "./types/api";

const EXPIRED_MSG = "登录已失效，请重新输入密钥。";

class PageErrorBoundary extends React.Component<
  { resetKey: string; children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidUpdate(prevProps: { resetKey: string }) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="page">
          <section className="card">
            <ErrorState
              message="页面渲染发生意外错误，请尝试重试或切换其他页面。"
              onRetry={() => this.setState({ hasError: false })}
            />
          </section>
        </div>
      );
    }
    return this.props.children;
  }
}

export function App() {
  const { route, go } = useRouter();
  const [authState, setAuthState] = useState<{
    status: "checking" | "authenticated" | "unauthenticated";
    message: string;
    canRetry: boolean;
  }>({ status: "checking", message: "", canRetry: false });
  const [loggingOut, setLoggingOut] = useState(false);

  const expiryTimerRef = useRef<number | undefined>(undefined);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const lastScreenRef = useRef<string>("");

  const enterLoggedOut = useCallback((message = "", canRetry = false) => {
    window.clearTimeout(expiryTimerRef.current);
    invalidateSession();
    invalidateNodeCaches();
    document.title = "Nodema 节点台";
    setAuthState({ status: "unauthenticated", message, canRetry });
  }, []);

  const enterAuthenticated = useCallback(
    (session: SessionInfo) => {
      if (
        session?.authenticated !== true ||
        !Number.isInteger(session.expires_in) ||
        session.expires_in <= 0
      ) {
        enterLoggedOut("无法验证登录会话。", true);
        return;
      }
      window.clearTimeout(expiryTimerRef.current);
      expiryTimerRef.current = window.setTimeout(
        () => enterLoggedOut(EXPIRED_MSG),
        session.expires_in * 1000,
      );
      setAuthState({ status: "authenticated", message: "", canRetry: false });
    },
    [enterLoggedOut],
  );

  const checkSession = useCallback(async () => {
    setAuthState({ status: "checking", message: "", canRetry: false });
    try {
      const session = await api<SessionInfo>("/session");
      enterAuthenticated(session);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        enterLoggedOut();
      } else {
        const code = err instanceof ApiError ? err.code : "OPERATION_FAILED";
        enterLoggedOut("无法检查登录状态。" + errorText(code), true);
      }
    }
  }, [enterAuthenticated, enterLoggedOut]);

  useEffect(() => {
    try {
      sessionStorage.removeItem("nodema.session");
    } catch {
      // storage disabled
    }
    if ("scrollRestoration" in window.history) {
      window.history.scrollRestoration = "manual";
    }
    void checkSession();

    const onExpired = () => enterLoggedOut(EXPIRED_MSG);
    window.addEventListener("nodema:session-expired", onExpired);

    const ch =
      typeof BroadcastChannel === "function" ? new BroadcastChannel("nodema-session") : null;
    channelRef.current = ch;
    const onMessage = (event: MessageEvent) => {
      if (event.data === "logout") enterLoggedOut("已退出，请重新登录。");
    };
    ch?.addEventListener("message", onMessage);

    return () => {
      window.clearTimeout(expiryTimerRef.current);
      window.removeEventListener("nodema:session-expired", onExpired);
      ch?.removeEventListener("message", onMessage);
      ch?.close();
    };
  }, [checkSession, enterLoggedOut]);

  // Update document title and scroll top when switching screens
  useEffect(() => {
    if (authState.status !== "authenticated") return;
    document.title = `${PAGE_TITLES[route.name]} · Nodema`;
    const screen = [
      route.name,
      route.params.get("tab") || "",
      route.params.get("node") || "",
      route.params.get("source") || "",
      route.params.get("subscription") || "",
      route.params.get("scan") || "",
    ].join("/");
    if (lastScreenRef.current && lastScreenRef.current !== screen) {
      // Returning to node list restores its saved scroll inside NodesPage
      const returningToNodeList =
        route.name === "nodes" && !route.params.has("node") && lastScreenRef.current.startsWith("nodes//");
      if (!returningToNodeList) window.scrollTo(0, 0);
    }
    lastScreenRef.current = screen;
  }, [authState.status, route]);

  const handleLogout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await api("/session", { method: "DELETE" });
      channelRef.current?.postMessage("logout");
      enterLoggedOut();
    } catch {
      // Keep user in app and let ApiError / network toast inform if needed
      enterLoggedOut("退出请求失败，已清除本地状态。");
    } finally {
      setLoggingOut(false);
    }
  };

  const renderPage = () => {
    switch (route.name) {
      case "overview":
        return <OverviewPage params={route.params} go={go} />;
      case "nodes":
        return route.params.has("node") ? (
          <NodeDetailPage params={route.params} />
        ) : (
          <NodesPage params={route.params} href={route.href} go={go} />
        );
      case "sources":
        return <SourcesHubPage params={route.params} go={go} />;
      case "exports":
        return <ExportsPage params={route.params} go={go} />;
      case "ops":
        return <OperationsPage params={route.params} go={go} />;
      case "settings":
        return <SettingsPage />;
      default:
        return <OverviewPage params={route.params} go={go} />;
    }
  };

  return (
    <AppProvider authenticated={authState.status === "authenticated"}>
      {authState.status === "authenticated" ? (
        <AppShell currentPage={route.name} onLogout={() => void handleLogout()} loggingOut={loggingOut}>
          <PageErrorBoundary resetKey={route.href}>{renderPage()}</PageErrorBoundary>
        </AppShell>
      ) : (
        <LoginPage
          checking={authState.status === "checking"}
          initialMessage={authState.message}
          canRetry={authState.canRetry}
          onRetryCheck={() => void checkSession()}
          onAuthenticated={enterAuthenticated}
        />
      )}
    </AppProvider>
  );
}
