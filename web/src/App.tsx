import { lazy, Suspense, useEffect } from "react";
import { EyeOff, RefreshCw, ShieldAlert, WifiOff } from "lucide-react";
import { AppShell } from "./components/AppShell";
import { PageLoading } from "./components/Feedback";
import { useApp } from "./store";
import { cn } from "./lib/utils";
import type { ModuleFlags } from "./types";

const OverviewPage = lazy(() => import("./pages/OverviewPage"));
const TasksPage = lazy(() => import("./pages/TaskOverviewPage"));
const InsightsPage = lazy(() => import("./pages/InsightsPage"));
const CalendarPage = lazy(() => import("./pages/CalendarPage"));
const RedBlackPage = lazy(() => import("./pages/RedBlackPage"));
const LinksPage = lazy(() => import("./pages/LinksPage"));
const MatrixPage = lazy(() => import("./pages/MatrixPage"));
const AnnouncementsPage = lazy(() => import("./pages/AnnouncementsPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const LoginPage = lazy(() => import("./pages/LoginPage"));

const PAGE_MODULES: Record<string, keyof ModuleFlags> = {
  overview: "overview",
  tasks: "tasks",
  insights: "insights",
  calendar: "calendar",
  redblack: "redblack",
  links: "links",
  matrix: "matrix",
  announcements: "announcements",
  settings: "settings",
};

const PAGES: Record<string, React.LazyExoticComponent<() => React.JSX.Element | null>> = {
  overview: OverviewPage,
  tasks: TasksPage,
  insights: InsightsPage,
  calendar: CalendarPage,
  redblack: RedBlackPage,
  links: LinksPage,
  matrix: MatrixPage,
  announcements: AnnouncementsPage,
  settings: SettingsPage,
  login: LoginPage,
};

function ErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="state-screen">
      <div className="state-card">
        <span className="state-icon danger">
          <WifiOff size={26} />
        </span>
        <h1>暂时无法打开团队工作室</h1>
        <p>{message}</p>
        <div className="state-actions">
          <button className="btn btn-primary" onClick={onRetry}>
            <RefreshCw size={16} /> 重新连接
          </button>
          <a className="btn btn-ghost" href="/api/docs" target="_blank" rel="noreferrer">
            查看 API 状态
          </a>
        </div>
        <small>请确认后端已启动：`.venv\Scripts\python.exe -m uvicorn backend.app.main:app --port 8000`</small>
      </div>
    </div>
  );
}

function AccessDenied() {
  const { navigate, isAdmin } = useApp();
  return (
    <div className="state-screen compact">
      <div className="state-card">
        <span className="state-icon amber">
          <ShieldAlert size={26} />
        </span>
        <h1>{isAdmin ? "模块已隐藏" : "仅管理员可访问"}</h1>
        <p>
          {isAdmin
            ? "该模块目前未在导航中展示。你仍可以通过工作台继续浏览，或在设置中重新开启模块。"
            : "当前身份没有权限进入工作室设置。如需管理权限，请联系团队管理员或使用部署设备的 Admin。"}
        </p>
        <div className="state-actions">
          <button className="btn btn-primary" onClick={() => navigate("overview")}>
            返回团队概览
          </button>
          {isAdmin ? (
            <button className="btn btn-secondary" onClick={() => navigate("settings")}>
              打开设置
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function HiddenModule({ module }: { module: string }) {
  const { navigate, isAdmin } = useApp();
  return (
    <div className="state-screen compact">
      <div className="state-card">
        <span className="state-icon gray">
          <EyeOff size={26} />
        </span>
        <h1>该模块已被隐藏</h1>
        <p>管理员在工作室设置中关闭了「{module}」模块的展示。内容仍然安全保留，重新开启后即可访问。</p>
        <div className="state-actions">
          <button className="btn btn-primary" onClick={() => navigate("overview")}>
            返回团队概览
          </button>
          {isAdmin ? (
            <button className="btn btn-secondary" onClick={() => navigate("settings")}>
              去设置中开启
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function PageFallback() {
  return (
    <div className="page-skeleton">
      <div className="skeleton skeleton-title" />
      <div className="skeleton skeleton-hero" />
      <div className={cn("skeleton-grid")}>
        <div className="skeleton skeleton-card" />
        <div className="skeleton skeleton-card" />
        <div className="skeleton skeleton-card" />
      </div>
    </div>
  );
}

export default function App() {
  const { data, config, loading, error, route, reload, isAdmin } = useApp();

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [route]);

  if (loading && !data) return <PageLoading />;
  if (error && !data) return <ErrorScreen message={error} onRetry={() => void reload()} />;
  if (!data || !config) return <PageLoading />;

  if (route === "login") {
    return (
      <Suspense fallback={<PageLoading />}>
        <LoginPage />
      </Suspense>
    );
  }

  const normalizedRoute = PAGES[route] ? route : "overview";
  const module = PAGE_MODULES[normalizedRoute];
  const moduleHidden = module ? !config.modules[module] : false;
  const requiresAdmin = normalizedRoute === "settings" && !isAdmin;

  let content: React.ReactNode;
  if (requiresAdmin) {
    content = <AccessDenied />;
  } else if (moduleHidden && !isAdmin) {
    content = <HiddenModule module={normalizedRoute} />;
  } else {
    const Component = PAGES[normalizedRoute] ?? OverviewPage;
    content = (
      <Suspense fallback={<PageFallback />}>
        <Component />
      </Suspense>
    );
  }

  return (
    <AppShell>
      {error ? (
        <div className="inline-error">
          <WifiOff size={16} />
          <span>{error}</span>
          <button className="text-button" onClick={() => void reload(true)}>
            重试
          </button>
        </div>
      ) : null}
      {content}
    </AppShell>
  );
}
