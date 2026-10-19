import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Clock,
  Eye,
  Gauge,
  ListTodo,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Timer,
  Trash2,
  UserRound,
  Users,
  WifiOff,
  X,
} from "lucide-react";
import { api, ApiError } from "../api";
import { useApp } from "../store";
import { useToast } from "../components/Toast";
import { Avatar } from "../components/Avatar";
import { EmptyState, LoadingBlock } from "../components/Feedback";
import { ConfirmDialog } from "../components/Modal";
import { TaskDialog } from "../components/TaskDialog";
import type { TaskMemberOption } from "../components/TaskDialog";
import { WorkloadMeter } from "../components/WorkloadMeter";
import { cn, formatDate, formatDateTime } from "../lib/utils";
import {
  DIFFICULTY_META,
  HEALTH_STATUSES,
  PRIORITIES,
  PRIORITY_META,
  PROGRESS_STATUSES,
  TASK_HEALTH_META,
  TASK_PROGRESS_META,
  formatPercent,
  formatPoints,
  taskLoadPoints,
} from "../lib/taskMeta";
import type {
  MemberTask,
  TaskDifficulty,
  TaskHealthStatus,
  TaskOverviewData,
  TaskPriority,
  TaskProgressStatus,
  Workload,
  WorkloadSummary,
} from "../types";
import "./TaskOverviewPage.css";

type ProgressFilter = "all" | TaskProgressStatus;
type HealthFilter = "all" | TaskHealthStatus;
type PriorityFilter = "all" | TaskPriority;

const EMPTY_TASKS: MemberTask[] = [];
const EMPTY_WORKLOADS: Workload[] = [];
const EMPTY_SUMMARY: WorkloadSummary = {
  members: 0,
  tasks: 0,
  openTasks: 0,
  completedTasks: 0,
  blockedTasks: 0,
  overdueTasks: 0,
  currentPoints: 0,
  averagePoints: 0,
  averageLoadPercent: 0,
  capacityPoints: 15,
  windowWeeks: 4,
};
const EMPTY_META = {
  capacityPoints: 15,
  windowWeeks: 4,
  windowLabel: "近 4 周",
  scoring: "任务基础 1 分 + 难度加成 + 优先级加成；每人每周容量 15 分",
};

function messageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

const PROGRESS_FILTERS: { value: ProgressFilter; label: string }[] = [
  { value: "all", label: "全部进度" },
  ...PROGRESS_STATUSES.map((value) => ({
    value: value as ProgressFilter,
    label: TASK_PROGRESS_META[value].label,
  })),
];

const HEALTH_FILTERS: { value: HealthFilter; label: string }[] = [
  { value: "all", label: "全部健康度" },
  ...HEALTH_STATUSES.map((value) => ({
    value: value as HealthFilter,
    label: TASK_HEALTH_META[value].label,
  })),
];

const PRIORITY_FILTERS: { value: PriorityFilter; label: string }[] = [
  { value: "all", label: "全部优先级" },
  ...PRIORITIES.map((value) => ({
    value: value as PriorityFilter,
    label: PRIORITY_META[value].label,
  })),
];

