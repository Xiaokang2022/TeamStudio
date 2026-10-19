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
  Braces,
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
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Server,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  Trophy,
  Users,
  Wand2,
  Waypoints,
  X,
  type LucideIcon,
} from "lucide-react";
import { api, ApiError } from "../api";
import { useApp } from "../store";
import { useToast } from "../components/Toast";
import { ConfirmDialog } from "../components/Modal";
import { LoadingBlock } from "../components/Feedback";
import { EmailPanel } from "../components/EmailPanel";
import {
  cn,
  copyText,
  formatDateTime,
  groupBy,
  hashRoute,
  navigate as navigateHash,
  safeJsonParse,
} from "../lib/utils";
import type {
  AdminIdEntry,
  AdminIpEntry,
  AppSettings,
  ModuleFlags,
  SettingsMeta,
  ValidationDetail,
  WorkspaceOption,
} from "../types";
import "./SettingsPage.css";

type TabKey = "appearance" | "modules" | "access" | "sso" | "email" | "json";
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

const TAB_KEYS: TabKey[] = ["appearance", "modules", "access", "sso", "email", "json"];

const TABS: { key: TabKey; label: string; hint: string; icon: LucideIcon }[] = [
  { key: "appearance", label: "外观与站点", hint: "名称、品牌与主题", icon: Palette },
  { key: "modules", label: "模块与展示", hint: "模块开关与默认项", icon: LayoutGrid },
  { key: "access", label: "团队与权限", hint: "白名单、访客与会话", icon: ShieldCheck },
  { key: "sso", label: "企业 SSO", hint: "OIDC 身份接入", icon: Fingerprint },
  { key: "email", label: "邮件提醒", hint: "SMTP、模板与日志", icon: Mail },
  { key: "json", label: "高级 JSON", hint: "完整配置与校验", icon: Braces },
];

const MODULE_META: {
  key: keyof ModuleFlags;
  label: string;
  description: string;
  icon: LucideIcon;
}[] = [
  { key: "overview", label: "团队概览", description: "成员卡片、成长轨迹与近期动态。", icon: LayoutDashboard },
  { key: "tasks", label: "任务总览", description: "成员任务台账、健康状态与工作量负载。", icon: ListTodo },
  { key: "calendar", label: "协作日历", description: "待办、提醒与月度日历视图。", icon: CalendarDays },
  { key: "redblack", label: "红黑榜", description: "每月红榜高光与黑榜改进记录。", icon: Trophy },
  { key: "announcements", label: "公告栏", description: "开发组公告与置顶消息。", icon: Megaphone },
  { key: "matrix", label: "责任田矩阵", description: "职责分工、负责人与联络方式。", icon: Waypoints },
  { key: "links", label: "常用链接", description: "团队常用工具与文档入口。", icon: Link2 },
  { key: "settings", label: "工作室设置", description: "关闭后导航隐藏，设备 Admin 仍可直接访问本页。", icon: Settings2 },
  { key: "email", label: "邮件提醒模块", description: "邮件提醒入口与相关能力开关。", icon: Mail },
];

const REMINDER_OFFSET_PRESETS = [0, 1, 2, 3, 5, 7, 14, 30];

