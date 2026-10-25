import { useEffect, useRef, useState } from "react";
import {
  Bell,
  Building2,
  CalendarDays,
  ChartNoAxesColumn,
  Check,
  ChevronDown,
  ChevronsUpDown,
  CircleUserRound,
  Command,
  FolderCog,
  Info,
  LayoutDashboard,
  Link2,
  ListTodo,
  LogIn,
  LogOut,
  Megaphone,
  Menu,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings2,
  ShieldCheck,
  Sparkles,
  Sun,
  Trophy,
  UserRound,
  Waypoints,
  X,
} from "lucide-react";
import { api } from "../api";
import { useApp, type ThemePreference } from "../store";
import { useToast } from "./Toast";
import { Avatar } from "./Avatar";
import { AboutDialog } from "./AboutDialog";
import { WorkspaceManager } from "./WorkspaceManager";
import { cn, formatFullDate } from "../lib/utils";
import type { ModuleFlags } from "../types";
import "./ShellScope.css";

interface NavItem {
  key: string;
  label: string;
  icon: typeof LayoutDashboard;
  module: keyof ModuleFlags;
}

const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "工作台",
    items: [
      { key: "overview", label: "团队概览", icon: LayoutDashboard, module: "overview" },
      { key: "tasks", label: "任务总览", icon: ListTodo, module: "tasks" },
      { key: "insights", label: "数据洞察", icon: ChartNoAxesColumn, module: "insights" },
      { key: "calendar", label: "协作日历", icon: CalendarDays, module: "calendar" },
    ],
  },
  {
    label: "文化与协作",
    items: [
      { key: "redblack", label: "红黑榜", icon: Trophy, module: "redblack" },
      { key: "announcements", label: "公告栏", icon: Megaphone, module: "announcements" },
      { key: "matrix", label: "责任田矩阵", icon: Waypoints, module: "matrix" },
      { key: "links", label: "常用链接", icon: Link2, module: "links" },
    ],
  },
];

const PAGE_LABELS: Record<string, string> = {
  overview: "团队概览",
  tasks: "任务总览",
  insights: "数据洞察",
  calendar: "协作日历",
  redblack: "红黑榜",
  announcements: "公告栏",
  matrix: "责任田矩阵",
  links: "常用链接",
  settings: "系统设置",
  profile: "个人主页",
  login: "登录",
};

const THEME_OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: "auto", label: "跟随系统", icon: Monitor },
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
];

const SIDEBAR_STORAGE = "teamstudio.sidebar.collapsed";

function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_STORAGE) === "1";
  } catch {
    return false;
  }
}

function roleLabel(
  role: string | null | undefined,
  isDevice: boolean,
  isGuest = false,
  isSuper = false,
): string {
  if (isDevice) return "超级管理员";
  if (isGuest) return "访客";
  if (isSuper || role === "super") return "超级管理员";
  if (role === "team_admin") return "团队管理员";
  return "成员";
}

const themePreferenceLabel = (preference: ThemePreference): string =>
  THEME_OPTIONS.find((option) => option.value === preference)?.label ?? "跟随系统";

