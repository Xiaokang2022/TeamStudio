import type { CurrentUser, Member, Todo, TodoPriority } from "../types";

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

export const STATUS_META: Record<string, { label: string; tone: string }> = {
  available: { label: "可协作", tone: "green" },
  busy: { label: "专注中", tone: "orange" },
  remote: { label: "远程", tone: "blue" },
  offline: { label: "休假中", tone: "gray" },
};

export function canManageGroup(
  user: CurrentUser | null | undefined,
  teamId?: string | null,
  groupId?: string | null,
): boolean {
  if (!user) return false;
  if (user.isSuperAdmin || user.isDeviceAdmin) return true;
  if (!teamId || !groupId) return false;
  return user.admin.teamIds.includes(teamId) || user.admin.groupIds.includes(groupId);
}

/**
 * 个人信息（姓名 / 邮箱 / 简介 / 头像 / 头像颜色 / 标签 / 技能）的编辑权限。
 * 仅超级管理员（含部署设备内置 Admin）与绑定账号本人可编辑。
 */
export function canEditPersonalInfo(
  user: CurrentUser | null | undefined,
  member: Pick<Member, "id" | "email"> | null | undefined,
): boolean {
  if (!user || !member) return false;
  if (user.isSuperAdmin || user.isDeviceAdmin) return true;
  if (!user.authenticated) return false;
  if (user.linkedMemberId && user.linkedMemberId === member.id) return true;
  const email = (user.email || "").trim().toLowerCase();
  return Boolean(email) && (member.email || "").trim().toLowerCase() === email;
}

/**
 * 组织信息（职位 / 团队角色 / 状态）的编辑权限。
 * 仅超级管理员（含部署设备内置 Admin）与在管辖范围内的团队 / 开发组管理员可编辑。
 */
export function canEditOrganizationalInfo(
  user: CurrentUser | null | undefined,
  teamId?: string | null,
  groupId?: string | null,
): boolean {
  if (!user) return false;
  if (user.isSuperAdmin || user.isDeviceAdmin) return true;
  const role = user.userRole ?? user.admin.role;
  if (role === "team_admin" && teamId) return user.admin.teamIds.includes(teamId);
  if (role === "group_admin" && groupId) return user.admin.groupIds.includes(groupId);
  return canManageGroup(user, teamId, groupId);
}

/**
 * 成员卡片「编辑资料」的入口权限：个人信息或组织信息至少有一项可编辑。
 */
export function canEditMember(
  user: CurrentUser | null | undefined,
  teamId: string,
  groupId: string,
  memberId: string,
): boolean {
  if (!user) return false;
  if (canEditOrganizationalInfo(user, teamId, groupId)) return true;
  return Boolean(user.permissions.canEditSelf && user.linkedMemberId === memberId);
}

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

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      document.body.removeChild(area);
      return true;
    } catch {
      return false;
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
