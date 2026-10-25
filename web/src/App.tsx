import { lazy, Suspense, useEffect } from "react";
import { EyeOff, LogIn, RefreshCw, ShieldAlert, WifiOff } from "lucide-react";
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
const ProfilePage = lazy(() => import("./pages/ProfilePage"));

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

const PAGE_LABELS: Record<string, string> = {
  overview: "团队概览",
  tasks: "任务总览",
  insights: "数据洞察",
  calendar: "协作日历",
  redblack: "红黑榜",
  links: "常用链接",
  matrix: "责任田矩阵",
  announcements: "公告栏",
  settings: "系统设置",
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
  profile: ProfilePage,
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
            : "当前身份没有权限进入工作室设置。如需管理权限，请联系团队管理员或使用系统内置的 Admin。"}
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
  const label = PAGE_LABELS[module] ?? module;
  return (
    <div className="state-screen compact">
      <div className="state-card">
        <span className="state-icon gray">
          <EyeOff size={26} />
        </span>
        <h1>该模块已被隐藏</h1>
        <p>管理员在工作室设置中关闭了「{label}」模块的展示。内容仍然安全保留，重新开启后即可访问。</p>
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

/** A module the admin did not open up to anonymous guests. */
function GuestModuleBlocked({ module }: { module: string }) {
  const { navigate } = useApp();
  const label = PAGE_LABELS[module] ?? module;
  return (
    <div className="state-screen compact">
      <div className="state-card">
        <span className="state-icon violet">
          <EyeOff size={26} />
        </span>
        <h1>模块未对访客开放</h1>
        <p>
          「{label}」仅对已登录成员开放。访客可以继续浏览其他公开模块，登录后即可查看本模块。
        </p>
        <div className="state-actions">
          <button className="btn btn-primary" onClick={() => navigate("login")}>
            <LogIn size={16} /> 登录 / 注册
          </button>
          <button className="btn btn-secondary" onClick={() => navigate("overview")}>
            返回团队概览
          </button>
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
  const { data, config, loading, error, route, reload, isAdmin, moduleVisible, navigate } = useApp();

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [route]);

  // Round 9: every page belongs to a module, so a hidden module must not stay addressable
  // through the hash. Redirect to the overview when that page is reachable as well —
  // otherwise fall through to the "module hidden" screen instead of looping.
  useEffect(() => {
    if (!data || !config || route === "login" || route === "profile") return;
    const normalized = PAGES[route] ? route : "overview";
    if (normalized === "settings") return;
    const guarded = PAGE_MODULES[normalized];
    if (!guarded) return;
    if (moduleVisible(guarded)) return;
    if (normalized !== "overview" && moduleVisible("overview")) navigate("overview");
  }, [config, data, moduleVisible, navigate, route]);

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
  const isSettingsRoute = normalizedRoute === "settings";
  const teamModuleFlags = data.active.moduleFlags ?? null;
  // Site switches only help telling "not open to guests" apart from "switched off".
  const siteModuleEnabled = module ? Boolean(config.modules[module]) : true;
  const teamModuleOff = Boolean(module && teamModuleFlags && !teamModuleFlags[module]);
  // Round 9: the settings entry is permission-based (super / team admins) and can never be
  // hidden by a module switch — the backend also pins `modules.settings` to true.
  const visible = isSettingsRoute ? true : module ? moduleVisible(module) : true;
  const requiresAdmin = isSettingsRoute && !isAdmin;
  const isGuest = !data.me.authenticated || data.me.source === "guest";

  let content: React.ReactNode;
  if (requiresAdmin) {
    content = <AccessDenied />;
  } else if (!visible) {
    // A guest is blocked by guest switches while the module itself is enabled for the
    // team; otherwise the module was switched off (site level or by the team).
    content =
      isGuest && module && siteModuleEnabled && !teamModuleOff ? (
        <GuestModuleBlocked module={module} />
      ) : (
        <HiddenModule module={normalizedRoute} />
      );
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