export function AppShell({ children }: { children: React.ReactNode }) {
  const {
    data,
    config,
    route,
    currentTeam,
    selectTeam,
    theme,
    themePreference,
    setThemePreference,
    moduleVisible,
    isAdmin,
    isSuperAdmin,
    permissions,
    navigate,
  } = useApp();
  const { toast } = useToast();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed);
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(max-width: 960px)").matches : false,
  );
  const [teamMenuOpen, setTeamMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const teamMenuRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const themeMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!teamMenuRef.current?.contains(event.target as Node)) setTeamMenuOpen(false);
      if (!userMenuRef.current?.contains(event.target as Node)) setUserMenuOpen(false);
      if (!themeMenuRef.current?.contains(event.target as Node)) setThemeMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 960px)");
    const onChange = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    setSidebarOpen(false);
    setTeamMenuOpen(false);
    setUserMenuOpen(false);
    setThemeMenuOpen(false);
  }, [route, currentTeam?.id]);

  const effectiveCollapsed = collapsed && !isMobile;

  const toggleCollapsed = () => {
    setCollapsed((value) => {
      const next = !value;
      try {
        localStorage.setItem(SIDEBAR_STORAGE, next ? "1" : "0");
      } catch {
        // ignore storage failures
      }
      return next;
    });
    setTeamMenuOpen(false);
  };

  const openTeamMenu = () => {
    if (effectiveCollapsed) {
      setCollapsed(false);
      try {
        localStorage.setItem(SIDEBAR_STORAGE, "0");
      } catch {
        // ignore
      }
      setTeamMenuOpen(true);
      return;
    }
    setTeamMenuOpen((value) => !value);
  };

  if (!data || !config) return null;
  const me = data.me;
  const isGuest = !me.authenticated || me.source === "guest";
  const canManageWorkspace = Boolean(permissions?.canManageWorkspace);
  const showGuestBanner = isGuest && config.features.showGuestBanner;
  // Round 9: the settings entry is permission-based and lives in the sidebar's 管理 group
  // (not in the avatar dropdown, not hideable by a module switch).
  const settingsNavLabel = isSuperAdmin ? "工作室设置" : "团队设置";
  const todayLabel = formatFullDate(data.serverTime || new Date().toISOString());
  const role = roleLabel(me.admin.role, me.isDeviceAdmin, isGuest, me.isSuperAdmin);
  const avatarColor = me.isDeviceAdmin ? "#0ea5e9" : me.avatarColor || "#7c3aed";
  const emailLoginReady = config.auth.emailLogin.enabled && config.email.configured;
  const quickThemeIcon = theme === "dark" ? Sun : Moon;
  const QuickThemeIcon = quickThemeIcon;
  const preferenceIcon =
    themePreference === "auto" ? Monitor : theme === "dark" ? Moon : Sun;
  const PreferenceIcon = preferenceIcon;
  const selectThemePreference = (preference: ThemePreference) => {
    setThemeMenuOpen(false);
    setThemePreference(preference);
  };

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      const result = await api.logout();
      if (result.endSessionUrl) {
        window.location.href = result.endSessionUrl;
        return;
      }
      window.location.hash = "/login";
      window.location.reload();
    } catch {
      toast("退出登录失败，请稍后重试", "error");
    } finally {
      setLoggingOut(false);
    }
  };

  /**
   * Deep-link the signed-in account's own member card. `linkedMemberId` is resolved
   * per active team by the backend, so the button is hidden when the current team
   * has no archive (the menu entry keeps the backend contract
   * `me.linkedMemberId === null` -> no dead link).
   *
   * Assigning an already identical hash does not emit `hashchange`, which would leave
   * the drawer closed; nudge the overview page in that edge case.
   */
  const openMyMemberCard = () => {
    const memberId = me.linkedMemberId;
    if (!memberId) return;
    setUserMenuOpen(false);
    const targetHash = `#/overview?member=${encodeURIComponent(memberId)}`;
    const unchanged = window.location.hash === targetHash;
    navigate("overview", { member: memberId });
    if (!unchanged) return;
    try {
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    } catch {
      window.location.hash = "#/overview";
      window.setTimeout(() => navigate("overview", { member: memberId }), 0);
    }
  };

  return (
    <div className={cn("app-shell", effectiveCollapsed && "sidebar-collapsed")}>
      <aside
        className={cn(
          "sidebar",
          sidebarOpen && "sidebar-open",
          effectiveCollapsed && "is-collapsed",
        )}
      >
        <div className="sidebar-brand">
          <button className="brand-mark" onClick={() => navigate("overview")} aria-label="返回团队概览">
            <Sparkles size={20} />
          </button>
          <div className="brand-copy">
            <strong>{config.site.name}</strong>
            <span>TEAM STUDIO</span>
          </div>
          <button className="icon-button sidebar-close" onClick={() => setSidebarOpen(false)} aria-label="关闭导航">
            <X size={18} />
          </button>
        </div>

        <nav className="main-nav">
          {NAV_GROUPS.map((group) => {
            const items = group.items.filter((item) => moduleVisible(item.module));
            if (!items.length) return null;
            return (
              <div className="nav-group" key={group.label}>
                <div className="sidebar-label">{group.label}</div>
                {items.map((item) => {
                  const Icon = item.icon;
                  const active = route === item.key;
                  return (
                    <button
                      key={item.key}
                      className={cn("nav-item", active && "active")}
                      onClick={() => navigate(item.key)}
                      title={effectiveCollapsed ? item.label : undefined}
                      aria-label={item.label}
                    >
                      <Icon size={18} />
                      <span>{item.label}</span>
                      {item.key === "announcements" && data.stats.pinned > 0 ? (
                        <span className="nav-count">{data.stats.pinned}</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            );
          })}
          {isAdmin ? (
            <div className="nav-group">
              <div className="sidebar-label">管理</div>
              <button
                className={cn("nav-item", route === "settings" && "active")}
                onClick={() => navigate("settings")}
                title={effectiveCollapsed ? settingsNavLabel : undefined}
                aria-label={settingsNavLabel}
              >
                <Settings2 size={18} />
                <span>{settingsNavLabel}</span>
                {isSuperAdmin ? <ShieldCheck size={14} className="nav-shield" /> : null}
              </button>
            </div>
          ) : null}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-team-switcher" ref={teamMenuRef}>
            <button
              className={cn("team-switcher-button", teamMenuOpen && "is-open")}
              onClick={openTeamMenu}
              aria-expanded={teamMenuOpen}
              aria-label="切换团队"
              title={effectiveCollapsed ? currentTeam?.name ?? "切换团队" : undefined}
            >
              <span className="team-badge" style={{ background: currentTeam?.color ?? config.site.theme.accent }}>
                <Building2 size={17} />
              </span>
              <span className="team-copy">
                <small>当前团队</small>
                <strong>{currentTeam?.name ?? "团队工作室"}</strong>
                <small className="team-member-count">
                  {currentTeam ? `${currentTeam.memberCount} 位成员` : "尚未创建团队"}
                </small>
              </span>
              <ChevronsUpDown size={15} />
            </button>
            {teamMenuOpen ? (
              <div className="popover team-popover team-popover-up">
                <div className="popover-label">切换团队</div>
                {data.teams.map((team) => (
                  <button
                    key={team.id}
                    className={cn("team-option", team.id === currentTeam?.id && "active")}
                    onClick={() => {
                      setTeamMenuOpen(false);
                      if (team.id !== currentTeam?.id) void selectTeam(team.id);
                    }}
                  >
                    <span className="team-option-dot" style={{ background: team.color }} />
                    <span>
                      <strong>{team.name}</strong>
                      <small>{team.memberCount} 位成员</small>
                    </span>
                    {team.id === currentTeam?.id ? <span className="team-current">当前</span> : null}
                  </button>
                ))}
                <div className="popover-note">
                  <Command size={13} /> 数据按团队隔离
                </div>
              </div>
            ) : null}
          </div>
          <div className="identity-mini">
            <Avatar name={me.name} src={me.avatar} color={avatarColor} size="sm" />
            <div>
              <strong>{me.name}</strong>
              <span>{role}</span>
            </div>
            <button
              className="icon-button about-trigger"
              onClick={() => setAboutOpen(true)}
              aria-label="关于团队工作室"
              title="关于团队工作室"
            >
              <Info size={15} />
            </button>
          </div>
          <p>{config.site.footerText}</p>
        </div>
      </aside>

      {sidebarOpen ? <button className="sidebar-scrim" onClick={() => setSidebarOpen(false)} aria-label="关闭导航" /> : null}

      <div className="app-main">
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="icon-button collapse-toggle"
              onClick={toggleCollapsed}
              aria-label={effectiveCollapsed ? "展开侧边栏" : "折叠侧边栏"}
              title={effectiveCollapsed ? "展开侧边栏" : "折叠侧边栏"}
            >
              {effectiveCollapsed ? <PanelLeftOpen size={19} /> : <PanelLeftClose size={19} />}
            </button>
            <button className="icon-button mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="打开导航">
              <Menu size={20} />
            </button>
            <div className="breadcrumb">
              <span>{currentTeam?.name ?? "团队工作室"}</span>
              <i>/</i>
              <span className="breadcrumb-page">
                {route === "settings" ? settingsNavLabel : (PAGE_LABELS[route] ?? "团队工作室")}
              </span>
            </div>
          </div>
          <div className="topbar-right">
            <span className="today-pill">{todayLabel}</span>
            {moduleVisible("announcements") ? (
              <button
                className="icon-button"
                onClick={() => navigate("announcements")}
                aria-label="查看公告"
                title="公告栏"
              >
                <Bell size={18} />
                {data.stats.pinned > 0 ? <span className="dot-badge" /> : null}
              </button>
            ) : null}
            <div className="theme-menu-wrap" ref={themeMenuRef}>
              <button
                className="icon-button theme-menu-trigger"
                onClick={() => setThemeMenuOpen((value) => !value)}
                aria-label="主题偏好"
                aria-expanded={themeMenuOpen}
                aria-haspopup="menu"
                title={`主题偏好：${themePreferenceLabel(themePreference)}`}
              >
                <PreferenceIcon size={18} />
              </button>
              {themeMenuOpen ? (
                <div className="popover theme-popover" role="menu" aria-label="主题偏好">
                  <div className="popover-label">外观主题</div>
                  {THEME_OPTIONS.map((option) => {
                    const OptionIcon = option.icon;
                    const active = themePreference === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="menuitemradio"
                        aria-checked={active}
                        className={cn("theme-option", active && "active")}
                        onClick={() => selectThemePreference(option.value)}
                      >
                        <OptionIcon size={15} />
                        <span>{option.label}</span>
                        {active ? <Check size={14} className="theme-check" /> : null}
                      </button>
                    );
                  })}
                  <div className="popover-note">
                    <Monitor size={13} /> 跟随系统时随操作系统明暗实时切换
                  </div>
                </div>
              ) : null}
            </div>
            <button
              className="icon-button quick-theme-toggle"
              onClick={() => setThemePreference(theme === "dark" ? "light" : "dark")}
              aria-label="切换明暗主题"
              title={theme === "dark" ? "切换到浅色" : "切换到深色"}
            >
              <QuickThemeIcon size={18} />
            </button>
            {me.authenticated && (isAdmin || me.linkedMemberId) && moduleVisible("calendar") ? (
              <button
                className="btn btn-secondary btn-sm quick-create"
                onClick={() => navigate("calendar", { new: "1" })}
              >
                <Plus size={15} /> 新建待办
              </button>
            ) : null}
            {isGuest ? (
              <button
                className="btn btn-primary btn-sm login-button"
                onClick={() => navigate("login")}
              >
                <LogIn size={15} /> 登录
              </button>
            ) : (
              <div className="user-menu-wrap" ref={userMenuRef}>
                <button className="user-chip" onClick={() => setUserMenuOpen((value) => !value)}>
                  <Avatar name={me.name} src={me.avatar} color={avatarColor} size="sm" />
                  <span className="user-chip-copy">
                    <strong>{me.name}</strong>
                    <small>{role}</small>
                  </span>
                  <ChevronDown size={14} />
                </button>
                {userMenuOpen ? (
                  <div className="popover user-popover">
                    <div className="user-popover-head">
                      <Avatar name={me.name} src={me.avatar} color={avatarColor} size="md" />
                      <div>
                        <strong>{me.name}</strong>
                        <span>
                          {me.email ||
                            (me.isDeviceAdmin
                              ? "部署设备身份，始终拥有管理权限"
                              : me.source === "ip"
                                ? "IP 白名单身份"
                                : "已通过身份验证")}
                        </span>
                      </div>
                    </div>
                    <div className="user-popover-meta">
                      <span
                        className={cn(
                          "badge",
                          isSuperAdmin ? "badge-green" : isGuest ? "badge-gray" : "badge-violet",
                        )}
                      >
                        <ShieldCheck size={12} /> {role}
                      </span>
                      {me.isDeviceAdmin ? (
                        <span className="badge badge-gray">系统内置</span>
                      ) : null}
                      {me.source === "sso" ? <span className="badge badge-blue">SSO 已登录</span> : null}
                      {me.source === "email" ? <span className="badge badge-blue">邮箱已验证</span> : null}
                      {me.source === "ip" ? <span className="badge badge-blue">IP 白名单</span> : null}
                    </div>
                    <button
                      className="menu-row"
                      onClick={() => {
                        setUserMenuOpen(false);
                        navigate("profile");
                      }}
                    >
                      <CircleUserRound size={16} /> 个人主页
                    </button>
                    {me.linkedMemberId ? (
                      <button className="menu-row" onClick={openMyMemberCard}>
                        <UserRound size={16} /> 我的成员卡片
                      </button>
                    ) : null}
                    {canManageWorkspace ? (
                      <button
                        className="menu-row"
                        onClick={() => {
                          setUserMenuOpen(false);
                          setWorkspaceOpen(true);
                        }}
                      >
                        <FolderCog size={16} /> 工作区管理
                      </button>
                    ) : null}
                    <button
                      className="menu-row"
                      onClick={() => {
                        setUserMenuOpen(false);
                        setAboutOpen(true);
                      }}
                    >
                      <Info size={16} /> 关于团队工作室
                    </button>
                    {me.isDeviceAdmin || me.source === "email" || me.source === "sso" ? (
                      <button
                        className="menu-row danger"
                        onClick={() => void handleLogout()}
                        disabled={loggingOut}
                      >
                        <LogOut size={16} /> {loggingOut ? "退出中…" : "退出登录 / 切换账号"}
                      </button>
                    ) : me.source === "ip" ? (
                      <div className="menu-note">当前通过 IP 白名单获得管理权限。</div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </header>

        {showGuestBanner ? (
          <div className="guest-banner">
            <span className="guest-banner-icon">
              <ShieldCheck size={17} />
            </span>
            <div>
              <strong>访客模式 · 只读浏览</strong>
              <span>
                {emailLoginReady
                  ? "使用邮箱验证码登录或注册后，可编辑个人资料、维护自己的任务与待办。"
                  : config.auth.sso.configured
                    ? "使用企业 SSO 登录后，可编辑个人资料与自己的待办。"
                    : "管理员配置邮件服务或企业 SSO 后，即可使用账号登录。"}
              </span>
            </div>
            {emailLoginReady || config.auth.sso.configured ? (
              <button className="btn btn-secondary btn-sm" onClick={() => navigate("login")}>
                登录 / 注册
              </button>
            ) : (
              <span className="guest-config-hint">管理员配置后即可登录</span>
            )}
          </div>
        ) : null}

        <main className="page-content">{children}</main>
      </div>

      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
      <WorkspaceManager open={workspaceOpen} onClose={() => setWorkspaceOpen(false)} />
    </div>
  );
}
