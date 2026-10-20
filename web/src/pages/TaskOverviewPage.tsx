import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Building2,
  Clock,
  Eye,
  Gauge,
  ListTodo,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Tags,
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
import { TagChips, TagLibraryDialog } from "../components/TagPicker";
import type { TagLibraryGroupOption } from "../components/TagPicker";
import { WorkloadMeter } from "../components/WorkloadMeter";
import { WorkloadDetailDialog } from "../components/WorkloadDetailDialog";
import { Select } from "../components/Select";
import { cn, formatDate, formatDateTime } from "../lib/utils";
import { TASK_RANGES, isWithinRange, rangeStartISO } from "../lib/scope";
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
  InsightsRangeKey,
  MemberTask,
  TaskDifficulty,
  TaskHealthStatus,
  TaskOverviewData,
  TaskPriority,
  TaskProgressStatus,
  TaskTag,
  Workload,
  WorkloadSummary,
} from "../types";
import "./TaskOverviewPage.css";

type ProgressFilter = "all" | TaskProgressStatus;
type HealthFilter = "all" | TaskHealthStatus;
type PriorityFilter = "all" | TaskPriority;

/** #13 sortable task-ledger columns. */
type TaskSortKey =
  | "member"
  | "priority"
  | "difficulty"
  | "load"
  | "expected"
  | "created"
  | "progress"
  | "health";
type SortDirection = "asc" | "desc";

interface SortState {
  key: TaskSortKey;
  direction: SortDirection;
}

const DEFAULT_SORT: SortState = { key: "created", direction: "desc" };
const DEFAULT_RANGE_KEY: InsightsRangeKey = "1m";

const PRIORITY_RANK: Record<TaskPriority, number> = { low: 0, normal: 1, high: 2, urgent: 3 };
const DIFFICULTY_RANK: Record<TaskDifficulty, number> = { easy: 0, medium: 1, hard: 2 };
const PROGRESS_RANK: Record<TaskProgressStatus, number> = {
  pending: 0,
  in_progress: 1,
  completed: 2,
};
const HEALTH_RANK: Record<TaskHealthStatus, number> = { normal: 0, delayed: 1, blocked: 2 };

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

function pointsOf(task: MemberTask): number {
  return typeof task.loadPoints === "number"
    ? task.loadPoints
    : taskLoadPoints(task.priority ?? "normal", task.difficulty ?? "medium");
}

/**
 * #13 window semantics: a task is "active" inside the selected span when it was
 * created / updated / completed after the window start, or is still unfinished.
 */
function isTaskActiveInRange(task: MemberTask, startISO: string | null): boolean {
  if (!startISO) return true;
  if (task.progressStatus !== "completed") return true;
  return (
    isWithinRange(task.createdAt, startISO) ||
    isWithinRange(task.updatedAt, startISO) ||
    isWithinRange(task.completedAt, startISO)
  );
}

function sortValue(task: MemberTask, key: TaskSortKey): string | number {
  switch (key) {
    case "member":
      return task.memberName ?? "";
    case "priority":
      return PRIORITY_RANK[task.priority] ?? 1;
    case "difficulty":
      return DIFFICULTY_RANK[task.difficulty] ?? 1;
    case "load":
      return pointsOf(task);
    case "expected":
      // Missing dates always sort after real dates in ascending order.
      return task.expectedDate || "9999-99-99";
    case "created":
      return task.createdAt || "";
    case "progress":
      return PROGRESS_RANK[task.progressStatus] ?? 0;
    case "health":
      return HEALTH_RANK[task.healthStatus] ?? 0;
    default:
      return "";
  }
}

