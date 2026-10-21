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
  ModuleFlags,
  PublicConfig,
  TeamRef,
} from "./types";
import { canManageTeam, hashRoute, navigate as navigateHash } from "./lib/utils";

export type ThemePreference = "auto" | "light" | "dark";
type ThemeMode = "light" | "dark";

interface AppContextValue {
  data: BootstrapData | null;
  config: PublicConfig | null;
  loading: boolean;
  refreshing: boolean;
  error: string;
  route: string;
  /** The theme actually applied to the document. */
  theme: ThemeMode;
  /** The user's saved preference (defaults to "auto"). */
  themePreference: ThemePreference;
  setThemePreference: (pref: ThemePreference) => void;
  canManageActiveTeam: boolean;
  canEditSelf: boolean;
  isAdmin: boolean;
  isSuperAdmin: boolean;
  permissions: CurrentUser["permissions"] | null;
  currentTeam: TeamRef | null;
  moduleVisible: (module: keyof ModuleFlags) => boolean;
  reload: (silent?: boolean) => Promise<void>;
  selectTeam: (teamId: string) => Promise<void>;
  navigate: (page: string, params?: Record<string, string>) => void;
}

const AppContext = createContext<AppContextValue | null>(null);
const STORAGE_TEAM = "teamstudio.team";
const STORAGE_THEME_PREFERENCE = "teamstudio.theme.preference";
/** Legacy key from earlier rounds ("light" | "dark"), migrated to a preference. */
const STORAGE_THEME_LEGACY = "teamstudio.theme";

function systemTheme(): ThemeMode {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function themeForPreference(preference: ThemePreference): ThemeMode {
  return preference === "auto" ? systemTheme() : preference;
}

function readThemePreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(STORAGE_THEME_PREFERENCE);
    if (saved === "auto" || saved === "light" || saved === "dark") return saved;
    // First run after the round-8 upgrade: migrate the old explicit choice once.
    const legacy = localStorage.getItem(STORAGE_THEME_LEGACY);
    if (legacy === "light" || legacy === "dark") {
      localStorage.setItem(STORAGE_THEME_PREFERENCE, legacy);
      localStorage.removeItem(STORAGE_THEME_LEGACY);
      return legacy;
    }
  } catch {
    // ignore storage failures
  }
  return "auto";
}

export function AppProvider({ children }: { children: ReactNode }) {
  const { toast } = useToast();
  const [data, setData] = useState<BootstrapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [route, setRoute] = useState(() => hashRoute().page);
  const [themePreference, setThemePreferenceState] = useState<ThemePreference>(
    readThemePreference,
  );
  const [theme, setTheme] = useState<ThemeMode>(() => {
    // Apply before the first paint so "follow the system" never flashes a
    // different palette than the one the visitor's OS asks for.
    const resolved = themeForPreference(readThemePreference());
    document.documentElement.dataset.theme = resolved;
    return resolved;
  });
  const selectionRef = useRef({
    teamId: localStorage.getItem(STORAGE_TEAM) ?? "",
  });
  const requestId = useRef(0);

  const fetchBootstrap = useCallback(async (silent = false) => {
    const id = ++requestId.current;
    if (silent) setRefreshing(true);
    else setLoading(true);
    setError("");
    try {
      const result = await api.bootstrap(selectionRef.current.teamId || undefined);
      if (id !== requestId.current) return;
      setData(result);
      if (result.active.team) {
        selectionRef.current.teamId = result.active.team.id;
        localStorage.setItem(STORAGE_TEAM, result.active.team.id);
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
  }, []);

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

  // Theme resolution: the user preference always wins. "auto" follows the
  // operating system and keeps a live `prefers-color-scheme` listener — the
  // site-level `theme.mode` never decides light/dark in round 8.
  useEffect(() => {
    const root = document.documentElement;
    if (themePreference !== "auto") {
      root.dataset.theme = themePreference;
      setTheme(themePreference);
      return undefined;
    }
    if (typeof window.matchMedia !== "function") {
      root.dataset.theme = "light";
      setTheme("light");
      return undefined;
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const next: ThemeMode = media.matches ? "dark" : "light";
      root.dataset.theme = next;
      setTheme(next);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [themePreference]);

  // Accent / radius / title still come from the site config.
  useEffect(() => {
    const config = data?.config;
    if (!config) return;
    const root = document.documentElement;
    root.style.setProperty("--accent", config.site.theme.accent);
    root.style.setProperty("--accent-secondary", config.site.theme.accentSecondary);
    root.style.setProperty("--radius-card", `${config.site.theme.radius}px`);
    document.title = `${config.site.name} · TeamStudio`;
  }, [data?.config]);

  const setThemePreference = useCallback((preference: ThemePreference) => {
    setThemePreferenceState(preference);
    try {
      localStorage.setItem(STORAGE_THEME_PREFERENCE, preference);
      localStorage.removeItem(STORAGE_THEME_LEGACY);
    } catch {
      // ignore storage failures
    }
  }, []);

  const selectTeam = useCallback(
    async (teamId: string) => {
      if (!teamId) return;
      if (teamId === selectionRef.current.teamId && data?.active.team?.id === teamId) return;
      selectionRef.current = { teamId };
      localStorage.setItem(STORAGE_TEAM, teamId);
      await fetchBootstrap(true);
    },
    [data?.active.team?.id, fetchBootstrap],
  );

  const navigate = useCallback((page: string, params?: Record<string, string>) => {
    navigateHash(page, params);
  }, []);

  const me = data?.me ?? null;
  const currentTeam = data?.active.team ?? null;
  const isGuest = !me || !me.authenticated || me.source === "guest";
  const isSuperAdmin = Boolean(me?.isSuperAdmin || me?.isDeviceAdmin);
  const permissions = me?.permissions ?? null;
  const isAdmin = Boolean(me?.isDeviceAdmin || me?.isSuperAdmin || me?.admin.role);
  const canManageActiveTeam = canManageTeam(me, currentTeam?.id ?? null);
  const config = data?.config ?? null;
  const moduleVisible = useCallback(
    (module: keyof ModuleFlags) =>
      Boolean(config?.modules[module]) &&
      (!isGuest || Boolean(config?.guestModules[module])),
    [config, isGuest],
  );

  const value = useMemo<AppContextValue>(
    () => ({
      data,
      config,
      loading,
      refreshing,
      error,
      route,
      theme,
      themePreference,
      setThemePreference,
      canManageActiveTeam,
      canEditSelf: Boolean(permissions?.canEditSelf),
      isAdmin,
      isSuperAdmin,
      permissions,
      currentTeam,
      moduleVisible,
      reload: fetchBootstrap,
      selectTeam,
      navigate,
    }),
    [
      data,
      config,
      loading,
      refreshing,
      error,
      route,
      theme,
      themePreference,
      setThemePreference,
      canManageActiveTeam,
      permissions,
      isAdmin,
      isSuperAdmin,
      currentTeam,
      moduleVisible,
      fetchBootstrap,
      selectTeam,
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