const FIELD_LABELS: Record<string, string> = {
  "site.name": "站点名称",
  "site.shortName": "站点简称",
  "site.tagline": "品牌标语",
  "site.logoText": "Logo 文字",
  "site.footerText": "页脚文案",
  "site.theme.mode": "主题模式",
  "site.theme.accent": "主色",
  "site.theme.accentSecondary": "辅助色",
  "site.theme.radius": "卡片圆角",
  "announcements.maxPinned": "公告置顶上限",
  "announcements.dashboardLimit": "概览公告数量",
  "announcements.showOnDashboard": "概览展示公告",
  "calendar.weekStartsOn": "每周起始日",
  "calendar.showWeekends": "展示周末",
  "calendar.defaultReminderOffsetsDays": "默认提醒提前天数",
  "calendar.defaultReminderTime": "默认提醒时间",
  "calendar.allowPastDue": "允许设置过期日期",
  "calendar.defaultEmailEnabled": "默认开启邮件提醒",
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
  "email.reminders.enabled": "提醒扫描",
  "email.reminders.offsetsDays": "提醒提前天数",
  "email.reminders.sendTime": "提醒发送时间",
  "email.reminders.scanIntervalSeconds": "扫描间隔",
  "email.reminders.notifyAssignee": "通知负责人",
  "email.reminders.additionalRecipients": "附加收件人",
  "email.reminders.includeAnnouncements": "附带置顶公告",
  "email.reminders.includeTodoDescription": "附带事项说明",
  "email.reminders.includeExtra": "附加补充内容",
  "email.reminders.extraContent": "补充内容",
  "email.reminders.subjectTemplate": "邮件主题模板",
  "email.reminders.bodyTemplate": "邮件正文模板",
  "auth.guestMode": "访客模式",
  "auth.allowGuestRead": "允许访客只读",
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
  "auth.session.maxAgeDays": "会话有效期",
  "auth.session.secureCookie": "仅 HTTPS Cookie",
  "features.allowMemberSelfEdit": "成员自助编辑",
  "features.showGuestBanner": "访客提示条",
  "features.showDemoBadge": "演示数据标识",
  "features.auditLog": "审计日志",
  "features.allowGuestTodoCreate": "访客创建待办",
  "adminWhitelist.ip": "IP / CIDR",
  "adminWhitelist.id": "SSO 标识 / 邮箱",
  "adminWhitelist.name": "显示名称",
  "adminWhitelist.role": "管理角色",
  "adminWhitelist.teamId": "团队",
  "adminWhitelist.groupIds": "开发组范围",
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

function readTabFromHash(): TabKey {
  const raw = hashRoute().params.get("tab") ?? "";
  return TAB_KEYS.includes(raw as TabKey) ? (raw as TabKey) : "appearance";
}

function pathLabel(path: string): string {
  if (FIELD_LABELS[path]) return FIELD_LABELS[path];
  const entry = path.match(/^auth\.adminWhitelist\.(ips|ids)\.(\d+)\.(.+)$/);
  if (entry) {
    const kind = entry[1] === "ips" ? "IP" : "ID";
    const field = FIELD_LABELS[`adminWhitelist.${entry[3]}`] ?? entry[3];
    return `${kind} 白名单第 ${Number(entry[2]) + 1} 项 · ${field}`;
  }
  const recipient = path.match(/^email\.reminders\.additionalRecipients\.(\d+)$/);
  if (recipient) return `附加收件人第 ${Number(recipient[1]) + 1} 项`;
  const domain = path.match(/^auth\.sso\.allowedEmailDomains\.(\d+)$/);
  if (domain) return `允许的邮箱域名第 ${Number(domain[1]) + 1} 项`;
  const offset = path.match(/^email\.reminders\.offsetsDays\.(\d+)$/);
  if (offset) return `提醒提前天数第 ${Number(offset[1]) + 1} 项`;
  return path;
}

function tabForPath(path: string): TabKey | null {
  if (path.startsWith("site")) return "appearance";
  if (
    path.startsWith("modules") ||
    path.startsWith("announcements") ||
    path.startsWith("calendar") ||
    path.startsWith("redblack") ||
    path.startsWith("features")
  ) {
    return "modules";
  }
  if (path.startsWith("auth.adminWhitelist") || path.startsWith("auth.session")) return "access";
  if (path.startsWith("auth.guestMode") || path.startsWith("auth.allowGuestRead")) return "access";
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
  if (entry.role === "team_admin" && !entry.teamId) return "团队管理员必须选择一个团队";
  if (entry.role === "group_admin" && entry.groupIds.length === 0) {
    return "开发组管理员必须至少选择一个开发组";
  }
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

function OffsetsEditor({
  values,
  onChange,
}: {
  values: number[];
  onChange: (values: number[]) => void;
}) {
  const [custom, setCustom] = useState("");
  const toggle = (offset: number) => {
    const next = values.includes(offset)
      ? values.filter((item) => item !== offset)
      : [...values, offset];
    onChange([...new Set(next)].sort((a, b) => b - a));
  };
  const addCustom = () => {
    const parsed = Number.parseInt(custom, 10);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 60) return;
    onChange([...new Set([...values, parsed])].sort((a, b) => b - a));
    setCustom("");
  };
  return (
    <div className="settings-offsets">
      <div className="tag-list">
        {REMINDER_OFFSET_PRESETS.map((offset) => {
          const active = values.includes(offset);
          return (
            <button
              key={offset}
              type="button"
              className={cn("chip", "chip-clickable", "settings-offset-chip", active && "is-active")}
              onClick={() => toggle(offset)}
            >
              {active ? <Check size={11} /> : null}
              {offset === 0 ? "当天" : `提前 ${offset} 天`}
            </button>
          );
        })}
        {values
          .filter((offset) => !REMINDER_OFFSET_PRESETS.includes(offset))
          .map((offset) => (
            <button
              key={offset}
              type="button"
              className="chip chip-clickable settings-offset-chip is-active"
              onClick={() => toggle(offset)}
            >
              <Check size={11} /> 提前 {offset} 天
            </button>
          ))}
      </div>
      <div className="settings-list-add">
        <input
          className="input"
          type="number"
          min={0}
          max={60}
          placeholder="自定义天数 (0-60)"
          value={custom}
          onChange={(event) => setCustom(event.target.value)}
        />
        <button type="button" className="btn btn-secondary btn-sm" onClick={addCustom}>
          <Plus size={14} /> 添加天数
        </button>
      </div>
      <p className="field-hint">
        当前：{values.length ? values.map((offset) => (offset === 0 ? "当天" : `提前 ${offset} 天`)).join(" · ") : "未设置"}
      </p>
    </div>
  );
}

function GroupPicker({
  workspace,
  teamFilter,
  selected,
  onChange,
}: {
  workspace: WorkspaceOption;
  teamFilter?: string;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const grouped = useMemo(() => groupBy(workspace.groups, (group) => group.team_id), [workspace.groups]);
  const visibleTeams = teamFilter
    ? workspace.teams.filter((team) => team.id === teamFilter)
    : workspace.teams;
  if (!visibleTeams.length) {
    return <p className="field-hint">工作区中暂无开发组数据。</p>;
  }
  return (
    <div className="settings-group-picker">
      {visibleTeams.map((team) => {
        const groups = grouped[team.id] ?? [];
        if (!groups.length) return null;
        return (
          <div className="settings-group-team" key={team.id}>
            <span className="settings-group-team-name">
              <i style={{ background: team.color }} />
              {team.name}
            </span>
            <div className="tag-list">
              {groups.map((group) => {
                const active = selected.includes(group.id);
                return (
                  <button
                    key={group.id}
                    type="button"
                    className={cn("chip", "chip-clickable", active && "settings-group-chip-active")}
                    onClick={() =>
                      onChange(
                        active
                          ? selected.filter((id) => id !== group.id)
                          : [...selected, group.id],
                      )
                    }
                  >
                    {active ? <Check size={11} /> : null}
                    {group.name}
                  </button>
                );
              })}
            </div>
          </div>
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
        <h1>仅部署设备的 Admin 可编辑设置</h1>
        <p>
          工作室设置接口只对部署设备内置的 <strong>Admin</strong> 开放。该身份由服务端根据请求来源自动识别，
          永远存在、不会写入 <code>settings.json</code>，也无法加入 IP / ID 白名单。
        </p>
        <p className="small muted">
          团队管理员与开发组管理员可以管理各自范围内的成员与内容，但无法查看或修改本页配置。
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
  const site = draft.site;
  const theme = site.theme;
  const modeLabel = theme.mode === "dark" ? "暗黑" : theme.mode === "auto" ? "跟随系统" : "纸白";
  const previewStyle = {
    "--pv-accent": "#0a59f7",
    "--pv-secondary": "#4d8dff",
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
          <Field label="站点名称" error={errorText(errorsFor("site.name"))} hint="例如：星港团队工作室">
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
        description="保存后立即应用到整个工作台，包括侧边栏高亮与按钮渐变。"
        icon={<Palette size={18} />}
      >
        <div className="settings-theme-grid">
          <Field label="主题模式" error={errorText(errorsFor("site.theme.mode"))}>
            <div className="segmented settings-mode-switch">
              {(
                [
                  { value: "light", label: "纸白" },
                  { value: "dark", label: "暗黑" },
                  { value: "auto", label: "跟随系统" },
                ] as const
              ).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={theme.mode === option.value ? "active" : undefined}
                  onClick={() =>
                    update((next) => {
                      next.site.theme.mode = option.value;
                    })
                  }
                >
                  {option.label}
                </button>
              ))}
            </div>
          </Field>

          <Field label="卡片圆角" error={errorText(errorsFor("site.theme.radius"))} hint="8 - 32 px">
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

          <Field
            label="统一色板"
            className="span-2"
            hint="当前版本采用固定鸿蒙色板，避免出现多套高饱和主题；主题仅切换纸白与暗黑两种模式。"
          >
            <div className="settings-locked-palette">
              <span className="settings-locked-swatch">
                <i style={{ background: "#0a59f7" }} /> 主色 #0a59f7
              </span>
              <span className="settings-locked-swatch">
                <i style={{ background: "#4d8dff" }} /> 辅助色 #4d8dff
              </span>
              <span className="settings-locked-swatch">
                <i style={{ background: "#f2f2ef" }} /> 纸白 #f2f2ef
              </span>
              <span className="settings-locked-swatch">
                <i style={{ background: "#09090b" }} /> 暗黑 #09090b
              </span>
            </div>
          </Field>
        </div>
      </SettingsCard>

      <SettingsCard
        title="实时预览"
        description="组件配色与圆角会以当前草稿值渲染，保存后同步到全站。"
        icon={<Eye size={18} />}
      >
        <div
          className="settings-preview"
          data-preview-mode={theme.mode === "dark" ? "dark" : "light"}
          style={previewStyle}
        >
          <div className="settings-preview-brand">
            <span className="settings-preview-logo">{site.logoText || "TS"}</span>
            <div>
              <strong>{site.name || "未命名团队工作室"}</strong>
              <small>{site.shortName || "SHORT"}</small>
            </div>
            <span className="settings-preview-mode">{modeLabel}</span>
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
          title="日历默认项"
          description="新建待办时的默认提醒策略，可被单个待办覆盖。"
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
            <Field label="默认提醒时间" error={errorText(errorsFor("calendar.defaultReminderTime"))}>
              <input
                className="input"
                type="time"
                value={draft.calendar.defaultReminderTime}
                onChange={(event) =>
                  update((next) => {
                    next.calendar.defaultReminderTime = event.target.value;
                  })
                }
              />
            </Field>
            <Field
              label="默认提醒提前天数"
              className="span-2"
              error={errorText(errorsFor("calendar.defaultReminderOffsetsDays"))}
              hint="0 表示到期当天提醒；系统会自动去重并倒序。"
            >
              <OffsetsEditor
                values={draft.calendar.defaultReminderOffsetsDays}
                onChange={(values) =>
                  update((next) => {
                    next.calendar.defaultReminderOffsetsDays = values;
                  })
                }
              />
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
              <ToggleRow
                label="默认开启邮件提醒"
                description="新建待办时默认勾选邮件提醒。"
                checked={draft.calendar.defaultEmailEnabled}
                onChange={(checked) =>
                  update((next) => {
                    next.calendar.defaultEmailEnabled = checked;
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
  const teamGroups = workspace.groups.filter((group) => group.team_id === entry.teamId);
  const problem = scopeProblem(entry);

  return (
    <article className={cn("settings-admin-entry", problem && "has-problem")}>
      <header className="settings-admin-entry-head">
        <span className="settings-admin-entry-tag">
          {kind === "ip" ? <Globe size={13} /> : <Fingerprint size={13} />}
          {kind === "ip" ? `IP 白名单 #${index + 1}` : `ID 白名单 #${index + 1}`}
        </span>
        <div className="settings-admin-entry-actions">
          <div className="segmented">
            <button
              type="button"
              className={entry.role === "team_admin" ? "active" : undefined}
              onClick={() => onChange({ ...entry, role: "team_admin" })}
            >
              团队管理员
            </button>
            <button
              type="button"
              className={entry.role === "group_admin" ? "active" : undefined}
              onClick={() => onChange({ ...entry, role: "group_admin" })}
            >
              开发组管理员
            </button>
          </div>
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
          hint={entry.role === "team_admin" ? "团队管理员必须指定团队" : "可仅用于筛选开发组"}
        >
          <select
            className="select"
            value={entry.teamId}
            onChange={(event) => {
              const teamId = event.target.value;
              const allowed = new Set(
                workspace.groups.filter((group) => group.team_id === teamId).map((group) => group.id),
              );
              onChange({
                ...entry,
                teamId,
                groupIds: entry.groupIds.filter((id) => allowed.has(id)),
              });
            }}
          >
            <option value="">未指定团队</option>
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
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
        <Field
          label="开发组范围"
          className="span-2"
          error={errorText(errorsFor(`${basePath}.groupIds`))}
          hint="开发组管理员必须至少选择一个开发组；团队管理员按团队授权时可不选。"
        >
          <GroupPicker
            workspace={workspace}
            teamFilter={entry.teamId || undefined}
            selected={entry.groupIds}
            onChange={(groupIds) => onChange({ ...entry, groupIds })}
          />
        </Field>
      </div>
      {problem ? (
        <p className="settings-entry-problem">
          <AlertTriangle size={13} /> {problem}
        </p>
      ) : (
        <p className="settings-entry-ok">
          <CheckCircle2 size={13} /> 范围有效
          {teamGroups.length && entry.role === "group_admin"
            ? ` · 已覆盖 ${entry.groupIds.length} 个开发组`
            : ""}
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
  const groupsByTeam = useMemo(() => groupBy(workspace.groups, (group) => group.team_id), [workspace.groups]);

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
        groupIds: [],
        note: "",
      });
    });
  };

  const addId = () => {
    const firstTeam = workspace.teams[0];
    const firstGroup = firstTeam ? groupsByTeam[firstTeam.id]?.[0] : undefined;
    mutateWhitelist((next) => {
      next.ids.push({
        id: "",
        name: "",
        role: "group_admin",
        teamId: firstTeam?.id ?? "",
        groupIds: firstGroup ? [firstGroup.id] : [],
        note: "",
      });
    });
  };

  return (
    <div className="settings-sections">
      <SettingsCard
        title="内置设备 Admin"
        description="部署设备始终拥有一个隐藏的超级管理员身份，不占用也不写入配置。"
        icon={<ShieldCheck size={18} />}
        extra={<span className="badge badge-green">始终可用</span>}
      >
        <div className="settings-device-note">
          <div className="settings-device-badge">
            <span className="settings-device-avatar">{deviceAdminName.slice(0, 2).toUpperCase()}</span>
            <div>
              <strong>{deviceAdminName}</strong>
              <span>内置超级管理员 · 设备身份</span>
            </div>
          </div>
          <ul className="settings-device-points">
            <li>
              <CheckCircle2 size={14} />
              来自本机回环地址或部署机自身 IPv4 的请求会自动获得该身份，无需登录、不会过期。
            </li>
            <li>
              <CheckCircle2 size={14} />
              该身份不保存在 <code>data/settings.json</code> 中，也无法删除或加入 IP / ID 白名单。
            </li>
            <li>
              <CheckCircle2 size={14} />
              只有该身份可以打开并保存本页设置；白名单中的管理员仅能管理被授权的团队 / 开发组。
            </li>
            <li>
              <ShieldAlert size={14} />
              不要尝试把部署机 IP 写进白名单来"授予"设置权限，它本来就是最高权限。
            </li>
          </ul>
        </div>
      </SettingsCard>

      <SettingsCard
        title="访客与登录策略"
        description="SSO 不可用或身份未匹配时的降级行为。"
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
            label="会话有效期（天）"
            error={errorText(errorsFor("auth.session.maxAgeDays"))}
            hint="1 - 90 天"
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
              <p>来自内网的固定办公机或运维跳板机可以在这里获得团队 / 开发组管理员权限。</p>
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
              <p>通过企业 SSO 登录的团队成员可以在这里获得对应团队或开发组的管理权限。</p>
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
          SSO 登录后，系统会用 <code>id</code> / <code>email</code> / <code>sub</code> 匹配 ID 白名单来确定团队或开发组管理权限；
          未匹配的白名单身份仍可作为普通成员或访客访问。
        </p>
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
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const lineCount = useMemo(() => jsonText.split("\n").length, [jsonText]);

  const syncScroll = () => {
    if (textareaRef.current && gutterRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

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
          <div className="settings-json-gutter" ref={gutterRef} aria-hidden="true">
            {Array.from({ length: lineCount }, (_, index) => (
              <span key={index}>{index + 1}</span>
            ))}
          </div>
          <textarea
            ref={textareaRef}
            className="settings-json-textarea"
            value={jsonText}
            spellCheck={false}
            wrap="off"
            onChange={(event) => onTextChange(event.target.value)}
            onScroll={syncScroll}
            aria-label="完整设置 JSON 编辑器"
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
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function SettingsPage() {
  const { data, reload, navigate } = useApp();
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [denied, setDenied] = useState(false);
  const [saved, setSaved] = useState<AppSettings | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [meta, setMeta] = useState<SettingsMeta | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceOption>({ teams: [], groups: [], members: [] });
  const [workspaceError, setWorkspaceError] = useState("");
  const [activeTab, setActiveTab] = useState<TabKey>(() => readTabFromHash());
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

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const result = await api.getSettings();
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
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
    void loadWorkspace();
  }, [loadSettings, loadWorkspace]);

  /* ---------- tab navigation (hash query: #/settings?tab=email) ---------- */

  useEffect(() => {
    const sync = () => setActiveTab(readTabFromHash());
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

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
    const checkTime = (value: string, path: string, label: string) => {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
        errors.push({ path, message: `${label}必须是 HH:MM 格式` });
      }
    };
    const checkOffsets = (values: number[], path: string, label: string) => {
      if (values.some((offset) => !Number.isFinite(offset) || offset < 0 || offset > 60)) {
        errors.push({ path, message: `${label}必须在 0-60 天之间` });
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
    checkTime(draft.calendar.defaultReminderTime, "calendar.defaultReminderTime", "默认提醒时间");
    checkOffsets(
      draft.calendar.defaultReminderOffsetsDays,
      "calendar.defaultReminderOffsetsDays",
      "默认提醒提前天数",
    );

    checkEmail(draft.email.smtp.fromEmail, "email.smtp.fromEmail", "发件邮箱");
    if (draft.email.smtp.port < 1 || draft.email.smtp.port > 65535) {
      errors.push({ path: "email.smtp.port", message: "SMTP 端口需在 1-65535 之间" });
    }
    if (draft.email.smtp.timeoutSeconds < 3 || draft.email.smtp.timeoutSeconds > 120) {
      errors.push({ path: "email.smtp.timeoutSeconds", message: "SMTP 超时需在 3-120 秒之间" });
    }
    checkTime(draft.email.reminders.sendTime, "email.reminders.sendTime", "提醒发送时间");
    checkOffsets(draft.email.reminders.offsetsDays, "email.reminders.offsetsDays", "提醒提前天数");
    if (
      draft.email.reminders.scanIntervalSeconds < 30 ||
      draft.email.reminders.scanIntervalSeconds > 86400
    ) {
      errors.push({
        path: "email.reminders.scanIntervalSeconds",
        message: "扫描间隔需在 30-86400 秒之间",
      });
    }
    draft.email.reminders.additionalRecipients.forEach((recipient, index) => {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient)) {
        errors.push({
          path: `email.reminders.additionalRecipients.${index}`,
          message: `附加收件人邮箱格式不正确：${recipient}`,
        });
      }
    });

    draft.auth.adminWhitelist.ips.forEach((entry, index) => {
      if (!entry.ip.trim()) {
        errors.push({ path: `auth.adminWhitelist.ips.${index}.ip`, message: "IP / CIDR 不能为空" });
      }
      const problem = scopeProblem(entry);
      if (problem === "团队管理员必须选择一个团队") {
        errors.push({ path: `auth.adminWhitelist.ips.${index}.teamId`, message: problem });
      } else if (problem) {
        errors.push({ path: `auth.adminWhitelist.ips.${index}.groupIds`, message: problem });
      }
    });
    draft.auth.adminWhitelist.ids.forEach((entry, index) => {
      if (!entry.id.trim()) {
        errors.push({ path: `auth.adminWhitelist.ids.${index}.id`, message: "SSO 标识 / 邮箱不能为空" });
      }
      const problem = scopeProblem(entry);
      if (problem === "团队管理员必须选择一个团队") {
        errors.push({ path: `auth.adminWhitelist.ids.${index}.teamId`, message: problem });
      } else if (problem) {
        errors.push({ path: `auth.adminWhitelist.ids.${index}.groupIds`, message: problem });
      }
    });
    if (draft.auth.session.maxAgeDays < 1 || draft.auth.session.maxAgeDays > 90) {
      errors.push({ path: "auth.session.maxAgeDays", message: "会话有效期需在 1-90 天之间" });
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
            统一管理站点外观、模块展示、权限白名单、企业 SSO 与邮件提醒。所有改动保存后即时生效。
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
          <a className="btn btn-secondary btn-sm" href="/api/settings/schema" target="_blank" rel="noreferrer">
            <FileJson size={15} /> JSON Schema
          </a>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSave}
            disabled={saving || !canSave}
          >
            {saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
            {saving ? "保存中…" : saveLabel}
          </button>
        </div>
      </header>

      <div className="settings-meta-strip">
        <span className="settings-meta-chip">
          <ShieldCheck size={13} />
          当前身份 <strong>{adminName}</strong>
          <span className="settings-meta-divider">·</span>
          设备管理员
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
          内置设备管理员 <strong>{meta?.deviceAdminName ?? "Admin"}</strong>
          <span className="settings-meta-divider">·</span>
          不写入配置
        </span>
      </div>

      {workspaceError ? (
        <div className="settings-workspace-warning">
          <AlertTriangle size={14} />
          <span>工作区数据加载失败：{workspaceError}。白名单的团队 / 开发组选择器可能不可用。</span>
          <button type="button" className="text-button" onClick={() => void loadWorkspace()}>
            重试
          </button>
        </div>
      ) : null}

      <div className="settings-layout">
        <nav className="settings-tabs" aria-label="设置分组">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.key}
                type="button"
                className={cn("settings-tab", tab.key === activeTab && "active")}
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
            <ShieldCheck size={13} /> 本页仅对部署设备内置 Admin 开放，保存后立即写入配置。
          </p>
        </nav>

        <div className="settings-main">
          {allErrors.length ? (
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
          {activeTab === "sso" ? (
            <SsoSection draft={draft} update={update} errorsFor={errorsFor} />
          ) : null}
          {activeTab === "email" ? (
            <EmailPanel settings={draft} update={update} errorsFor={errorsFor} />
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
