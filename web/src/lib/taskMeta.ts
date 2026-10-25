import type {
  TaskDifficulty,
  TaskHealthStatus,
  TaskPriority,
  TaskProgressStatus,
  WorkloadLevel,
} from "../types";

export const TASK_PROGRESS_META: Record<
  TaskProgressStatus,
  { label: string; tone: string; badge: string }
> = {
  pending: { label: "待完成", tone: "neutral", badge: "badge-gray" },
  in_progress: { label: "进行中", tone: "blue", badge: "badge-blue" },
  completed: { label: "已完成", tone: "green", badge: "badge-green" },
};

export const TASK_HEALTH_META: Record<
  TaskHealthStatus,
  { label: string; tone: string; badge: string; description: string }
> = {
  normal: {
    label: "正常",
    tone: "green",
    badge: "badge-green",
    description: "按计划推进，无阻塞",
  },
  delayed: {
    label: "延期",
    tone: "orange",
    badge: "badge-orange",
    description: "预计完成时间需要调整",
  },
  blocked: {
    label: "阻塞",
    tone: "red",
    badge: "badge-red",
    description: "存在外部依赖或问题阻塞",
  },
};

/**
 * Round 9：优先级/难度各 1-3 分，任务负载分 = 优先级分 × 难度分（1-9）。
 * urgent 仅作为历史数据兼容读取（按 3 分），不再出现在任何入口/选项里。
 */
export const PRIORITY_META: Record<
  TaskPriority,
  { label: string; tone: string; badge: string; score: number }
> = {
  low: { label: "低", tone: "neutral", badge: "badge-gray", score: 1 },
  normal: { label: "普通", tone: "blue", badge: "badge-blue", score: 2 },
  high: { label: "高", tone: "orange", badge: "badge-orange", score: 3 },
};

export const DIFFICULTY_META: Record<
  TaskDifficulty,
  { label: string; tone: string; badge: string; score: number }
> = {
  easy: { label: "简单", tone: "green", badge: "badge-green", score: 1 },
  medium: { label: "中等", tone: "blue", badge: "badge-blue", score: 2 },
  hard: { label: "困难", tone: "orange", badge: "badge-orange", score: 3 },
};

/** 单任务负载分上限：优先级 3 分 × 难度 3 分。 */
export const TASK_MAX_POINTS = 9;
/** 每人每周容量（分），负载百分比 = 点数 / 15 * 100。 */
export const TASK_CAPACITY_POINTS = 15;

export const PROGRESS_STATUSES: TaskProgressStatus[] = ["pending", "in_progress", "completed"];
export const HEALTH_STATUSES: TaskHealthStatus[] = ["normal", "delayed", "blocked"];
export const PRIORITIES: TaskPriority[] = ["low", "normal", "high"];
export const DIFFICULTIES: TaskDifficulty[] = ["easy", "medium", "hard"];

export const WORKLOAD_LEVEL_META: Record<
  WorkloadLevel,
  { label: string; className: string }
> = {
  low: { label: "轻载", className: "is-low" },
  balanced: { label: "均衡", className: "is-balanced" },
  high: { label: "偏高", className: "is-high" },
  overload: { label: "超载", className: "is-overload" },
};

export function workloadLevel(percent: number): WorkloadLevel {
  if (percent < 40) return "low";
  if (percent < 85) return "balanced";
  if (percent < 110) return "high";
  return "overload";
}

export function loadTone(percent: number): string {
  return WORKLOAD_LEVEL_META[workloadLevel(percent)].className;
}

/* 历史数据兜底：urgent 在迁移前可能仍出现在旧 payload 里，按 3 分读取。 */
const PRIORITY_SCORE_FALLBACK: Record<string, number> = {
  low: 1,
  normal: 2,
  high: 3,
  urgent: 3,
};
const DIFFICULTY_SCORE_FALLBACK: Record<string, number> = {
  easy: 1,
  medium: 2,
  hard: 3,
};

export function priorityScore(priority: TaskPriority | string | null | undefined): number {
  return PRIORITY_SCORE_FALLBACK[priority ?? ""] ?? PRIORITY_META.normal.score;
}

export function difficultyScore(difficulty: TaskDifficulty | string | null | undefined): number {
  return DIFFICULTY_SCORE_FALLBACK[difficulty ?? ""] ?? DIFFICULTY_META.medium.score;
}

/** 任务负载分 = 优先级分（1-3）× 难度分（1-3），取值 1-9。 */
export function taskLoadPoints(priority: TaskPriority, difficulty: TaskDifficulty): number {
  return priorityScore(priority) * difficultyScore(difficulty);
}

export function formatPoints(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded} 分` : `${rounded.toFixed(1)} 分`;
}

export function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}
