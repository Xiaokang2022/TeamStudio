import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, ApiError } from "./api";
import { useToast } from "./components/Toast";
import type {
  BootstrapData,
  CurrentUser,
  PublicConfig,
  TeamRef,
  GroupRef,
  ModuleFlags,
  ScopeKind,
} from "./types";
import { canManageGroup, hashRoute, navigate as navigateHash } from "./lib/utils";
import { scopeOptionsFor, type ScopeOption } from "./lib/scope";

type ThemeMode = "light" | "dark";

interface AppContextValue {
  data: BootstrapData | null;
  config: PublicConfig | null;
  loading: boolean;
  refreshing: boolean;
  error: string;
  route: string;
  theme: ThemeMode;
  scope: ScopeKind;
  scopeLabel: string;
  scopeOptions: ScopeOption[];
  canManageActiveGroup: boolean;
  canEditSelf: boolean;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  permissions: CurrentUser["permissions"] | null;
  currentTeam: TeamRef | null;
  currentGroup: GroupRef | null;
  moduleVisible: (module: keyof ModuleFlags) => boolean;
  reload: (silent?: boolean) => Promise<void>;
  selectTeam: (teamId: string, groupId?: string) => Promise<void>;
  selectGroup: (groupId: string) => Promise<void>;
  setScope: (scope: ScopeKind) => void;
  toggleTheme: () => void;
  navigate: (page: string, params?: Record<string, string>) => void;
}

const AppContext = createContext<AppContextValue | null>(null);
const STORAGE_TEAM = "teamstudio.team";
const STORAGE_GROUP = "teamstudio.group";
const STORAGE_THEME = "teamstudio.theme";
const STORAGE_SCOPE = "teamstudio.scope";

function readScope(): ScopeKind {
  try {
    const saved = localStorage.getItem(STORAGE_SCOPE);
    if (saved === "group" || saved === "team" || saved === "all") return saved;
  } catch {
    // ignore storage failures
  }
  return "group";
}

