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

export const PRIORITY_META: Record<
  TaskPriority,
  { label: string; tone: string; badge: string; weight: number }
> = {
  low: { label: "低", tone: "neutral", badge: "badge-gray", weight: 0 },
  normal: { label: "普通", tone: "blue", badge: "badge-blue", weight: 1 },
  high: { label: "高", tone: "orange", badge: "badge-orange", weight: 2 },
  urgent: { label: "紧急", tone: "red", badge: "badge-red", weight: 3 },
};

export const DIFFICULTY_META: Record<
  TaskDifficulty,
  { label: string; tone: string; badge: string; weight: number }
> = {
  easy: { label: "简单", tone: "green", badge: "badge-green", weight: 0 },
  medium: { label: "中等", tone: "blue", badge: "badge-blue", weight: 1 },
  hard: { label: "困难", tone: "orange", badge: "badge-orange", weight: 2 },
};

export const TASK_BASE_POINTS = 1;
export const TASK_CAPACITY_POINTS = 15;

export const PROGRESS_STATUSES: TaskProgressStatus[] = ["pending", "in_progress", "completed"];
export const HEALTH_STATUSES: TaskHealthStatus[] = ["normal", "delayed", "blocked"];
export const PRIORITIES: TaskPriority[] = ["low", "normal", "high", "urgent"];
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

export function taskLoadPoints(priority: TaskPriority, difficulty: TaskDifficulty): number {
  return (
    TASK_BASE_POINTS + (PRIORITY_META[priority]?.weight ?? 0) + (DIFFICULTY_META[difficulty]?.weight ?? 0)
  );
}

export function formatPoints(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded} 分` : `${rounded.toFixed(1)} 分`;
}

export function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}
