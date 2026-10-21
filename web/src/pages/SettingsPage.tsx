import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  AtSign,
  BadgeCheck,
  Braces,
  Building2,
  CalendarDays,
  Check,
  CheckCircle2,
  Clock,
  Code2,
  Copy,
  Database,
  Download,
  Eye,
  EyeOff,
  FileJson,
  Fingerprint,
  Globe,
  Inbox,
  KeyRound,
  LayoutDashboard,
  LayoutGrid,
  Link2,
  ListTodo,
  Loader2,
  Lock,
  Mail,
  Megaphone,
  Palette,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Send,
  Server,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  TrendingUp,
  Trophy,
  UserPlus,
  Users,
  UsersRound,
  Wand2,
  Waypoints,
  X,
  type LucideIcon,
} from "lucide-react";
import { api, ApiError } from "../api";
import { useApp } from "../store";
import { useToast } from "../components/Toast";
import { ConfirmDialog, ConfirmInputDialog } from "../components/Modal";
import { LoadingBlock } from "../components/Feedback";
import { Avatar } from "../components/Avatar";
import { WorkspaceManager } from "../components/WorkspaceManager";
import { CodeEditor } from "../components/CodeEditor";
import { Select } from "../components/Select";
import {
  cn,
  copyText,
  formatDateTime,
  hashRoute,
  navigate as navigateHash,
  safeJsonParse,
} from "../lib/utils";
import type {
  ActivationLink,
  AdminIdEntry,
  AdminIpEntry,
  AppSettings,
  DomainSettingsData,
  DomainTeamSettings,
  EmailLog,
  EmailStatus,
  ModuleFlags,
  SettingsMeta,
  SystemResetInfo,
  SystemResetResult,
  SystemResetStats,
  UserAccount,
  UserRole,
  UsersData,
  ValidationDetail,
  WorkspaceOption,
} from "../types";
import "./SettingsPage.css";

type TabKey =
  | "workspace"
  | "appearance"
  | "modules"
  | "access"
  | "accounts"
  | "sso"
  | "email"
  | "json"
  | "reset";
type UpdateSettings = (mutate: (next: AppSettings) => void) => void;
type ErrorsFor = (prefix: string) => ValidationDetail[];
type Whitelist = AppSettings["auth"]["adminWhitelist"];

interface JsonState {
  status: "idle" | "ok" | "error";
  syntaxError?: string;
  details?: ValidationDetail[];
  checkedAt?: string;
}

type ConfirmKind = "reload" | "discard" | "json-sync" | "json-reset";

const TAB_KEYS: TabKey[] = [
  "workspace",
  "appearance",
  "modules",
  "access",
  "accounts",
  "sso",
  "email",
  "json",
];

const TABS: { key: TabKey; label: string; hint: string; icon: LucideIcon }[] = [
  { key: "workspace", label: "工作区设置", hint: "团队基础信息与结构", icon: Building2 },
  { key: "appearance", label: "外观与站点", hint: "名称、品牌与主题", icon: Palette },
  { key: "modules", label: "模块与展示", hint: "模块开关与访客访问", icon: LayoutGrid },
  { key: "access", label: "成员与权限", hint: "登录、白名单与超级管理员", icon: ShieldCheck },
  { key: "accounts", label: "账号与角色", hint: "预创建账号与角色授权", icon: UsersRound },
  { key: "sso", label: "企业 SSO", hint: "OIDC 身份接入", icon: Fingerprint },
  { key: "email", label: "邮件服务", hint: "SMTP 中继与验证码邮件", icon: Mail },
  { key: "json", label: "高级 JSON", hint: "完整配置与校验", icon: Braces },
];

/**
 * The factory-reset tab is appended only for the deployment device's built-in Admin.
 * It is deliberately kept out of `TABS` / `TAB_KEYS` so no other identity can deep-link
 * into it: `#/settings?tab=reset` falls back to a normal tab for stored super admins.
 */
const RESET_TAB: { key: TabKey; label: string; hint: string; icon: LucideIcon } = {
  key: "reset",
  label: "重置系统",
  hint: "仅系统内置管理员 · 危险操作",
  icon: ShieldAlert,
};

const MODULE_META: {
  key: keyof ModuleFlags;
  label: string;
  description: string;
  icon: LucideIcon;
}[] = [
  { key: "overview", label: "团队概览", description: "成员卡片、成长轨迹与近期动态。", icon: LayoutDashboard },
  { key: "tasks", label: "任务总览", description: "成员任务台账、健康状态与工作量负载。", icon: ListTodo },
  { key: "insights", label: "数据洞察", description: "完成率、趋势与成员 / 团队数据对比。", icon: TrendingUp },
  { key: "calendar", label: "协作日历", description: "待办、月度日历与展示偏好。", icon: CalendarDays },
  { key: "redblack", label: "红黑榜", description: "每月红榜高光与黑榜改进记录。", icon: Trophy },
  { key: "announcements", label: "公告栏", description: "团队公告与置顶消息。", icon: Megaphone },
  { key: "matrix", label: "责任田矩阵", description: "职责分工、负责人与联络方式。", icon: Waypoints },
  { key: "links", label: "常用链接", description: "团队常用工具与文档入口。", icon: Link2 },
  { key: "settings", label: "工作室设置", description: "关闭后导航隐藏，超级管理员仍可直接访问本页。", icon: Settings2 },
];

const FIELD_LABELS: Record<string, string> = {
  "site.name": "站点名称",
  "site.shortName": "站点简称",
  "site.tagline": "品牌标语",
  "site.logoText": "Logo 文字",
  "site.footerText": "页脚文案",
  "site.theme.mode": "主题模式（兼容字段，已不参与明暗解析）",
  "site.theme.accent": "主色",
  "site.theme.accentSecondary": "辅助色",
  "site.theme.radius": "卡片圆角",
  "announcements.maxPinned": "公告置顶上限",
  "announcements.dashboardLimit": "概览公告数量",
  "announcements.showOnDashboard": "概览展示公告",
  "calendar.weekStartsOn": "每周起始日",
  "calendar.showWeekends": "展示周末",
  "calendar.allowPastDue": "允许设置过期日期",
  "redblack.showScores": "展示分数",
  "redblack.monthlyThemeEnabled": "月度主题",
  "redblack.redLabel": "红榜名称",
  "redblack.blackLabel": "黑榜名称",
  "email.enabled": "邮件功能",
  "email.smtp.host": "SMTP 主机",
  "email.smtp.port": "SMTP 端口",
  "email.smtp.username": "SMTP 用户名",
  "email.smtp.password": "SMTP 密码",
  "email.smtp.fromEmail": "发件邮箱",
  "email.smtp.fromName": "发件人名称",
  "email.smtp.useStartTls": "STARTTLS",
  "email.smtp.useSsl": "SSL 直连",
  "email.smtp.timeoutSeconds": "SMTP 超时",
  "email.subjectTemplate": "验证码邮件主题",
  "email.bodyTemplate": "验证码邮件正文",
  "auth.guestMode": "访客模式",
  "auth.allowGuestRead": "允许访客只读",
  "auth.emailLogin.enabled": "邮箱验证码登录",
  "auth.emailLogin.codeLength": "验证码位数",
  "auth.emailLogin.codeExpiryMinutes": "验证码有效期",
  "auth.emailLogin.resendSeconds": "重发间隔",
  "auth.emailLogin.maxAttempts": "最大尝试次数",
  "auth.emailLogin.precreatedActivationMinutes": "激活链接有效期",
  "auth.sso.enabled": "启用 SSO",
  "auth.sso.providerName": "SSO 提供方名称",
  "auth.sso.issuer": "Issuer",
  "auth.sso.clientId": "Client ID",
  "auth.sso.clientSecret": "Client Secret",
  "auth.sso.scopes": "Scopes",
  "auth.sso.redirectUri": "回调地址",
  "auth.sso.authorizationEndpoint": "授权端点",
  "auth.sso.tokenEndpoint": "Token 端点",
  "auth.sso.userinfoEndpoint": "UserInfo 端点",
  "auth.sso.endSessionEndpoint": "登出端点",
  "auth.sso.claimId": "唯一标识 Claim",
  "auth.sso.claimName": "姓名 Claim",
  "auth.sso.claimEmail": "邮箱 Claim",
  "auth.sso.allowedEmailDomains": "允许的邮箱域名",
  "auth.sso.autoProvision": "自动创建成员",
  "auth.session.cookieName": "会话 Cookie 名",
  "auth.session.maxAgeDays": "登录状态保持天数",
  "auth.session.secureCookie": "仅 HTTPS Cookie",
  "features.allowMemberSelfEdit": "成员自助编辑",
  "features.showGuestBanner": "访客提示条",
  "features.showDemoBadge": "演示数据标识",
  "features.auditLog": "审计日志",
  "features.allowGuestTodoCreate": "访客创建待办",
  modules: "模块展示",
  guestModules: "访客可访问模块",
  "adminWhitelist.ip": "IP / CIDR",
  "adminWhitelist.id": "SSO 标识 / 邮箱",
  "adminWhitelist.name": "显示名称",
  "adminWhitelist.role": "管理角色",
  "adminWhitelist.teamId": "团队",
  "adminWhitelist.note": "备注",
};

function cloneSettings(value: AppSettings): AppSettings {
  return JSON.parse(JSON.stringify(value)) as AppSettings;
}

function prettify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function asValidationDetails(details: unknown): ValidationDetail[] {
  if (!Array.isArray(details)) return [];
  return details.filter((item): item is ValidationDetail => {
    if (!item || typeof item !== "object") return false;
    const record = item as Record<string, unknown>;
    return typeof record.path === "string" && typeof record.message === "string";
  });
}

function readTabFromHash(allowed: TabKey[] = TAB_KEYS, fallback: TabKey = "appearance"): TabKey {
  const raw = hashRoute().params.get("tab") ?? "";
  return allowed.includes(raw as TabKey) ? (raw as TabKey) : fallback;
}

function pathLabel(path: string): string {
  if (FIELD_LABELS[path]) return FIELD_LABELS[path];
  const modulePath = path.match(/^(modules|guestModules)\.([a-zA-Z]+)$/);
  if (modulePath) {
    const meta = MODULE_META.find((item) => item.key === modulePath[2]);
    if (meta) {
      return modulePath[1] === "guestModules" ? `访客访问 · ${meta.label}` : `模块 · ${meta.label}`;
    }
  }
  const entry = path.match(/^auth\.adminWhitelist\.(ips|ids)\.(\d+)\.(.+)$/);
  if (entry) {
    const kind = entry[1] === "ips" ? "IP" : "ID";
    const field = FIELD_LABELS[`adminWhitelist.${entry[3]}`] ?? entry[3];
    return `${kind} 白名单第 ${Number(entry[2]) + 1} 项 · ${field}`;
  }
  const domain = path.match(/^auth\.sso\.allowedEmailDomains\.(\d+)$/);
  if (domain) return `允许的邮箱域名第 ${Number(domain[1]) + 1} 项`;
  return path;
}

function tabForPath(path: string): TabKey | null {
  if (path.startsWith("site")) return "appearance";
  if (
    path.startsWith("modules") ||
    path.startsWith("guestModules") ||
    path.startsWith("announcements") ||
    path.startsWith("calendar") ||
    path.startsWith("redblack") ||
    path.startsWith("features")
  ) {
    return "modules";
  }
  if (path.startsWith("auth.adminWhitelist") || path.startsWith("auth.session")) return "access";
  if (path.startsWith("auth.guestMode") || path.startsWith("auth.allowGuestRead")) return "access";
  if (path.startsWith("auth.emailLogin")) return "access";
  if (path.startsWith("auth.sso")) return "sso";
  if (path.startsWith("email")) return "email";
  if (path.startsWith("version")) return "json";
  return null;
}

function errorText(list: ValidationDetail[]): string | undefined {
  if (!list.length) return undefined;
  return list.map((item) => item.message).join("；");
}

function toInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function setEntryValue(
  kind: "ip" | "id",
  entry: AdminIpEntry | AdminIdEntry,
  value: string,
): AdminIpEntry | AdminIdEntry {
  return kind === "ip"
    ? { ...(entry as AdminIpEntry), ip: value }
    : { ...(entry as AdminIdEntry), id: value };
}

function entryValue(kind: "ip" | "id", entry: AdminIpEntry | AdminIdEntry): string {
  return kind === "ip" ? (entry as AdminIpEntry).ip : (entry as AdminIdEntry).id;
}

function scopeProblem(entry: AdminIpEntry | AdminIdEntry): string | null {
  if (!entry.teamId) return "团队管理员必须选择一个团队";
  return null;
}

/* ------------------------------------------------------------------ */
/* Small presentational primitives                                     */
/* ------------------------------------------------------------------ */