function compareTasks(a: MemberTask, b: MemberTask, sort: SortState): number {
  const left = sortValue(a, sort.key);
  const right = sortValue(b, sort.key);
  let result = 0;
  if (typeof left === "number" && typeof right === "number") {
    result = left - right;
  } else {
    result = String(left).localeCompare(String(right), "zh-CN");
  }
  if (result === 0) {
    result = (a.createdAt || "").localeCompare(b.createdAt || "");
  }
  return sort.direction === "asc" ? result : -result;
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

function SortableTh({
  label,
  sortKey,
  sort,
  onSort,
  title,
  className,
}: {
  label: string;
  sortKey: TaskSortKey;
  sort: SortState;
  onSort: (key: TaskSortKey) => void;
  title?: string;
  className?: string;
}) {
  const active = sort.key === sortKey;
  const ariaSort: "ascending" | "descending" | "none" = active
    ? sort.direction === "asc"
      ? "ascending"
      : "descending"
    : "none";
  return (
    <th scope="col" className={cn("tasks-th-sortable", className)} aria-sort={ariaSort}>
      <button
        type="button"
        className={cn("tasks-sort-btn", active && "is-active")}
        onClick={() => onSort(sortKey)}
        title={title ?? `按${label}排序`}
        aria-label={`按${label}排序${active ? (sort.direction === "asc" ? "（当前升序）" : "（当前降序）") : ""}`}
      >
        <span>{label}</span>
        {active ? (
          sort.direction === "asc" ? (
            <ArrowUp size={11} aria-hidden="true" />
          ) : (
            <ArrowDown size={11} aria-hidden="true" />
          )
        ) : (
          <ArrowUpDown size={11} className="tasks-sort-idle" aria-hidden="true" />
        )}
      </button>
    </th>
  );
}

export default function TaskOverviewPage() {
  const { data, currentTeam, currentGroup, canManageActiveGroup, reload, scope, navigate } = useApp();
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
  const [tagLibraryOpen, setTagLibraryOpen] = useState(false);
  /** Member workload opened from the rail; null = dialog closed. */
  const [workloadDetail, setWorkloadDetail] = useState<Workload | null>(null);

  const [search, setSearch] = useState("");
  const [memberFilter, setMemberFilter] = useState<string>("all");
  const [progressFilter, setProgressFilter] = useState<ProgressFilter>("all");
  const [healthFilter, setHealthFilter] = useState<HealthFilter>("all");
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>("all");
  const [tagFilter, setTagFilter] = useState<string>("all");
  const [showCompleted, setShowCompleted] = useState(true);
  const [rangeKey, setRangeKey] = useState<InsightsRangeKey>(DEFAULT_RANGE_KEY);
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);

  const range = useMemo(
    () => TASK_RANGES.find((option) => option.key === rangeKey) ?? TASK_RANGES[2],
    [rangeKey],
  );
  const rangeStart = useMemo(() => rangeStartISO(range.days), [range.days]);

  /** groupId -> owning team/group metadata (for aggregate-scope write routing). */
  const groupIndex = useMemo(() => {
    const map = new Map<string, { teamId: string; teamName: string; groupName: string }>();
    data?.teams.forEach((team) => {
      team.groups.forEach((group) => {
        map.set(group.id, { teamId: team.id, teamName: team.name, groupName: group.name });
      });
    });
    return map;
  }, [data?.teams]);

  const resolveTeamId = useCallback(
    (taskGroupId: string) => groupIndex.get(taskGroupId)?.teamId ?? teamId,
    [groupIndex, teamId],
  );

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
        const result = await api.tasks(teamId, groupId, scope);
        setPayload(result);
      } catch (err) {
        setError(messageOf(err, "加载任务台账失败，请稍后重试。"));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [teamId, groupId, scope],
  );

  useEffect(() => {
    setPayload(null);
    void loadTasks();
  }, [loadTasks]);

  // Switching development groups or browsing scope must never keep stale filters.
  useEffect(() => {
    setSearch("");
    setMemberFilter("all");
    setProgressFilter("all");
    setHealthFilter("all");
    setPriorityFilter("all");
    setTagFilter("all");
    setShowCompleted(true);
    setRangeKey(DEFAULT_RANGE_KEY);
    setSort(DEFAULT_SORT);
    setDialog({ open: false, task: null });
    setDeleting(null);
    setBusyId(null);
    setTagLibraryOpen(false);
    setWorkloadDetail(null);
  }, [groupId, scope]);

  const tasks = payload?.tasks ?? EMPTY_TASKS;
  const workloads = payload?.workloads ?? EMPTY_WORKLOADS;
  const summary = payload?.summary ?? EMPTY_SUMMARY;
  const meta = payload?.meta ?? EMPTY_META;
  const windowLabel = meta.windowLabel || "近 4 周";
  const aggregate = scope !== "group";
  const showTeamBadge = scope === "all";

  /** #13 tasks active inside the selected time span. */
  const windowTasks = useMemo(
    () => tasks.filter((task) => isTaskActiveInRange(task, rangeStart)),
    [tasks, rangeStart],
  );

  const inProgressCount = useMemo(
    () => windowTasks.filter((task) => task.progressStatus === "in_progress").length,
    [windowTasks],
  );
  const openCount = useMemo(
    () => windowTasks.filter((task) => task.progressStatus !== "completed").length,
    [windowTasks],
  );
  const blockedCount = useMemo(
    () => windowTasks.filter((task) => task.healthStatus === "blocked").length,
    [windowTasks],
  );
  const overdueCount = useMemo(
    () =>
      windowTasks.filter((task) => task.overdue && task.progressStatus !== "completed").length,
    [windowTasks],
  );

  const kpis = useMemo(
    () => [
      {
        key: "open",
        label: "未完成任务",
        value: String(openCount),
        unit: "条",
        hint: `${range.label}内共 ${windowTasks.length} 条任务`,
        icon: ListTodo,
        tone: "neutral",
      },
      {
        key: "progress",
        label: "进行中",
        value: String(inProgressCount),
        unit: "条",
        hint: openCount
          ? `占未完成 ${formatPercent((inProgressCount / Math.max(1, openCount)) * 100)}`
          : "等待成员开始推进",
        icon: Timer,
        tone: "blue",
      },
      {
        key: "blocked",
        label: "阻塞任务",
        value: String(blockedCount),
        unit: "条",
        hint: blockedCount ? "需要协调解除依赖" : "暂无阻塞",
        icon: AlertTriangle,
        tone: "amber",
      },
      {
        key: "overdue",
        label: "逾期任务",
        value: String(overdueCount),
        unit: "条",
        hint: overdueCount ? "已超过预期完成时间" : "全部按预期推进",
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
    [
      openCount,
      inProgressCount,
      blockedCount,
      overdueCount,
      windowTasks.length,
      range.label,
      summary.averageLoadPercent,
      summary.averagePoints,
      summary.capacityPoints,
      summary.members,
      windowLabel,
    ],
  );

  /** Tag options available for filtering, derived from hydrated task tags. */
  const tagUsage = useMemo(() => {
    const map = new Map<string, { tag: TaskTag; count: number }>();
    windowTasks.forEach((task) => {
      (task.tags ?? []).forEach((tag) => {
        const current = map.get(tag.id);
        if (current) current.count += 1;
        else map.set(tag.id, { tag, count: 1 });
      });
    });
    return Array.from(map.values()).sort(
      (a, b) => b.count - a.count || a.tag.name.localeCompare(b.tag.name, "zh-CN"),
    );
  }, [windowTasks]);

  const filteredTasks = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return windowTasks.filter((task) => {
      if (!showCompleted && task.progressStatus === "completed") return false;
      if (progressFilter !== "all" && task.progressStatus !== progressFilter) return false;
      if (healthFilter !== "all" && task.healthStatus !== healthFilter) return false;
      if (priorityFilter !== "all" && task.priority !== priorityFilter) return false;
      if (memberFilter !== "all" && task.memberId !== memberFilter) return false;
      if (tagFilter !== "all" && !(task.tags ?? []).some((tag) => tag.id === tagFilter)) return false;
      if (keyword) {
        const tagText = (task.tags ?? []).map((tag) => tag.name).join(" ");
        const haystack =
          `${task.title} ${task.description} ${task.memberName} ${task.memberTitle} ${tagText} ${task.groupName ?? ""} ${task.teamName ?? ""}`.toLowerCase();
        if (!haystack.includes(keyword)) return false;
      }
      return true;
    });
  }, [
    windowTasks,
    search,
    showCompleted,
    progressFilter,
    healthFilter,
    priorityFilter,
    memberFilter,
    tagFilter,
  ]);

  const sortedTasks = useMemo(
    () => [...filteredTasks].sort((a, b) => compareTasks(a, b, sort)),
    [filteredTasks, sort],
  );

  const memberOptions = useMemo(() => {
    const map = new Map<string, { id: string; name: string }>();
    windowTasks.forEach((task) => {
      if (!map.has(task.memberId)) map.set(task.memberId, { id: task.memberId, name: task.memberName });
    });
    workloads.forEach((workload) => {
      if (!map.has(workload.memberId)) {
        map.set(workload.memberId, { id: workload.memberId, name: workload.memberName });
      }
    });
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }, [windowTasks, workloads]);

  /** Target group of the open dialog: task's own group when editing, current group when creating. */
  const dialogGroupId = dialog.task ? dialog.task.groupId : groupId;
  const dialogGroupMeta = groupIndex.get(dialog.task?.groupId ?? "");
  const dialogTeamId = dialog.task ? resolveTeamId(dialog.task.groupId) : teamId;
  const dialogGroupName = dialog.task
    ? dialog.task.groupName ?? dialogGroupMeta?.groupName
    : currentGroup?.name;

  const dialogMembers = useMemo<TaskMemberOption[]>(() => {
    const map = new Map<string, TaskMemberOption>();
    if (scope === "group") {
      workloads.forEach((workload) => {
        map.set(workload.memberId, {
          id: workload.memberId,
          name: workload.memberName,
          title: workload.memberTitle,
          avatarColor: workload.avatarColor,
        });
      });
    }
    tasks
      .filter((task) => task.groupId === dialogGroupId)
      .forEach((task) => {
        map.set(task.memberId, {
          id: task.memberId,
          name: task.memberName,
          title: task.memberTitle,
          avatarColor: task.memberAvatarColor,
        });
      });
    if (dialog.task) {
      map.set(dialog.task.memberId, {
        id: dialog.task.memberId,
        name: dialog.task.memberName,
        title: dialog.task.memberTitle,
        avatarColor: dialog.task.memberAvatarColor,
      });
    }
    return Array.from(map.values());
  }, [scope, workloads, tasks, dialogGroupId, dialog.task]);

  const defaultMemberId = selfMemberId ?? dialogMembers[0]?.id ?? null;

  /** Groups offered by the tag library manager (aggregate scope can manage every visible group). */
  const tagGroupOptions = useMemo<TagLibraryGroupOption[]>(() => {
    const list: TagLibraryGroupOption[] = [];
    const seen = new Set<string>();
    const push = (
      nextTeamId: string,
      groupIdValue: string,
      groupNameValue: string,
      label: string,
    ) => {
      if (!nextTeamId || !groupIdValue || seen.has(groupIdValue)) return;
      seen.add(groupIdValue);
      list.push({
        teamId: nextTeamId,
        groupId: groupIdValue,
        groupName: groupNameValue,
        label,
      });
    };
    payload?.scope?.groups?.forEach((group) => {
      push(
        group.teamId,
        group.id,
        group.name,
        `${group.teamShortName || group.teamName} / ${group.name}`,
      );
    });
    if (!list.length) {
      data?.teams.forEach((team) => {
        team.groups.forEach((group) => {
          push(team.id, group.id, group.name, `${team.shortName || team.name} / ${group.name}`);
        });
      });
    }
    return list;
  }, [payload?.scope, data?.teams]);

  const filtersActive =
    Boolean(search.trim()) ||
    memberFilter !== "all" ||
    progressFilter !== "all" ||
    healthFilter !== "all" ||
    priorityFilter !== "all" ||
    tagFilter !== "all" ||
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
    setTagFilter("all");
    setShowCompleted(true);
  };

  const toggleSort = (key: TaskSortKey) => {
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: "asc" },
    );
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
      // Aggregate scope: write back to the group that actually owns the task.
      await api.deleteTask(resolveTeamId(deleting.groupId), deleting.groupId, deleting.id);
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

  const rangePicker = (
    <div className="tasks-range" role="group" aria-label="任务时间跨度">
      {TASK_RANGES.map((option) => (
        <button
          key={option.key}
          type="button"
          className={cn("tasks-range-btn", rangeKey === option.key && "active")}
          onClick={() => setRangeKey(option.key)}
          aria-pressed={rangeKey === option.key}
          title={`只看${option.label}内活跃的任务`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );

  const filters = (
    <div className="tasks-filters">
      <div className="tasks-filter-row">
        <label className="tasks-search">
          <Search size={14} aria-hidden="true" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索任务标题、说明、标签或成员…"
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

        <div className="tasks-filter-select tasks-filter-select-custom">
          <UserRound size={13} aria-hidden="true" />
          <Select
            value={memberFilter}
            onChange={setMemberFilter}
            ariaLabel="按成员筛选"
            className="tasks-member-select"
            searchable
            options={[
              { value: "all", label: "全部成员" },
              ...memberOptions.map((option) => ({ value: option.id, label: option.name })),
            ]}
          />
        </div>

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

        {tagUsage.length ? (
          <div className="tasks-filter-group tasks-tag-filter-group">
            <span className="tasks-filter-label">
              <Tags size={11} /> 标签
            </span>
            <div className="tasks-tag-filters" role="group" aria-label="按标签筛选">
              <button
                type="button"
                className={cn("tasks-tag-filter", tagFilter === "all" && "active")}
                onClick={() => setTagFilter("all")}
                aria-pressed={tagFilter === "all"}
              >
                全部
              </button>
              {tagUsage.map(({ tag, count }) => (
                <button
                  key={tag.id}
                  type="button"
                  className={cn("tasks-tag-filter", tagFilter === tag.id && "active")}
                  onClick={() => setTagFilter((current) => (current === tag.id ? "all" : tag.id))}
                  aria-pressed={tagFilter === tag.id}
                  title={`按标签「${tag.name}」筛选（${count} 条任务）`}
                >
                  <i style={{ background: tag.color }} aria-hidden="true" />
                  {tag.name}
                  <small>{count}</small>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );

  const taskCountLabel = filtersActive
    ? `筛选 ${sortedTasks.length} / ${windowTasks.length} 条`
    : `共 ${windowTasks.length} 条任务`;

  const renderTaskTags = (task: MemberTask) => {
    const tags = task.tags ?? [];
    if (!tags.length) return null;
    return <TagChips tags={tags} max={3} className="tasks-task-tag-chips" />;
  };

  const listKey = [
    rangeKey,
    scope,
    memberFilter,
    progressFilter,
    healthFilter,
    priorityFilter,
    tagFilter,
    showCompleted ? "1" : "0",
    search,
    sort.key,
    sort.direction,
  ].join("|");

  const table = (
    <div className="table-wrap tasks-table-wrap" key={`table-${listKey}`}>
      <table className="data-table tasks-table">
        <thead>
          <tr>
            <SortableTh label="成员" sortKey="member" sort={sort} onSort={toggleSort} />
            <th scope="col">任务</th>
            <SortableTh label="优先级" sortKey="priority" sort={sort} onSort={toggleSort} />
            <SortableTh label="难度" sortKey="difficulty" sort={sort} onSort={toggleSort} />
            <SortableTh label="进度" sortKey="progress" sort={sort} onSort={toggleSort} />
            <SortableTh label="健康度" sortKey="health" sort={sort} onSort={toggleSort} />
            <SortableTh label="预期完成" sortKey="expected" sort={sort} onSort={toggleSort} />
            <SortableTh
              label="负载"
              sortKey="load"
              sort={sort}
              onSort={toggleSort}
              title="按负载点数排序（负载点数 = 1 分基础 + 优先级加成 + 难度加成）"
            />
            <SortableTh label="创建时间" sortKey="created" sort={sort} onSort={toggleSort} />
            <th scope="col">
              <span className="tasks-th-actions">操作</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sortedTasks.map((task, index) => {
            const progress = TASK_PROGRESS_META[task.progressStatus] ?? TASK_PROGRESS_META.pending;
            const health = TASK_HEALTH_META[task.healthStatus] ?? TASK_HEALTH_META.normal;
            const priorityKey: TaskPriority = task.priority ?? "normal";
            const difficultyKey: TaskDifficulty = task.difficulty ?? "medium";
            const priority = PRIORITY_META[priorityKey] ?? PRIORITY_META.normal;
            const difficulty = DIFFICULTY_META[difficultyKey] ?? DIFFICULTY_META.medium;
            const points = pointsOf(task);
            const manageable = canManageTask(task);
            return (
              <tr
                key={task.id}
                style={{ "--row-i": index } as CSSProperties}
                className={cn(
                  "tasks-row",
                  `health-${task.healthStatus}`,
                  task.progressStatus === "completed" && "is-completed",
                )}
              >
                <td>
                  <div className="tasks-member-cell">
                    <Avatar name={task.memberName} color={task.memberAvatarColor} size="xs" />
                    <div className="tasks-member-copy">
                      <strong>{task.memberName}</strong>
                      <small>{task.memberTitle || "开发组成员"}</small>
                      {aggregate && task.groupName ? (
                        <span
                          className="tasks-group-badge"
                          title={`${task.teamName ?? ""} ${task.groupName}`.trim()}
                        >
                          <Building2 size={9} />
                          {task.groupName}
                          {showTeamBadge && task.teamName ? ` · ${task.teamName}` : ""}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </td>
                <td>
                  <div className="tasks-task-cell">
                    <span className="tasks-task-title">{task.title}</span>
                    {task.description ? (
                      <p className="tasks-task-desc">{task.description}</p>
                    ) : null}
                    {renderTaskTags(task)}
                    {task.completedAt ? (
                      <span className="tasks-task-note">
                        完成于 {formatDateTime(task.completedAt)}
                      </span>
                    ) : null}
                  </div>
                </td>
                <td>
                  <span
                    className={cn("tasks-tag", `is-priority-${priorityKey}`)}
                    title={`优先级 ${priority.label}（+${priority.weight} 分）`}
                  >
                    <i className="tasks-tag-dot" /> {priority.label}
                  </span>
                </td>
                <td>
                  <span
                    className={cn("tasks-tag", `is-difficulty-${difficultyKey}`)}
                    title={`难度 ${difficulty.label}（+${difficulty.weight} 分）`}
                  >
                    <i className="tasks-tag-dot" /> {difficulty.label}
                  </span>
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
                  <div className="tasks-date-cell">
                    <span className="tasks-date">{formatDateTime(task.createdAt)}</span>
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
    <div className="tasks-card-list" key={`cards-${listKey}`}>
      {sortedTasks.map((task, index) => {
        const progress = TASK_PROGRESS_META[task.progressStatus] ?? TASK_PROGRESS_META.pending;
        const health = TASK_HEALTH_META[task.healthStatus] ?? TASK_HEALTH_META.normal;
        const priorityKey: TaskPriority = task.priority ?? "normal";
        const difficultyKey: TaskDifficulty = task.difficulty ?? "medium";
        const priority = PRIORITY_META[priorityKey] ?? PRIORITY_META.normal;
        const difficulty = DIFFICULTY_META[difficultyKey] ?? DIFFICULTY_META.medium;
        const points = pointsOf(task);
        const manageable = canManageTask(task);
        return (
          <article
            key={task.id}
            style={{ "--row-i": index } as CSSProperties}
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
                  {aggregate && task.groupName ? (
                    <span className="tasks-group-badge">
                      <Building2 size={9} />
                      {task.groupName}
                      {showTeamBadge && task.teamName ? ` · ${task.teamName}` : ""}
                    </span>
                  ) : null}
                </div>
              </div>
              <span className={cn("badge", progress.badge)}>{progress.label}</span>
            </header>
            <h3 className="tasks-card-title">{task.title}</h3>
            {task.description ? <p className="tasks-card-desc">{task.description}</p> : null}
            {renderTaskTags(task)}
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
            {aggregate
              ? ` 当前按「${scope === "all" ? "全部团队" : currentTeam.name}」聚合浏览。`
              : ""}
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
              {windowLabel}滚动平均 · 每人容量 {formatPoints(meta.capacityPoints)} / 周 · 点击负载卡片查看逐任务明细
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
                <WorkloadMeter
                  key={workload.memberId}
                  workload={workload}
                  windowLabel={windowLabel}
                  onOpen={() => setWorkloadDetail(workload)}
                />
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
              {summary.completedTasks ? ` · 全量已完成 ${summary.completedTasks} 条` : ""}
            </p>
          </div>
          <div className="tasks-panel-tools">
            {rangePicker}
            <span className="badge badge-gray tasks-window-badge">
              <Clock size={11} /> {range.label}
            </span>
            <button
              type="button"
              className="btn btn-secondary btn-sm tasks-tag-library-btn"
              onClick={() => setTagLibraryOpen(true)}
              title="管理当前开发组的标签库"
            >
              <Tags size={13} /> 标签库
            </button>
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
          ) : sortedTasks.length ? (
            <>
              {table}
              {mobileCards}
            </>
          ) : (
            <EmptyState
              icon={<ListTodo size={24} />}
              title={windowTasks.length ? "没有符合筛选条件的任务" : `${range.label}内还没有活跃任务`}
              description={
                windowTasks.length
                  ? "试试放宽成员、进度、健康度或标签筛选条件。"
                  : tasks.length
                    ? "切换到更长的时间跨度，或者新建一条任务。"
                    : canCreate
                      ? "为成员登记第一项任务，优先级与难度会自动换算成负载点数计入团队负载。"
                      : "当前为只读视图，暂时没有可查看的任务。"
              }
              action={
                windowTasks.length ? (
                  <button className="btn btn-secondary btn-sm" onClick={resetFilters}>
                    <RotateCcw size={14} /> 重置筛选
                  </button>
                ) : tasks.length ? (
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => setRangeKey(TASK_RANGES[TASK_RANGES.length - 1].key)}
                  >
                    <Clock size={14} /> 查看近 3 个月
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
        任务台账按所选时间跨度（{range.label}）过滤活跃任务，点击表头可切换升/降序；{" "}
        {windowLabel}平均负载按滚动窗口统计，仅供团队节奏参考。
      </p>

      <TaskDialog
        open={dialog.open}
        task={dialog.task}
        teamId={dialogTeamId}
        groupId={dialogGroupId}
        targetGroupName={dialogGroupName}
        aggregate={aggregate}
        members={dialogMembers}
        canAssignOthers={canManageActiveGroup}
        selfMemberId={selfMemberId}
        defaultMemberId={defaultMemberId}
        onClose={() => setDialog({ open: false, task: null })}
        onSaved={handleSaved}
      />

      <TagLibraryDialog
        open={tagLibraryOpen}
        onClose={() => setTagLibraryOpen(false)}
        teamId={teamId}
        groupId={groupId}
        groupName={currentGroup.name}
        groupOptions={aggregate && tagGroupOptions.length > 1 ? tagGroupOptions : []}
        onChanged={() => {
          void loadTasks(true);
        }}
      />

      <WorkloadDetailDialog
        open={Boolean(workloadDetail)}
        workload={workloadDetail}
        tasks={tasks}
        windowLabel={windowLabel}
        capacityPoints={meta.capacityPoints}
        scoring={meta.scoring}
        showGroupBadge={aggregate}
        onClose={() => setWorkloadDetail(null)}
        onFilterMember={(memberId) => setMemberFilter(memberId)}
        onOpenProfile={(memberId) => navigate("overview", { member: memberId })}
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
