import { AlertTriangle, CalendarDays, Clock, ListTodo, Maximize2 } from "lucide-react";
import { Avatar } from "./Avatar";
import { cn } from "../lib/utils";
import {
  WORKLOAD_LEVEL_META,
  formatPercent,
  formatPoints,
  workloadLevel,
} from "../lib/taskMeta";
import type { Workload } from "../types";

export interface WorkloadMeterProps {
  workload: Workload;
  /** Rolling window label from the API meta payload, e.g. 近 4 周. */
  windowLabel?: string;
  className?: string;
  /** When provided the card becomes a button that opens the detailed workload view. */
  onOpen?: () => void;
}

/**
 * One member workload card used inside the task overview rail.
 *
 * The global `.workload`, `.workload-head`, `.workload-title`, `.workload-bar`,
 * `.workload-fill`, `.workload-meta`, `.load-pill` and `.is-*` classes are styled by the
 * shared design system; `.tasks-wl-*` classes below add the page-specific layout fallback.
 */
export function WorkloadMeter({
  workload,
  windowLabel = "近 4 周",
  className,
  onOpen,
}: WorkloadMeterProps) {
  const currentLevel =
    WORKLOAD_LEVEL_META[workloadLevel(workload.currentLoadPercent)] ?? WORKLOAD_LEVEL_META.balanced;
  const averageLevel =
    WORKLOAD_LEVEL_META[workloadLevel(workload.averageLoadPercent)] ?? WORKLOAD_LEVEL_META.balanced;
  const currentWidth = Math.max(0, Math.min(100, workload.currentLoadPercent));
  const averageWidth = Math.max(0, Math.min(100, workload.averageLoadPercent));
  const hasBlocked = workload.blockedTasks > 0;
  const hasOverdue = workload.overdueTasks > 0;

  return (
    <article
      className={cn("workload", "tasks-wl", currentLevel.className, onOpen && "is-clickable", className)}
      aria-label={
        onOpen
          ? `查看 ${workload.memberName} 的详细负载`
          : `${workload.memberName} 工作量负载`
      }
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen}
      onKeyDown={
        onOpen
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen();
              }
            }
          : undefined
      }
    >
      <header className="workload-head tasks-wl-head">
        <Avatar name={workload.memberName} color={workload.avatarColor} size="md" />
        <div className="workload-title tasks-wl-title">
          <strong>{workload.memberName}</strong>
          <small>{workload.memberTitle || "开发组成员"}</small>
        </div>
        <span className={cn("load-pill", currentLevel.className)}>{currentLevel.label}</span>
        {onOpen ? <Maximize2 size={13} className="tasks-wl-open-icon" aria-hidden="true" /> : null}
      </header>

      <div className="tasks-wl-current">
        <div className="tasks-wl-current-head">
          <span>当前负载</span>
          <strong>{formatPercent(workload.currentLoadPercent)}</strong>
        </div>
        <div
          className={cn("workload-bar", currentLevel.className)}
          role="img"
          aria-label={`当前负载 ${formatPercent(
            workload.currentLoadPercent,
          )}，周容量 ${formatPoints(workload.capacityPoints)}`}
        >
          <span
            className={cn("workload-fill", currentLevel.className)}
            style={{ width: `${currentWidth}%` }}
          />
        </div>
      </div>

      <div className="workload-meta tasks-wl-meta">
        <span title="当前未完成任务负载点数 / 每周容量">
          <Clock size={11} /> {formatPoints(workload.currentPoints)} /{" "}
          {formatPoints(workload.capacityPoints)}
        </span>
        <span title={`${windowLabel}平均负载`}>
          <CalendarDays size={11} /> 平均 {formatPercent(workload.averageLoadPercent)}
        </span>
      </div>

      <div
        className="tasks-wl-average"
        title={`${windowLabel}平均负载点数 ${formatPoints(workload.averagePoints)}`}
      >
        <span>{windowLabel}平均</span>
        <span className="tasks-wl-average-bar" aria-hidden="true">
          <i className={averageLevel.className} style={{ width: `${averageWidth}%` }} />
        </span>
        <strong>{formatPoints(workload.averagePoints)}</strong>
      </div>

      <footer className="tasks-wl-flags">
        <span className="tasks-wl-flag">
          <ListTodo size={11} /> {workload.openTasks} 项未完成
        </span>
        {hasBlocked ? (
          <span className="tasks-wl-flag is-danger">
            <AlertTriangle size={11} /> 阻塞 {workload.blockedTasks}
          </span>
        ) : null}
        {hasOverdue ? (
          <span className="tasks-wl-flag is-danger">
            <Clock size={11} /> 逾期 {workload.overdueTasks}
          </span>
        ) : null}
        {!hasBlocked && !hasOverdue ? <span className="tasks-wl-flag is-ok">状态平稳</span> : null}
      </footer>
    </article>
  );
}
