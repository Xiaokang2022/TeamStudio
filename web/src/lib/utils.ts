import type {
  CurrentUser,
  InsightsRangeKey,
  Member,
  MemberMembership,
  Todo,
  TodoPriority,
} from "../types";

/**
 * Minimal identity shape shared by member cards, workloads and profile rows.
 * `memberIds` lists every archive row of the same person (main archive first).
 */
export type MemberIdentity = Pick<Member, "id" | "email"> & { memberIds?: string[] };

/** One team a person belongs to (used for multi-team badges). */
export interface MemberTeamRef {
  teamId: string;
  teamName: string;
}

export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export function initials(name: string): string {
  const trimmed = (name || "?").trim();
  if (!trimmed) return "?";
  if (/[\u4e00-\u9fa5]/.test(trimmed)) {
    return trimmed.slice(-2);
  }
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
  return trimmed.slice(0, 2).toUpperCase();
}

/** Name collation used by member cards/profiles (Chinese pinyin order). */
const NAME_COLLATOR = new Intl.Collator("zh-Hans-CN");

/** Ascending name comparison for Chinese-friendly sorting. */
export function compareNames(left: string, right: string): number {
  return NAME_COLLATOR.compare(left || "", right || "");
}

export function dateFromISO(value: string): Date {
  if (!value) return new Date();
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

export function todayISO(): string {
  return toISODate(new Date());
}

export function toISODate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function monthKey(date: Date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function shiftMonth(key: string, amount: number): string {
  const [year, month] = key.split("-").map(Number);
  const date = new Date(year, month - 1 + amount, 1);
  return monthKey(date);
}

export function monthLabel(key: string): string {
  const [year, month] = key.split("-").map(Number);
  return `${year} 年 ${month} 月`;
}

export function formatDate(value: string, options?: Intl.DateTimeFormatOptions): string {
  if (!value) return "";
  return dateFromISO(value).toLocaleDateString("zh-CN", {
    month: "short",
    day: "numeric",
    ...options,
  });
}

export function formatFullDate(value: string): string {
  if (!value) return "";
  return dateFromISO(value).toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  });
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function relativeTime(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diff = Date.now() - date.getTime();
  const minutes = Math.round(diff / 60000);
  if (Math.abs(minutes) < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} 天前`;
  return date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

export function daysUntil(dueDate: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = dateFromISO(dueDate);
  due.setHours(0, 0, 0, 0);
  return Math.round((due.getTime() - today.getTime()) / 86400000);
}

export function dueLabel(todo: Pick<Todo, "dueDate" | "status">): {
  label: string;
  tone: "danger" | "warning" | "normal" | "muted";
} {
  if (todo.status === "done") return { label: "已完成", tone: "muted" };
  const days = daysUntil(todo.dueDate);
  if (days < 0) return { label: `逾期 ${Math.abs(days)} 天`, tone: "danger" };
  if (days === 0) return { label: "今天到期", tone: "danger" };
  if (days === 1) return { label: "明天到期", tone: "warning" };
  if (days <= 3) return { label: `${days} 天后到期`, tone: "warning" };
  return { label: `${days} 天后`, tone: "normal" };
}

export const PRIORITY_META: Record<TodoPriority, { label: string; tone: string }> = {
  low: { label: "低", tone: "low" },
  normal: { label: "普通", tone: "normal" },
  high: { label: "高", tone: "high" },
  urgent: { label: "紧急", tone: "urgent" },
};

/**
 * 团队管理权限：超级管理员（含系统内置 Admin）可管理所有团队；
 * 团队管理员只能管理 `admin.teamIds` 内的团队（创建 / 删除团队仍仅超级管理员）。
 */
export function canManageTeam(
  user: CurrentUser | null | undefined,
  teamId?: string | null,
): boolean {
  if (!user) return false;
  if (user.isSuperAdmin || user.isDeviceAdmin) return true;
  if (!teamId) return false;
  return user.admin.teamIds.includes(teamId);
}

/**
 * Every member archive id linked to this account. The backend returns
 * `linkedMemberIds` for all teams; `linkedMemberId` (current team's archive)
 * stays as a fallback for older payloads.
 */
export function linkedMemberIdsOf(user: CurrentUser | null | undefined): string[] {
  if (!user) return [];
  const ids = Array.isArray(user.linkedMemberIds) ? user.linkedMemberIds.filter(Boolean) : [];
  const fallback = user.linkedMemberId ? [user.linkedMemberId] : [];
  return Array.from(new Set([...ids, ...fallback]));
}

/** Every archive id of one person: the main archive id plus its merged `memberIds`. */
export function memberArchiveIdsOf(
  member: Pick<Member, "id"> & { memberIds?: string[] } | null | undefined,
): string[] {
  if (!member) return [];
  const ids = [member.id, ...(Array.isArray(member.memberIds) ? member.memberIds : [])].filter(
    Boolean,
  );
  return Array.from(new Set(ids));
}

/**
 * "这是我" 判定：账号在任一团队的档案都算本人（linkedMemberIds 命中），
 * 或登录邮箱与该档案邮箱一致。超级管理员身份不在此列——那是权限而非本人。
 */
export function isLinkedMember(
  user: CurrentUser | null | undefined,
  member: MemberIdentity | null | undefined,
): boolean {
  if (!user || !member) return false;
  const linkedIds = linkedMemberIdsOf(user);
  if (memberArchiveIdsOf(member).some((id) => linkedIds.includes(id))) return true;
  const viewerEmail = (user.email || "").trim().toLowerCase();
  const memberEmail = (member.email || "").trim().toLowerCase();
  return Boolean(viewerEmail) && Boolean(memberEmail) && viewerEmail === memberEmail;
}

/** Fields any payload may use to describe a person's team memberships. */
export interface TeamRefSource {
  teamId?: string;
  teamName?: string;
  memberships?: MemberMembership[];
  teamIds?: string[];
  teamNames?: string[];
}

/**
 * All teams a person belongs to. Prefers the merged `memberships` payload, then
 * the flat `teamIds`/`teamNames` arrays, and finally the single team fields of
 * classic (non-aggregated) payloads.
 */
export function memberTeamRefs(
  member: TeamRefSource | null | undefined,
): MemberTeamRef[] {
  if (!member) return [];
  const memberships = Array.isArray(member.memberships) ? member.memberships : [];
  if (memberships.length) {
    return memberships
      .map((item) => ({
        teamId: item.teamId || "",
        teamName: item.teamName || item.teamId || "",
      }))
      .filter((item) => item.teamId || item.teamName);
  }
  const teamIds = Array.isArray(member.teamIds) ? member.teamIds : [];
  const teamNames = Array.isArray(member.teamNames) ? member.teamNames : [];
  if (teamIds.length || teamNames.length) {
    const count = Math.max(teamIds.length, teamNames.length);
    return Array.from({ length: count }, (_, index) => ({
      teamId: teamIds[index] ?? `team-${index}`,
      teamName: teamNames[index] ?? teamIds[index] ?? "",
    })).filter((item) => item.teamName);
  }
  if (member.teamId || member.teamName) {
    return [
      {
        teamId: member.teamId ?? "",
        teamName: member.teamName ?? "",
      },
    ];
  }
  return [];
}

/**
 * 个人信息（姓名 / 邮箱 / 简介 / 头像 / 头像颜色 / 标签 / 技能）的编辑权限。
 * 仅超级管理员（含系统内置 Admin）与绑定账号本人可编辑。
 */
export function canEditPersonalInfo(
  user: CurrentUser | null | undefined,
  member: MemberIdentity | null | undefined,
): boolean {
  if (!user || !member) return false;
  if (user.isSuperAdmin || user.isDeviceAdmin) return true;
  if (!user.authenticated) return false;
  return isLinkedMember(user, member);
}

/**
 * 组织信息（职位 / 团队角色）的编辑权限。
 * 仅超级管理员（含系统内置 Admin）与在管辖范围内的团队管理员可编辑。
 */
export function canEditOrganizationalInfo(
  user: CurrentUser | null | undefined,
  teamId?: string | null,
): boolean {
  if (!user) return false;
  if (user.isSuperAdmin || user.isDeviceAdmin) return true;
  const role = user.userRole ?? user.admin.role;
  if (role === "team_admin" && teamId) return user.admin.teamIds.includes(teamId);
  return canManageTeam(user, teamId);
}

/**
 * 成员卡片「编辑资料」的入口权限：个人信息或组织信息至少有一项可编辑。
 * `member` 可以是成员档案对象（推荐，支持合并卡的 `memberIds`）或单个档案 id。
 */
export function canEditMember(
  user: CurrentUser | null | undefined,
  teamId: string,
  member: string | MemberIdentity | null | undefined,
): boolean {
  if (!user) return false;
  if (canEditOrganizationalInfo(user, teamId)) return true;
  if (!user.permissions.canEditSelf || !member) return false;
  if (typeof member === "string") {
    return linkedMemberIdsOf(user).includes(member);
  }
  const linkedIds = linkedMemberIdsOf(user);
  return memberArchiveIdsOf(member).some((id) => linkedIds.includes(id));
}

/* ------------------------------------------------------------------ */
/* Ranges & tag palette (formerly web/src/lib/scope.ts)               */
/* ------------------------------------------------------------------ */

export interface RangeOption {
  key: InsightsRangeKey;
  label: string;
  days: number | null;
}

/** Analytics range: minimum one week, maximum everything. */
export const INSIGHTS_RANGES: RangeOption[] = [
  { key: "1w", label: "近 1 周", days: 7 },
  { key: "2w", label: "近 2 周", days: 14 },
  { key: "1m", label: "近 1 个月", days: 30 },
  { key: "3m", label: "近 3 个月", days: 90 },
  { key: "all", label: "全部时间", days: null },
];

/** Task ledger range: minimum one week, maximum three months. */
export const TASK_RANGES: RangeOption[] = [
  { key: "1w", label: "近 1 周", days: 7 },
  { key: "2w", label: "近 2 周", days: 14 },
  { key: "1m", label: "近 1 个月", days: 30 },
  { key: "2m", label: "近 2 个月", days: 60 },
  { key: "3m", label: "近 3 个月", days: 90 },
];

export function rangeStartISO(days: number | null, now: Date = new Date()): string | null {
  if (days === null) return null;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - days);
  const year = start.getFullYear();
  const month = String(start.getMonth() + 1).padStart(2, "0");
  const day = String(start.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** True when an ISO timestamp/date falls inside [start, +∞). */
export function isWithinRange(value: string | null | undefined, startISO: string | null): boolean {
  if (!startISO) return true;
  if (!value) return false;
  return value.slice(0, 10) >= startISO;
}

/** Shared palette for the team tag library. */
export const TAG_COLORS = [
  "#0a59f7",
  "#1d7a4d",
  "#9a6210",
  "#b3261e",
  "#7c3aed",
  "#0e7490",
  "#be185d",
  "#4f6f8f",
];

export function tagColorFor(index: number): string {
  return TAG_COLORS[index % TAG_COLORS.length];
}

/* ------------------------------------------------------------------ */
/* Misc helpers                                                       */
/* ------------------------------------------------------------------ */

export interface CalendarCell {
  date: Date;
  iso: string;
  day: number;
  inMonth: boolean;
  isToday: boolean;
  isWeekend: boolean;
}

export function buildCalendar(
  year: number,
  month: number,
  weekStartsOn: 0 | 1 = 1,
): CalendarCell[] {
  const first = new Date(year, month, 1);
  const startOffset = (first.getDay() - weekStartsOn + 7) % 7;
  const start = new Date(year, month, 1 - startOffset);
  const today = todayISO();
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
    return {
      date,
      iso: toISODate(date),
      day: date.getDate(),
      inMonth: date.getMonth() === month,
      isToday: toISODate(date) === today,
      isWeekend: date.getDay() === 0 || date.getDay() === 6,
    };
  });
}

export function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {
  return items.reduce<Record<string, T[]>>((acc, item) => {
    const group = key(item);
    (acc[group] ??= []).push(item);
    return acc;
  }, {});
}

export function safeJsonParse<T = unknown>(text: string): { value: T | null; error: string | null } {
  try {
    return { value: JSON.parse(text) as T, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "JSON 语法错误";
    return { value: null, error: message };
  }
}

/**
 * 复制文本到剪贴板，返回「是否真的复制成功」。
 *
 * 注意：不能把「尝试过」当成成功。
 * - 安全上下文（https / localhost）优先用 navigator.clipboard.writeText；
 * - 非安全上下文（例如 plain-http 局域网地址）navigator.clipboard 为 undefined，
 *   退回 textarea + execCommand("copy") 的旧方案，并把 execCommand 的布尔返回值透传出去；
 * - 任何失败都返回 false，由调用方决定如何提示 / 提供手动复制回退。
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 权限被拒 / 非用户激活等场景：继续尝试旧方案，而不是直接判定成功。
    }
  }

  const previousFocus = document.activeElement as HTMLElement | null;
  let area: HTMLTextAreaElement | null = null;
  try {
    area = document.createElement("textarea");
    area.value = text;
    area.readOnly = true;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "0";
    area.style.left = "0";
    area.style.width = "1px";
    area.style.height = "1px";
    area.style.padding = "0";
    area.style.border = "none";
    area.style.outline = "none";
    area.style.boxShadow = "none";
    area.style.background = "transparent";
    area.style.opacity = "0";
    area.style.pointerEvents = "none";
    area.style.zIndex = "-1";
    document.body.appendChild(area);
    area.focus({ preventScroll: true });
    area.select();
    area.setSelectionRange(0, text.length);
    if (typeof document.execCommand !== "function") return false;
    return document.execCommand("copy") === true;
  } catch {
    return false;
  } finally {
    if (area?.parentNode) area.parentNode.removeChild(area);
    if (previousFocus && typeof previousFocus.focus === "function") {
      try {
        previousFocus.focus({ preventScroll: true });
      } catch {
        // 焦点元素可能已卸载，忽略。
      }
    }
  }
}

export function hashRoute(): { page: string; params: URLSearchParams } {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [pagePart, queryPart = ""] = raw.split("?");
  const page = (pagePart || "overview").split("/")[0] || "overview";
  return { page, params: new URLSearchParams(queryPart) };
}

export function navigate(page: string, params?: Record<string, string>): void {
  const search = new URLSearchParams(params).toString();
  window.location.hash = `/${page}${search ? `?${search}` : ""}`;
}

export function uid(prefix = "tmp"): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}
