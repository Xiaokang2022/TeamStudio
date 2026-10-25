import {
  CheckCircle2,
  Clock,
  Gauge,
  ListTodo,
  TriangleAlert,
  Users,
} from "lucide-react";
import { Modal } from "./Modal";
import { Avatar } from "./Avatar";
import { EmptyState } from "./Feedback";
import { cn, formatDate } from "../lib/utils";
import {
  DIFFICULTY_META,
  PRIORITY_META,
  TASK_MAX_POINTS,
  TASK_PROGRESS_META,
  WORKLOAD_LEVEL_META,
  formatPercent,
  formatPoints,
  taskLoadPoints,
  workloadLevel,
} from "../lib/taskMeta";
import type { MemberTask, Workload } from "../types";
import "./WorkloadDetailDialog.css";

export interface WorkloadDetailDialogProps {
  open: boolean;
  workload: Workload | null;
  /** Every task in the current ledger payload; the dialog filters by member. */
  tasks: MemberTask[];
  windowLabel?: string;
  capacityPoints?: number;
  scoring?: string;
  onClose: () => void;
  onFilterMember?: (memberId: string) => void;
  onOpenProfile?: (memberId: string) => void;
}

function pointsOf(task: MemberTask): number {
  return typeof task.loadPoints === "number"
    ? task.loadPoints
    : taskLoadPoints(task.priority ?? "normal", task.difficulty ?? "medium");
}

function CompareTask(a: MemberTask, b: MemberTask): number {
  return (
    pointsOf(b) - pointsOf(a) ||
    (a.expectedDate || "9999-99-99").localeCompare(b.expectedDate || "9999-99-99") ||
    a.title.localeCompare(b.title, "zh-CN")
  );
}

/**
 * Detailed per-member workload breakdown opened from the workload rail.
 *
 * Answers "why is this member loaded that way": current/average points, capacity,
 * task counts, and the point formula for every open task plus the completed backlog.
 * All numbers come from the same API payload as the rail, so the modal can never
 * disagree with the card that opened it.
 */
