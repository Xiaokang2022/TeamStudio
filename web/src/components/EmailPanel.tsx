import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Eye,
  EyeOff,
  Inbox,
  Info,
  Loader2,
  Mail,
  MailCheck,
  MailWarning,
  Plus,
  RefreshCw,
  ScanLine,
  ScrollText,
  Send,
  Server,
  Sparkles,
  Timer,
  X,
  type LucideIcon,
} from "lucide-react";
import { api, ApiError } from "../api";
import { useToast } from "./Toast";
import { Modal } from "./Modal";
import { EmptyState, LoadingBlock } from "./Feedback";
import { cn, formatDateTime } from "../lib/utils";
import type { AppSettings, EmailLog, EmailStatus, ValidationDetail } from "../types";
import "./EmailPanel.css";

type UpdateSettings = (mutate: (next: AppSettings) => void) => void;
type ErrorsFor = (prefix: string) => ValidationDetail[];

interface EmailPanelProps {
  settings: AppSettings;
  update: UpdateSettings;
  errorsFor: ErrorsFor;
}

interface ScanResult {
  sent?: number;
  skipped?: number;
  failed?: number;
  pending?: number;
  reason?: string;
  startedAt?: string;
  finishedAt?: string;
}

const REMINDER_PRESETS = [0, 1, 2, 3, 5, 7, 14, 30];

const EMAIL_VARIABLES: { token: string; label: string }[] = [
  { token: "{{memberName}}", label: "负责人姓名" },
  { token: "{{todoTitle}}", label: "待办标题" },
  { token: "{{todoDescription}}", label: "待办说明" },
  { token: "{{dueDate}}", label: "截止日期" },
  { token: "{{dueTime}}", label: "截止时间" },
  { token: "{{groupName}}", label: "开发组名称" },
  { token: "{{teamName}}", label: "团队名称" },
  { token: "{{priority}}", label: "优先级" },
  { token: "{{announcements}}", label: "置顶公告" },
  { token: "{{extraContent}}", label: "补充内容" },
  { token: "{{siteName}}", label: "站点名称" },
];

const KIND_LABELS: Record<string, string> = {
  reminder: "日程提醒",
  test: "配置测试",
  manual: "手动发送",
};

function errorText(list: ValidationDetail[]): string | undefined {
  if (!list.length) return undefined;
  return list.map((item) => item.message).join("；");
}

function toInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function EmailField({
  label,
  hint,
  error,
  className,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("field", className, error && "field-has-error")}>
      <label>
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

function EmailToggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="settings-toggle-row">
      <span className="settings-toggle-copy">
        <strong>{label}</strong>
        {description ? <small>{description}</small> : null}
      </span>
      <span className="switch">
        <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
        <span className="switch-track" />
      </span>
    </label>
  );
}