export default function TaskOverviewPage() {
  const { data, currentTeam, currentGroup, canManageActiveGroup, reload } = useApp();
  const { toast } = useToast();
  const me = data?.me ?? null;
  const teamId = currentTeam?.id ?? "";
  const groupId = currentGroup?.id ?? "";
  const selfMemberId = me?.linkedMemberId ?? null;
  const canCreate = Boolean(me?.authenticated && (canManageActiveGroup || selfMemberId));

  const [payload, setPayload] = useState<TaskOverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<{ open: boolean; task: MemberTask | null }>({
    open: false,
    task: null,
  });
  const [deleting, setDeleting] = useState<MemberTask | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [memberFilter, setMemberFilter] = useState<string>("all");
  const [progressFilter, setProgressFilter] = useState<ProgressFilter>("all");
  const [healthFilter, setHealthFilter] = useState<HealthFilter>("all");
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>("all");
  const [showCompleted, setShowCompleted] = useState(true);

  const loadTasks = useCallback(
    async (silent = false) => {
      if (!teamId || !groupId) {
        setLoading(false);
        return;
      }
      if (silent) setRefreshing(true);
      else setLoading(true);
      setError("");
      try {
        const result = await api.tasks(teamId, groupId);
        setPayload(result);
      } catch (err) {
        setError(messageOf(err, "加载任务台账失败，请稍后重试。"));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [teamId, groupId],
  );

  useEffect(() => {
    setPayload(null);
    void loadTasks();
  }, [loadTasks]);

  // Switching development groups must never keep filters pointing at a previous member.
  useEffect(() => {
    setSearch("");
    setMemberFilter("all");
    setProgressFilter("all");
    setHealthFilter("all");
    setPriorityFilter("all");
    setShowCompleted(true);
    setDialog({ open: false, task: null });
    setDeleting(null);
    setBusyId(null);
  }, [groupId]);

  const tasks = payload?.tasks ?? EMPTY_TASKS;
  const workloads = payload?.workloads ?? EMPTY_WORKLOADS;
  const summary = payload?.summary ?? EMPTY_SUMMARY;
  const meta = payload?.meta ?? EMPTY_META;
  const windowLabel = meta.windowLabel || "近 4 周";

  const inProgressCount = useMemo(
    () => tasks.filter((task) => task.progressStatus === "in_progress").length,
    [tasks],
  );

  const kpis = useMemo(
    () => [
      {
        key: "open",
        label: "未完成任务",
        value: String(summary.openTasks),
        unit: "条",
        hint: `共 ${summary.tasks} 条任务`,
        icon: ListTodo,
        tone: "neutral",
      },
      {
        key: "progress",
        label: "进行中",
        value: String(inProgressCount),
        unit: "条",
        hint: summary.openTasks
          ? `占未完成 ${formatPercent((inProgressCount / summary.openTasks) * 100)}`
          : "等待成员开始推进",
        icon: Timer,
        tone: "blue",
      },
      {
        key: "blocked",
        label: "阻塞任务",
        value: String(summary.blockedTasks),
        unit: "条",
        hint: summary.blockedTasks ? "需要协调解除依赖" : "暂无阻塞",
        icon: AlertTriangle,
        tone: "amber",
      },
      {
        key: "overdue",
        label: "逾期任务",
        value: String(summary.overdueTasks),
        unit: "条",
        hint: summary.overdueTasks ? "已超过预期完成时间" : "全部按预期推进",
        icon: Clock,
        tone: "red",
      },
      {
        key: "load",
        label: "团队平均负载",
        value: formatPercent(summary.averageLoadPercent),
        unit: "",
        hint: `人均 ${formatPoints(
          summary.averagePoints / Math.max(1, summary.members),
        )} / ${formatPoints(summary.capacityPoints)} · ${windowLabel}`,
        icon: Gauge,
        tone: "blue",
      },
    ],
    [summary, inProgressCount, windowLabel],
  );

  const filteredTasks = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return tasks.filter((task) => {
      if (!showCompleted && task.progressStatus === "completed") return false;
      if (progressFilter !== "all" && task.progressStatus !== progressFilter) return false;
      if (healthFilter !== "all" && task.healthStatus !== healthFilter) return false;
      if (priorityFilter !== "all" && task.priority !== priorityFilter) return false;
      if (memberFilter !== "all" && task.memberId !== memberFilter) return false;
      if (keyword) {
        const haystack =
          `${task.title} ${task.description} ${task.memberName} ${task.memberTitle}`.toLowerCase();
        if (!haystack.includes(keyword)) return false;
      }
      return true;
    });
  }, [tasks, search, showCompleted, progressFilter, healthFilter, priorityFilter, memberFilter]);

  const dialogMembers = useMemo<TaskMemberOption[]>(
    () =>
      workloads.map((workload) => ({
        id: workload.memberId,
        name: workload.memberName,
        title: workload.memberTitle,
        avatarColor: workload.avatarColor,
      })),
    [workloads],
  );

  const defaultMemberId = selfMemberId ?? dialogMembers[0]?.id ?? null;
  const filtersActive =
    Boolean(search.trim()) ||
    memberFilter !== "all" ||
    progressFilter !== "all" ||
    healthFilter !== "all" ||
    priorityFilter !== "all" ||
    !showCompleted;

  const canManageTask = useCallback(
    (task: MemberTask) =>
      Boolean(
        me?.authenticated &&
          (canManageActiveGroup || (selfMemberId && task.memberId === selfMemberId)),
      ),
    [me?.authenticated, canManageActiveGroup, selfMemberId],
  );

  const resetFilters = () => {
    setSearch("");
    setMemberFilter("all");
    setProgressFilter("all");
    setHealthFilter("all");
    setPriorityFilter("all");
    setShowCompleted(true);
  };

  const openCreate = () => {
    if (!canCreate) {
      toast("当前身份为只读，无法创建任务。", "info");
      return;
    }
    setDialog({ open: true, task: null });
  };

  const openEdit = (task: MemberTask) => {
    if (!canManageTask(task)) return;
    setDialog({ open: true, task });
  };

  const handleSaved = useCallback(
    (saved: MemberTask) => {
      const creating = !dialog.task;
      setDialog({ open: false, task: null });
      if (creating) {
        // A freshly created task should always be visible after saving.
        resetFilters();
      } else {
        setMemberFilter((current) =>
          current !== "all" && current !== saved.memberId ? "all" : current,
        );
      }
      void loadTasks(true);
      void reload(true);
    },
    [dialog.task, loadTasks, reload],
  );

  const removeTask = async () => {
    if (!deleting) return;
    setBusyId(deleting.id);
    try {
      await api.deleteTask(teamId, groupId, deleting.id);
      toast("任务已删除", "success");
      setDeleting(null);
      await loadTasks(true);
      void reload(true);
    } catch (err) {
      toast(messageOf(err, "删除任务失败，请稍后重试。"), "error");
    } finally {
      setBusyId(null);
    }
  };

  if (!currentTeam || !currentGroup) {
    return (
      <EmptyState
        title="还没有可查看的开发组"
        description="请先在左侧导航选择一个团队与开发组，然后再回来查看团队任务总览。"
      />
    );
  }

  const summaryBar = (
    <div className="tasks-kpis">
      {kpis.map((kpi) => {
        const Icon = kpi.icon;
        return (
          <article className={cn("tasks-kpi", `is-${kpi.tone}`)} key={kpi.key}>
            <div className="tasks-kpi-top">
              <span className="tasks-kpi-icon">
                <Icon size={15} />
              </span>
              <span className="tasks-kpi-label">{kpi.label}</span>
            </div>
            <div className="tasks-kpi-value">
              <strong>{kpi.value}</strong>
              {kpi.unit ? <small>{kpi.unit}</small> : null}
            </div>
            <span className="tasks-kpi-hint">{kpi.hint}</span>
          </article>
        );
      })}
    </div>
  );

  const errorBanner = error ? (
    <div className="inline-error" role="alert">
      <WifiOff size={16} />
      <span>{error}</span>
      <button className="text-button" onClick={() => void loadTasks()} disabled={refreshing}>
        重新加载
      </button>
    </div>
  ) : null;

  const filters = (
    <div className="tasks-filters">
      <div className="tasks-filter-row">
        <label className="tasks-search">
          <Search size={14} aria-hidden="true" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索任务标题、说明或成员…"
            aria-label="搜索任务"
            type="search"
          />
          {search ? (
            <button
              type="button"
              className="tasks-search-clear"
              onClick={() => setSearch("")}
              aria-label="清除搜索"
            >
              <X size={13} />
            </button>
          ) : null}
        </label>

        <label className="tasks-filter-select">
          <UserRound size={13} aria-hidden="true" />
          <select
            value={memberFilter}
            onChange={(event) => setMemberFilter(event.target.value)}
            aria-label="按成员筛选"
          >
            <option value="all">全部成员</option>
            {workloads.map((workload) => (
              <option key={workload.memberId} value={workload.memberId}>
                {workload.memberName}
              </option>
            ))}
          </select>
        </label>

        <div className="tasks-segmented" role="group" aria-label="按进度状态筛选">
          {PROGRESS_FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={cn("tasks-seg", progressFilter === option.value && "active")}
              onClick={() => setProgressFilter(option.value)}
              aria-pressed={progressFilter === option.value}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="tasks-filter-tail">
          <label className="switch tasks-completed-switch">
            <input
              type="checkbox"
              checked={showCompleted}
              onChange={(event) => setShowCompleted(event.target.checked)}
            />
            <span className="switch-track" />
            <span>显示已完成</span>
          </label>

          <button
            type="button"
            className="text-button tasks-reset"
            onClick={resetFilters}
            disabled={!filtersActive}
          >
            <RotateCcw size={12} /> 重置筛选
          </button>
        </div>
      </div>

      <div className="tasks-filter-row tasks-filter-row-secondary">
        <div className="tasks-filter-group">
          <span className="tasks-filter-label">健康度</span>
          <div className="tasks-health-filters" role="group" aria-label="按健康状态筛选">
            {HEALTH_FILTERS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={cn(
                  "tasks-health-chip",
                  option.value !== "all" && `is-${option.value}`,
                  healthFilter === option.value && "active",
                )}
                onClick={() => setHealthFilter(option.value)}
                aria-pressed={healthFilter === option.value}
              >
                {option.value === "all" ? null : <i className="tasks-health-dot" />}
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="tasks-filter-group">
          <span className="tasks-filter-label">优先级</span>
          <div className="tasks-priority-filters" role="group" aria-label="按优先级筛选">
            {PRIORITY_FILTERS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={cn(
                  "tasks-priority-chip",
                  option.value !== "all" && `is-priority-${option.value}`,
                  priorityFilter === option.value && "active",
                )}
                onClick={() => setPriorityFilter(option.value)}
                aria-pressed={priorityFilter === option.value}
              >
                {option.value === "all" ? null : <i className="tasks-priority-dot" />}
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );

  const taskCountLabel = filtersActive
    ? `筛选 ${filteredTasks.length} / ${tasks.length} 条`
    : `共 ${tasks.length} 条任务`;

  const table = (
    <div className="table-wrap tasks-table-wrap">
      <table className="data-table tasks-table">
        <thead>
          <tr>
            <th scope="col">成员</th>
            <th scope="col">任务</th>
            <th scope="col">进度</th>
            <th scope="col">健康度</th>
            <th scope="col">预期完成</th>
            <th scope="col" title="负载点数 = 1 分基础 + 优先级加成 + 难度加成">
              负载
            </th>
            <th scope="col">
              <span className="tasks-th-actions">操作</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {filteredTasks.map((task) => {
            const progress = TASK_PROGRESS_META[task.progressStatus] ?? TASK_PROGRESS_META.pending;
            const health = TASK_HEALTH_META[task.healthStatus] ?? TASK_HEALTH_META.normal;
            const priorityKey: TaskPriority = task.priority ?? "normal";
            const difficultyKey: TaskDifficulty = task.difficulty ?? "medium";
            const priority = PRIORITY_META[priorityKey] ?? PRIORITY_META.normal;
            const difficulty = DIFFICULTY_META[difficultyKey] ?? DIFFICULTY_META.medium;
            const points =
              typeof task.loadPoints === "number"
                ? task.loadPoints
                : taskLoadPoints(priorityKey, difficultyKey);
            const manageable = canManageTask(task);
            return (
              <tr
                key={task.id}
                className={cn(
                  "tasks-row",
                  `health-${task.healthStatus}`,
                  task.progressStatus === "completed" && "is-completed",
                )}
              >
                <td>
                  <div className="tasks-member-cell">
                    <Avatar
                      name={task.memberName}
                      color={task.memberAvatarColor}
                      size="xs"
                    />
                    <div className="tasks-member-copy">
                      <strong>{task.memberName}</strong>
                      <small>{task.memberTitle || "开发组成员"}</small>
                    </div>
                  </div>
                </td>
                <td>
                  <div className="tasks-task-cell">
                    <span className="tasks-task-title">{task.title}</span>
                    {task.description ? (
                      <p className="tasks-task-desc">{task.description}</p>
                    ) : null}
                    <div className="tasks-task-tags">
                      <span
                        className={cn("tasks-tag", `is-priority-${priorityKey}`)}
                        title={`优先级 ${priority.label}（+${priority.weight} 分）`}
                      >
                        <i className="tasks-tag-dot" /> 优先级 {priority.label}
                      </span>
                      <span
                        className={cn("tasks-tag", `is-difficulty-${difficultyKey}`)}
                        title={`难度 ${difficulty.label}（+${difficulty.weight} 分）`}
                      >
                        <i className="tasks-tag-dot" /> 难度 {difficulty.label}
                      </span>
                    </div>
                    {task.completedAt ? (
                      <span className="tasks-task-note">
                        完成于 {formatDateTime(task.completedAt)}
                      </span>
                    ) : null}
                  </div>
                </td>
                <td>
                  <span className={cn("badge", progress.badge)}>{progress.label}</span>
                </td>
                <td>
                  <span
                    className={cn(
                      "badge",
                      health.badge,
                      "tasks-health-badge",
                      `is-${task.healthStatus}`,
                    )}
                  >
                    {task.healthStatus === "blocked" ? <AlertTriangle size={10} /> : null}
                    {health.label}
                  </span>
                </td>
                <td>
                  <div className="tasks-date-cell">
                    <span className={cn("tasks-date", task.overdue && "is-overdue")}>
                      {task.expectedDate ? formatDate(task.expectedDate) : "未设置"}
                    </span>
                    {task.overdue ? <span className="tasks-overdue-flag">已逾期</span> : null}
                  </div>
                </td>
                <td>
                  <div
                    className="tasks-points"
                    title={`负载点数 ${points}：基础 1 分 + 优先级 ${priority.label}（+${priority.weight}）+ 难度 ${difficulty.label}（+${difficulty.weight}）`}
                  >
                    <span className="tasks-points-value">{formatPoints(points)}</span>
                    <span
                      className="tasks-points-meter"
                      role="img"
                      aria-label={`负载强度 ${points} / 6`}
                    >
                      {Array.from({ length: 6 }, (_, index) => (
                        <i key={index} className={index < points ? "is-on" : undefined} />
                      ))}
                    </span>
                  </div>
                </td>
                <td>
                  {manageable ? (
                    <div className="tasks-row-actions">
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => openEdit(task)}
                        aria-label={`编辑任务 ${task.title}`}
                        title="编辑任务"
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        type="button"
                        className="icon-button danger"
                        onClick={() => setDeleting(task)}
                        aria-label={`删除任务 ${task.title}`}
                        title="删除任务"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ) : (
                    <span className="tasks-actions-muted">只读</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  const mobileCards = (
    <div className="tasks-card-list">
      {filteredTasks.map((task) => {
        const progress = TASK_PROGRESS_META[task.progressStatus] ?? TASK_PROGRESS_META.pending;
        const health = TASK_HEALTH_META[task.healthStatus] ?? TASK_HEALTH_META.normal;
        const priorityKey: TaskPriority = task.priority ?? "normal";
        const difficultyKey: TaskDifficulty = task.difficulty ?? "medium";
        const priority = PRIORITY_META[priorityKey] ?? PRIORITY_META.normal;
        const difficulty = DIFFICULTY_META[difficultyKey] ?? DIFFICULTY_META.medium;
        const points =
          typeof task.loadPoints === "number"
            ? task.loadPoints
            : taskLoadPoints(priorityKey, difficultyKey);
        const manageable = canManageTask(task);
        return (
          <article
            key={task.id}
            className={cn(
              "tasks-card",
              `health-${task.healthStatus}`,
              task.progressStatus === "completed" && "is-completed",
            )}
          >
            <header className="tasks-card-head">
              <div className="tasks-member-cell">
                <Avatar name={task.memberName} color={task.memberAvatarColor} size="sm" />
                <div className="tasks-member-copy">
                  <strong>{task.memberName}</strong>
                  <small>{task.memberTitle || "开发组成员"}</small>
                </div>
              </div>
              <span className={cn("badge", progress.badge)}>{progress.label}</span>
            </header>
            <h3 className="tasks-card-title">{task.title}</h3>
            {task.description ? <p className="tasks-card-desc">{task.description}</p> : null}
            <div className="tasks-task-tags">
              <span
                className={cn("tasks-tag", `is-priority-${priorityKey}`)}
                title={`优先级 ${priority.label}（+${priority.weight} 分）`}
              >
                <i className="tasks-tag-dot" /> 优先级 {priority.label}
              </span>
              <span
                className={cn("tasks-tag", `is-difficulty-${difficultyKey}`)}
                title={`难度 ${difficulty.label}（+${difficulty.weight} 分）`}
              >
                <i className="tasks-tag-dot" /> 难度 {difficulty.label}
              </span>
            </div>
            <div className="tasks-card-meta">
              <span
                className={cn(
                  "badge",
                  health.badge,
                  "tasks-health-badge",
                  `is-${task.healthStatus}`,
                )}
              >
                {task.healthStatus === "blocked" ? <AlertTriangle size={10} /> : null}
                {health.label}
              </span>
              <span className={cn("tasks-date", task.overdue && "is-overdue")}>
                <Clock size={11} />{" "}
                {task.expectedDate ? formatDate(task.expectedDate) : "未设置预期"}
                {task.overdue ? " · 已逾期" : ""}
              </span>
              <span
                className="tasks-points"
                title={`负载点数 ${points}：基础 1 分 + 优先级 ${priority.label}（+${priority.weight}）+ 难度 ${difficulty.label}（+${difficulty.weight}）`}
              >
                <Gauge size={11} /> {formatPoints(points)}
              </span>
            </div>
            {manageable ? (
              <footer className="tasks-card-actions">
                <button className="btn btn-secondary btn-sm" onClick={() => openEdit(task)}>
                  <Pencil size={12} /> 编辑
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => setDeleting(task)}>
                  <Trash2 size={12} /> 删除
                </button>
              </footer>
            ) : null}
          </article>
        );
      })}
    </div>
  );

  return (
    <div className="tasks-page">
      {errorBanner}

      <header className="page-header">
        <div className="page-heading">
          <span className="eyebrow">
            <ListTodo size={12} /> TASK LEDGER
          </span>
          <h1 className="page-title">团队任务总览</h1>
          <p className="page-subtitle">
            成员自主维护任务进度、健康状态与预期完成时间；任务负载由基础 1 分、优先级与难度加成计算，
            每人每周容量 15 分，帮助团队在过载前及时调整节奏。
          </p>
        </div>
        <div className="page-actions">
          {!canCreate ? (
            <span className="badge badge-gray tasks-readonly">
              <Eye size={12} /> 只读视图
            </span>
          ) : null}
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => void loadTasks(true)}
            disabled={loading || refreshing}
          >
            <RefreshCw size={14} className={loading || refreshing ? "spin" : undefined} /> 刷新
          </button>
          {canCreate ? (
            <button className="btn btn-primary btn-sm" onClick={openCreate}>
              <Plus size={15} /> 新建任务
            </button>
          ) : null}
        </div>
      </header>

      {summaryBar}

      <section className="panel tasks-workload-panel" aria-labelledby="tasks-workload-title">
        <header className="panel-header tasks-panel-head">
          <div className="tasks-panel-heading">
            <h2 id="tasks-workload-title">
              <Gauge size={15} /> 成员负载
            </h2>
            <p className="tasks-panel-sub">
              {windowLabel}滚动平均 · 每人容量 {formatPoints(meta.capacityPoints)} / 周
            </p>
          </div>
          <span className="tasks-panel-meta">
            <Users size={13} /> {summary.members} 位成员 · 当前总负载{" "}
            {formatPoints(summary.currentPoints)}
          </span>
        </header>
        <div className="panel-body tasks-workload-body">
          {loading && !payload ? (
            <LoadingBlock label="正在汇总成员负载…" rows={2} />
          ) : workloads.length ? (
            <div className="tasks-workload-rail">
              {workloads.map((workload) => (
                <WorkloadMeter key={workload.memberId} workload={workload} windowLabel={windowLabel} />
              ))}
            </div>
          ) : (
            <EmptyState
              compact
              icon={<Users size={22} />}
              title="暂时没有成员数据"
              description="当前开发组还没有成员，添加成员后即可查看每个人的任务负载。"
            />
          )}
        </div>
      </section>

      <section className="panel tasks-ledger" aria-labelledby="tasks-ledger-title">
        <header className="panel-header tasks-panel-head">
          <div className="tasks-panel-heading">
            <h2 id="tasks-ledger-title">
              <ListTodo size={15} /> 任务台账
            </h2>
            <p className="tasks-panel-sub">
              {taskCountLabel}
              {summary.completedTasks
                ? ` · 已完成 ${summary.completedTasks} 条`
                : ""}
            </p>
          </div>
          <div className="tasks-panel-tools">
            <span className="badge badge-gray tasks-window-badge">
              <Clock size={11} /> {windowLabel}
            </span>
            <button
              type="button"
              className="icon-button"
              onClick={() => void loadTasks(true)}
              disabled={loading || refreshing}
              aria-label="刷新任务台账"
              title="刷新任务台账"
            >
              <RefreshCw size={15} className={loading || refreshing ? "spin" : undefined} />
            </button>
          </div>
        </header>

        {filters}

        <div className="panel-body tasks-ledger-body">
          {loading && !payload ? (
            <LoadingBlock label="正在加载任务台账…" rows={5} />
          ) : error && !payload ? (
            <EmptyState
              icon={<WifiOff size={24} />}
              title="任务台账暂时不可用"
              description={error}
              action={
                <button className="btn btn-primary btn-sm" onClick={() => void loadTasks()}>
                  <RefreshCw size={14} /> 重新加载
                </button>
              }
            />
          ) : filteredTasks.length ? (
            <>
              {table}
              {mobileCards}
            </>
          ) : (
            <EmptyState
              icon={<ListTodo size={24} />}
              title={tasks.length ? "没有符合筛选条件的任务" : "还没有登记任务"}
              description={
                tasks.length
                  ? "试试放宽成员、进度或健康度筛选条件。"
                  : canCreate
                    ? "为成员登记第一项任务，优先级与难度会自动换算成负载点数计入团队负载。"
                    : "当前为只读视图，暂时没有可查看的任务。"
              }
              action={
                tasks.length ? (
                  <button className="btn btn-secondary btn-sm" onClick={resetFilters}>
                    <RotateCcw size={14} /> 重置筛选
                  </button>
                ) : canCreate ? (
                  <button className="btn btn-primary btn-sm" onClick={openCreate}>
                    <Plus size={14} /> 新建任务
                  </button>
                ) : null
              }
            />
          )}
        </div>
      </section>

      <p className="tasks-page-note">
        <Gauge size={12} />{" "}
        {meta.scoring
          ? `${meta.scoring}；`
          : "负载点数 = 1 分基础 + 优先级加成 + 难度加成；每人每周容量 15 分；"}
        {windowLabel}平均按滚动窗口统计，仅供团队节奏参考。
      </p>

      <TaskDialog
        open={dialog.open}
        task={dialog.task}
        teamId={teamId}
        groupId={groupId}
        members={dialogMembers}
        canAssignOthers={canManageActiveGroup}
        selfMemberId={selfMemberId}
        defaultMemberId={defaultMemberId}
        onClose={() => setDialog({ open: false, task: null })}
        onSaved={handleSaved}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        title="删除任务"
        message={`确定删除「${deleting?.title ?? ""}」吗？删除后该成员的任务负载会立即重新计算。`}
        confirmLabel="删除任务"
        loading={Boolean(deleting && busyId === deleting.id)}
        onClose={() => setDeleting(null)}
        onConfirm={() => void removeTask()}
      />
    </div>
  );
}
