import { useEffect, useRef, useState } from "react";
import {
  Bell,
  Building2,
  CalendarDays,
  ChartNoAxesColumn,
  ChevronDown,
  ChevronsUpDown,
  CircleUserRound,
  Command,
  FolderCog,
  Globe2,
  Info,
  Layers3,
  LayoutDashboard,
  Link2,
  ListTodo,
  LogIn,
  LogOut,
  Megaphone,
  Menu,
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
  UsersRound,
  Waypoints,
  X,
} from "lucide-react";
import { api } from "../api";
import { useApp } from "../store";
import { useToast } from "./Toast";
import { Avatar } from "./Avatar";
import { AboutDialog } from "./AboutDialog";
import { WorkspaceManager } from "./WorkspaceManager";
import { cn, formatFullDate } from "../lib/utils";
import type { ModuleFlags } from "../types";
import "./ShellScope.css";

const NAV_GROUPS: {
  label: string;
  items: { key: string; label: string; icon: typeof LayoutDashboard; module: keyof ModuleFlags; adminOnly?: boolean }[];
}[] = [
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
  if (role === "group_admin") return "开发组管理员";
  return "成员";
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const {
    data,
    config,
    route,
    currentTeam,
    currentGroup,
    selectTeam,
    selectGroup,
    scope,
    scopeLabel,
    scopeOptions,
    setScope,
    toggleTheme,
    theme,
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
  const [groupMenuOpen, setGroupMenuOpen] = useState(false);
  const [teamMenuOpen, setTeamMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const groupMenuRef = useRef<HTMLDivElement>(null);
  const teamMenuRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!groupMenuRef.current?.contains(event.target as Node)) setGroupMenuOpen(false);
      if (!teamMenuRef.current?.contains(event.target as Node)) setTeamMenuOpen(false);
      if (!userMenuRef.current?.contains(event.target as Node)) setUserMenuOpen(false);
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
    setGroupMenuOpen(false);
    setTeamMenuOpen(false);
  }, [route, currentGroup?.id]);

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
    setGroupMenuOpen(false);
    setTeamMenuOpen(false);
  };

  const openGroupMenu = () => {
    if (effectiveCollapsed) {
      setCollapsed(false);
      try {
        localStorage.setItem(SIDEBAR_STORAGE, "0");
      } catch {
        // ignore
      }
      setGroupMenuOpen(true);
      return;
    }
    setGroupMenuOpen((value) => !value);
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
  const settingsVisible = isAdmin && moduleVisible("settings");
  const todayLabel = formatFullDate(data.serverTime || new Date().toISOString());
  const role = roleLabel(me.admin.role, me.isDeviceAdmin, isGuest, me.isSuperAdmin);
  const avatarColor = me.isDeviceAdmin ? "#0ea5e9" : me.avatarColor || "#7c3aed";
  const emailLoginReady = config.auth.emailLogin.enabled && config.email.configured;

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

        <div className="group-switcher" ref={groupMenuRef}>
          <button
            className={cn("group-switcher-button", groupMenuOpen && "is-open")}
            onClick={openGroupMenu}
            aria-expanded={groupMenuOpen}
            aria-label="切换开发组"
            title={effectiveCollapsed ? currentGroup?.name ?? "切换开发组" : undefined}
          >
            <span
              className="group-badge"
              style={{ background: currentGroup?.color ?? config.site.theme.accent }}
            >
              <Layers3 size={17} />
            </span>
            <span className="group-copy">
              <small>当前开发组</small>
              <strong>{currentGroup?.name ?? "开发组"}</strong>
            </span>
            <ChevronsUpDown size={15} />
          </button>
          {groupMenuOpen ? (
            <div className="popover group-popover">
              <div className="popover-label">切换开发组</div>
              {currentTeam?.groups.map((group) => {
                const active = group.id === currentGroup?.id;
                return (
                  <button
                    key={group.id}
                    className={cn("group-option", active && "active")}
                    onClick={() => {
                      setGroupMenuOpen(false);
                      if (group.id !== currentGroup?.id) void selectGroup(group.id);
                    }}
                  >
                    <span className="group-option-dot" style={{ background: group.color }} />
                    <span className="group-option-copy">
                      <strong>{group.name}</strong>
                      <small>{group.description || "暂无简介"}</small>
                    </span>
                    <span className="group-option-count">{group.memberCount}</span>
                    {active ? <span className="group-option-current">当前</span> : null}
                  </button>
                );
              })}
              <div className="popover-note">
                <Layers3 size={13} /> 开发组内数据独立；切换后所有模块同步刷新
              </div>
            </div>
          ) : null}
        </div>

        <div className="scope-switcher" role="group" aria-label="浏览视角">
          <div className="scope-switcher-label">
            <Globe2 size={13} /> 浏览视角
          </div>
          <div className="scope-switcher-options">
            {scopeOptions.map((option) => (
              <button
                key={option.key}
                type="button"
                className={cn("scope-option", scope === option.key && "is-active")}
                aria-pressed={scope === option.key}
                title={option.description}
                onClick={() => setScope(option.key)}
              >
                {option.key === "group" ? (
                  <Layers3 size={14} />
                ) : option.key === "team" ? (
                  <UsersRound size={14} />
                ) : (
                  <Globe2 size={14} />
                )}
                <span>{option.shortLabel}</span>
              </button>
            ))}
          </div>
          <p className="scope-switcher-hint">
            正在浏览：<strong>{scopeLabel}</strong>
          </p>
        </div>

        <nav className="main-nav">
          {NAV_GROUPS.map((group) => {
            const items = group.items.filter(
              (item) => moduleVisible(item.module) && (!item.adminOnly || isAdmin),
            );
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
          {settingsVisible ? (
            <div className="nav-group">
              <div className="sidebar-label">管理</div>
              <button
                className={cn("nav-item", route === "settings" && "active")}
                onClick={() => navigate("settings")}
                title={effectiveCollapsed ? "系统设置" : undefined}
                aria-label="系统设置"
              >
                <Settings2 size={18} />
                <span>系统设置</span>
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
                      <small>{team.groups.length} 个开发组</small>
                    </span>
                    {team.id === currentTeam?.id ? <span className="team-current">当前</span> : null}
                  </button>
                ))}
                <div className="popover-note">
                  <Command size={13} /> 数据按团队与开发组自动隔离
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
              {scope === "group" ? (
                <>
                  <span>{currentTeam?.name}</span>
                  <i>/</i>
                  <strong>{currentGroup?.name}</strong>
                </>
              ) : scope === "all" ? (
                <strong className="breadcrumb-scope">
                  <Globe2 size={13} /> 所有团队
                </strong>
              ) : (
                <strong className="breadcrumb-scope">
                  <UsersRound size={13} /> {currentTeam?.name ?? "当前团队"}
                </strong>
              )}
              <i>/</i>
              <span className="breadcrumb-page">{PAGE_LABELS[route] ?? "团队工作室"}</span>
            </div>
          </div>
          <div className="topbar-right">
            <span className="today-pill">{todayLabel}</span>
            <button
              className="icon-button"
              onClick={() => navigate("announcements")}
              aria-label="查看公告"
              title="公告栏"
            >
              <Bell size={18} />
              {data.stats.pinned > 0 ? <span className="dot-badge" /> : null}
            </button>
            <button className="icon-button" onClick={toggleTheme} aria-label="切换主题" title="切换明暗主题">
              {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            {me.authenticated && (isAdmin || me.linkedMemberId) ? (
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
                              ? "本机始终拥有管理权限"
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
                      <button
                        className="menu-row"
                        onClick={() => {
                          setUserMenuOpen(false);
                          navigate("overview", { member: me.linkedMemberId! });
                        }}
                      >
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
                    {isAdmin ? (
                      <button
                        className="menu-row"
                        onClick={() => {
                          setUserMenuOpen(false);
                          navigate("settings");
                        }}
                      >
                        <Settings2 size={16} /> 系统设置
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