function systemTheme(): ThemeMode {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function resolveTheme(preferred: PublicConfig["site"]["theme"] | undefined): ThemeMode {
  try {
    const saved = localStorage.getItem(STORAGE_THEME);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // ignore storage failures
  }
  // The site default is "auto": follow the operating system when the visitor has
  // never picked an explicit theme on this browser.
  const mode = preferred?.mode ?? "auto";
  if (mode === "auto") return systemTheme();
  return mode;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const { toast } = useToast();
  const [data, setData] = useState<BootstrapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [route, setRoute] = useState(() => hashRoute().page);
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const resolved = resolveTheme(undefined);
    // Apply before the first paint so "follow the system" never flashes a
    // different palette than the one the visitor's OS asks for.
    document.documentElement.dataset.theme = resolved;
    return resolved;
  });
  const [scope, setScopeState] = useState<ScopeKind>(readScope);
  const selectionRef = useRef({
    teamId: localStorage.getItem(STORAGE_TEAM) ?? "",
    groupId: localStorage.getItem(STORAGE_GROUP) ?? "",
  });
  const requestId = useRef(0);

  const fetchBootstrap = useCallback(
    async (silent = false) => {
      const id = ++requestId.current;
      if (silent) setRefreshing(true);
      else setLoading(true);
      setError("");
      try {
        const result = await api.bootstrap(selectionRef.current.teamId, selectionRef.current.groupId);
        if (id !== requestId.current) return;
        setData(result);
        if (result.active.team) {
          selectionRef.current.teamId = result.active.team.id;
          localStorage.setItem(STORAGE_TEAM, result.active.team.id);
        }
        if (result.active.group) {
          selectionRef.current.groupId = result.active.group.id;
          localStorage.setItem(STORAGE_GROUP, result.active.group.id);
        }
      } catch (err) {
        if (id !== requestId.current) return;
        const message = err instanceof ApiError ? err.message : "加载工作区失败";
        setError(message);
      } finally {
        if (id === requestId.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    void fetchBootstrap();
  }, [fetchBootstrap]);

  useEffect(() => {
    const onHashChange = () => setRoute(hashRoute().page);
    window.addEventListener("hashchange", onHashChange);
    if (!window.location.hash) window.location.hash = "/overview";
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get("sso");
    if (!status) return;
    const message = params.get("sso_message");
    if (status === "unconfigured") {
      toast("企业 SSO 尚未配置，已自动以访客模式进入", "info");
    } else if (status === "denied") {
      toast(message || "SSO 登录已取消", "info");
    } else if (status === "error") {
      toast(message || "SSO 登录失败，已保持访客模式", "error");
    }
    params.delete("sso");
    params.delete("sso_message");
    const search = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`);
  }, [toast]);

  useEffect(() => {
    const config = data?.config;
    if (!config) return;
    const mode = resolveTheme(config.site.theme);
    setTheme(mode);
    const root = document.documentElement;
    root.dataset.theme = mode;
    root.style.setProperty("--accent", config.site.theme.accent);
    root.style.setProperty("--accent-secondary", config.site.theme.accentSecondary);
    root.style.setProperty("--radius-card", `${config.site.theme.radius}px`);
    document.title = `${config.site.name} · TeamStudio`;
    if (config.site.theme.mode !== "auto" || localStorage.getItem(STORAGE_THEME)) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => {
      const next = event.matches ? "dark" : "light";
      setTheme(next);
      root.dataset.theme = next;
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [data?.config]);

  const selectTeam = useCallback(
    async (teamId: string, groupId?: string) => {
      const team = data?.teams.find((item) => item.id === teamId);
      const targetGroup = groupId || team?.groups[0]?.id || "";
      selectionRef.current = { teamId, groupId: targetGroup };
      localStorage.setItem(STORAGE_TEAM, teamId);
      if (targetGroup) localStorage.setItem(STORAGE_GROUP, targetGroup);
      await fetchBootstrap(true);
    },
    [data?.teams, fetchBootstrap],
  );

  const selectGroup = useCallback(
    async (groupId: string) => {
      const team =
        data?.teams.find((item) => item.groups.some((group) => group.id === groupId)) ??
        data?.active.team;
      if (!team) return;
      selectionRef.current = { teamId: team.id, groupId };
      localStorage.setItem(STORAGE_TEAM, team.id);
      localStorage.setItem(STORAGE_GROUP, groupId);
      await fetchBootstrap(true);
    },
    [data?.active.team, data?.teams, fetchBootstrap],
  );

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      localStorage.setItem(STORAGE_THEME, next);
      document.documentElement.dataset.theme = next;
      return next;
    });
  }, []);

  // Browsing scope is a view preference, not a permission boundary: every identity
  // (guest included) may pick 开发组 / 团队 / 所有团队. The backend already allows
  // `?scope=all` for everyone, so store the requested scope verbatim and persist it.
  const setScope = useCallback((next: ScopeKind) => {
    setScopeState(next);
    try {
      localStorage.setItem(STORAGE_SCOPE, next);
    } catch {
      // ignore storage failures
    }
  }, []);

  const navigate = useCallback((page: string, params?: Record<string, string>) => {
    navigateHash(page, params);
  }, []);

  const me = data?.me ?? null;
  const currentTeam = data?.active.team ?? null;
  const currentGroup = data?.active.group ?? null;
  const isSuperAdmin = Boolean(me?.isSuperAdmin || me?.isDeviceAdmin);
  const permissions = me?.permissions ?? null;
  const isAdmin = Boolean(me?.isDeviceAdmin || me?.isSuperAdmin || me?.admin.role);
  const scopeOptions = useMemo<ScopeOption[]>(() => scopeOptionsFor(isSuperAdmin), [isSuperAdmin]);
  const canManageActiveGroup = canManageGroup(me, currentTeam?.id, currentGroup?.id);
  const scopeLabel =
    scope === "all"
      ? "所有团队"
      : scope === "team"
        ? currentTeam?.name ?? "当前团队"
        : currentGroup?.name ?? "当前开发组";

  const value = useMemo<AppContextValue>(
    () => ({
      data,
      config: data?.config ?? null,
      loading,
      refreshing,
      error,
      route,
      theme,
      scope,
      scopeLabel,
      scopeOptions,
      canManageActiveGroup,
      canEditSelf: Boolean(data?.me.permissions.canEditSelf),
      isAdmin,
      isSuperAdmin,
      permissions,
      currentTeam,
      currentGroup,
      moduleVisible: (module) => Boolean(data?.config.modules[module]),
      reload: fetchBootstrap,
      selectTeam,
      selectGroup,
      setScope,
      toggleTheme,
      navigate,
    }),
    [
      data,
      loading,
      refreshing,
      error,
      route,
      theme,
      scope,
      scopeLabel,
      scopeOptions,
      canManageActiveGroup,
      isAdmin,
      isSuperAdmin,
      permissions,
      currentTeam,
      currentGroup,
      fetchBootstrap,
      selectTeam,
      selectGroup,
      setScope,
      toggleTheme,
      navigate,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const context = useContext(AppContext);
  if (!context) throw new Error("useApp must be used within AppProvider");
  return context;
}