function EmailCard({
  title,
  description,
  icon,
  extra,
  children,
}: {
  title: string;
  description?: string;
  icon: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card settings-card email-card">
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

function ReminderOffsets({ values, onChange }: { values: number[]; onChange: (values: number[]) => void }) {
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
        {REMINDER_PRESETS.map((offset) => {
          const active = values.includes(offset);
          return (
            <button
              key={offset}
              type="button"
              className={cn("chip", "chip-clickable", "settings-offset-chip", active && "is-active")}
              onClick={() => toggle(offset)}
            >
              {active ? <CheckCircle2 size={11} /> : null}
              {offset === 0 ? "当天" : `提前 ${offset} 天`}
            </button>
          );
        })}
        {values
          .filter((offset) => !REMINDER_PRESETS.includes(offset))
          .map((offset) => (
            <button
              key={offset}
              type="button"
              className="chip chip-clickable settings-offset-chip is-active"
              onClick={() => toggle(offset)}
            >
              <CheckCircle2 size={11} /> 提前 {offset} 天
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

function RecipientsEditor({
  items,
  onChange,
}: {
  items: string[];
  onChange: (items: string[]) => void;
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
        <p className="field-hint">暂无附加收件人，仅通知待办负责人。</p>
      )}
      <div className="settings-list-add">
        <input
          className="input"
          type="email"
          value={value}
          placeholder="ops@company.com"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
          }}
        />
        <button type="button" className="btn btn-secondary btn-sm" onClick={commit}>
          <Plus size={14} /> 添加收件人
        </button>
      </div>
    </div>
  );
}

function StatusStat({
  icon: Icon,
  label,
  value,
  detail,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: "green" | "orange" | "red" | "blue" | "gray";
}) {
  return (
    <div className={cn("email-stat", tone && `is-${tone}`)}>
      <span className="email-stat-icon">
        <Icon size={16} />
      </span>
      <small>{label}</small>
      <strong>{value}</strong>
      {detail ? <span className="email-stat-detail">{detail}</span> : null}
    </div>
  );
}

export function EmailPanel({ settings, update, errorsFor }: EmailPanelProps) {
  const { toast } = useToast();
  const reminder = settings.email.reminders;
  const smtp = settings.email.smtp;

  const [status, setStatus] = useState<EmailStatus | null>(null);
  const [logs, setLogs] = useState<EmailLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusError, setStatusError] = useState("");
  const [actionError, setActionError] = useState("");
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [testing, setTesting] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [preview, setPreview] = useState<{ subject: string; body: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [insertTarget, setInsertTarget] = useState<"subject" | "body">("body");

  const subjectRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [statusResult, logsResult] = await Promise.all([
        api.emailStatus(),
        api.emailLogs(50),
      ]);
      setStatus(statusResult);
      setLogs(logsResult.logs);
      setStatusError("");
    } catch (error) {
      setStatusError(error instanceof ApiError ? error.message : "加载邮件状态失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const configured = Boolean(smtp.host.trim() && smtp.fromEmail.trim());
  const statusFromSaved = status
    ? `${status.enabled ? "已启用" : "未启用"} · ${status.smtpConfigured ? "SMTP 已配置" : "SMTP 未配置"}`
    : "未知";

  const openTest = () => {
    setTestTo((current) => current || smtp.fromEmail || "");
    setActionError("");
    setTestOpen(true);
  };

  const sendTest = async () => {
    const recipient = testTo.trim();
    if (!recipient) {
      toast("请填写测试收件邮箱", "error");
      return;
    }
    setTesting(true);
    setActionError("");
    try {
      const result = await api.emailTest(recipient);
      toast(`测试邮件已发送至 ${result.to}，请检查收件箱`);
      setTestOpen(false);
      await refresh(true);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "测试邮件发送失败";
      setActionError(message);
      toast(message, "error");
    } finally {
      setTesting(false);
    }
  };

  const scanNow = async () => {
    setScanning(true);
    setActionError("");
    setScanResult(null);
    try {
      const result = (await api.emailScan()) as unknown as ScanResult;
      setScanResult(result);
      const sent = result.sent ?? 0;
      const skipped = result.skipped ?? 0;
      const failed = result.failed ?? 0;
      toast(`扫描完成：发送 ${sent} 封 · 跳过 ${skipped} 封 · 失败 ${failed} 封`);
      await refresh(true);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "立即扫描失败";
      setActionError(message);
      toast(message, "error");
    } finally {
      setScanning(false);
    }
  };

  const openPreview = async () => {
    setPreviewOpen(true);
    setPreviewLoading(true);
    setPreviewError("");
    try {
      const result = await api.emailPreview();
      setPreview(result);
    } catch (error) {
      setPreviewError(error instanceof ApiError ? error.message : "生成模板预览失败");
    } finally {
      setPreviewLoading(false);
    }
  };

  const insertVariable = (token: string) => {
    const isBody = insertTarget === "body";
    const element = isBody ? bodyRef.current : subjectRef.current;
    const current = isBody ? reminder.bodyTemplate : reminder.subjectTemplate;
    if (!element) {
      update((next) => {
        if (isBody) next.email.reminders.bodyTemplate = current + token;
        else next.email.reminders.subjectTemplate = current + token;
      });
      return;
    }
    const start = element.selectionStart ?? current.length;
    const end = element.selectionEnd ?? current.length;
    const nextValue = current.slice(0, start) + token + current.slice(end);
    update((next) => {
      if (isBody) next.email.reminders.bodyTemplate = nextValue;
      else next.email.reminders.subjectTemplate = nextValue;
    });
    requestAnimationFrame(() => {
      element.focus();
      const position = start + token.length;
      element.setSelectionRange(position, position);
    });
  };

  const logsFailed = useMemo(() => logs.filter((log) => log.status === "failed").length, [logs]);
  const sentToday = status?.sentToday ?? 0;
  const failedToday = status?.failedToday ?? 0;

  return (
    <div className="settings-sections email-panel">
      <EmailCard
        title="邮件提醒概览"
        description="状态来自服务端已保存配置；修改 SMTP 或提醒开关后请先保存，再刷新状态。"
        icon={<Mail size={18} />}
        extra={
          <div className="email-head-actions">
            <span className={cn("badge", settings.email.enabled ? "badge-green" : "badge-gray")}>
              {settings.email.enabled ? "邮件已启用" : "邮件未启用"}
            </span>
            <span className={cn("badge", configured ? "badge-blue" : "badge-orange")}>
              {configured ? "SMTP 已填写" : "SMTP 待配置"}
            </span>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => void refresh()}
              disabled={loading}
            >
              <RefreshCw size={14} className={loading ? "spin" : undefined} /> 刷新状态
            </button>
          </div>
        }
      >
        {statusError ? (
          <div className="email-banner is-error">
            <AlertTriangle size={15} />
            <span>{statusError}</span>
            <button type="button" className="text-button" onClick={() => void refresh()}>
              重试
            </button>
          </div>
        ) : null}
        {actionError ? (
          <div className="email-banner is-error">
            <AlertTriangle size={15} />
            <span>{actionError}</span>
            <button type="button" className="icon-button" aria-label="关闭提示" onClick={() => setActionError("")}>
              <X size={14} />
            </button>
          </div>
        ) : null}

        {loading && !status ? (
          <LoadingBlock label="正在读取邮件状态…" rows={3} />
        ) : (
          <div className="email-status-grid">
            <StatusStat
              icon={MailCheck}
              label="邮件通道"
              value={status?.enabled ? "已启用" : "未启用"}
              detail={status ? `提醒扫描：${status.remindersEnabled ? "开启" : "关闭"}` : statusFromSaved}
              tone={status?.enabled ? "green" : "gray"}
            />
            <StatusStat
              icon={Server}
              label="SMTP 配置"
              value={status?.smtpConfigured ? "已就绪" : "未就绪"}
              detail={status?.fromEmail ? `发件：${status.fromEmail}` : "缺少 host 或 fromEmail"}
              tone={status?.smtpConfigured ? "green" : "orange"}
            />
            <StatusStat
              icon={Timer}
              label="调度器"
              value={status?.scheduler.running ? "运行中" : "未运行"}
              detail={
                status?.scheduler.nextScanAt ? `下次扫描 ${formatDateTime(status.scheduler.nextScanAt)}` : "等待调度启动"
              }
              tone={status?.scheduler.running ? "green" : "gray"}
            />
            <StatusStat
              icon={Clock}
              label="上次扫描"
              value={status?.lastScanAt ? formatDateTime(status.lastScanAt) : "尚未扫描"}
              detail={status?.scheduler.lastError ? status.scheduler.lastError : "扫描会去重已发送提醒"}
              tone={status?.scheduler.lastError ? "red" : "blue"}
            />
            <StatusStat
              icon={ScrollText}
              label="待发送提醒"
              value={status?.pendingReminders ?? 0}
              detail="满足发送时间且未发送的提醒"
              tone={(status?.pendingReminders ?? 0) > 0 ? "orange" : "gray"}
            />
            <StatusStat
              icon={Mail}
              label="今日发送 / 失败"
              value={`${sentToday} / ${failedToday}`}
              detail={`最近日志失败 ${logsFailed} 条`}
              tone={failedToday > 0 ? "red" : "green"}
            />
          </div>
        )}

        <div className="email-actions">
          <button type="button" className="btn btn-primary btn-sm" onClick={openTest}>
            <Send size={14} /> 发送测试邮件
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void scanNow()}
            disabled={scanning}
          >
            {scanning ? <Loader2 size={14} className="spin" /> : <ScanLine size={14} />}
            {scanning ? "扫描中…" : "立即扫描提醒"}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void openPreview()}>
            <Eye size={14} /> 预览当前模板
          </button>
          <span className="email-actions-hint">
            <Info size={13} /> 测试邮件需要先保存并启用邮件通道。
          </span>
        </div>

        {scanResult ? (
          <div className="email-scan-result">
            <span className="email-scan-title">
              <CheckCircle2 size={14} /> 本次扫描结果
            </span>
            <div className="email-scan-counts">
              <span>
                发送 <strong>{scanResult.sent ?? 0}</strong>
              </span>
              <span>
                跳过 <strong>{scanResult.skipped ?? 0}</strong>
              </span>
              <span className={cn((scanResult.failed ?? 0) > 0 && "is-bad")}>
                失败 <strong>{scanResult.failed ?? 0}</strong>
              </span>
              <span>
                待发送 <strong>{scanResult.pending ?? 0}</strong>
              </span>
            </div>
            {scanResult.reason ? <p className="email-scan-reason">{scanResult.reason}</p> : null}
          </div>
        ) : null}
      </EmailCard>

      <EmailCard
        title="SMTP 发件配置"
        description="支持标准 SMTP / STARTTLS / SSL。密码仅保存在服务端 settings.json。"
        icon={<Server size={18} />}
      >
        <div className="settings-toggle-stack">
          <EmailToggle
            label="启用邮件功能"
            description="总开关：关闭后不会发送任何提醒或测试邮件。"
            checked={settings.email.enabled}
            onChange={(checked) =>
              update((next) => {
                next.email.enabled = checked;
              })
            }
          />
          <EmailToggle
            label="启用提醒扫描"
            description="按设定的时间与提前天数自动发送日历提醒。"
            checked={reminder.enabled}
            onChange={(checked) =>
              update((next) => {
                next.email.reminders.enabled = checked;
              })
            }
          />
        </div>
        <div className="divider" />
        <div className="form-grid">
          <EmailField
            label="SMTP 主机"
            error={errorText(errorsFor("email.smtp.host"))}
            hint="例如 smtp.exmail.qq.com"
          >
            <input
              className="input"
              value={smtp.host}
              spellCheck={false}
              placeholder="smtp.example.com"
              onChange={(event) =>
                update((next) => {
                  next.email.smtp.host = event.target.value;
                })
              }
            />
          </EmailField>
          <EmailField label="端口" error={errorText(errorsFor("email.smtp.port"))} hint="SSL 常用 465，STARTTLS 常用 587">
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
          </EmailField>
          <EmailField label="用户名" error={errorText(errorsFor("email.smtp.username"))} hint="多数邮箱为完整邮箱地址">
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
          </EmailField>
          <EmailField label="密码 / 授权码" error={errorText(errorsFor("email.smtp.password"))}>
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
          </EmailField>
          <EmailField label="发件邮箱" error={errorText(errorsFor("email.smtp.fromEmail"))}>
            <input
              className="input"
              type="email"
              value={smtp.fromEmail}
              spellCheck={false}
              placeholder="teamstudio@company.com"
              onChange={(event) =>
                update((next) => {
                  next.email.smtp.fromEmail = event.target.value;
                })
              }
            />
          </EmailField>
          <EmailField label="发件人名称" error={errorText(errorsFor("email.smtp.fromName"))}>
            <input
              className="input"
              value={smtp.fromName}
              onChange={(event) =>
                update((next) => {
                  next.email.smtp.fromName = event.target.value;
                })
              }
            />
          </EmailField>
          <EmailField label="超时时间（秒）" error={errorText(errorsFor("email.smtp.timeoutSeconds"))} hint="3 - 120 秒">
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
          </EmailField>
          <div className="email-encryption">
            <EmailToggle
              label="STARTTLS"
              description="587 端口常用，先明文连接再升级 TLS。"
              checked={smtp.useStartTls}
              onChange={(checked) =>
                update((next) => {
                  next.email.smtp.useStartTls = checked;
                  if (checked) next.email.smtp.useSsl = false;
                })
              }
            />
            <EmailToggle
              label="SSL 直连"
              description="465 端口常用，全程加密连接。"
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
      </EmailCard>

      <EmailCard
        title="提醒策略"
        description="扫描器每隔固定时间检查待办，在截止日前按提前天数发送一次提醒并自动去重。"
        icon={<Timer size={18} />}
      >
        <div className="form-grid">
          <EmailField
            label="提醒提前天数"
            className="span-2"
            error={errorText(errorsFor("email.reminders.offsetsDays"))}
            hint="同一待办在每个提前天数各发送一次；0 表示到期当天。"
          >
            <ReminderOffsets
              values={reminder.offsetsDays}
              onChange={(values) =>
                update((next) => {
                  next.email.reminders.offsetsDays = values;
                })
              }
            />
          </EmailField>
          <EmailField label="发送时间" error={errorText(errorsFor("email.reminders.sendTime"))} hint="每天该时间之后才会发送">
            <input
              className="input"
              type="time"
              value={reminder.sendTime}
              onChange={(event) =>
                update((next) => {
                  next.email.reminders.sendTime = event.target.value;
                })
              }
            />
          </EmailField>
          <EmailField
            label="扫描间隔（秒）"
            error={errorText(errorsFor("email.reminders.scanIntervalSeconds"))}
            hint="30 - 86400 秒，默认 60 秒"
          >
            <input
              className="input"
              type="number"
              min={30}
              max={86400}
              value={reminder.scanIntervalSeconds}
              onChange={(event) =>
                update((next) => {
                  next.email.reminders.scanIntervalSeconds = toInt(event.target.value, 60);
                })
              }
            />
          </EmailField>
          <div className="span-2 settings-toggle-stack">
            <EmailToggle
              label="通知待办负责人"
              description="按负责人邮箱发送；关闭后只发送给附加收件人。"
              checked={reminder.notifyAssignee}
              onChange={(checked) =>
                update((next) => {
                  next.email.reminders.notifyAssignee = checked;
                })
              }
            />
            <EmailToggle
              label="附带置顶公告"
              description="在正文中插入开发组置顶公告摘要。"
              checked={reminder.includeAnnouncements}
              onChange={(checked) =>
                update((next) => {
                  next.email.reminders.includeAnnouncements = checked;
                })
              }
            />
            <EmailToggle
              label="附带事项说明"
              description="将待办描述渲染到 {{todoDescription}}。"
              checked={reminder.includeTodoDescription}
              onChange={(checked) =>
                update((next) => {
                  next.email.reminders.includeTodoDescription = checked;
                })
              }
            />
            <EmailToggle
              label="附加补充内容"
              description="在正文中渲染 {{extraContent}} 对应内容。"
              checked={reminder.includeExtra}
              onChange={(checked) =>
                update((next) => {
                  next.email.reminders.includeExtra = checked;
                })
              }
            />
          </div>
          <EmailField
            label="附加收件人"
            className="span-2"
            error={errorText(errorsFor("email.reminders.additionalRecipients"))}
            hint="所有提醒都会抄送给这些邮箱，例如开发组公共邮箱。"
          >
            <RecipientsEditor
              items={reminder.additionalRecipients}
              onChange={(items) =>
                update((next) => {
                  next.email.reminders.additionalRecipients = items;
                })
              }
            />
          </EmailField>
          <EmailField
            label="补充内容"
            className="span-2"
            error={errorText(errorsFor("email.reminders.extraContent"))}
            hint="会在 {{extraContent}} 位置渲染，仅在开启「附加补充内容」时生效。"
          >
            <textarea
              className="textarea"
              rows={3}
              value={reminder.extraContent}
              onChange={(event) =>
                update((next) => {
                  next.email.reminders.extraContent = event.target.value;
                })
              }
            />
          </EmailField>
        </div>
      </EmailCard>

      <EmailCard
        title="邮件模板"
        description="使用双花括号变量渲染；主题与正文都支持下列变量。"
        icon={<Sparkles size={18} />}
        extra={
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void openPreview()}>
            <Eye size={14} /> 预览渲染效果
          </button>
        }
      >
        <div className="email-template-grid">
          <EmailField
            label="邮件主题模板"
            error={errorText(errorsFor("email.reminders.subjectTemplate"))}
            hint="留空会导致渲染结果为空，提醒发送会被拒绝。"
          >
            <input
              ref={subjectRef}
              className="input"
              value={reminder.subjectTemplate}
              spellCheck={false}
              onChange={(event) =>
                update((next) => {
                  next.email.reminders.subjectTemplate = event.target.value;
                })
              }
            />
          </EmailField>
          <EmailField
            label="邮件正文模板"
            error={errorText(errorsFor("email.reminders.bodyTemplate"))}
            hint="支持换行；渲染时会自动去除首尾空白。"
          >
            <textarea
              ref={bodyRef}
              className="textarea email-template-body"
              rows={12}
              spellCheck={false}
              value={reminder.bodyTemplate}
              onChange={(event) =>
                update((next) => {
                  next.email.reminders.bodyTemplate = event.target.value;
                })
              }
            />
          </EmailField>
        </div>

        <div className="email-variables">
          <div className="email-variables-head">
            <span>
              <Info size={13} /> 点击变量插入到
            </span>
            <div className="segmented">
              <button
                type="button"
                className={insertTarget === "subject" ? "active" : undefined}
                onClick={() => setInsertTarget("subject")}
              >
                主题
              </button>
              <button
                type="button"
                className={insertTarget === "body" ? "active" : undefined}
                onClick={() => setInsertTarget("body")}
              >
                正文
              </button>
            </div>
          </div>
          <div className="tag-list email-variable-chips">
            {EMAIL_VARIABLES.map((variable) => (
              <button
                key={variable.token}
                type="button"
                className="chip chip-clickable email-variable-chip"
                title={variable.label}
                onClick={() => insertVariable(variable.token)}
              >
                <code>{variable.token}</code>
                <span>{variable.label}</span>
              </button>
            ))}
          </div>
          <p className="field-hint">
            预览使用服务器上已保存的模板渲染示例数据；修改模板后请先保存，再点击预览。
          </p>
        </div>
      </EmailCard>

      <EmailCard
        title="发送日志"
        description="最近的邮件出站记录（收件人已脱敏），包含测试邮件与日程提醒。"
        icon={<ScrollText size={18} />}
        extra={
          <div className="email-head-actions">
            <span className="badge badge-gray">最近 {logs.length} 条</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => void refresh()}
              disabled={loading}
            >
              <RefreshCw size={14} className={loading ? "spin" : undefined} /> 刷新日志
            </button>
          </div>
        }
      >
        {loading && !logs.length ? (
          <LoadingBlock label="正在读取发送日志…" rows={4} />
        ) : logs.length ? (
          <div className="table-wrap email-log-table">
            <table className="data-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>类型</th>
                  <th>收件人</th>
                  <th>主题</th>
                  <th>状态</th>
                  <th>错误信息</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id}>
                    <td className="email-log-time">{formatDateTime(log.created_at)}</td>
                    <td>
                      <span className="chip">{KIND_LABELS[log.kind] ?? log.kind}</span>
                    </td>
                    <td className="email-log-recipient">{log.recipient}</td>
                    <td className="email-log-subject" title={log.subject}>
                      {log.subject || "—"}
                    </td>
                    <td>
                      <span className={cn("badge", log.status === "sent" ? "badge-green" : "badge-red")}>
                        {log.status === "sent" ? (
                          <MailCheck size={12} />
                        ) : (
                          <MailWarning size={12} />
                        )}
                        {log.status === "sent" ? "已发送" : "失败"}
                      </span>
                    </td>
                    <td className="email-log-error" title={log.error}>
                      {log.error || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            compact
            icon={<Inbox size={22} />}
            title="还没有邮件记录"
            description="保存并启用邮件后，发送测试邮件或执行一次提醒扫描即可看到日志。"
          />
        )}
      </EmailCard>

      <Modal
        open={testOpen}
        title="发送测试邮件"
        description="将使用当前已保存的 SMTP 配置发送一封配置测试邮件。"
        size="sm"
        onClose={() => {
          if (!testing) setTestOpen(false);
        }}
        footer={
          <>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setTestOpen(false)}
              disabled={testing}
            >
              取消
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void sendTest()} disabled={testing}>
              {testing ? <Loader2 size={15} className="spin" /> : <Send size={15} />}
              {testing ? "发送中…" : "发送测试邮件"}
            </button>
          </>
        }
      >
        <div className="email-test-form">
          <EmailField
            label="收件邮箱"
            hint="留空默认使用发件邮箱；发送结果会写入发送日志。"
            error={statusError ? statusError : undefined}
          >
            <input
              className="input"
              type="email"
              value={testTo}
              placeholder={smtp.fromEmail || "name@company.com"}
              onChange={(event) => setTestTo(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void sendTest();
                }
              }}
            />
          </EmailField>
          <div className="email-test-hint">
            <Info size={14} />
            <span>
              测试邮件依赖已保存的配置。若刚修改过 SMTP，请先点击页面右上角「保存设置」，再重新打开此弹窗。
            </span>
          </div>
        </div>
      </Modal>

      <Modal
        open={previewOpen}
        title="模板预览"
        description="使用服务器已保存模板与示例数据渲染，变量展示的是最终替换结果。"
        size="lg"
        onClose={() => setPreviewOpen(false)}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => void openPreview()} disabled={previewLoading}>
              <RefreshCw size={14} className={previewLoading ? "spin" : undefined} /> 重新生成
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setPreviewOpen(false)}>
              关闭
            </button>
          </>
        }
      >
        {previewLoading ? (
          <LoadingBlock label="正在渲染模板…" rows={4} />
        ) : previewError ? (
          <div className="email-banner is-error">
            <AlertTriangle size={15} />
            <span>{previewError}</span>
          </div>
        ) : preview ? (
          <div className="email-preview">
            <div className="email-preview-subject">
              <small>主题</small>
              <strong>{preview.subject || "（渲染结果为空）"}</strong>
            </div>
            <div className="email-preview-body">
              <small>正文</small>
              <pre>{preview.body || "（渲染结果为空）"}</pre>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