export function WorkloadDetailDialog({
  open,
  workload,
  tasks,
  windowLabel = "近 4 周",
  capacityPoints,
  scoring,
  onClose,
  onFilterMember,
  onOpenProfile,
}: WorkloadDetailDialogProps) {
  if (!workload) return null;

  const capacity = capacityPoints ?? workload.capacityPoints ?? 15;
  const level = WORKLOAD_LEVEL_META[workloadLevel(workload.currentLoadPercent)] ?? WORKLOAD_LEVEL_META.balanced;
  const averageLevel =
    WORKLOAD_LEVEL_META[workloadLevel(workload.averageLoadPercent)] ?? WORKLOAD_LEVEL_META.balanced;
  const currentWidth = Math.max(0, Math.min(100, workload.currentLoadPercent));
  const averageWidth = Math.max(0, Math.min(100, workload.averageLoadPercent));

  const archiveIds = workload.memberIds?.length ? workload.memberIds : [workload.memberId];
  const archiveIdSet = new Set([workload.memberId, ...archiveIds]);
  const memberTasks = tasks.filter((task) => archiveIdSet.has(task.memberId));
  const activeTasks = memberTasks
    .filter((task) => task.progressStatus !== "completed")
    .sort(CompareTask);
  const completedTasks = memberTasks
    .filter((task) => task.progressStatus === "completed")
    .sort((a, b) => (b.completedAt || b.updatedAt || "").localeCompare(a.completedAt || a.updatedAt || ""));

  const activePoints = activeTasks.reduce((total, task) => total + pointsOf(task), 0);
  const completedPoints = completedTasks.reduce((total, task) => total + pointsOf(task), 0);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${workload.memberName} · 负载详情`}
      description={`按任务逐条拆解当前负载：未完成任务点数合计 ÷ 每人每周容量（${formatPoints(
        capacity,
      )}），${windowLabel}平均负载按滚动窗口统计。`}
      size="lg"
      className="wl-detail-modal"
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={onClose}>
            关闭
          </button>
          {onFilterMember ? (
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => {
                onFilterMember(workload.memberId);
                onClose();
              }}
            >
              <ListTodo size={14} /> 在台账中筛选该成员
            </button>
          ) : null}
          {onOpenProfile ? (
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => {
                onOpenProfile(workload.memberId);
                onClose();
              }}
            >
              <Users size={14} /> 查看成员档案
            </button>
          ) : null}
        </>
      }
    >
      <div className="wl-detail">
        <header className="wl-detail-hero">
          <Avatar
            name={workload.memberName}
            src={workload.avatar}
            color={workload.avatarColor}
            size="lg"
          />
          <div className="wl-detail-identity">
            <strong>{workload.memberName}</strong>
            <span>{workload.memberTitle || "团队成员"}</span>
          </div>
          <div className="wl-detail-hero-level">
            <span className={cn("load-pill", level.className)}>
              {level.label} · {formatPercent(workload.currentLoadPercent)}
            </span>
            <small>
              未完成 {workload.openTasks} 项 · 已完成 {workload.completedTasks} 项
            </small>
          </div>
        </header>

        <section className="wl-detail-section" aria-label="负载概览">
          <div className="wl-detail-bar-head">
            <span>
              <Gauge size={13} /> 当前负载
            </span>
            <strong>
              {formatPoints(workload.currentPoints)} / {formatPoints(capacity)}
            </strong>
          </div>
          <div
            className={cn("workload-bar", level.className)}
            role="img"
            aria-label={`当前负载 ${formatPercent(workload.currentLoadPercent)}，周容量 ${formatPoints(capacity)}`}
          >
            <span className={cn("workload-fill", level.className)} style={{ width: `${currentWidth}%` }} />
          </div>
          <div className="wl-detail-bar-head is-average">
            <span>
              <Clock size={13} /> {windowLabel}平均负载
            </span>
            <strong>
              {formatPoints(workload.averagePoints)} · {formatPercent(workload.averageLoadPercent)}
            </strong>
          </div>
          <div className="wl-detail-average-track" aria-hidden="true">
            <i className={averageLevel.className} style={{ width: `${averageWidth}%` }} />
          </div>
        </section>

        <section className="wl-detail-stats" aria-label="负载统计">
          <div className="wl-detail-stat">
            <small>未完成任务</small>
            <strong>{workload.openTasks}</strong>
            <span>{formatPoints(activePoints)}</span>
          </div>
          <div className="wl-detail-stat">
            <small>已完成任务</small>
            <strong>{workload.completedTasks}</strong>
            <span>{formatPoints(completedPoints)}</span>
          </div>
          <div className={cn("wl-detail-stat", workload.blockedTasks > 0 && "is-danger")}>
            <small>阻塞中</small>
            <strong>{workload.blockedTasks}</strong>
            <span>{workload.blockedTasks ? "需要协调" : "无阻塞"}</span>
          </div>
          <div className={cn("wl-detail-stat", workload.overdueTasks > 0 && "is-danger")}>
            <small>已逾期</small>
            <strong>{workload.overdueTasks}</strong>
            <span>{workload.overdueTasks ? "优先处理" : "按计划推进"}</span>
          </div>
        </section>

        <section className="wl-detail-section" aria-label="未完成任务负载构成">
          <header className="wl-detail-section-head">
            <h3>
              <TriangleAlert size={14} /> 未完成任务 · 当前负载构成
            </h3>
            <span className="badge badge-gray">{activeTasks.length} 项</span>
          </header>
          {activeTasks.length ? (
            <ul className="wl-detail-task-list">
              {activeTasks.map((task) => {
                const progress = TASK_PROGRESS_META[task.progressStatus];
                const priority = PRIORITY_META[task.priority] ?? PRIORITY_META.normal;
                const difficulty = DIFFICULTY_META[task.difficulty] ?? DIFFICULTY_META.medium;
                const points = pointsOf(task);
                // Round 9：负载分 = 优先级分（1-3）× 难度分（1-3），满分 9。
                const formula = `优先级分 ${priority.score} × 难度分 ${difficulty.score} = ${points} / ${TASK_MAX_POINTS}`;
                return (
                  <li key={task.id} className={cn("wl-detail-task", task.overdue && "is-overdue")}>
                    <div className="wl-detail-task-main">
                      <strong>{task.title}</strong>
                      <div className="wl-detail-task-meta">
                        <span className={cn("badge", progress.badge)}>{progress.label}</span>
                        <span className={cn("badge", priority.badge)}>优先级 {priority.label}</span>
                        <span className={cn("badge", difficulty.badge)}>难度 {difficulty.label}</span>
                        <span className={cn("wl-detail-task-date", task.overdue && "is-danger")}>
                          <Clock size={11} />
                          {task.expectedDate ? `${formatDate(task.expectedDate)} 预计完成` : "未设置预计完成"}
                        </span>
                      </div>
                    </div>
                    <div className="wl-detail-task-points" title={formula}>
                      <strong>{formatPoints(points)}</strong>
                      <small>{formula}</small>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState
              compact
              icon={<CheckCircle2 size={22} />}
              title="当前没有未完成任务"
              description="这位成员目前没有进行中的任务，当前负载为 0。"
            />
          )}
          {activeTasks.length ? (
            <p className="wl-detail-formula">
              未完成任务点数合计 <strong>{formatPoints(workload.currentPoints)}</strong> ÷ 每周容量{" "}
              <strong>{formatPoints(capacity)}</strong> ={" "}
              <strong>{formatPercent(workload.currentLoadPercent)}</strong>
            </p>
          ) : null}
        </section>

        {completedTasks.length ? (
          <section className="wl-detail-section" aria-label="已完成任务">
            <header className="wl-detail-section-head">
              <h3>
                <CheckCircle2 size={14} /> 已完成任务 · 不计入当前负载
              </h3>
              <span className="badge badge-green">{completedTasks.length} 项</span>
            </header>
            <ul className="wl-detail-task-list is-completed">
              {completedTasks.map((task) => (
                <li key={task.id} className="wl-detail-task">
                  <div className="wl-detail-task-main">
                    <strong>{task.title}</strong>
                    <div className="wl-detail-task-meta">
                      <span className="badge badge-green">已完成</span>
                      <span className="wl-detail-task-date">
                        <Clock size={11} />
                        {task.completedAt ? formatDate(task.completedAt) : "完成时间未知"}
                      </span>
                    </div>
                  </div>
                  <div className="wl-detail-task-points">
                    <strong>{formatPoints(pointsOf(task))}</strong>
                    <small>已完成</small>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {scoring ? (
          <p className="wl-detail-scoring">
            <ListTodo size={12} /> {scoring}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

export default WorkloadDetailDialog;
