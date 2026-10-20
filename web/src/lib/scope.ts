import type { InsightsRangeKey, ScopeKind } from "../types";

/** Global browsing scopes exposed in the sidebar. */
export const SCOPE_OPTIONS: {
  key: ScopeKind;
  label: string;
  shortLabel: string;
  description: string;
}[] = [
  {
    key: "group",
    label: "当前开发组",
    shortLabel: "开发组",
    description: "只看当前选中的开发组数据",
  },
  {
    key: "team",
    label: "当前团队",
    shortLabel: "团队",
    description: "汇总当前团队下所有开发组的数据",
  },
  {
    key: "all",
    label: "所有团队",
    shortLabel: "所有",
    description: "跨团队浏览整个站点的数据",
  },
];

export type ScopeOption = (typeof SCOPE_OPTIONS)[number];

/**
 * 浏览视角选项：所有身份均可使用开发组 / 团队 / 所有团队视图。
 */
export function scopeOptionsFor(_isSuperAdmin: boolean): ScopeOption[] {
  return SCOPE_OPTIONS;
}

export function isAggregateScope(scope: ScopeKind): boolean {
  return scope !== "group";
}

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

/** Shared palette for the group tag library. */
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