function Field({
  label,
  hint,
  error,
  className,
  children,
  htmlFor,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  className?: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className={cn("field", className, error && "field-has-error")}>
      <label htmlFor={htmlFor}>
        {label}
        {error ? (
          <span className="field-error-inline">
            <AlertTriangle size={11} /> {error}
          </span>
        ) : null}
      </label>
      {children}
      {!error && hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled,
  badge,
}: {
  label: string;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  badge?: ReactNode;
}) {
  return (
    <label className={cn("settings-toggle-row", disabled && "is-disabled")}>
      <span className="settings-toggle-copy">
        <strong>
          {label}
          {badge}
        </strong>
        {description ? <small>{description}</small> : null}
      </span>
      <span className="switch">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="switch-track" />
      </span>
    </label>
  );
}

function SettingsCard({
  title,
  description,
  icon,
  extra,
  children,
  className,
  id,
}: {
  title: string;
  description?: string;
  icon: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section className={cn("card settings-card", className)} id={id}>
      <header className="settings-card-head">
        <span className="settings-card-icon">{icon}</span>
        <div className="settings-card-heading">
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
        {extra ? <div className="settings-card-extra">{extra}</div> : null}
      </header>
      <div className="settings-card-body">{children}</div>
    </section>
  );
}

function StringListEditor({
  items,
  onChange,
  placeholder,
  addLabel = "添加",
  emptyText = "暂无条目",
  type = "text",
}: {
  items: string[];
  onChange: (items: string[]) => void;
  placeholder?: string;
  addLabel?: string;
  emptyText?: string;
  type?: "text" | "email";
}) {
  const [value, setValue] = useState("");
  const commit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (!items.includes(trimmed)) onChange([...items, trimmed]);
    setValue("");
  };
  return (
    <div className="settings-list-editor">
      {items.length ? (
        <div className="tag-list">
          {items.map((item, index) => (
            <span className="chip" key={`${item}-${index}`}>
              {item}
              <button
                type="button"
                className="chip-remove"
                aria-label={`移除 ${item}`}
                onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="field-hint">{emptyText}</p>
      )}
      <div className="settings-list-add">
        <input
          className="input"
          type={type}
          value={value}
          placeholder={placeholder}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
          }}
        />
        <button type="button" className="btn btn-secondary btn-sm" onClick={commit}>
          <Plus size={14} /> {addLabel}
        </button>
      </div>
    </div>
  );
}

function TeamPicker({
  workspace,
  selected,
  onChange,
  emptyText = "工作区中暂无团队。",
}: {
  workspace: WorkspaceOption;
  selected: string[];
  onChange: (ids: string[]) => void;
  emptyText?: string;
}) {
  if (!workspace.teams.length) {
    return <p className="field-hint">{emptyText}</p>;
  }
  return (
    <div className="tag-list settings-team-picker">
      {workspace.teams.map((team) => {
        const active = selected.includes(team.id);
        return (
          <button
            key={team.id}
            type="button"
            className={cn("chip", "chip-clickable", active && "settings-team-chip-active")}
            onClick={() =>
              onChange(active ? selected.filter((id) => id !== team.id) : [...selected, team.id])
            }
          >
            {active ? <Check size={11} /> : null}
            <i className="settings-team-dot" style={{ background: team.color }} />
            {team.name}
          </button>
        );
      })}
    </div>
  );
}

function SettingsAccessDenied({ onBack }: { onBack: () => void }) {
  return (
    <div className="state-screen compact">
      <div className="state-card">
        <span className="state-icon amber">
          <ShieldAlert size={26} />
        </span>
        <h1>仅超级管理员可编辑站点设置</h1>
        <p>
          站点级设置只对<strong>超级管理员</strong>开放：系统内置的 <code>Admin</code>
          以及账号角色为 <code>super</code> 的成员。系统内置 Admin 由服务端按请求来源自动识别，永远存在、
          不写入 <code>settings.json</code>。
        </p>
        <p className="small muted">
          团队管理员可以管理自己被授权团队的团队信息与成员内容，但无法查看或修改站点配置。
        </p>
        <div className="state-actions">
          <button className="btn btn-primary" onClick={onBack}>
            返回团队概览
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Section components                                                  */
/* ------------------------------------------------------------------ */

function AppearanceSection({
  draft,
  update,
  errorsFor,
}: {
  draft: AppSettings;
  update: UpdateSettings;
  errorsFor: ErrorsFor;
}) {
  const { theme: effectiveTheme } = useApp();
  const site = draft.site;
  const theme = site.theme;
  // 明暗主题由每位用户的个性化设置决定（默认跟随系统），站点级不再提供明暗开关。
  // 预览直接使用当前生效主题，强调色与圆角仍取自站点草稿。
  const previewMode: "dark" | "light" = effectiveTheme;
  const previewModeLabel = effectiveTheme === "dark" ? "当前生效 · 暗黑" : "当前生效 · 纸白";
  const previewStyle = {
    "--pv-accent": theme.accent || "#0a59f7",
    "--pv-secondary": theme.accentSecondary || "#4d8dff",
    "--pv-radius": `${theme.radius}px`,
  } as CSSProperties;
  const enabledModules = MODULE_META.filter((item) => draft.modules[item.key]);

  return (
    <div className="settings-sections">
      <SettingsCard
        title="站点身份"
        description="展示在侧边栏、登录页、浏览器标题与邮件中的品牌信息。"
        icon={<Sparkles size={18} />}
      >
        <div className="form-grid">
          <Field label="站点名称" error={errorText(errorsFor("site.name"))} hint="例如：团队工作室">
            <input
              className="input"
              value={site.name}
              maxLength={40}
              onChange={(event) =>
                update((next) => {
                  next.site.name = event.target.value;
                })
              }
            />
          </Field>
          <Field label="站点简称" error={errorText(errorsFor("site.shortName"))} hint="用于紧凑场景，最多 12 字">
            <input
              className="input"
              value={site.shortName}
              maxLength={12}
              onChange={(event) =>
                update((next) => {
                  next.site.shortName = event.target.value;
                })
              }
            />
          </Field>
          <Field label="Logo 文字" error={errorText(errorsFor("site.logoText"))} hint="1-4 个字符，显示在品牌标识中">
            <input
              className="input"
              value={site.logoText}
              maxLength={4}
              onChange={(event) =>
                update((next) => {
                  next.site.logoText = event.target.value;
                })
              }
            />
          </Field>
          <Field
            label="页脚文案"
            error={errorText(errorsFor("site.footerText"))}
            hint="显示在侧边栏底部与登录页"
          >
            <input
              className="input"
              value={site.footerText}
              maxLength={120}
              onChange={(event) =>
                update((next) => {
                  next.site.footerText = event.target.value;
                })
              }
            />
          </Field>
          <Field
            label="品牌标语"
            className="span-2"
            error={errorText(errorsFor("site.tagline"))}
            hint="一句话介绍团队气质，出现在登录页与分享卡片。"
          >
            <textarea
              className="textarea"
              value={site.tagline}
              maxLength={120}
              rows={2}
              onChange={(event) =>
                update((next) => {
                  next.site.tagline = event.target.value;
                })
              }
            />
          </Field>
        </div>
      </SettingsCard>

      <SettingsCard
        title="主题与品牌色"
        description="明暗主题由每位成员的个性化设置决定；站点设置只保留品牌强调色与圆角。"
        icon={<Palette size={18} />}
      >
        <p className="settings-note">
          <Palette size={13} />
          站点不再提供明暗模式开关：实际生效的主题跟随每位用户的「个性化设置」（默认「跟随系统」，会实时响应操作系统 /
          浏览器的明暗切换）。成员可在「个人主页 → 个性化设置」中切换「跟随系统 / 浅色 / 深色」；站点级{" "}
          <code>site.theme.mode</code> 仅作为兼容字段保留，不参与明暗解析。
        </p>
        <div className="settings-theme-grid">
          <Field
            label="主色（强调色）"
            error={errorText(errorsFor("site.theme.accent"))}
            hint="#RRGGBB；用于导航高亮、主按钮与图表强调"
          >
            <div className="settings-color-control">
              <input
                type="color"
                value={/^#[0-9a-fA-F]{6}$/.test(theme.accent) ? theme.accent : "#0a59f7"}
                aria-label="主色取色器"
                onChange={(event) =>
                  update((next) => {
                    next.site.theme.accent = event.target.value;
                  })
                }
              />
              <input
                className="input"
                value={theme.accent}
                maxLength={7}
                spellCheck={false}
                onChange={(event) =>
                  update((next) => {
                    next.site.theme.accent = event.target.value;
                  })
                }
              />
            </div>
          </Field>

          <Field
            label="辅助色"
            error={errorText(errorsFor("site.theme.accentSecondary"))}
            hint="#RRGGBB；用于渐变与次级强调"
          >
            <div className="settings-color-control">
              <input
                type="color"
                value={
                  /^#[0-9a-fA-F]{6}$/.test(theme.accentSecondary)
                    ? theme.accentSecondary
                    : "#4d8dff"
                }
                aria-label="辅助色取色器"
                onChange={(event) =>
                  update((next) => {
                    next.site.theme.accentSecondary = event.target.value;
                  })
                }
              />
              <input
                className="input"
                value={theme.accentSecondary}
                maxLength={7}
                spellCheck={false}
                onChange={(event) =>
                  update((next) => {
                    next.site.theme.accentSecondary = event.target.value;
                  })
                }
              />
            </div>
          </Field>

          <Field
            label="卡片圆角"
            className="span-2"
            error={errorText(errorsFor("site.theme.radius"))}
            hint="8 - 32 px"
          >
            <div className="settings-range">
              <input
                type="range"
                min={8}
                max={32}
                value={theme.radius}
                onChange={(event) =>
                  update((next) => {
                    next.site.theme.radius = toInt(event.target.value, 18);
                  })
                }
              />
              <span className="settings-range-value">{theme.radius}px</span>
            </div>
          </Field>
        </div>
      </SettingsCard>

      <SettingsCard
        title="实时预览"
        description="强调色与圆角会以当前草稿值渲染；明暗跟随当前生效的主题。"
        icon={<Eye size={18} />}
      >
        <div
          className="settings-preview"
          data-preview-mode={previewMode}
          style={previewStyle}
        >
          <div className="settings-preview-brand">
            <span className="settings-preview-logo">{site.logoText || "TS"}</span>
            <div>
              <strong>{site.name || "未命名团队工作室"}</strong>
              <small>{site.shortName || "SHORT"}</small>
            </div>
            <span className="settings-preview-mode">{previewModeLabel}</span>
          </div>
          <p className="settings-preview-tagline">{site.tagline || "在这里写一句品牌标语。"}</p>
          <div className="settings-preview-nav">
            {enabledModules.slice(0, 5).map((module) => {
              const Icon = module.icon;
              return (
                <span key={module.key} className="settings-preview-nav-item">
                  <Icon size={13} /> {module.label}
                </span>
              );
            })}
            {!enabledModules.length ? (
              <span className="settings-preview-nav-item is-off">所有模块均已隐藏</span>
            ) : null}
          </div>
          <div className="settings-preview-actions">
            <span className="settings-preview-button">主要按钮</span>
            <span className="settings-preview-button ghost">次要按钮</span>
            <span className="settings-preview-chip">圆角 {theme.radius}px</span>
          </div>
          <footer>{site.footerText || "TeamStudio"}</footer>
        </div>
      </SettingsCard>
    </div>
  );
}

function ModulesSection({
  draft,
  update,
  errorsFor,
}: {
  draft: AppSettings;
  update: UpdateSettings;
  errorsFor: ErrorsFor;
}) {
  return (
    <div className="settings-sections">
      <SettingsCard
        title="模块展示"
        description="关闭的模块会从导航中隐藏；直接访问链接对管理员仍然可用，可随时重新开启。"
        icon={<LayoutGrid size={18} />}
      >
        <div className="settings-toggle-grid">
          {MODULE_META.map((module) => {
            const Icon = module.icon;
            return (
              <div className={cn("settings-module-toggle", draft.modules[module.key] && "is-on")} key={module.key}>
                <span className="settings-module-icon">
                  <Icon size={16} />
                </span>
                <ToggleRow
                  label={module.label}
                  description={module.description}
                  checked={draft.modules[module.key]}
                  onChange={(checked) =>
                    update((next) => {
                      next.modules[module.key] = checked;
                    })
                  }
                />
              </div>
            );
          })}
        </div>
      </SettingsCard>

      <SettingsCard
        title="访客可访问模块"
        description="未登录访客只能访问被放行的模块：导航会隐藏未放行的入口，服务端接口也会按同样规则再次校验。系统设置始终不对访客开放。"
        icon={<Eye size={18} />}
        extra={<span className="badge badge-gray">仅访客生效</span>}
      >
        <div className="settings-toggle-grid">
          {MODULE_META.filter((module) => module.key !== "settings").map((module) => {
            const Icon = module.icon;
            const moduleEnabled = draft.modules[module.key];
            return (
              <div
                className={cn(
                  "settings-module-toggle",
                  moduleEnabled && draft.guestModules[module.key] && "is-on",
                )}
                key={`guest-${module.key}`}
              >
                <span className="settings-module-icon">
                  <Icon size={16} />
                </span>
                <ToggleRow
                  label={module.label}
                  description={
                    moduleEnabled
                      ? module.description
                      : "该模块已在「模块展示」中关闭，访客同样不可访问。"
                  }
                  badge={
                    moduleEnabled ? undefined : <span className="badge badge-gray">模块已关闭</span>
                  }
                  checked={draft.guestModules[module.key]}
                  disabled={!moduleEnabled}
                  onChange={(checked) =>
                    update((next) => {
                      next.guestModules[module.key] = checked;
                    })
                  }
                />
              </div>
            );
          })}
        </div>
        <p className="settings-note">
          <ShieldCheck size={13} />
          此处只决定「访客能访问哪些模块」；关闭「访客模式」或「允许访客只读」后，访客将完全无法浏览内容。
          「系统设置」模块不对访客开放，也不会出现在上面的列表中。
        </p>
      </SettingsCard>

      <div className="settings-two-col">
        <SettingsCard
          title="公告与概览"
          description="控制置顶公告数量与概览页展示条数。"
          icon={<Megaphone size={18} />}
        >
          <div className="form-grid">
            <Field
              label="置顶公告上限"
              error={errorText(errorsFor("announcements.maxPinned"))}
              hint="0 - 3 条，0 表示禁止置顶"
            >
              <input
                className="input"
                type="number"
                min={0}
                max={3}
                value={draft.announcements.maxPinned}
                onChange={(event) =>
                  update((next) => {
                    next.announcements.maxPinned = toInt(event.target.value, 3);
                  })
                }
              />
            </Field>
            <Field
              label="概览展示数量"
              error={errorText(errorsFor("announcements.dashboardLimit"))}
              hint="1 - 10 条"
            >
              <input
                className="input"
                type="number"
                min={1}
                max={10}
                value={draft.announcements.dashboardLimit}
                onChange={(event) =>
                  update((next) => {
                    next.announcements.dashboardLimit = toInt(event.target.value, 4);
                  })
                }
              />
            </Field>
            <div className="span-2">
              <ToggleRow
                label="在团队概览展示公告"
                description="关闭后公告仅出现在公告栏页面。"
                checked={draft.announcements.showOnDashboard}
                onChange={(checked) =>
                  update((next) => {
                    next.announcements.showOnDashboard = checked;
                  })
                }
              />
            </div>
          </div>
        </SettingsCard>

        <SettingsCard
          title="日历展示"
          description="设置协作日历的展示偏好与逾期策略。"
          icon={<CalendarDays size={18} />}
        >
          <div className="form-grid">
            <Field label="每周起始日" error={errorText(errorsFor("calendar.weekStartsOn"))}>
              <div className="segmented">
                <button
                  type="button"
                  className={draft.calendar.weekStartsOn === 1 ? "active" : undefined}
                  onClick={() =>
                    update((next) => {
                      next.calendar.weekStartsOn = 1;
                    })
                  }
                >
                  周一
                </button>
                <button
                  type="button"
                  className={draft.calendar.weekStartsOn === 0 ? "active" : undefined}
                  onClick={() =>
                    update((next) => {
                      next.calendar.weekStartsOn = 0;
                    })
                  }
                >
                  周日
                </button>
              </div>
            </Field>
            <div className="span-2 settings-toggle-stack">
              <ToggleRow
                label="展示周末"
                description="关闭后日历仅显示工作日，数据不受影响。"
                checked={draft.calendar.showWeekends}
                onChange={(checked) =>
                  update((next) => {
                    next.calendar.showWeekends = checked;
                  })
                }
              />
              <ToggleRow
                label="允许设置过去日期"
                description="关闭后新建待办不能选择今天之前的日期。"
                checked={draft.calendar.allowPastDue}
                onChange={(checked) =>
                  update((next) => {
                    next.calendar.allowPastDue = checked;
                  })
                }
              />
            </div>
          </div>
        </SettingsCard>
      </div>

      <div className="settings-two-col">
        <SettingsCard
          title="红黑榜"
          description="自定义两个榜单的称呼与展示细节。"
          icon={<Trophy size={18} />}
        >
          <div className="form-grid">
            <Field label="红榜名称" error={errorText(errorsFor("redblack.redLabel"))}>
              <input
                className="input"
                value={draft.redblack.redLabel}
                onChange={(event) =>
                  update((next) => {
                    next.redblack.redLabel = event.target.value;
                  })
                }
              />
            </Field>
            <Field label="黑榜名称" error={errorText(errorsFor("redblack.blackLabel"))}>
              <input
                className="input"
                value={draft.redblack.blackLabel}
                onChange={(event) =>
                  update((next) => {
                    next.redblack.blackLabel = event.target.value;
                  })
                }
              />
            </Field>
            <div className="span-2 settings-toggle-stack">
              <ToggleRow
                label="展示分数"
                description="关闭后只展示事迹与理由，不显示分值。"
                checked={draft.redblack.showScores}
                onChange={(checked) =>
                  update((next) => {
                    next.redblack.showScores = checked;
                  })
                }
              />
              <ToggleRow
                label="启用月度主题"
                description="允许每月设置红黑榜主题文案。"
                checked={draft.redblack.monthlyThemeEnabled}
                onChange={(checked) =>
                  update((next) => {
                    next.redblack.monthlyThemeEnabled = checked;
                  })
                }
              />
            </div>
          </div>
        </SettingsCard>

        <SettingsCard
          title="功能开关"
          description="协作体验与安全相关的细粒度开关。"
          icon={<Settings2 size={18} />}
        >
          <div className="settings-toggle-stack">
            <ToggleRow
              label="成员自助编辑"
              description="允许成员编辑自己的资料与作品记录。"
              checked={draft.features.allowMemberSelfEdit}
              onChange={(checked) =>
                update((next) => {
                  next.features.allowMemberSelfEdit = checked;
                })
              }
            />
            <ToggleRow
              label="访客提示条"
              description="访客模式顶部显示只读提示与登录入口。"
              checked={draft.features.showGuestBanner}
              onChange={(checked) =>
                update((next) => {
                  next.features.showGuestBanner = checked;
                })
              }
            />
            <ToggleRow
              label="演示数据标识"
              description="在示例数据旁展示演示标签。"
              checked={draft.features.showDemoBadge}
              onChange={(checked) =>
                update((next) => {
                  next.features.showDemoBadge = checked;
                })
              }
            />
            <ToggleRow
              label="审计日志"
              description="记录设置与内容变更，便于追溯。"
              checked={draft.features.auditLog}
              onChange={(checked) =>
                update((next) => {
                  next.features.auditLog = checked;
                })
              }
            />
            <ToggleRow
              label="允许访客创建待办"
              description="开启后未登录访客也可以创建日历待办。"
              checked={draft.features.allowGuestTodoCreate}
              onChange={(checked) =>
                update((next) => {
                  next.features.allowGuestTodoCreate = checked;
                })
              }
            />
          </div>
        </SettingsCard>
      </div>
    </div>
  );
}

function AdminEntryCard({
  kind,
  index,
  entry,
  workspace,
  errorsFor,
  onChange,
  onRemove,
}: {
  kind: "ip" | "id";
  index: number;
  entry: AdminIpEntry | AdminIdEntry;
  workspace: WorkspaceOption;
  errorsFor: ErrorsFor;
  onChange: (next: AdminIpEntry | AdminIdEntry) => void;
  onRemove: () => void;
}) {
  const basePath = `auth.adminWhitelist.${kind === "ip" ? "ips" : "ids"}.${index}`;
  const teams = workspace.teams;
  const problem = scopeProblem(entry);

  return (
    <article className={cn("settings-admin-entry", problem && "has-problem")}>
      <header className="settings-admin-entry-head">
        <span className="settings-admin-entry-tag">
          {kind === "ip" ? <Globe size={13} /> : <Fingerprint size={13} />}
          {kind === "ip" ? `IP 白名单 #${index + 1}` : `ID 白名单 #${index + 1}`}
        </span>
        <div className="settings-admin-entry-actions">
          <span className="badge badge-orange">团队管理员</span>
          <button
            type="button"
            className="icon-button settings-icon-danger"
            aria-label="删除该白名单条目"
            onClick={onRemove}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </header>

      <div className="form-grid">
        <Field
          label={kind === "ip" ? "IP / CIDR" : "SSO 标识 / 邮箱"}
          error={errorText(errorsFor(`${basePath}.${kind === "ip" ? "ip" : "id"}`))}
          hint={
            kind === "ip"
              ? "支持单个 IP 或 CIDR，例如 192.168.1.20、10.0.0.0/24"
              : "填写 SSO 的 sub / 唯一标识或登录邮箱，匹配时忽略大小写"
          }
        >
          <input
            className="input"
            value={entryValue(kind, entry)}
            placeholder={kind === "ip" ? "10.0.0.0/24" : "user@company.com"}
            spellCheck={false}
            onChange={(event) => onChange(setEntryValue(kind, entry, event.target.value))}
          />
        </Field>
        <Field
          label="显示名称"
          error={errorText(errorsFor(`${basePath}.name`))}
          hint="展示在身份信息与审计记录中"
        >
          <input
            className="input"
            value={entry.name}
            maxLength={60}
            onChange={(event) => onChange({ ...entry, name: event.target.value })}
          />
        </Field>
        <Field
          label="团队"
          error={errorText(errorsFor(`${basePath}.teamId`))}
          hint="白名单条目只能授予一个团队的管理权限"
        >
          <Select
            value={entry.teamId}
            onChange={(teamId) => onChange({ ...entry, teamId })}
            ariaLabel="白名单条目所属团队"
            placeholder="未指定团队"
            options={[
              { value: "", label: "未指定团队" },
              ...teams.map((team) => ({ value: team.id, label: team.name })),
            ]}
          />
        </Field>
        <Field
          label="备注"
          error={errorText(errorsFor(`${basePath}.note`))}
          hint="例如：运维值班机、外部审计账号"
        >
          <input
            className="input"
            value={entry.note}
            maxLength={200}
            onChange={(event) => onChange({ ...entry, note: event.target.value })}
          />
        </Field>
      </div>
      {problem ? (
        <p className="settings-entry-problem">
          <AlertTriangle size={13} /> {problem}
        </p>
      ) : (
        <p className="settings-entry-ok">
          <CheckCircle2 size={13} /> 范围有效：仅授予所选团队的管理权限
        </p>
      )}
    </article>
  );
}

function AccessSection({
  draft,
  update,
  errorsFor,
  workspace,
  meta,
}: {
  draft: AppSettings;
  update: UpdateSettings;
  errorsFor: ErrorsFor;
  workspace: WorkspaceOption;
  meta: SettingsMeta | null;
}) {
  const whitelist = draft.auth.adminWhitelist;
  const deviceAdminName = meta?.deviceAdminName ?? "Admin";

  const mutateWhitelist = (mutate: (next: Whitelist) => void) => {
    update((next) => {
      mutate(next.auth.adminWhitelist);
    });
  };

  const addIp = () => {
    const firstTeam = workspace.teams[0];
    mutateWhitelist((next) => {
      next.ips.push({
        ip: "",
        name: "",
        role: "team_admin",
        teamId: firstTeam?.id ?? "",
        note: "",
      });
    });
  };

  const addId = () => {
    const firstTeam = workspace.teams[0];
    mutateWhitelist((next) => {
      next.ids.push({
        id: "",
        name: "",
        role: "team_admin",
        teamId: firstTeam?.id ?? "",
        note: "",
      });
    });
  };

  return (
    <div className="settings-sections">
      <SettingsCard
        title="超级管理员与系统内置 Admin"
        description="站点级设置仅超级管理员可编辑；系统内置的 Admin 始终拥有最高权限。"
        icon={<ShieldCheck size={18} />}
        extra={<span className="badge badge-green">始终可用</span>}
      >
        <div className="settings-device-note">
          <div className="settings-device-badge">
            <span className="settings-device-avatar">{deviceAdminName.slice(0, 2).toUpperCase()}</span>
            <div>
              <strong>{deviceAdminName}</strong>
              <span>系统内置管理员 · 超级管理员</span>
            </div>
          </div>
          <ul className="settings-device-points">
            <li>
              <CheckCircle2 size={14} />
              来自本机回环地址或本机自身 IPv4 的请求会自动获得该身份；系统内置管理员可在登录页退出，随后改用其他账号登录。
            </li>
            <li>
              <CheckCircle2 size={14} />
              该身份不保存在 <code>data/settings.json</code> 中，也不会出现在账号列表里被管理。
            </li>
            <li>
              <CheckCircle2 size={14} />
              账号角色为 <code>super</code> 的超级管理员与系统内置 Admin 拥有相同的站点级权限：可编辑本页设置、
              管理账号与角色、查看所有团队。
            </li>
            <li>
              <ShieldAlert size={14} />
              团队管理员只能管理被授权的团队，无法查看或修改本页站点配置。
            </li>
          </ul>
        </div>
      </SettingsCard>

      <SettingsCard
        title="访客与登录策略"
        description="邮箱验证码登录、企业 SSO 与访客降级行为。"
        icon={<Users size={18} />}
      >
        <div className="settings-toggle-stack">
          <ToggleRow
            label="启用访客模式"
            description="关闭后未认证访客将无法浏览团队内容。"
            checked={draft.auth.guestMode}
            onChange={(checked) =>
              update((next) => {
                next.auth.guestMode = checked;
              })
            }
          />
          <ToggleRow
            label="允许访客只读"
            description="访客可查看概览、日历、红黑榜等公开内容但不能写入。"
            checked={draft.auth.allowGuestRead}
            onChange={(checked) =>
              update((next) => {
                next.auth.allowGuestRead = checked;
              })
            }
          />
        </div>

        <div className="divider" />

        <div className="settings-toggle-stack">
          <ToggleRow
            label="邮箱验证码登录"
            description="使用邮箱 + 六位验证码登录；预创建账号通过一次性激活链接激活，无需验证码邮件。"
            checked={draft.auth.emailLogin.enabled}
            onChange={(checked) =>
              update((next) => {
                next.auth.emailLogin.enabled = checked;
              })
            }
          />
        </div>
        <div className="form-grid">
          <Field
            label="验证码位数"
            error={errorText(errorsFor("auth.emailLogin.codeLength"))}
            hint="4 - 8 位，默认 6 位"
          >
            <input
              className="input"
              type="number"
              min={4}
              max={8}
              value={draft.auth.emailLogin.codeLength}
              onChange={(event) =>
                update((next) => {
                  next.auth.emailLogin.codeLength = toInt(event.target.value, 6);
                })
              }
            />
          </Field>
          <Field
            label="验证码有效期（分钟）"
            error={errorText(errorsFor("auth.emailLogin.codeExpiryMinutes"))}
            hint="2 - 30 分钟，默认 10 分钟"
          >
            <input
              className="input"
              type="number"
              min={2}
              max={30}
              value={draft.auth.emailLogin.codeExpiryMinutes}
              onChange={(event) =>
                update((next) => {
                  next.auth.emailLogin.codeExpiryMinutes = toInt(event.target.value, 10);
                })
              }
            />
          </Field>
          <Field
            label="重发间隔（秒）"
            error={errorText(errorsFor("auth.emailLogin.resendSeconds"))}
            hint="30 - 600 秒，默认 60 秒"
          >
            <input
              className="input"
              type="number"
              min={30}
              max={600}
              value={draft.auth.emailLogin.resendSeconds}
              onChange={(event) =>
                update((next) => {
                  next.auth.emailLogin.resendSeconds = toInt(event.target.value, 60);
                })
              }
            />
          </Field>
          <Field
            label="最大尝试次数"
            error={errorText(errorsFor("auth.emailLogin.maxAttempts"))}
            hint="3 - 10 次，超过后本次验证码失效"
          >
            <input
              className="input"
              type="number"
              min={3}
              max={10}
              value={draft.auth.emailLogin.maxAttempts}
              onChange={(event) =>
                update((next) => {
                  next.auth.emailLogin.maxAttempts = toInt(event.target.value, 5);
                })
              }
            />
          </Field>
          <Field
            label="激活链接有效期（分钟）"
            error={errorText(errorsFor("auth.emailLogin.precreatedActivationMinutes"))}
            hint="1 - 120 分钟，默认 10 分钟；预创建账号的激活链接一次性有效"
          >
            <input
              className="input"
              type="number"
              min={1}
              max={120}
              value={draft.auth.emailLogin.precreatedActivationMinutes}
              onChange={(event) =>
                update((next) => {
                  next.auth.emailLogin.precreatedActivationMinutes = toInt(
                    event.target.value,
                    10,
                  );
                })
              }
            />
          </Field>
        </div>
        <p className="settings-note">
          <Mail size={13} />
          验证码仅以 HMAC 哈希保存在 <code>email_codes</code> 表中；预创建账号的激活令牌只保存
          SHA-256 哈希，链接一次性有效。邮件内容与 SMTP 中继在「邮件服务」中配置。
        </p>

        <div className="divider" />
        <div className="form-grid">
          <Field
            label="会话 Cookie 名称"
            error={errorText(errorsFor("auth.session.cookieName"))}
            hint="3 - 64 个字符，建议保持默认"
          >
            <input
              className="input"
              value={draft.auth.session.cookieName}
              spellCheck={false}
              onChange={(event) =>
                update((next) => {
                  next.auth.session.cookieName = event.target.value;
                })
              }
            />
          </Field>
          <Field
            label="登录状态保持天数"
            error={errorText(errorsFor("auth.session.maxAgeDays"))}
            hint="登录状态保持天数，默认 7 天，每次访问自动续期"
          >
            <input
              className="input"
              type="number"
              min={1}
              max={90}
              value={draft.auth.session.maxAgeDays}
              onChange={(event) =>
                update((next) => {
                  next.auth.session.maxAgeDays = toInt(event.target.value, 7);
                })
              }
            />
          </Field>
          <div className="span-2">
            <ToggleRow
              label="仅 HTTPS Cookie"
              description="生产环境启用后，Cookie 只会通过 HTTPS 发送。"
              checked={draft.auth.session.secureCookie}
              onChange={(checked) =>
                update((next) => {
                  next.auth.session.secureCookie = checked;
                })
              }
            />
          </div>
        </div>
      </SettingsCard>

      <SettingsCard
        title="IP 白名单"
        description="按来源 IP / CIDR 授权管理员，无需 SSO 登录。"
        icon={<Globe size={18} />}
        extra={
          <button type="button" className="btn btn-secondary btn-sm" onClick={addIp}>
            <Plus size={14} /> 新增 IP
          </button>
        }
      >
        {whitelist.ips.length ? (
          <div className="settings-admin-list">
            {whitelist.ips.map((entry, index) => (
              <AdminEntryCard
                key={`ip-${index}`}
                kind="ip"
                index={index}
                entry={entry}
                workspace={workspace}
                errorsFor={errorsFor}
                onChange={(next) =>
                  mutateWhitelist((list) => {
                    list.ips[index] = next as AdminIpEntry;
                  })
                }
                onRemove={() =>
                  mutateWhitelist((list) => {
                    list.ips.splice(index, 1);
                  })
                }
              />
            ))}
          </div>
        ) : (
          <div className="settings-inline-empty">
            <Globe size={18} />
            <div>
              <strong>尚未配置 IP 白名单</strong>
              <p>来自内网的固定办公机或运维跳板机可以在这里获得团队管理员权限。</p>
            </div>
            <button type="button" className="btn btn-secondary btn-sm" onClick={addIp}>
              <Plus size={14} /> 新增第一条
            </button>
          </div>
        )}
      </SettingsCard>

      <SettingsCard
        title="ID 白名单"
        description="SSO 登录成功后，按唯一标识或邮箱匹配管理员权限。"
        icon={<Fingerprint size={18} />}
        extra={
          <button type="button" className="btn btn-secondary btn-sm" onClick={addId}>
            <Plus size={14} /> 新增 ID
          </button>
        }
      >
        {whitelist.ids.length ? (
          <div className="settings-admin-list">
            {whitelist.ids.map((entry, index) => (
              <AdminEntryCard
                key={`id-${index}`}
                kind="id"
                index={index}
                entry={entry}
                workspace={workspace}
                errorsFor={errorsFor}
                onChange={(next) =>
                  mutateWhitelist((list) => {
                    list.ids[index] = next as AdminIdEntry;
                  })
                }
                onRemove={() =>
                  mutateWhitelist((list) => {
                    list.ids.splice(index, 1);
                  })
                }
              />
            ))}
          </div>
        ) : (
          <div className="settings-inline-empty">
            <Fingerprint size={18} />
            <div>
              <strong>尚未配置 ID 白名单</strong>
              <p>通过企业 SSO 登录的团队成员可以在这里获得对应团队的管理权限。</p>
            </div>
            <button type="button" className="btn btn-secondary btn-sm" onClick={addId}>
              <Plus size={14} /> 新增第一条
            </button>
          </div>
        )}
      </SettingsCard>
    </div>
  );
}

function SsoSection({
  draft,
  update,
  errorsFor,
}: {
  draft: AppSettings;
  update: UpdateSettings;
  errorsFor: ErrorsFor;
}) {
  const sso = draft.auth.sso;
  const [showSecret, setShowSecret] = useState(false);
  const missingFields = useMemo(() => {
    const required: { key: keyof typeof sso; label: string }[] = [
      { key: "issuer", label: "Issuer" },
      { key: "clientId", label: "Client ID" },
      { key: "clientSecret", label: "Client Secret" },
      { key: "redirectUri", label: "回调地址" },
    ];
    return required.filter((item) => !String(sso[item.key] ?? "").trim()).map((item) => item.label);
  }, [sso]);
  const configured = sso.enabled && missingFields.length === 0;

  return (
    <div className="settings-sections">
      <SettingsCard
        title="身份接入状态"
        description="通过标准 OIDC 授权码流程接入企业身份；未配置时自动回退访客模式。"
        icon={<Fingerprint size={18} />}
        extra={
          <span className={cn("badge", configured ? "badge-green" : sso.enabled ? "badge-orange" : "badge-gray")}>
            {configured ? "已就绪" : sso.enabled ? "配置不完整" : "未启用"}
          </span>
        }
      >
        <div className="settings-sso-status">
          <div className="settings-sso-item">
            <span className="settings-sso-label">SSO 开关</span>
            <strong>{sso.enabled ? "已启用" : "已停用"}</strong>
          </div>
          <div className="settings-sso-item">
            <span className="settings-sso-label">提供方</span>
            <strong>{sso.providerName || "未命名"}</strong>
          </div>
          <div className="settings-sso-item">
            <span className="settings-sso-label">Issuer</span>
            <strong className="mono">{sso.issuer || "—"}</strong>
          </div>
          <div className="settings-sso-item">
            <span className="settings-sso-label">回调地址</span>
            <strong className="mono">{sso.redirectUri || "—"}</strong>
          </div>
        </div>
        {missingFields.length ? (
          <p className="settings-sso-missing">
            <AlertTriangle size={13} />
            仍缺少：{missingFields.join(" / ")}。在补全并启用之前，登录会带上 <code>sso=unconfigured</code> 自动回退访客。
          </p>
        ) : (
          <p className="settings-sso-ready">
            <CheckCircle2 size={13} />
            配置完整：启用后登录页会显示「使用 {sso.providerName} 登录」，SSO 身份会按 ID 白名单匹配管理权限。
          </p>
        )}
        <div className="settings-sso-fallback">
          <Lock size={14} />
          <span>
            <strong>回退策略：</strong>
            {draft.auth.guestMode
              ? "SSO 不可用时访客仍可浏览公开内容；登录入口会提示未配置并自动以访客模式进入。"
              : "SSO 不可用且访客模式关闭时，未认证请求将无法读取团队内容。"}
          </span>
        </div>
      </SettingsCard>

      <SettingsCard
        title="OIDC 基础配置"
        description="与身份提供方（Keycloak / Azure AD / 飞书 / Okta 等）登记的信息保持一致。"
        icon={<KeyRound size={18} />}
      >
        <div className="settings-toggle-stack">
          <ToggleRow
            label="启用企业 SSO"
            description="关闭后忽略以下配置并始终以访客模式运行。"
            checked={sso.enabled}
            onChange={(checked) =>
              update((next) => {
                next.auth.sso.enabled = checked;
              })
            }
          />
        </div>
        <div className="divider" />
        <div className="form-grid">
          <Field label="提供方名称" error={errorText(errorsFor("auth.sso.providerName"))} hint="显示在登录按钮上">
            <input
              className="input"
              value={sso.providerName}
              onChange={(event) =>
                update((next) => {
                  next.auth.sso.providerName = event.target.value;
                })
              }
            />
          </Field>
          <Field label="Scopes" error={errorText(errorsFor("auth.sso.scopes"))} hint="通常为 openid profile email">
            <input
              className="input"
              value={sso.scopes}
              spellCheck={false}
              onChange={(event) =>
                update((next) => {
                  next.auth.sso.scopes = event.target.value;
                })
              }
            />
          </Field>
          <Field label="Issuer" error={errorText(errorsFor("auth.sso.issuer"))} hint="例如 https://id.example.com/realms/team">
            <input
              className="input"
              value={sso.issuer}
              spellCheck={false}
              onChange={(event) =>
                update((next) => {
                  next.auth.sso.issuer = event.target.value;
                })
              }
            />
          </Field>
          <Field label="Client ID" error={errorText(errorsFor("auth.sso.clientId"))}>
            <input
              className="input"
              value={sso.clientId}
              spellCheck={false}
              onChange={(event) =>
                update((next) => {
                  next.auth.sso.clientId = event.target.value;
                })
              }
            />
          </Field>
          <Field
            label="Client Secret"
            error={errorText(errorsFor("auth.sso.clientSecret"))}
            hint="仅保存在服务端 settings.json，不会回传到公开接口"
          >
            <div className="settings-secret-control">
              <input
                className="input"
                type={showSecret ? "text" : "password"}
                value={sso.clientSecret}
                spellCheck={false}
                autoComplete="new-password"
                onChange={(event) =>
                  update((next) => {
                    next.auth.sso.clientSecret = event.target.value;
                  })
                }
              />
              <button
                type="button"
                className="icon-button"
                aria-label={showSecret ? "隐藏密钥" : "显示密钥"}
                onClick={() => setShowSecret((value) => !value)}
              >
                {showSecret ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </Field>
          <Field
            label="回调地址"
            error={errorText(errorsFor("auth.sso.redirectUri"))}
            hint="必须与 IdP 中登记的重定向 URI 完全一致"
          >
            <input
              className="input"
              value={sso.redirectUri}
              spellCheck={false}
              onChange={(event) =>
                update((next) => {
                  next.auth.sso.redirectUri = event.target.value;
                })
              }
            />
          </Field>
          <Field
            label="允许的邮箱域名"
            className="span-2"
            error={errorText(errorsFor("auth.sso.allowedEmailDomains"))}
            hint="留空表示不限制；填写后仅匹配这些域名（例如 company.com）。"
          >
            <StringListEditor
              items={sso.allowedEmailDomains}
              placeholder="company.com"
              addLabel="添加域名"
              emptyText="未限制邮箱域名"
              onChange={(items) =>
                update((next) => {
                  next.auth.sso.allowedEmailDomains = items;
                })
              }
            />
          </Field>
          <div className="span-2">
            <ToggleRow
              label="自动创建成员"
              description="SSO 首次登录时若未匹配到成员，可自动创建成员档案。"
              checked={sso.autoProvision}
              onChange={(checked) =>
                update((next) => {
                  next.auth.sso.autoProvision = checked;
                })
              }
            />
          </div>
        </div>
      </SettingsCard>

      <SettingsCard
        title="手动端点（可选）"
        description="留空时优先使用 Issuer 自动发现；自建 IdP 可在此显式指定。"
        icon={<Server size={18} />}
      >
        <div className="form-grid">
          <Field label="授权端点" error={errorText(errorsFor("auth.sso.authorizationEndpoint"))}>
            <input
              className="input"
              value={sso.authorizationEndpoint}
              placeholder="https://id.example.com/oauth2/authorize"
              spellCheck={false}
              onChange={(event) =>
                update((next) => {
                  next.auth.sso.authorizationEndpoint = event.target.value;
                })
              }
            />
          </Field>
          <Field label="Token 端点" error={errorText(errorsFor("auth.sso.tokenEndpoint"))}>
            <input
              className="input"
              value={sso.tokenEndpoint}
              placeholder="https://id.example.com/oauth2/token"
              spellCheck={false}
              onChange={(event) =>
                update((next) => {
                  next.auth.sso.tokenEndpoint = event.target.value;
                })
              }
            />
          </Field>
          <Field label="UserInfo 端点" error={errorText(errorsFor("auth.sso.userinfoEndpoint"))}>
            <input
              className="input"
              value={sso.userinfoEndpoint}
              placeholder="https://id.example.com/oauth2/userinfo"
              spellCheck={false}
              onChange={(event) =>
                update((next) => {
                  next.auth.sso.userinfoEndpoint = event.target.value;
                })
              }
            />
          </Field>
          <Field label="登出端点" error={errorText(errorsFor("auth.sso.endSessionEndpoint"))}>
            <input
              className="input"
              value={sso.endSessionEndpoint}
              placeholder="https://id.example.com/oauth2/logout"
              spellCheck={false}
              onChange={(event) =>
                update((next) => {
                  next.auth.sso.endSessionEndpoint = event.target.value;
                })
              }
            />
          </Field>
        </div>
      </SettingsCard>

      <SettingsCard
        title="Claim 映射"
        description="声明 OIDC 用户信息中哪个字段对应系统所需的数据。"
        icon={<Globe size={18} />}
      >
        <div className="form-grid">
          <Field
            label="唯一标识 Claim"
            error={errorText(errorsFor("auth.sso.claimId"))}
            hint="用于匹配 ID 白名单，默认 sub"
          >
            <input
              className="input"
              value={sso.claimId}
              onChange={(event) =>
                update((next) => {
                  next.auth.sso.claimId = event.target.value;
                })
              }
            />
          </Field>
          <Field label="姓名 Claim" error={errorText(errorsFor("auth.sso.claimName"))} hint="默认 name">
            <input
              className="input"
              value={sso.claimName}
              onChange={(event) =>
                update((next) => {
                  next.auth.sso.claimName = event.target.value;
                })
              }
            />
          </Field>
          <Field label="邮箱 Claim" error={errorText(errorsFor("auth.sso.claimEmail"))} hint="默认 email">
            <input
              className="input"
              value={sso.claimEmail}
              onChange={(event) =>
                update((next) => {
                  next.auth.sso.claimEmail = event.target.value;
                })
              }
            />
          </Field>
        </div>
        <p className="settings-note">
          <ShieldCheck size={13} />
          SSO 登录后，系统会用 <code>id</code> / <code>email</code> / <code>sub</code> 匹配 ID 白名单来确定团队管理权限；
          未匹配的白名单身份仍可作为普通成员或访客访问。
        </p>
      </SettingsCard>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Accounts & roles (super administrators only)                        */
/* ------------------------------------------------------------------ */

const ROLE_OPTIONS: { value: UserRole; label: string }[] = [
  { value: "member", label: "成员" },
  { value: "team_admin", label: "团队管理员" },
  { value: "super", label: "超级管理员" },
];

const ROLE_BADGE: Record<UserRole, string> = {
  member: "badge-gray",
  team_admin: "badge-orange",
  super: "badge-violet",
};

const ACCOUNT_EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function roleLabel(role: UserRole): string {
  return ROLE_OPTIONS.find((item) => item.value === role)?.label ?? role;
}

interface AccountDraft {
  name: string;
  role: UserRole;
  teamIds: string[];
}

function emptyAccountDraft(): AccountDraft {
  return { name: "", role: "member", teamIds: [] };
}

function accountScopeIssue(role: UserRole, teamIds: string[]): string | null {
  if (role === "team_admin" && teamIds.length === 0) return "团队管理员至少需要指定一个团队";
  return null;
}

function AccountScopeEditor({
  workspace,
  draft,
  onChange,
}: {
  workspace: WorkspaceOption;
  draft: AccountDraft;
  onChange: (next: AccountDraft) => void;
}) {
  if (draft.role === "team_admin") {
    return (
      <Field
        label="授权团队"
        className="span-2"
        hint="团队管理员可管理所选团队的成员、任务与团队信息；站点级设置仍仅超级管理员可编辑。"
      >
        <TeamPicker
          workspace={workspace}
          selected={draft.teamIds}
          onChange={(teamIds) => onChange({ ...draft, teamIds })}
        />
      </Field>
    );
  }
  return (
    <p className="settings-note span-2">
      <ShieldCheck size={13} />
      {draft.role === "super"
        ? "超级管理员拥有与系统内置 Admin 相同的站点级权限，请谨慎授予。"
        : "成员角色无需额外授权范围，登录后可浏览被允许的团队内容。"}
    </p>
  );
}

function AccountAvatar({ account }: { account: UserAccount }) {
  if (account.avatar) {
    return <img className="settings-account-avatar" src={account.avatar} alt={`${account.name} 的头像`} />;
  }
  return <Avatar name={account.name || account.email || "?"} color={account.avatarColor} size="md" />;
}

function AccountsSection({
  workspace,
  deviceAdminName,
}: {
  workspace: WorkspaceOption;
  deviceAdminName: string;
}) {
  const { reload } = useApp();
  const { toast } = useToast();
  const [data, setData] = useState<UsersData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [createForm, setCreateForm] = useState<AccountDraft & { email: string }>({
    email: "",
    ...emptyAccountDraft(),
  });
  const [createTouched, setCreateTouched] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<AccountDraft>(emptyAccountDraft());
  const [savingId, setSavingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<UserAccount | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [activation, setActivation] = useState<
    (ActivationLink & { email: string; name: string }) | null
  >(null);
  const [activationBusy, setActivationBusy] = useState<string | null>(null);
  // 复制失败时用它选中可见的激活链接输入框，保证用户可以直接 Ctrl+C 手动复制。
  const activationInputRef = useRef<HTMLInputElement | null>(null);

  const selectActivationInput = useCallback(() => {
    // 激活卡片依赖 setActivation 渲染，等一帧后再选中（否则 ref 还是旧的 null）。
    window.setTimeout(() => {
      const input = activationInputRef.current;
      if (!input) return;
      input.focus();
      input.select();
      input.setSelectionRange(0, input.value.length);
    }, 0);
  }, []);

  /**
   * 激活链接的唯一展示入口（预创建 / 重新生成都走这里）：
   * 先写剪贴板，再按 copyText 的真实结果 toast；只有真的复制成功才提示成功，
   * 失败时提示手动复制并选中输入框。
   */
  const presentActivation = useCallback(
    async (
      next: ActivationLink & { email: string; name: string },
      source: "created" | "regenerated",
    ): Promise<boolean> => {
      setActivation(next);
      const copied = await copyText(next.url);
      if (copied) {
        toast(
          source === "created"
            ? "已创建并复制激活链接，可直接粘贴发送"
            : "已重新生成并复制激活链接，可直接粘贴发送",
          "success",
        );
      } else {
        toast("激活链接已生成，但复制失败，请点击链接或「复制链接」手动复制", "error");
        selectActivationInput();
      }
      return copied;
    },
    [selectActivationInput, toast],
  );

  const load = useCallback(
    async (silent = false) => {
      if (silent) setRefreshing(true);
      else setLoading(true);
      try {
        const result = await api.listUsers();
        setData(result);
        setError("");
      } catch (err) {
        const message = err instanceof ApiError ? err.message : "加载账号列表失败";
        if (silent) toast(message, "error");
        else setError(message);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const teamName = useCallback(
    (id: string) => workspace.teams.find((team) => team.id === id)?.name ?? id,
    [workspace.teams],
  );

  const createEmail = createForm.email.trim().toLowerCase();
  const createIssue = !ACCOUNT_EMAIL_PATTERN.test(createEmail)
    ? createEmail
      ? "请填写有效的邮箱地址"
      : "请填写登录邮箱"
    : accountScopeIssue(createForm.role, createForm.teamIds);

  const submitCreate = async () => {
    if (creating || createIssue) return;
    setCreateTouched(true);
    setCreating(true);
    try {
      const result = await api.createUser({
        email: createEmail,
        name: createForm.name.trim() || undefined,
        role: createForm.role,
        teamIds: createForm.role === "team_admin" ? createForm.teamIds : [],
      });
      if (result.activation) {
        await presentActivation(
          {
            ...result.activation,
            email: result.user.email,
            name: result.user.name || result.user.email,
          },
          "created",
        );
      } else {
        toast(`账号「${result.user.name || result.user.email}」已创建`, "success");
      }
      setCreateForm({ email: "", ...emptyAccountDraft() });
      setCreateTouched(false);
      await load(true);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "预创建账号失败", "error");
    } finally {
      setCreating(false);
    }
  };

  const startEdit = (account: UserAccount) => {
    setEditingId(account.id);
    setEditForm({
      name: account.name,
      role: account.role,
      teamIds: [...account.teamIds],
    });
  };

  const saveEdit = async (account: UserAccount) => {
    if (savingId) return;
    const issue = !editForm.name.trim()
      ? "显示名称不能为空"
      : accountScopeIssue(editForm.role, editForm.teamIds);
    if (issue) {
      toast(issue, "error");
      return;
    }
    setSavingId(account.id);
    try {
      await api.updateUser(account.id, {
        name: editForm.name.trim(),
        role: editForm.role,
        teamIds: editForm.role === "team_admin" ? editForm.teamIds : [],
      });
      toast("账号信息已更新");
      setEditingId(null);
      await load(true);
      if (account.isSelf) await reload(true);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "保存账号失败", "error");
    } finally {
      setSavingId(null);
    }
  };

  const issueActivation = async (account: UserAccount) => {
    if (activationBusy) return;
    setActivationBusy(account.id);
    try {
      const result = await api.createActivationLink(account.id);
      await presentActivation(
        {
          ...result.activation,
          email: account.email,
          name: account.name || account.email,
        },
        "regenerated",
      );
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "生成激活链接失败", "error");
    } finally {
      setActivationBusy(null);
    }
  };

  const copyActivation = async () => {
    if (!activation) return;
    const copied = await copyText(activation.url);
    if (copied) {
      toast("激活链接已复制", "success");
    } else {
      toast("复制失败，请手动选中复制", "error");
      selectActivationInput();
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      await api.deleteUser(deleteTarget.id);
      toast(`账号「${deleteTarget.name || deleteTarget.email}」已删除`, "success");
      setDeleteTarget(null);
      await load(true);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "删除账号失败", "error");
    } finally {
      setDeleting(false);
    }
  };

  const users = data?.users ?? [];
  const deviceRow = users.find((account) => account.isDeviceAdmin);
  const normalUsers = users.filter((account) => !account.isDeviceAdmin);
  const editIssue = !editForm.name.trim()
    ? "显示名称不能为空"
    : accountScopeIssue(editForm.role, editForm.teamIds);

  return (
    <div className="settings-sections">
      <SettingsCard
        title="预创建账号"
        description="按邮箱预创建成员或管理员账号；创建后不会立即发送邮件，对方首次用邮箱验证码登录时自动激活。"
        icon={<UserPlus size={18} />}
      >
        <div className="form-grid">
          <Field label="登录邮箱" hint="账号 ID 取邮箱前缀且不可修改">
            <input
              className="input"
              type="email"
              value={createForm.email}
              placeholder="member@company.com"
              spellCheck={false}
              autoComplete="off"
              onChange={(event) =>
                setCreateForm((current) => ({ ...current, email: event.target.value }))
              }
            />
          </Field>
          <Field label="显示名称" hint="可选，默认使用邮箱前缀">
            <input
              className="input"
              value={createForm.name}
              maxLength={40}
              placeholder="例如：张明"
              onChange={(event) =>
                setCreateForm((current) => ({ ...current, name: event.target.value }))
              }
            />
          </Field>
          <Field label="账号角色">
            <Select
              value={createForm.role}
              onChange={(value) =>
                setCreateForm((current) => ({ ...current, role: value as UserRole }))
              }
              options={ROLE_OPTIONS}
              ariaLabel="新账号角色"
            />
          </Field>
          <AccountScopeEditor
            workspace={workspace}
            draft={createForm}
            onChange={(next) => setCreateForm((current) => ({ ...current, ...next }))}
          />
        </div>
        {createIssue && (createTouched || createForm.email.trim()) ? (
          <p className="settings-entry-problem">
            <AlertTriangle size={13} /> {createIssue}
          </p>
        ) : null}
        <div className="settings-account-form-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void submitCreate()}
            disabled={creating || Boolean(createIssue)}
          >
            {creating ? <Loader2 size={14} className="spin" /> : <UserPlus size={14} />}
            {creating ? "创建中…" : "预创建账号"}
          </button>
          <span className="field-hint">
            创建后会同步生成一次性激活链接，复制发送给对方即可激活并登录。
          </span>
        </div>
        <p className="settings-note">
          <Link2 size={13} />
          预创建账号（含团队管理员与超级管理员）无需激活即可直接用邮箱验证码登录，验证成功时自动激活；
          也可以打开一次性激活链接快捷激活并登录，无需邮箱验证码，也不依赖 SMTP 邮件服务。链接默认 10
          分钟内有效、仅可使用一次。
        </p>
      </SettingsCard>

      {activation ? (
        <SettingsCard
          title="账号激活链接"
          description={`${activation.name}（${activation.email}）的一次性激活链接，${activation.expiresInMinutes} 分钟内有效。`}
          icon={<Link2 size={18} />}
          extra={
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setActivation(null)}
              aria-label="关闭激活链接"
            >
              <X size={14} /> 关闭
            </button>
          }
        >
          <div className="settings-activation-link">
            <input
              ref={activationInputRef}
              className="input settings-activation-input"
              value={activation.url}
              readOnly
              spellCheck={false}
              title="点击即可复制激活链接"
              onFocus={(event) => event.currentTarget.select()}
              onClick={(event) => {
                const input = event.currentTarget;
                const whole = input.value.length;
                // 用户正在手动框选部分文本时不打断选择，也不重复复制。
                const partialSelection =
                  input.selectionStart !== input.selectionEnd &&
                  !(input.selectionStart === 0 && input.selectionEnd === whole);
                if (partialSelection) return;
                input.select();
                void copyActivation();
              }}
            />
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void copyActivation()}>
              <Copy size={14} /> 复制链接
            </button>
          </div>
          <p className="settings-activation-hint">
            <Copy size={12} /> 点击链接输入框即可复制；若复制失败，输入框会被自动选中，按 Ctrl+C 也能复制。
          </p>
          <p className="settings-note">
            <Clock size={13} />
            过期时间：{formatDateTime(activation.expiresAt)}。链接仅可使用一次；过期或需重新发送时，
            可在账号列表中点击「激活链接」重新生成。
          </p>
        </SettingsCard>
      ) : null}

      <SettingsCard
        title="账号列表"
        description={`共 ${normalUsers.length} 个可管理账号${deviceRow ? "，另有 1 个系统内置管理员" : ""}。`}
        icon={<UsersRound size={18} />}
        extra={
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void load(true)}
            disabled={loading || refreshing}
          >
            <RefreshCw size={14} className={refreshing ? "spin" : undefined} /> 刷新
          </button>
        }
      >
        {loading ? (
          <LoadingBlock label="正在读取账号列表…" rows={4} />
        ) : error ? (
          <div className="settings-inline-empty">
            <AlertTriangle size={18} />
            <div>
              <strong>无法加载账号列表</strong>
              <p>{error}</p>
            </div>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
              重新加载
            </button>
          </div>
        ) : (
          <div className="settings-account-list">
            {deviceRow ? (
              <article className="settings-account-row is-device">
                <div className="settings-account-main">
                  <span className="settings-device-avatar settings-account-device-avatar">
                    {(deviceAdminName || "Admin").slice(0, 2).toUpperCase()}
                  </span>
                  <div className="settings-account-copy">
                    <div className="settings-account-name">
                      <strong>{deviceAdminName || deviceRow.name}</strong>
                      <span className={cn("badge", ROLE_BADGE[deviceRow.role])}>
                        {deviceRow.roleLabel || roleLabel(deviceRow.role)}
                      </span>
                      <span className="badge badge-gray">只读</span>
                    </div>
                    <div className="settings-account-meta">
                      <span>系统内置管理员，不可管理</span>
                    </div>
                  </div>
                </div>
              </article>
            ) : null}

            {normalUsers.length ? (
              normalUsers.map((account) => (
                <article className="settings-account-row" key={account.id}>
                  <div className="settings-account-main">
                    <AccountAvatar account={account} />
                    <div className="settings-account-copy">
                      <div className="settings-account-name">
                        <strong>{account.name || account.email}</strong>
                        <span className={cn("badge", ROLE_BADGE[account.role])}>
                          {account.roleLabel || roleLabel(account.role)}
                        </span>
                        {account.emailVerified ? (
                          <span className="badge badge-green">
                            <BadgeCheck size={11} /> 已验证
                          </span>
                        ) : (
                          <span className="badge badge-orange">待首次登录激活</span>
                        )}
                        {account.isSelf ? <span className="badge badge-blue">当前账号</span> : null}
                      </div>
                      <div className="settings-account-meta">
                        <span>
                          <AtSign size={11} /> {account.id}
                        </span>
                        <span>{account.email}</span>
                        {account.teamIds.length ? (
                          <span>团队：{account.teamIds.map(teamName).join("、")}</span>
                        ) : null}
                      </div>
                    </div>
                    <div className="settings-account-actions">
                      {!account.emailVerified ? (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => void issueActivation(account)}
                          disabled={activationBusy === account.id}
                          title="生成一次性激活链接"
                        >
                          {activationBusy === account.id ? (
                            <Loader2 size={14} className="spin" />
                          ) : (
                            <Link2 size={14} />
                          )}
                          激活链接
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => startEdit(account)}
                        disabled={editingId === account.id}
                      >
                        <Pencil size={14} /> 编辑
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm settings-icon-danger"
                        onClick={() => setDeleteTarget(account)}
                        disabled={Boolean(account.isSelf)}
                        title={account.isSelf ? "不能删除当前登录的账号" : "删除账号"}
                      >
                        <Trash2 size={14} /> 删除
                      </button>
                    </div>
                  </div>

                  {editingId === account.id ? (
                    <form
                      className="settings-account-edit"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void saveEdit(account);
                      }}
                    >
                      <div className="form-grid">
                        <Field label="显示名称" hint="留空时使用邮箱前缀">
                          <input
                            className="input"
                            value={editForm.name}
                            maxLength={40}
                            onChange={(event) =>
                              setEditForm((current) => ({ ...current, name: event.target.value }))
                            }
                          />
                        </Field>
                        <Field label="账号角色">
                          <Select
                            value={editForm.role}
                            onChange={(value) =>
                              setEditForm((current) => ({ ...current, role: value as UserRole }))
                            }
                            options={ROLE_OPTIONS}
                            ariaLabel={`${account.name} 的账号角色`}
                          />
                        </Field>
                        <AccountScopeEditor
                          workspace={workspace}
                          draft={editForm}
                          onChange={setEditForm}
                        />
                      </div>
                      {editIssue ? (
                        <p className="settings-entry-problem">
                          <AlertTriangle size={13} /> {editIssue}
                        </p>
                      ) : (
                        <p className="settings-entry-ok">
                          <CheckCircle2 size={13} /> 角色与授权范围有效
                        </p>
                      )}
                      <div className="settings-account-edit-actions">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => setEditingId(null)}
                          disabled={savingId === account.id}
                        >
                          取消
                        </button>
                        <button
                          type="submit"
                          className="btn btn-primary btn-sm"
                          disabled={Boolean(editIssue) || savingId === account.id}
                        >
                          {savingId === account.id ? (
                            <Loader2 size={14} className="spin" />
                          ) : (
                            <Save size={14} />
                          )}
                          {savingId === account.id ? "保存中…" : "保存修改"}
                        </button>
                      </div>
                    </form>
                  ) : null}
                </article>
              ))
            ) : (
              <div className="settings-inline-empty">
                <UsersRound size={18} />
                <div>
                  <strong>暂无其他账号</strong>
                  <p>使用上方的「预创建账号」表单添加成员或管理员账号。</p>
                </div>
              </div>
            )}
          </div>
        )}
      </SettingsCard>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除账号？"
        message={
          deleteTarget
            ? `即将删除账号「${deleteTarget.name || deleteTarget.email}」。删除后该账号将立即失去登录权限，历史内容会保留，操作不可撤销。`
            : ""
        }
        confirmLabel="删除账号"
        loading={deleting}
        onClose={() => {
          if (!deleting) setDeleteTarget(null);
        }}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* SMTP relay (super administrators only)                              */
/* ------------------------------------------------------------------ */

const EMAIL_TOKENS = ["{{siteName}}", "{{code}}", "{{expiresMinutes}}"];

function emailKindLabel(kind: string): string {
  if (kind === "verification") return "验证码邮件";
  if (kind === "test") return "测试邮件";
  return "历史记录";
}

function EmailSection({
  draft,
  update,
  errorsFor,
}: {
  draft: AppSettings;
  update: UpdateSettings;
  errorsFor: ErrorsFor;
}) {
  const { toast } = useToast();
  const smtp = draft.email.smtp;
  const [status, setStatus] = useState<EmailStatus | null>(null);
  const [logs, setLogs] = useState<EmailLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [testTo, setTestTo] = useState("");
  const [testing, setTesting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const load = useCallback(
    async (silent = false) => {
      if (silent) setRefreshing(true);
      else setLoading(true);
      try {
        const [nextStatus, nextLogs] = await Promise.all([api.emailStatus(), api.emailLogs(30)]);
        setStatus(nextStatus);
        setLogs(nextLogs.logs);
        setError("");
      } catch (err) {
        const message = err instanceof ApiError ? err.message : "加载邮件服务状态失败";
        if (silent) toast(message, "error");
        else setError(message);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const sendTest = async () => {
    if (testing) return;
    const target = testTo.trim() || smtp.fromEmail.trim();
    if (!target) {
      toast("请先填写测试收件邮箱或发件邮箱", "error");
      return;
    }
    setTesting(true);
    try {
      const result = await api.emailTest(target);
      toast(`测试邮件已发送至 ${result.to}`, "success");
      await load(true);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "测试发送失败，请检查 SMTP 配置", "error");
    } finally {
      setTesting(false);
    }
  };

  const insertToken = (token: string) => {
    update((next) => {
      const separator =
        next.email.bodyTemplate && !next.email.bodyTemplate.endsWith("\n") ? "\n" : "";
      next.email.bodyTemplate = `${next.email.bodyTemplate}${separator}${token}`;
    });
  };

  const previewBody = draft.email.bodyTemplate
    .replaceAll("{{siteName}}", draft.site.name || "团队工作室")
    .replaceAll("{{code}}", "123456")
    .replaceAll("{{expiresMinutes}}", String(draft.auth.emailLogin.codeExpiryMinutes || 10));

  const statusBadge = status
    ? status.configured
      ? { tone: "badge-green", label: "已就绪" }
      : status.enabled
        ? { tone: "badge-orange", label: "配置不完整" }
        : { tone: "badge-gray", label: "未启用" }
    : { tone: "badge-gray", label: "未知" };

  return (
    <div className="settings-sections">
      <SettingsCard
        title="SMTP 中继状态"
        description="用于发送邮箱验证码的外部 SMTP 服务器；本版本不再内置邮件服务器与本地信箱。"
        icon={<Server size={18} />}
        extra={
          <>
            <span className={cn("badge", statusBadge.tone)}>{statusBadge.label}</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void load(true)}
              disabled={loading || refreshing}
            >
              <RefreshCw size={14} className={refreshing ? "spin" : undefined} /> 刷新
            </button>
          </>
        }
      >
        {loading ? (
          <LoadingBlock label="正在读取邮件服务状态…" rows={3} />
        ) : error ? (
          <div className="settings-inline-empty">
            <AlertTriangle size={18} />
            <div>
              <strong>无法读取邮件服务状态</strong>
              <p>{error}</p>
            </div>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
              重新加载
            </button>
          </div>
        ) : status ? (
          <>
            <div className="settings-sso-status settings-email-status">
              <div className="settings-sso-item">
                <span className="settings-sso-label">中继服务器</span>
                <strong className="mono">
                  {status.host ? `${status.host}:${status.port}` : "未配置"}
                </strong>
              </div>
              <div className="settings-sso-item">
                <span className="settings-sso-label">发件人</span>
                <strong>
                  {status.fromName || "—"}
                  {status.fromEmail ? ` <${status.fromEmail}>` : ""}
                </strong>
              </div>
              <div className="settings-sso-item">
                <span className="settings-sso-label">加密方式</span>
                <strong>{status.useSsl ? "SSL 直连" : status.useStartTls ? "STARTTLS" : "明文"}</strong>
              </div>
              <div className="settings-sso-item">
                <span className="settings-sso-label">今日发送</span>
                <strong>{status.sentToday} 封</strong>
              </div>
              <div className="settings-sso-item">
                <span className="settings-sso-label">最近成功</span>
                <strong>{status.lastSentAt ? formatDateTime(status.lastSentAt) : "—"}</strong>
              </div>
              <div className="settings-sso-item">
                <span className="settings-sso-label">最近错误</span>
                <strong className={status.lastError ? "settings-email-error-text" : undefined}>
                  {status.lastError || "无"}
                </strong>
              </div>
            </div>
            {status.configured ? (
              <p className="settings-sso-ready">
                <CheckCircle2 size={13} /> SMTP 中继已可用，邮箱验证码登录可以正常发送。
              </p>
            ) : (
              <p className="settings-sso-missing">
                <AlertTriangle size={13} />
                邮件服务尚未就绪：请填写 SMTP 服务器与发件邮箱，并保持「启用邮件服务」开启。
              </p>
            )}
            <div className="settings-email-test">
              <input
                className="input"
                type="email"
                value={testTo}
                placeholder="测试收件邮箱（留空则发送到发件邮箱）"
                spellCheck={false}
                onChange={(event) => setTestTo(event.target.value)}
              />
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => void sendTest()}
                disabled={testing}
              >
                {testing ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
                {testing ? "发送中…" : "发送测试邮件"}
              </button>
            </div>
          </>
        ) : null}
      </SettingsCard>

      <SettingsCard
        title="SMTP 中继配置"
        description="填写外部 SMTP 服务器的地址与账号；保存站点设置后生效。"
        icon={<Mail size={18} />}
      >
        <div className="settings-toggle-stack">
          <ToggleRow
            label="启用邮件服务"
            description="关闭后邮箱验证码登录将不可用，仅能通过 SSO 或访客模式访问。"
            checked={draft.email.enabled}
            onChange={(checked) =>
              update((next) => {
                next.email.enabled = checked;
              })
            }
          />
        </div>
        <div className="divider" />
        <div className="form-grid">
          <Field
            label="SMTP 服务器 IP / 域名"
            error={errorText(errorsFor("email.smtp.host"))}
            hint="支持域名或 IP，例如 smtp.company.com、10.0.0.5"
          >
            <input
              className="input"
              value={smtp.host}
              placeholder="smtp.company.com"
              spellCheck={false}
              onChange={(event) =>
                update((next) => {
                  next.email.smtp.host = event.target.value;
                })
              }
            />
          </Field>
          <Field label="SMTP 端口" error={errorText(errorsFor("email.smtp.port"))} hint="1 - 65535，常用 587 / 465">
            <input
              className="input"
              type="number"
              min={1}
              max={65535}
              value={smtp.port}
              onChange={(event) =>
                update((next) => {
                  next.email.smtp.port = toInt(event.target.value, 587);
                })
              }
            />
          </Field>
          <Field
            label="SMTP 用户名"
            error={errorText(errorsFor("email.smtp.username"))}
            hint="中继账号（代理邮箱），留空表示匿名中继"
          >
            <input
              className="input"
              value={smtp.username}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) =>
                update((next) => {
                  next.email.smtp.username = event.target.value;
                })
              }
            />
          </Field>
          <Field
            label="SMTP 密码"
            error={errorText(errorsFor("email.smtp.password"))}
            hint="仅保存在服务端 settings.json，不会回传到页面"
          >
            <div className="settings-secret-control">
              <input
                className="input"
                type={showPassword ? "text" : "password"}
                value={smtp.password}
                spellCheck={false}
                autoComplete="new-password"
                onChange={(event) =>
                  update((next) => {
                    next.email.smtp.password = event.target.value;
                  })
                }
              />
              <button
                type="button"
                className="icon-button"
                aria-label={showPassword ? "隐藏密码" : "显示密码"}
                onClick={() => setShowPassword((value) => !value)}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </Field>
          <Field
            label="发件邮箱"
            error={errorText(errorsFor("email.smtp.fromEmail"))}
            hint="收件人看到的发件地址，需与中继账号匹配"
          >
            <input
              className="input"
              type="email"
              value={smtp.fromEmail}
              placeholder="noreply@company.com"
              spellCheck={false}
              onChange={(event) =>
                update((next) => {
                  next.email.smtp.fromEmail = event.target.value;
                })
              }
            />
          </Field>
          <Field label="发件人名称" error={errorText(errorsFor("email.smtp.fromName"))} hint="例如：团队工作室">
            <input
              className="input"
              value={smtp.fromName}
              maxLength={80}
              onChange={(event) =>
                update((next) => {
                  next.email.smtp.fromName = event.target.value;
                })
              }
            />
          </Field>
          <Field
            label="连接超时（秒）"
            error={errorText(errorsFor("email.smtp.timeoutSeconds"))}
            hint="3 - 120 秒，默认 15 秒"
          >
            <input
              className="input"
              type="number"
              min={3}
              max={120}
              value={smtp.timeoutSeconds}
              onChange={(event) =>
                update((next) => {
                  next.email.smtp.timeoutSeconds = toInt(event.target.value, 15);
                })
              }
            />
          </Field>
          <div className="span-2 settings-toggle-stack">
            <ToggleRow
              label="STARTTLS"
              description="先建立明文连接再升级为 TLS，常用端口 587。"
              checked={smtp.useStartTls}
              onChange={(checked) =>
                update((next) => {
                  next.email.smtp.useStartTls = checked;
                  if (checked) next.email.smtp.useSsl = false;
                })
              }
            />
            <ToggleRow
              label="SSL 直连"
              description="全程 TLS 加密，常用端口 465。与 STARTTLS 只能开启一种。"
              checked={smtp.useSsl}
              onChange={(checked) =>
                update((next) => {
                  next.email.smtp.useSsl = checked;
                  if (checked) next.email.smtp.useStartTls = false;
                })
              }
            />
          </div>
        </div>
      </SettingsCard>

      <SettingsCard
        title="验证码邮件内容"
        description="邮箱验证码邮件的主题与正文模板，留空时使用服务端默认文案。"
        icon={<Inbox size={18} />}
      >
        <Field
          label="邮件主题"
          error={errorText(errorsFor("email.subjectTemplate"))}
          hint="支持变量：{{siteName}}、{{code}}、{{expiresMinutes}}"
        >
          <input
            className="input"
            value={draft.email.subjectTemplate}
            maxLength={160}
            placeholder="[{{siteName}}] 邮箱验证码"
            onChange={(event) =>
              update((next) => {
                next.email.subjectTemplate = event.target.value;
              })
            }
          />
        </Field>
        <Field
          label="邮件正文"
          error={errorText(errorsFor("email.bodyTemplate"))}
          hint="验证码会按上方模板渲染；请保留 {{code}} 变量以发送验证码。"
        >
          <textarea
            className="textarea"
            value={draft.email.bodyTemplate}
            rows={8}
            maxLength={4000}
            spellCheck={false}
            onChange={(event) =>
              update((next) => {
                next.email.bodyTemplate = event.target.value;
              })
            }
          />
        </Field>
        <div className="settings-email-tokens">
          <span className="field-hint">插入变量：</span>
          {EMAIL_TOKENS.map((token) => (
            <button
              key={token}
              type="button"
              className="chip chip-clickable"
              onClick={() => insertToken(token)}
            >
              {token}
            </button>
          ))}
        </div>
        <div className="settings-email-preview">
          <span className="settings-email-preview-label">渲染预览</span>
          <pre>{previewBody || "（正文为空，将使用服务端默认模板）"}</pre>
        </div>
      </SettingsCard>

      <SettingsCard
        title="最近发送记录"
        description="仅展示脱敏后的收件地址与发送结果，便于排查中继问题。"
        icon={<Clock size={18} />}
        extra={
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void load(true)}
            disabled={loading || refreshing}
          >
            <RefreshCw size={14} className={refreshing ? "spin" : undefined} /> 刷新
          </button>
        }
      >
        {logs.length ? (
          <ul className="settings-email-logs">
            {logs.map((log) => (
              <li
                className={cn("settings-email-log", log.status === "failed" && "is-failed")}
                key={log.id}
              >
                <span className={cn("badge", log.status === "sent" ? "badge-green" : "badge-red")}>
                  {log.status === "sent" ? "已发送" : "失败"}
                </span>
                <div className="settings-email-log-copy">
                  <strong>{log.subject || "（无主题）"}</strong>
                  <small>
                    {log.recipient} · {emailKindLabel(log.kind)} · {formatDateTime(log.created_at)}
                  </small>
                  {log.error ? <em>{log.error}</em> : null}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="settings-inline-empty">
            <Inbox size={18} />
            <div>
              <strong>暂无发送记录</strong>
              <p>发送测试邮件或成员使用邮箱验证码登录后，这里会显示最近的中继结果。</p>
            </div>
          </div>
        )}
      </SettingsCard>
    </div>
  );
}

interface JsonWorkspaceProps {
  draft: AppSettings;
  saved: AppSettings | null;
  jsonText: string;
  jsonDirty: boolean;
  saving: boolean;
  busy: boolean;
  state: JsonState;
  liveSyntaxError: string | null;
  meta: SettingsMeta | null;
  onTextChange: (text: string) => void;
  onFormat: () => void;
  onValidate: () => void;
  onSave: () => void;
  onSyncDraft: () => void;
  onResetServer: () => void;
  onCopy: () => void;
  onJumpTab: (tab: TabKey) => void;
}

function JsonWorkspace({
  draft,
  saved,
  jsonText,
  jsonDirty,
  saving,
  busy,
  state,
  liveSyntaxError,
  meta,
  onTextChange,
  onFormat,
  onValidate,
  onSave,
  onSyncDraft,
  onResetServer,
  onCopy,
  onJumpTab,
}: JsonWorkspaceProps) {
  const lineCount = useMemo(() => jsonText.split("\n").length, [jsonText]);

  return (
    <div className="settings-sections">
      <SettingsCard
        title="完整配置 JSON"
        description="以原文编辑整个设置对象，保留所有字段；保存前必须通过服务端校验。"
        icon={<Code2 size={18} />}
        className="settings-json-card"
        extra={
          <div className="settings-json-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={onFormat}>
              <Wand2 size={14} /> 格式化
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onValidate} disabled={busy}>
              {busy ? <Loader2 size={14} className="spin" /> : <CheckCircle2 size={14} />}
              校验配置
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onSyncDraft}>
              <RefreshCw size={14} /> 从 GUI 草稿同步
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onResetServer}>
              <RotateCcw size={14} /> 恢复服务器版本
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onCopy}>
              <Copy size={14} /> 复制
            </button>
            <a className="btn btn-ghost btn-sm" href="/api/settings/schema" target="_blank" rel="noreferrer">
              <Download size={14} /> Schema
            </a>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={onSave}
              disabled={saving || busy}
            >
              {saving ? <Loader2 size={14} className="spin" /> : <Save size={14} />}
              校验并保存
            </button>
          </div>
        }
      >
        <div className="settings-json-meta">
          <span className={cn("settings-json-live", liveSyntaxError ? "is-error" : "is-ok")}>
            {liveSyntaxError ? <AlertTriangle size={13} /> : <CheckCircle2 size={13} />}
            {liveSyntaxError ? "JSON 语法错误" : "JSON 语法正常"}
          </span>
          <span className="settings-json-stat">{lineCount} 行</span>
          <span className="settings-json-stat">{jsonText.length.toLocaleString("zh-CN")} 字符</span>
          {jsonDirty ? <span className="badge badge-orange">JSON 有未保存修改</span> : null}
          <span className="settings-json-stat mono">v{draft.version}</span>
          <span className="settings-json-stat">
            {saved ? `服务器版本 v${saved.version} · ${formatDateTime(meta?.updatedAt)}` : "尚未同步服务器版本"}
          </span>
        </div>

        <div className="settings-json-editor">
          <CodeEditor
            value={jsonText}
            onChange={onTextChange}
            language="json"
            height="100%"
            ariaLabel="完整设置 JSON 编辑器"
          />
        </div>

        <div className="settings-json-help">
          <span>
            <Braces size={13} /> 编辑内容仅在点击「校验并保存」后写入服务器，不会部分保存。
          </span>
          <span>
            <Lock size={13} /> 保存时会整体替换配置；缺失字段会由服务端按默认值补全，建议先「从 GUI 草稿同步」再修改。
          </span>
        </div>
      </SettingsCard>

      {liveSyntaxError ? (
        <div className="settings-json-result is-error" role="alert">
          <div className="settings-json-result-head">
            <AlertTriangle size={16} />
            <strong>JSON 语法无法解析</strong>
          </div>
          <p className="settings-json-result-syntax">{liveSyntaxError}</p>
        </div>
      ) : null}

      {state.status === "ok" ? (
        <div className="settings-json-result is-ok" role="status">
          <div className="settings-json-result-head">
            <CheckCircle2 size={16} />
            <strong>校验通过</strong>
            {state.checkedAt ? <span className="muted small">· {formatDateTime(state.checkedAt)}</span> : null}
          </div>
          <p>配置结构合法且已通过服务端校验，可以点击「校验并保存」立即生效。</p>
        </div>
      ) : null}

      {state.status === "error" ? (
        <div className="settings-json-result is-error" role="alert">
          <div className="settings-json-result-head">
            <AlertTriangle size={16} />
            <strong>校验未通过</strong>
            {state.checkedAt ? <span className="muted small">· {formatDateTime(state.checkedAt)}</span> : null}
          </div>
          {state.syntaxError ? <p className="settings-json-result-syntax">{state.syntaxError}</p> : null}
          {state.details && state.details.length ? (
            <ul className="settings-error-list">
              {state.details.map((detail, index) => {
                const tab = tabForPath(detail.path);
                return (
                  <li key={`${detail.path}-${index}`}>
                    <button
                      type="button"
                      className="settings-error-path"
                      title={tab ? "跳转到对应 GUI 分组" : detail.path}
                      onClick={() => (tab ? onJumpTab(tab) : undefined)}
                    >
                      {pathLabel(detail.path)}
                    </button>
                    <code>{detail.path}</code>
                    <span>{detail.message}</span>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Domain settings: teams only                                         */
/* ------------------------------------------------------------------ */

interface DomainTeamDraft {
  name: string;
  shortName: string;
  description: string;
  color: string;
}

const DOMAIN_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function DomainColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const swatch = DOMAIN_COLOR_PATTERN.test(value) ? value : "#5865f2";
  return (
    <Field label={label} hint="使用 #RRGGBB 格式，或直接点击色块取色">
      <div className="settings-color-control">
        <input
          type="color"
          value={swatch}
          aria-label={`${label}取色器`}
          onChange={(event) => onChange(event.target.value)}
        />
        <input
          className="input"
          value={value}
          maxLength={7}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    </Field>
  );
}

function DomainReadonlyRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="settings-domain-readonly-row">
      <span>{label}</span>
      <strong>{value || "—"}</strong>
    </div>
  );
}

function TeamDomainCard({
  team,
  onSaved,
}: {
  team: DomainTeamSettings;
  onSaved: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<DomainTeamDraft>(() => ({
    name: team.name,
    shortName: team.shortName,
    description: team.description,
    color: team.color,
  }));
  const [saving, setSaving] = useState(false);
  const editable = team.canEdit;

  useEffect(() => {
    setDraft({
      name: team.name,
      shortName: team.shortName,
      description: team.description,
      color: team.color,
    });
  }, [team.id, team.name, team.shortName, team.description, team.color]);

  const dirty =
    editable &&
    (draft.name !== team.name ||
      draft.shortName !== team.shortName ||
      draft.description !== team.description ||
      draft.color !== team.color);
  const colorValid = DOMAIN_COLOR_PATTERN.test(draft.color);
  const nameValid = draft.name.trim().length > 0;

  const save = async () => {
    if (saving || !editable) return;
    if (!nameValid) {
      toast("团队名称不能为空", "error");
      return;
    }
    if (!colorValid) {
      toast("团队标识色必须是 #RRGGBB 格式", "error");
      return;
    }
    setSaving(true);
    try {
      await api.updateDomainTeam(team.id, {
        name: draft.name.trim(),
        shortName: draft.shortName.trim(),
        description: draft.description.trim(),
        color: draft.color.toLowerCase(),
      });
      toast(`团队「${draft.name.trim()}」已更新`);
      await onSaved();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : "保存团队设置失败", "error");
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    setDraft({
      name: team.name,
      shortName: team.shortName,
      description: team.description,
      color: team.color,
    });
  };

  return (
    <article className="settings-domain-team">
      <header className="settings-domain-team-head">
        <span className="settings-domain-team-mark" style={{ color: team.color }}>
          <Building2 size={19} />
        </span>
        <div className="settings-domain-team-copy">
          <div className="settings-domain-team-title">
            <strong>{team.name}</strong>
            <span className="badge badge-gray">{team.shortName || "暂无简称"}</span>
            <span className={cn("badge", editable ? "badge-blue" : "badge-gray")}>
              {editable ? "可编辑" : "只读"}
            </span>
          </div>
          <small>
            团队 ID <code className="mono">{team.id}</code> · 标识色{" "}
            <code className="mono">{team.color}</code>
          </small>
        </div>
        {editable ? (
          <div className="settings-domain-actions">
            {dirty ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={reset}
                disabled={saving}
              >
                <RotateCcw size={14} /> 撤销
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => void save()}
              disabled={!dirty || saving}
            >
              {saving ? <Loader2 size={14} className="spin" /> : <Save size={14} />}
              {saving ? "保存中…" : "保存团队"}
            </button>
          </div>
        ) : null}
      </header>

      {editable ? (
        <div className="form-grid settings-domain-form">
          <Field label="团队名称" hint="2 - 40 个字符">
            <input
              className="input"
              value={draft.name}
              maxLength={40}
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            />
          </Field>
          <Field label="团队简称" hint="留空时自动取名称前 4 个字符">
            <input
              className="input"
              value={draft.shortName}
              maxLength={12}
              onChange={(event) =>
                setDraft((current) => ({ ...current, shortName: event.target.value }))
              }
            />
          </Field>
          <DomainColorField
            label="团队标识色"
            value={draft.color}
            onChange={(color) => setDraft((current) => ({ ...current, color }))}
          />
          <Field label="团队简介" className="span-2" hint="最多 120 个字符">
            <textarea
              className="textarea"
              value={draft.description}
              rows={2}
              maxLength={120}
              onChange={(event) =>
                setDraft((current) => ({ ...current, description: event.target.value }))
              }
            />
          </Field>
        </div>
      ) : (
        <div className="settings-domain-readonly">
          <DomainReadonlyRow label="团队名称" value={team.name} />
          <DomainReadonlyRow label="团队简称" value={team.shortName} />
          <DomainReadonlyRow label="团队简介" value={team.description} />
          <DomainReadonlyRow label="标识色" value={<code className="mono">{team.color}</code>} />
        </div>
      )}
    </article>
  );
}

function WorkspaceSettingsSection() {
  const { reload } = useApp();
  const { toast } = useToast();
  const [data, setData] = useState<DomainSettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [managerOpen, setManagerOpen] = useState(false);

  const load = useCallback(
    async (silent = false) => {
      if (silent) setRefreshing(true);
      else setLoading(true);
      try {
        const result = await api.domainSettings();
        setData(result);
        setError("");
      } catch (err) {
        const message = err instanceof ApiError ? err.message : "加载工作区设置失败";
        if (silent) toast(message, "error");
        else setError(message);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const handleSaved = useCallback(async () => {
    await load(true);
    await reload(true);
  }, [load, reload]);

  const teams = data?.teams ?? [];
  const permissions = data?.permissions;

  const scopeHint = permissions?.isSuperAdmin
    ? "你是超级管理员：可编辑所有团队的基础信息。"
    : permissions?.canEditTeam
      ? "你是团队管理员：可编辑被授权团队的团队信息；新建或删除团队需要超级管理员操作。"
      : "你暂时没有可编辑的团队：团队信息为只读。";

  return (
    <div className="settings-sections">
      <SettingsCard
        title="工作区结构与基础信息"
        description="团队是唯一组织单位：数据按团队隔离。团队名称、简介和标识色保存后立即生效，并同步到导航与团队切换器。"
        icon={<Building2 size={18} />}
        extra={
          <>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void load(true)}
              disabled={loading || refreshing}
            >
              <RefreshCw size={14} className={refreshing ? "spin" : undefined} /> 刷新
            </button>
            {permissions?.canEditStructure ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setManagerOpen(true)}
              >
                <Settings2 size={14} /> 管理工作区结构
              </button>
            ) : null}
          </>
        }
      >
        {loading ? (
          <LoadingBlock label="正在读取团队信息…" rows={4} />
        ) : error ? (
          <div className="settings-inline-empty">
            <AlertTriangle size={18} />
            <div>
              <strong>无法加载工作区设置</strong>
              <p>{error}</p>
            </div>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
              重新加载
            </button>
          </div>
        ) : (
          <>
            <div className="settings-domain-summary">
              <span className="settings-domain-summary-item">
                <Building2 size={14} />
                <strong>{teams.length}</strong> 个团队
              </span>
              <span className="settings-domain-summary-item">
                <ShieldCheck size={14} />
                {permissions?.isSuperAdmin ? "全部工作区" : "按角色授权范围"}
              </span>
            </div>
            <p className="settings-note">
              <ShieldCheck size={13} />
              {scopeHint}
            </p>
            {teams.length ? (
              <div className="settings-domain-list">
                {teams.map((team) => (
                  <TeamDomainCard key={team.id} team={team} onSaved={handleSaved} />
                ))}
              </div>
            ) : (
              <div className="settings-inline-empty">
                <Building2 size={18} />
                <div>
                  <strong>当前范围没有可管理的团队</strong>
                  <p>请联系超级管理员创建团队，或检查你的账号授权范围。</p>
                </div>
              </div>
            )}
            {!permissions?.canEditStructure && permissions ? (
              <p className="settings-note">
                <Building2 size={13} />
                新建 / 删除团队需要超级管理员操作。
              </p>
            ) : null}
          </>
        )}
      </SettingsCard>

      <WorkspaceManager
        open={managerOpen}
        onClose={() => {
          setManagerOpen(false);
          void load(true);
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Whole-system factory reset (deployment device Admin only)           */
/* ------------------------------------------------------------------ */

const RESET_PRIMARY_STATS: { key: keyof SystemResetStats; label: string; icon: LucideIcon }[] = [
  { key: "teams", label: "团队", icon: Building2 },
  { key: "members", label: "成员", icon: UsersRound },
  { key: "tasks", label: "任务", icon: ListTodo },
  { key: "todos", label: "待办", icon: CheckCircle2 },
  { key: "accounts", label: "账号", icon: Users },
];

const RESET_EXTRA_STATS: { key: keyof SystemResetStats; label: string }[] = [
  { key: "works", label: "工作记录" },
  { key: "boards", label: "红黑榜" },
  { key: "entries", label: "红黑记录" },
  { key: "links", label: "常用链接" },
  { key: "matrix", label: "责任田" },
  { key: "announcements", label: "公告" },
  { key: "tags", label: "任务标签" },
  { key: "emailCodes", label: "邮箱验证码" },
  { key: "activationTokens", label: "激活令牌" },
  { key: "emailLogs", label: "邮件日志" },
  { key: "auditLogs", label: "审计日志" },
];

/**
 * Dangerous "restore defaults and erase everything" panel. It is rendered only for the
 * deployment device's built-in Admin, requires two confirmations (a yes/no dialog and an
 * exact site-name input) and refreshes the whole shell after the backend wiped the data.
 */
function SystemResetSection({ onCompleted }: { onCompleted: () => Promise<void> }) {
  const { toast } = useToast();
  const [info, setInfo] = useState<SystemResetInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [forbidden, setForbidden] = useState(false);
  const [step, setStep] = useState<"closed" | "confirm" | "input">("closed");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SystemResetResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const next = await api.systemResetInfo();
      setInfo(next);
      setForbidden(false);
    } catch (error) {
      if (error instanceof ApiError && (error.status === 403 || error.status === 401)) {
        setForbidden(true);
      } else {
        setLoadError(error instanceof ApiError ? error.message : "读取系统重置信息失败");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submitReset = useCallback(
    async (value: string) => {
      if (!info || !info.siteName.trim() || submitting) return;
      setSubmitting(true);
      let payload: SystemResetResult;
      try {
        payload = await api.resetSystem({ confirmName: value.trim(), acknowledge: true });
      } catch (error) {
        if (error instanceof ApiError) {
          if (error.status === 403) {
            setStep("closed");
            setForbidden(true);
            toast("仅系统内置 Admin 可以重置系统", "error");
          } else if (error.status === 422 && error.code === "confirm_mismatch") {
            const expected =
              error.details && typeof error.details === "object"
                ? (error.details as { expected?: unknown }).expected
                : undefined;
            toast(
              typeof expected === "string" && expected
                ? `站点名称不匹配，请完整输入「${expected}」`
                : "站点名称不匹配，重置未执行",
              "error",
            );
            // Return to the first confirmation so the operator retries deliberately.
            setStep("confirm");
          } else if (error.status === 422 && error.code === "acknowledge_required") {
            toast("请确认你已了解该操作的危险性", "error");
          } else {
            toast(error.message || "重置失败，请稍后重试", "error");
          }
        } else {
          toast("重置失败，请稍后重试", "error");
        }
        setSubmitting(false);
        return;
      }
      setSubmitting(false);
      setStep("closed");
      setResult(payload);
      toast("已重置整个系统，全部数据已清除");
      try {
        localStorage.removeItem("teamstudio.team");
      } catch {
        // ignore storage failures
      }
      try {
        await onCompleted();
        await load();
      } catch {
        toast("数据已清除，但页面状态刷新失败，请手动重新加载", "error");
      }
    },
    [info, load, onCompleted, submitting, toast],
  );

  if (forbidden) {
    return (
      <div className="state-screen compact">
        <div className="state-card">
          <span className="state-icon danger">
            <ShieldAlert size={26} />
          </span>
          <h1>仅系统内置 Admin 可重置系统</h1>
          <p>
            系统重置会清空整个站点的数据，只对系统内置的 <code>Admin</code>{" "}
            开放。存储在册的超级管理员账号即使拥有站点设置权限，也不能查看或执行该操作。
          </p>
          <div className="state-actions">
            <button className="btn btn-primary" onClick={() => void load()}>
              <RefreshCw size={16} /> 重新检查权限
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (loading && !info) {
    return (
      <div className="card card-pad">
        <LoadingBlock label="正在读取系统重置信息…" rows={4} />
      </div>
    );
  }

  if (loadError || !info) {
    return (
      <div className="card card-pad settings-danger-load-error">
        <span className="settings-danger-load-icon">
          <AlertTriangle size={22} />
        </span>
        <div className="settings-danger-load-copy">
          <strong>读取系统重置信息失败</strong>
          <p>{loadError || "服务器没有返回可用的系统状态。"}</p>
        </div>
        <div className="settings-danger-load-actions">
          <button className="btn btn-primary btn-sm" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
            {loading ? "读取中…" : "重试"}
          </button>
        </div>
      </div>
    );
  }

  const stats = info.stats;
  const resetTarget = info.siteName.trim();
  const totalRecords = (Object.values(stats) as number[]).reduce((sum, value) => sum + value, 0);

  return (
    <>
      <div className="settings-sections">
        {result ? (
          <section className="card settings-danger-success" role="status" aria-live="polite">
            <div className="settings-danger-success-head">
              <span className="settings-danger-success-icon">
                <CheckCircle2 size={24} />
              </span>
              <div>
                <h2>重置完成</h2>
                <p>已恢复默认设置并清空全部数据，工作区现在是空的。</p>
              </div>
            </div>
            <dl className="settings-danger-success-meta">
              <div>
                <dt>重置时间</dt>
                <dd>{formatDateTime(result.resetAt)}</dd>
              </div>
              <div>
                <dt>站点名称</dt>
                <dd>{result.siteName || info.defaultSiteName}（已恢复默认）</dd>
              </div>
              <div>
                <dt>移除上传头像</dt>
                <dd>{result.uploadsRemoved} 个</dd>
              </div>
              <div>
                <dt>会话密钥</dt>
                <dd>{result.sessionSecretRotated ? "已轮换，其他账号会话已失效" : "未轮换"}</dd>
              </div>
            </dl>
            <p className="settings-danger-success-note">
              <ShieldCheck size={15} />
              <span>
                <strong>系统内置管理员身份保留</strong>
                ：你仍以系统内置 <code>Admin</code> 身份登录，不会被登出。需要重建工作区时，前往
                「工作区设置」重新创建团队即可。
              </span>
            </p>
          </section>
        ) : null}

        <section className="card settings-danger-hero">
          <div className="settings-danger-hero-head">
            <span className="settings-danger-hero-icon">
              <ShieldAlert size={22} />
            </span>
            <div>
              <span className="settings-danger-hero-eyebrow">DANGER ZONE · 仅系统内置管理员</span>
              <h2>重置整个系统为默认设置并清除所有数据</h2>
              <p>
                这是一次不可撤销的出厂重置：全部业务数据与账号记录会被永久删除，所有设置恢复为默认值，
                已上传的头像文件也会被移除。系统不会自动备份，也无法回滚。
              </p>
            </div>
          </div>

          <div className="settings-danger-target">
            <span className="settings-danger-target-label">当前完整站点名称（最终确认时必须逐字输入）</span>
            <code className="settings-danger-target-name">
              {resetTarget || "（站点名称为空）"}
            </code>
            <span className="settings-danger-target-hint">
              重置后将恢复为默认站点名称「{info.defaultSiteName}」。
            </span>
            {resetTarget ? null : (
              <p className="settings-danger-target-empty">
                当前站点名称为空，无法执行重置。请先在「外观与站点」中设置站点名称。
              </p>
            )}
          </div>

          <ul className="settings-danger-notes">
            <li>
              <Trash2 size={14} />
              <span>
                删除所有团队、成员、工作记录、任务、待办、红黑榜、公告、任务标签、常用链接与责任田数据。
              </span>
            </li>
            <li>
              <Users size={14} />
              <span>删除全部账号、邮箱验证码、激活令牌、邮件日志与审计日志，并移除已上传的头像文件。</span>
            </li>
            <li>
              <RotateCcw size={14} />
              <span>站点名称、短名、主题、模块开关、权限、SSO 与 SMTP 等所有设置恢复为默认值。</span>
            </li>
            <li>
              <ShieldCheck size={14} />
              <span>
                系统内置管理员身份不写入配置，因此会保留；重置后工作区变为空白，可在「工作区设置」中重新创建。
              </span>
            </li>
          </ul>

          <div className="settings-danger-actions">
            <button
              type="button"
              className="btn btn-danger btn-lg"
              onClick={() => setStep("confirm")}
              disabled={!resetTarget}
            >
              <ShieldAlert size={17} /> 重置整个系统
            </button>
            <span className="settings-danger-actions-hint">
              需要连续两次确认，其中一次必须输入完整站点名称。
            </span>
          </div>
        </section>

        <section className="card settings-danger-card">
          <header className="settings-danger-card-head">
            <div>
              <h2>将被清除的数据</h2>
              <p>以下为当前系统中即将被永久删除的记录数量。</p>
            </div>
            <span className="settings-danger-card-total">共 {totalRecords} 条记录</span>
          </header>
          <div className="settings-danger-stats">
            {RESET_PRIMARY_STATS.map((item) => {
              const Icon = item.icon;
              return (
                <div key={item.key} className="settings-danger-stat">
                  <span className="settings-danger-stat-icon">
                    <Icon size={15} />
                  </span>
                  <span className="settings-danger-stat-value">{stats[item.key]}</span>
                  <span className="settings-danger-stat-label">{item.label}</span>
                </div>
              );
            })}
          </div>
          <div className="settings-danger-stats-compact">
            {RESET_EXTRA_STATS.map((item) => (
              <span key={item.key} className="settings-danger-stat-mini">
                {item.label}
                <strong>{stats[item.key]}</strong>
              </span>
            ))}
          </div>
          <p className="settings-danger-last-reset">
            <Clock size={13} />
            {info.lastResetAt ? (
              <>
                上次重置 <strong>{formatDateTime(info.lastResetAt)}</strong>
                {info.lastResetBy ? (
                  <>
                    <span className="settings-meta-divider">·</span>
                    操作者 <strong>{info.lastResetBy}</strong>
                  </>
                ) : null}
              </>
            ) : (
              "该系统从未执行过完整重置。"
            )}
          </p>
        </section>
      </div>

      <ConfirmDialog
        open={step === "confirm"}
        title="确定要重置整个系统吗？"
        message="重置会永久删除全部团队、成员、任务、待办、账号、日志与上传文件，并把所有设置恢复为默认值。系统内置管理员身份会保留，但所有业务数据都无法恢复。确认后还需要输入完整站点名称。"
        confirmLabel="确认重置"
        onClose={() => setStep("closed")}
        onConfirm={() => setStep("input")}
        tone="danger"
      />

      <ConfirmInputDialog
        open={step === "input"}
        title="最后一步：输入完整站点名称"
        description="名称必须与当前站点完全一致，最终按钮才会解锁。"
        message={
          <>
            <p>
              即将<strong>永久删除全部数据</strong>并恢复默认设置：所有团队、成员、任务、待办、
              账号、邮件验证码、激活令牌、邮件日志与审计日志，以及已上传的头像文件。
            </p>
            <p>
              该操作<strong>不可撤销、无法恢复</strong>。系统内置管理员身份会保留，但工作区将变为空白，需要重新创建。
            </p>
            <p>
              请输入当前完整站点名称 <strong>{info.siteName}</strong> 以解锁最终按钮。
            </p>
          </>
        }
        expected={info.siteName}
        inputLabel="完整站点名称"
        confirmLabel="重置并清除全部数据"
        actionLabel="重置"
        loading={submitting}
        onClose={() => {
          if (!submitting) setStep("closed");
        }}
        onConfirm={(value) => void submitReset(value)}
      />
    </>
  );
}

function DomainSettingsPage() {
  const { data, navigate } = useApp();
  const me = data?.me;
  const isAdmin = Boolean(me && (me.isDeviceAdmin || me.admin.role));
  if (!isAdmin) {
    return <SettingsAccessDenied onBack={() => navigate("overview")} />;
  }
  const identityLabel = me?.isDeviceAdmin
    ? "系统内置管理员"
    : me?.userRole === "super"
      ? "超级管理员"
      : me?.admin.role === "team_admin"
        ? "团队管理员"
        : "管理员";
  const scopeLabel = me?.isSuperAdmin
    ? "所有团队"
    : me?.admin.teamIds.length
      ? `${me.admin.teamIds.length} 个团队`
      : "暂无团队授权";

  return (
    <div className="settings-page fade-up">
      <header className="page-header settings-header">
        <div className="page-heading">
          <span className="eyebrow">
            <Building2 size={13} /> WORKSPACE SETTINGS
          </span>
          <h1 className="page-title">工作区设置</h1>
          <p className="page-subtitle">
            管理你被授权团队的团队信息，保存后立即生效。团队是唯一组织单位，数据按团队隔离；站点级设置仅超级管理员可访问。
          </p>
        </div>
        <div className="page-actions settings-header-actions">
          <span className="settings-dirty-pill is-clean">
            <i />
            已按角色授权
          </span>
        </div>
      </header>

      <div className="settings-meta-strip">
        <span className="settings-meta-chip">
          <ShieldCheck size={13} />
          当前身份 <strong>{me?.name}</strong>
          <span className="settings-meta-divider">·</span>
          {identityLabel}
        </span>
        <span className="settings-meta-chip">
          <Building2 size={13} />
          可管理范围 <strong>{scopeLabel}</strong>
        </span>
      </div>

      <WorkspaceSettingsSection />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

/**
 * Settings are role-scoped: super administrators get the full site control
 * centre; team administrators only ever see the domain (workspace) settings.
 * Non-super identities must never request `/api/settings` — that endpoint
 * answers 403 for them.
 */
export default function SettingsPage() {
  const { data } = useApp();
  const isSuper = Boolean(data?.me.isSuperAdmin);
  return isSuper ? <SiteSettingsPage /> : <DomainSettingsPage />;
}

function SiteSettingsPage() {
  const { data, reload, navigate } = useApp();
  const { toast } = useToast();

  // Only the built-in Admin of the deployment device may see / execute the factory reset.
  // Stored super administrators (`isSuperAdmin` true, `isDeviceAdmin` false) never get it.
  const isDeviceAdmin = Boolean(data?.me.isDeviceAdmin);
  const tabs = useMemo(
    () => (isDeviceAdmin ? [...TABS, RESET_TAB] : TABS),
    [isDeviceAdmin],
  );
  const allowedTabKeys = useMemo(() => tabs.map((tab) => tab.key), [tabs]);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [denied, setDenied] = useState(false);
  const [saved, setSaved] = useState<AppSettings | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [meta, setMeta] = useState<SettingsMeta | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceOption>({ teams: [] });
  const [workspaceError, setWorkspaceError] = useState("");
  const [activeTab, setActiveTab] = useState<TabKey>(() =>
    readTabFromHash(allowedTabKeys, "appearance"),
  );
  const [saving, setSaving] = useState(false);
  const [serverErrors, setServerErrors] = useState<ValidationDetail[]>([]);
  const [jsonText, setJsonText] = useState("");
  const [jsonDirty, setJsonDirty] = useState(false);
  const [jsonState, setJsonState] = useState<JsonState>({ status: "idle" });
  const [jsonBusy, setJsonBusy] = useState(false);
  const [confirmKind, setConfirmKind] = useState<ConfirmKind | null>(null);

  /* ---------- data loading ---------- */

  const loadWorkspace = useCallback(async () => {
    try {
      const result = await api.settingsWorkspace();
      setWorkspace(result);
      setWorkspaceError("");
    } catch (error) {
      setWorkspaceError(error instanceof ApiError ? error.message : "加载工作区数据失败");
    }
  }, []);

  const loadSettings = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setLoadError("");
    try {
      const result = await api.getSettings();
      // 契约 v3：旧服务端可能还没返回 guestModules；按「除系统设置外全部放行」补齐，
      // 避免设置页与 JSON 编辑器因缺字段崩溃（保存时会按新结构写回）。
      if (!result.settings.guestModules) {
        result.settings.guestModules = { ...result.settings.modules, settings: false };
      }
      // 系统设置模块永远不对访客开放：无论旧配置残留什么值都强制关闭。
      result.settings.guestModules.settings = false;
      setSaved(result.settings);
      setDraft(cloneSettings(result.settings));
      setMeta(result.meta);
      setServerErrors([]);
      setJsonText(prettify(result.settings));
      setJsonDirty(false);
      setJsonState({ status: "idle" });
      setDenied(false);
      if (!result.settings.auth.adminWhitelist) {
        setWorkspaceError("服务端返回的配置缺少 auth.adminWhitelist 字段");
      }
    } catch (error) {
      if (error instanceof ApiError && (error.status === 403 || error.status === 401)) {
        setDenied(true);
      } else {
        setLoadError(error instanceof ApiError ? error.message : "加载工作室配置失败");
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
    void loadWorkspace();
  }, [loadSettings, loadWorkspace]);

  /**
   * After a successful factory reset: drop the stale selected team id and re-read
   * settings, workspace options and the bootstrap data. `loadSettings(true)` refreshes in the
   * background so the reset success panel stays visible instead of a full-page loader.
   */
  const handleResetCompleted = useCallback(async () => {
    try {
      localStorage.removeItem("teamstudio.team");
    } catch {
      // ignore storage failures
    }
    await loadSettings(true);
    await loadWorkspace();
    await reload(true);
  }, [loadSettings, loadWorkspace, reload]);

  /* ---------- tab navigation (hash query: #/settings?tab=email) ---------- */

  useEffect(() => {
    const sync = () => setActiveTab(readTabFromHash(allowedTabKeys, "appearance"));
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [allowedTabKeys]);

  // Defensive guard: if the device-admin identity ever disappears while the reset tab is
  // active, fall back to a normal tab instead of rendering a forbidden section.
  useEffect(() => {
    if (!isDeviceAdmin && activeTab === "reset") setActiveTab("appearance");
  }, [activeTab, isDeviceAdmin]);

  const selectTab = useCallback(
    (tab: TabKey) => {
      setActiveTab(tab);
      navigateHash("settings", { tab });
      if (tab === "json") {
        setJsonText((current) => {
          if (!jsonDirty) {
            const source = draft ?? saved;
            return source ? prettify(source) : current;
          }
          return current;
        });
      }
    },
    [draft, jsonDirty, saved],
  );

  // Keep the raw JSON editor in sync with the GUI draft whenever the JSON tab is
  // entered without pending JSON edits (including hash-driven navigation).
  useEffect(() => {
    if (activeTab !== "json" || jsonDirty || !draft) return;
    const next = prettify(draft);
    setJsonText((current) => (current === next ? current : next));
  }, [activeTab, draft, jsonDirty]);

  /* ---------- draft editing ---------- */

  const update = useCallback<UpdateSettings>((mutate) => {
    setDraft((current) => {
      if (!current) return current;
      const next = cloneSettings(current);
      mutate(next);
      return next;
    });
    setServerErrors([]);
  }, []);

  const dirty = useMemo(() => {
    if (!saved || !draft) return false;
    return JSON.stringify(saved) !== JSON.stringify(draft);
  }, [saved, draft]);

  const hasUnsaved = dirty || jsonDirty;

  useEffect(() => {
    if (!hasUnsaved) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasUnsaved]);

  /* ---------- client-side validation ---------- */

  const clientErrors = useMemo<ValidationDetail[]>(() => {
    if (!draft) return [];
    const errors: ValidationDetail[] = [];
    const checkColor = (value: string, path: string, label: string) => {
      if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
        errors.push({ path, message: `${label}必须是 #RRGGBB 格式` });
      }
    };
    const checkEmail = (value: string, path: string, label: string) => {
      if (value && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
        errors.push({ path, message: `${label}格式不正确` });
      }
    };

    checkColor(draft.site.theme.accent, "site.theme.accent", "主色");
    checkColor(draft.site.theme.accentSecondary, "site.theme.accentSecondary", "辅助色");
    if (draft.site.theme.radius < 8 || draft.site.theme.radius > 32) {
      errors.push({ path: "site.theme.radius", message: "圆角需在 8-32 px 之间" });
    }
    if (draft.announcements.maxPinned < 0 || draft.announcements.maxPinned > 3) {
      errors.push({ path: "announcements.maxPinned", message: "置顶公告上限需在 0-3 之间" });
    }
    if (draft.announcements.dashboardLimit < 1 || draft.announcements.dashboardLimit > 10) {
      errors.push({ path: "announcements.dashboardLimit", message: "概览公告数量需在 1-10 之间" });
    }

    if (draft.email.smtp.host.trim() !== draft.email.smtp.host) {
      errors.push({ path: "email.smtp.host", message: "SMTP 服务器地址不能包含首尾空格" });
    }
    if (/\s/.test(draft.email.smtp.host.trim())) {
      errors.push({ path: "email.smtp.host", message: "SMTP 服务器地址不能包含空格" });
    }
    checkEmail(draft.email.smtp.fromEmail, "email.smtp.fromEmail", "发件邮箱");
    if (draft.email.smtp.port < 1 || draft.email.smtp.port > 65535) {
      errors.push({ path: "email.smtp.port", message: "SMTP 端口需在 1-65535 之间" });
    }
    if (draft.email.smtp.timeoutSeconds < 3 || draft.email.smtp.timeoutSeconds > 120) {
      errors.push({ path: "email.smtp.timeoutSeconds", message: "SMTP 超时需在 3-120 秒之间" });
    }
    if (draft.email.smtp.useStartTls && draft.email.smtp.useSsl) {
      errors.push({ path: "email.smtp.useSsl", message: "STARTTLS 与 SSL 直连只能开启一种" });
    }

    if (draft.auth.emailLogin.codeLength < 4 || draft.auth.emailLogin.codeLength > 8) {
      errors.push({ path: "auth.emailLogin.codeLength", message: "验证码位数需在 4-8 之间" });
    }
    if (
      draft.auth.emailLogin.codeExpiryMinutes < 2 ||
      draft.auth.emailLogin.codeExpiryMinutes > 30
    ) {
      errors.push({
        path: "auth.emailLogin.codeExpiryMinutes",
        message: "验证码有效期需在 2-30 分钟之间",
      });
    }
    if (draft.auth.emailLogin.resendSeconds < 30 || draft.auth.emailLogin.resendSeconds > 600) {
      errors.push({ path: "auth.emailLogin.resendSeconds", message: "重发间隔需在 30-600 秒之间" });
    }
    if (draft.auth.emailLogin.maxAttempts < 3 || draft.auth.emailLogin.maxAttempts > 10) {
      errors.push({ path: "auth.emailLogin.maxAttempts", message: "最大尝试次数需在 3-10 次之间" });
    }

    draft.auth.adminWhitelist.ips.forEach((entry, index) => {
      if (!entry.ip.trim()) {
        errors.push({ path: `auth.adminWhitelist.ips.${index}.ip`, message: "IP / CIDR 不能为空" });
      }
      const problem = scopeProblem(entry);
      if (problem) {
        errors.push({ path: `auth.adminWhitelist.ips.${index}.teamId`, message: problem });
      }
    });
    draft.auth.adminWhitelist.ids.forEach((entry, index) => {
      if (!entry.id.trim()) {
        errors.push({ path: `auth.adminWhitelist.ids.${index}.id`, message: "SSO 标识 / 邮箱不能为空" });
      }
      const problem = scopeProblem(entry);
      if (problem) {
        errors.push({ path: `auth.adminWhitelist.ids.${index}.teamId`, message: problem });
      }
    });
    if (draft.auth.session.maxAgeDays < 1 || draft.auth.session.maxAgeDays > 90) {
      errors.push({ path: "auth.session.maxAgeDays", message: "登录状态保持天数需在 1-90 天之间" });
    }
    if (draft.auth.session.cookieName.trim().length < 3) {
      errors.push({ path: "auth.session.cookieName", message: "会话 Cookie 名至少 3 个字符" });
    }
    if (draft.auth.session.cookieName.trim().length > 64) {
      errors.push({ path: "auth.session.cookieName", message: "会话 Cookie 名不能超过 64 个字符" });
    }
    return errors;
  }, [draft]);

  const errorsFor = useCallback<ErrorsFor>(
    (prefix) =>
      [...clientErrors, ...serverErrors].filter(
        (detail) => detail.path === prefix || detail.path.startsWith(`${prefix}.`),
      ),
    [clientErrors, serverErrors],
  );

  const allErrors = useMemo(() => {
    const seen = new Set<string>();
    const merged: ValidationDetail[] = [];
    [...clientErrors, ...serverErrors].forEach((detail) => {
      const key = `${detail.path}|${detail.message}`;
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(detail);
    });
    return merged;
  }, [clientErrors, serverErrors]);

  /* ---------- saving ---------- */

  const applySaved = useCallback(
    (result: { settings: AppSettings; meta: SettingsMeta }) => {
      // 与 loadSettings 一致：保证 guestModules 始终存在，且系统设置模块对访客始终关闭。
      if (!result.settings.guestModules) {
        result.settings.guestModules = { ...result.settings.modules, settings: false };
      }
      result.settings.guestModules.settings = false;
      setSaved(result.settings);
      setDraft(cloneSettings(result.settings));
      setMeta(result.meta);
      setServerErrors([]);
      setJsonText(prettify(result.settings));
      setJsonDirty(false);
      setJsonState({ status: "ok", checkedAt: new Date().toISOString() });
    },
    [],
  );

  const handleGuiSave = useCallback(async () => {
    if (!draft || saving) return;
    if (clientErrors.length) {
      setServerErrors(clientErrors);
      toast("有配置项未通过本地预检，请先修正后再保存", "error");
      const first = clientErrors[0];
      const tab = tabForPath(first.path);
      if (tab) selectTab(tab);
      return;
    }
    setSaving(true);
    setServerErrors([]);
    try {
      const result = await api.saveSettings(draft);
      applySaved(result);
      toast("配置已保存，导航与主题已即时更新");
      await reload(true);
    } catch (error) {
      if (error instanceof ApiError) {
        const details = asValidationDetails(error.details);
        if (details.length) {
          setServerErrors(details);
          toast("配置校验未通过，请查看下方的路径错误", "error");
          const tab = tabForPath(details[0].path);
          if (tab) selectTab(tab);
        } else if (error.status === 403) {
          setDenied(true);
        } else {
          toast(error.message || "保存失败，请稍后重试", "error");
        }
      } else {
        toast("保存失败，请稍后重试", "error");
      }
    } finally {
      setSaving(false);
    }
  }, [applySaved, clientErrors, draft, reload, saving, selectTab, toast]);

  const parseJsonDraft = useCallback((): AppSettings | null => {
    const parsed = safeJsonParse<unknown>(jsonText);
    if (parsed.error || parsed.value === null) {
      setJsonState({
        status: "error",
        syntaxError: parsed.error ?? "JSON 为空或无法解析",
        details: [],
        checkedAt: new Date().toISOString(),
      });
      return null;
    }
    if (typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
      setJsonState({
        status: "error",
        syntaxError: "顶层配置必须是一个 JSON 对象（{ ... }）",
        details: [],
        checkedAt: new Date().toISOString(),
      });
      return null;
    }
    return parsed.value as AppSettings;
  }, [jsonText]);

  const validateJson = useCallback(async (): Promise<AppSettings | null> => {
    const candidate = parseJsonDraft();
    if (!candidate) {
      toast("JSON 语法错误，无法校验", "error");
      return null;
    }
    setJsonBusy(true);
    try {
      const result = await api.validateSettings(candidate);
      setJsonState({ status: "ok", checkedAt: new Date().toISOString() });
      return result.settings ?? candidate;
    } catch (error) {
      if (error instanceof ApiError) {
        const details = asValidationDetails(error.details);
        setJsonState({
          status: "error",
          syntaxError: details.length ? undefined : error.message,
          details,
          checkedAt: new Date().toISOString(),
        });
        toast(details.length ? "配置校验未通过，请查看路径错误" : error.message || "校验失败", "error");
      } else {
        setJsonState({
          status: "error",
          syntaxError: "校验失败，请稍后重试",
          details: [],
          checkedAt: new Date().toISOString(),
        });
        toast("校验失败，请稍后重试", "error");
      }
      return null;
    } finally {
      setJsonBusy(false);
    }
  }, [parseJsonDraft, toast]);

  const handleJsonSave = useCallback(async () => {
    if (saving || jsonBusy) return;
    const candidate = parseJsonDraft();
    if (!candidate) {
      toast("JSON 语法错误，保存前必须修正", "error");
      return;
    }
    setSaving(true);
    setJsonBusy(true);
    try {
      const validated = await api.validateSettings(candidate);
      const result = await api.saveSettings(validated.settings ?? candidate);
      applySaved(result);
      toast("JSON 配置已保存并即时生效");
      await reload(true);
    } catch (error) {
      if (error instanceof ApiError) {
        const details = asValidationDetails(error.details);
        if (details.length) {
          setJsonState({
            status: "error",
            details,
            checkedAt: new Date().toISOString(),
          });
          toast("配置校验未通过，请查看路径错误", "error");
        } else if (error.status === 403) {
          setDenied(true);
        } else {
          setJsonState({
            status: "error",
            syntaxError: error.message,
            details: [],
            checkedAt: new Date().toISOString(),
          });
          toast(error.message || "保存失败，请稍后重试", "error");
        }
      } else {
        toast("保存失败，请稍后重试", "error");
      }
    } finally {
      setSaving(false);
      setJsonBusy(false);
    }
  }, [applySaved, jsonBusy, parseJsonDraft, reload, saving, toast]);

  const handleSave = useCallback(() => {
    if (activeTab === "json") {
      void handleJsonSave();
    } else {
      void handleGuiSave();
    }
  }, [activeTab, handleGuiSave, handleJsonSave]);

  /* ---------- json helpers ---------- */

  const formatJson = useCallback(() => {
    const parsed = safeJsonParse<unknown>(jsonText);
    if (parsed.error || parsed.value === null) {
      setJsonState({
        status: "error",
        syntaxError: parsed.error ?? "JSON 无法解析",
        details: [],
        checkedAt: new Date().toISOString(),
      });
      toast("JSON 语法错误，无法格式化", "error");
      return;
    }
    setJsonText(prettify(parsed.value));
    setJsonDirty(true);
    setJsonState({ status: "idle" });
    toast("已格式化 JSON", "info");
  }, [jsonText, toast]);

  const copyJson = useCallback(async () => {
    const ok = await copyText(jsonText);
    toast(ok ? "已复制完整配置 JSON" : "复制失败，请手动选择文本", ok ? "success" : "error");
  }, [jsonText, toast]);

  const liveSyntaxError = useMemo(() => {
    if (!jsonText.trim()) return "JSON 内容为空";
    const parsed = safeJsonParse<unknown>(jsonText);
    return parsed.error;
  }, [jsonText]);

  /* ---------- unsaved-change guards ---------- */

  const requestConfirm = (kind: ConfirmKind) => {
    if (kind === "reload" && !hasUnsaved) {
      void loadSettings();
      void loadWorkspace();
      return;
    }
    if ((kind === "json-sync" || kind === "json-reset") && !jsonDirty) {
      if (kind === "json-sync" && draft) setJsonText(prettify(draft));
      if (kind === "json-reset" && saved) setJsonText(prettify(saved));
      setJsonState({ status: "idle" });
      return;
    }
    setConfirmKind(kind);
  };

  const confirmMeta = useMemo(() => {
    switch (confirmKind) {
      case "reload":
        return {
          title: "放弃修改并重新加载？",
          message: "当前有未保存的修改，重新加载会丢弃这些改动并从服务器重新读取配置。",
          confirmLabel: "重新加载",
        };
      case "discard":
        return {
          title: "撤销所有未保存修改？",
          message: "草稿与 JSON 编辑内容都会恢复到上次保存的配置，此操作不可撤销。",
          confirmLabel: "撤销修改",
        };
      case "json-sync":
        return {
          title: "用 GUI 草稿覆盖 JSON？",
          message: "当前 JSON 编辑器中的内容将被 GUI 草稿的完整配置替换。",
          confirmLabel: "覆盖 JSON",
        };
      case "json-reset":
        return {
          title: "恢复为服务器版本？",
          message: "JSON 编辑器将丢弃当前内容，恢复为服务器上已保存的配置。",
          confirmLabel: "恢复服务器版本",
        };
      default:
        return null;
    }
  }, [confirmKind]);

  const runConfirm = () => {
    const kind = confirmKind;
    setConfirmKind(null);
    if (!kind) return;
    if (kind === "reload") {
      void loadSettings();
      void loadWorkspace();
      return;
    }
    if (kind === "discard") {
      if (saved) {
        setDraft(cloneSettings(saved));
        setJsonText(prettify(saved));
        setJsonDirty(false);
        setJsonState({ status: "idle" });
        setServerErrors([]);
        toast("已恢复到上次保存的配置", "info");
      }
      return;
    }
    if (kind === "json-sync") {
      if (draft) setJsonText(prettify(draft));
      setJsonDirty(false);
      setJsonState({ status: "idle" });
      toast("已从 GUI 草稿同步 JSON", "info");
      return;
    }
    if (kind === "json-reset") {
      if (saved) setJsonText(prettify(saved));
      setJsonDirty(false);
      setJsonState({ status: "idle" });
      toast("已恢复为服务器版本", "info");
    }
  };

  /* ---------- render guards ---------- */

  if (denied) {
    return <SettingsAccessDenied onBack={() => navigate("overview")} />;
  }

  if (loading) {
    return (
      <div className="settings-page">
        <div className="card card-pad settings-loading">
          <LoadingBlock label="正在读取工作室配置…" rows={6} />
        </div>
      </div>
    );
  }

  if (loadError || !draft || !saved) {
    return (
      <div className="state-screen compact">
        <div className="state-card">
          <span className="state-icon danger">
            <AlertTriangle size={26} />
          </span>
          <h1>读取工作室配置失败</h1>
          <p>{loadError || "服务器没有返回有效的配置数据。"}</p>
          <div className="state-actions">
            <button className="btn btn-primary" onClick={() => void loadSettings()}>
              <RefreshCw size={16} /> 重新加载
            </button>
            <button className="btn btn-ghost" onClick={() => navigate("overview")}>
              返回团队概览
            </button>
          </div>
        </div>
      </div>
    );
  }

  const canSave = hasUnsaved && !saving;
  const adminName = data?.me.name ?? "Admin";
  const identityLabel = data?.me.isDeviceAdmin ? "系统内置管理员" : "超级管理员";
  const isSiteTab =
    activeTab !== "workspace" && activeTab !== "accounts" && activeTab !== "reset";
  const saveLabel = activeTab === "json" ? "校验并保存" : "保存设置";

  return (
    <div className="settings-page fade-up">
      <header className="page-header settings-header">
        <div className="page-heading">
          <span className="eyebrow">
            <ShieldCheck size={13} /> ADMIN CONTROL CENTER
          </span>
          <h1 className="page-title">工作室设置</h1>
          <p className="page-subtitle">
            统一管理站点外观、模块展示、登录权限、账号角色、企业 SSO 与邮件服务。站点级设置保存后即时生效，
            工作区结构的修改会立即写入。
          </p>
        </div>
        <div className="page-actions settings-header-actions">
          <span className={cn("settings-dirty-pill", hasUnsaved ? "is-dirty" : "is-clean")}>
            <i />
            {hasUnsaved ? "有未保存修改" : "已与配置同步"}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => requestConfirm("reload")}
            disabled={saving}
          >
            <RefreshCw size={15} /> 重新加载
          </button>
          {hasUnsaved ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => requestConfirm("discard")}
              disabled={saving}
            >
              <RotateCcw size={15} /> 撤销修改
            </button>
          ) : null}
          {isSiteTab ? (
            <a className="btn btn-secondary btn-sm" href="/api/settings/schema" target="_blank" rel="noreferrer">
              <FileJson size={15} /> JSON Schema
            </a>
          ) : null}
          {isSiteTab ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleSave}
              disabled={saving || !canSave}
            >
              {saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
              {saving ? "保存中…" : saveLabel}
            </button>
          ) : null}
        </div>
      </header>

      <div className="settings-meta-strip">
        <span className="settings-meta-chip">
          <ShieldCheck size={13} />
          当前身份 <strong>{adminName}</strong>
          <span className="settings-meta-divider">·</span>
          {identityLabel}
        </span>
        <span className="settings-meta-chip">
          <FileJson size={13} />
          配置版本 <strong>v{meta?.schemaVersion ?? draft.version}</strong>
        </span>
        <span className="settings-meta-chip">
          <Clock size={13} />
          最后保存 <strong>{meta?.updatedAt ? formatDateTime(meta.updatedAt) : "—"}</strong>
        </span>
        <span className="settings-meta-chip settings-meta-path" title={meta?.path}>
          <Database size={13} />
          <code>{meta?.path ?? "data/settings.json"}</code>
        </span>
        <span className="settings-meta-chip">
          <Sparkles size={13} />
          系统内置管理员 <strong>{meta?.deviceAdminName ?? "Admin"}</strong>
          <span className="settings-meta-divider">·</span>
          不写入配置
        </span>
      </div>

      {workspaceError ? (
        <div className="settings-workspace-warning">
          <AlertTriangle size={14} />
          <span>
            工作区数据加载失败：{workspaceError}。「成员与权限」「账号与角色」中的团队选择器可能不可用。
          </span>
          <button type="button" className="text-button" onClick={() => void loadWorkspace()}>
            重试
          </button>
        </div>
      ) : null}

      <div className="settings-layout">
        <nav className="settings-tabs" aria-label="设置分组">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.key}
                type="button"
                className={cn(
                  "settings-tab",
                  tab.key === activeTab && "active",
                  tab.key === "reset" && "settings-danger-tab",
                )}
                aria-pressed={tab.key === activeTab}
                onClick={() => selectTab(tab.key)}
              >
                <span className="settings-tab-icon">
                  <Icon size={17} />
                </span>
                <span className="settings-tab-copy">
                  <strong>{tab.label}</strong>
                  <small>{tab.hint}</small>
                </span>
                {tab.key === "json" && jsonDirty ? <i className="settings-tab-dot" /> : null}
                {tab.key === "email" && !draft.email.enabled ? (
                  <span className="settings-tab-flag">关</span>
                ) : null}
              </button>
            );
          })}
          <p className="settings-tabs-note">
            <ShieldCheck size={13} /> 站点级设置仅超级管理员可修改；团队管理员只能在「工作区设置」中管理自己的团队范围。
          </p>
        </nav>

        <div className="settings-main">
          {isSiteTab && allErrors.length ? (
            <div className="settings-error-panel" role="alert">
              <header className="settings-error-head">
                <span className="settings-error-icon">
                  <AlertTriangle size={17} />
                </span>
                <div>
                  <strong>配置未通过校验（{allErrors.length} 项）</strong>
                  <p>修正以下路径后即可保存；点击路径可跳转到对应分组。</p>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="收起错误列表"
                  onClick={() => setServerErrors([])}
                >
                  <X size={16} />
                </button>
              </header>
              <ul className="settings-error-list">
                {allErrors.map((detail, index) => {
                  const tab = tabForPath(detail.path);
                  return (
                    <li key={`${detail.path}-${detail.message}-${index}`}>
                      <button
                        type="button"
                        className="settings-error-path"
                        onClick={() => (tab ? selectTab(tab) : undefined)}
                        title={detail.path}
                      >
                        {pathLabel(detail.path)}
                      </button>
                      <code>{detail.path}</code>
                      <span>{detail.message}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          {activeTab === "workspace" ? <WorkspaceSettingsSection /> : null}
          {activeTab === "appearance" ? (
            <AppearanceSection draft={draft} update={update} errorsFor={errorsFor} />
          ) : null}
          {activeTab === "modules" ? (
            <ModulesSection draft={draft} update={update} errorsFor={errorsFor} />
          ) : null}
          {activeTab === "access" ? (
            <AccessSection
              draft={draft}
              update={update}
              errorsFor={errorsFor}
              workspace={workspace}
              meta={meta}
            />
          ) : null}
          {activeTab === "accounts" ? (
            <AccountsSection
              workspace={workspace}
              deviceAdminName={meta?.deviceAdminName ?? "Admin"}
            />
          ) : null}
          {activeTab === "sso" ? (
            <SsoSection draft={draft} update={update} errorsFor={errorsFor} />
          ) : null}
          {activeTab === "email" ? (
            <EmailSection draft={draft} update={update} errorsFor={errorsFor} />
          ) : null}
          {activeTab === "json" ? (
            <JsonWorkspace
              draft={draft}
              saved={saved}
              jsonText={jsonText}
              jsonDirty={jsonDirty}
              saving={saving}
              busy={jsonBusy}
              state={jsonState}
              liveSyntaxError={liveSyntaxError}
              meta={meta}
              onTextChange={(text) => {
                setJsonText(text);
                setJsonDirty(true);
                setJsonState({ status: "idle" });
              }}
              onFormat={formatJson}
              onValidate={() => void validateJson()}
              onSave={() => void handleJsonSave()}
              onSyncDraft={() => requestConfirm("json-sync")}
              onResetServer={() => requestConfirm("json-reset")}
              onCopy={() => void copyJson()}
              onJumpTab={selectTab}
            />
          ) : null}
          {activeTab === "reset" && isDeviceAdmin ? (
            <SystemResetSection onCompleted={handleResetCompleted} />
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        open={confirmMeta !== null}
        title={confirmMeta?.title ?? ""}
        message={confirmMeta?.message ?? ""}
        confirmLabel={confirmMeta?.confirmLabel}
        onClose={() => setConfirmKind(null)}
        onConfirm={runConfirm}
        loading={saving}
        tone="danger"
      />
    </div>
  );
}
