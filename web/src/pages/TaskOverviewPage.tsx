import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Clock,
  Eye,
  FolderPlus,
  Gauge,
  Layers,
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
import { ConfirmDialog, Modal } from "../components/Modal";
import { TaskDialog } from "../components/TaskDialog";
import type { TaskMemberOption } from "../components/TaskDialog";
import { TagChips, TagLibraryDialog } from "../components/TagPicker";
import { WorkloadMeter } from "../components/WorkloadMeter";
import { WorkloadDetailDialog } from "../components/WorkloadDetailDialog";
import { Select } from "../components/Select";
import {
  TASK_RANGES,
  cn,
  compareNames,
  formatDate,
  formatDateTime,
  isWithinRange,
  linkedMemberIdsOf,
  rangeStartISO,
} from "../lib/utils";
import {
  DIFFICULTIES,
  DIFFICULTY_META,
  HEALTH_STATUSES,
  PRIORITIES,
  PRIORITY_META,
  PROGRESS_STATUSES,
  TASK_CAPACITY_POINTS,
  TASK_HEALTH_META,
  TASK_MAX_POINTS,
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
  TeamGroup,
  Workload,
  WorkloadSummary,
} from "../types";
import "./TaskOverviewPage.css";

type ProgressFilter = "all" | TaskProgressStatus;
type HealthFilter = "all" | TaskHealthStatus;
type PriorityFilter = "all" | TaskPriority;
/** 任务分组筛选："all" = 全部任务，"none" = 未分组，其他值 = 任务组 id。 */
type GroupFilter = string;

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

// Round 9：排序按分值 1/2/3（与 taskMeta 的乘法评分一致）。
const PRIORITY_RANK: Record<TaskPriority, number> = { low: 1, normal: 2, high: 3 };
const DIFFICULTY_RANK: Record<TaskDifficulty, number> = { easy: 1, medium: 2, hard: 3 };
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
  capacityPoints: TASK_CAPACITY_POINTS,
  windowWeeks: 4,
  windowLabel: "近 4 周",
  scoring: `负载分 = 优先级分（1-3）× 难度分（1-3），满分 ${TASK_MAX_POINTS}；每人每周容量 ${TASK_CAPACITY_POINTS} 分`,
};
const EMPTY_GROUPS: TeamGroup[] = [];

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

// Round 9：优先级 / 难度行内编辑选项（带分值，与 TaskDialog 按钮文案保持一致）。
const PRIORITY_EDIT_OPTIONS = PRIORITIES.map((value) => ({
  value,
  label: `${PRIORITY_META[value].label} · ${PRIORITY_META[value].score} 分`,
}));
const DIFFICULTY_EDIT_OPTIONS = DIFFICULTIES.map((value) => ({
  value,
  label: `${DIFFICULTY_META[value].label} · ${DIFFICULTY_META[value].score} 分`,
}));

const GROUP_COLOR_PRESETS = [
  "#5865f2",
  "#7c3aed",
  "#0ea5e9",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#ec4899",
  "#64748b",
];

/**
 * Round 9：任务组管理（仅团队管理员可见）。增删改都走 groups API，
 * 成功后由父级重新拉取台账，组列表与 taskCount 始终与后端一致。
 */
function GroupManagerDialog({
  open,
  teamId,
  groups,
  onClose,
  onChanged,
}: {
  open: boolean;
  teamId: string;
  groups: TeamGroup[];
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [color, setColor] = useState(GROUP_COLOR_PRESETS[0]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState(GROUP_COLOR_PRESETS[0]);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) return;
    setName("");
    setColor(GROUP_COLOR_PRESETS[0]);
    setEditingId(null);
    setConfirmDeleteId(null);
    setBusy(false);
  }, [open]);

  const createGroup = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast("请填写任务组名称。", "info");
      return;
    }
    setBusy(true);
    try {
      await api.createGroup(teamId, { kind: "task", name: trimmed, color });
      toast(`已创建任务组「${trimmed}」`, "success");
      setName("");
      await onChanged();
    } catch (err) {
      toast(messageOf(err, "创建任务组失败，请稍后重试。"), "error");
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async (group: TeamGroup) => {
    const trimmed = editName.trim();
    if (!trimmed) {
      toast("任务组名称不能为空。", "info");
      return;
    }
    setBusy(true);
    try {
      await api.updateGroup(teamId, group.id, { name: trimmed, color: editColor });
      toast("任务组已更新", "success");
      setEditingId(null);
      await onChanged();
    } catch (err) {
      toast(messageOf(err, "更新任务组失败，请稍后重试。"), "error");
    } finally {
      setBusy(false);
    }
  };

  const removeGroup = async (group: TeamGroup) => {
    setBusy(true);
    try {
      await api.deleteGroup(teamId, group.id);
      toast(`已删除任务组「${group.name}」，组内任务变为未分组`, "success");
      setConfirmDeleteId(null);
      await onChanged();
    } catch (err) {
      toast(messageOf(err, "删除任务组失败，请稍后重试。"), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="任务分组管理"
      size="md"
      description="任务组用于任务台账的筛选与分区显示；删除任务组后，组内任务会自动变为未分组（任务本身不会被删除）。"
      footer={
        <button className="btn btn-ghost" type="button" onClick={onClose}>
          关闭
        </button>
      }
    >
      <div className="tasks-group-manager">
        <div className="tasks-group-create">
          <label htmlFor="tasks-group-new-name">新建任务组</label>
          <div className="tasks-group-create-row">
            <input
              id="tasks-group-new-name"
              className="input"
              value={name}
              maxLength={24}
              placeholder="例如：本周冲刺、客户端体验"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void createGroup();
                }
              }}
              disabled={busy}
            />
            <input
              className="tasks-group-color"
              type="color"
              value={color}
              onChange={(event) => setColor(event.target.value)}
              aria-label="任务组颜色"
              disabled={busy}
            />
            <button
              className="btn btn-primary btn-sm"
              type="button"
              onClick={() => void createGroup()}
              disabled={busy || !name.trim()}
            >
              <FolderPlus size={13} /> 新建
            </button>
          </div>
          <div className="tasks-group-swatches" role="group" aria-label="选择任务组颜色">
            {GROUP_COLOR_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className={cn("tasks-group-swatch", color === preset && "active")}
                style={{ background: preset }}
                onClick={() => setColor(preset)}
                aria-label={`使用颜色 ${preset}`}
                aria-pressed={color === preset}
              />
            ))}
          </div>
          <span className="field-hint">同一团队内任务组名称唯一；颜色用于列表中的圆点标识。</span>
        </div>

        {groups.length ? (
          <ul className="tasks-group-list">
            {groups.map((group) => (
              <li key={group.id} className="tasks-group-row">
                {editingId === group.id ? (
                  <>
                    <span className="tasks-group-dot" style={{ background: editColor }} />
                    <input
                      className="input tasks-group-rename"
                      value={editName}
                      maxLength={24}
                      onChange={(event) => setEditName(event.target.value)}
                      aria-label={`重命名任务组 ${group.name}`}
                      disabled={busy}
                    />
                    <input
                      className="tasks-group-color"
                      type="color"
                      value={editColor}
                      onChange={(event) => setEditColor(event.target.value)}
                      aria-label="任务组颜色"
                      disabled={busy}
                    />
                    <button
                      className="btn btn-primary btn-sm"
                      type="button"
                      onClick={() => void saveEdit(group)}
                      disabled={busy || !editName.trim()}
                    >
                      保存
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      type="button"
                      onClick={() => setEditingId(null)}
                      disabled={busy}
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <>
                    <span className="tasks-group-dot" style={{ background: group.color }} />
                    <strong>{group.name}</strong>
                    <span className="tasks-group-count">{group.taskCount ?? 0} 条任务</span>
                    {confirmDeleteId === group.id ? (
                      <>
                        <span className="tasks-group-confirm">
                          确认删除？组内任务将变为未分组。
                        </span>
                        <button
                          className="btn btn-danger btn-sm"
                          type="button"
                          onClick={() => void removeGroup(group)}
                          disabled={busy}
                        >
                          确认删除
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          disabled={busy}
                        >
                          取消
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="icon-button"
                          type="button"
                          onClick={() => {
                            setEditingId(group.id);
                            setEditName(group.name);
                            setEditColor(group.color || GROUP_COLOR_PRESETS[0]);
                            setConfirmDeleteId(null);
                          }}
                          aria-label={`重命名任务组 ${group.name}`}
                          title="重命名"
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          className="icon-button danger"
                          type="button"
                          onClick={() => {
                            setConfirmDeleteId(group.id);
                            setEditingId(null);
                          }}
                          aria-label={`删除任务组 ${group.name}`}
                          title="删除"
                        >
                          <Trash2 size={13} />
                        </button>
                      </>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            compact
            icon={<FolderPlus size={22} />}
            title="还没有任务组"
            description="创建任务组后，可在任务台账中按组筛选或分区查看任务。"
          />
        )}
      </div>
    </Modal>
  );
}

export default function TaskOverviewPage() {
  const { data, currentTeam, canManageActiveTeam, reload, navigate } = useApp();
  const { toast } = useToast();
  const me = data?.me ?? null;
  const teamId = currentTeam?.id ?? "";
  /** Current team's archive id (null when this team has no archive). */
  const selfMemberId = me?.linkedMemberId ?? null;
  /** Every archive id of the signed-in account across all teams. */
  const selfMemberIds = useMemo(() => linkedMemberIdsOf(me), [me]);
  const canCreate = Boolean(me?.authenticated && (canManageActiveTeam || selfMemberId));

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
  const [groupFilter, setGroupFilter] = useState<GroupFilter>("all");
  const [groupBy, setGroupBy] = useState(false);
  const [groupManageOpen, setGroupManageOpen] = useState(false);
  const [showCompleted, setShowCompleted] = useState(true);
  const [rangeKey, setRangeKey] = useState<InsightsRangeKey>(DEFAULT_RANGE_KEY);
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);

  const range = useMemo(
    () => TASK_RANGES.find((option) => option.key === rangeKey) ?? TASK_RANGES[2],
    [rangeKey],
  );
  const rangeStart = useMemo(() => rangeStartISO(range.days), [range.days]);

  const loadTasks = useCallback(
    async (silent = false) => {
      if (!teamId) {
        setLoading(false);
        return;
      }
      if (silent) setRefreshing(true);
      else setLoading(true);
      setError("");
      try {
        const result = await api.tasks(teamId);
        setPayload(result);
      } catch (err) {
        setError(messageOf(err, "加载任务台账失败，请稍后重试。"));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [teamId],
  );

  useEffect(() => {
    setPayload(null);
    void loadTasks();
  }, [loadTasks]);

  // Switching teams must never keep stale filters.
  useEffect(() => {
    setSearch("");
    setMemberFilter("all");
    setProgressFilter("all");
    setHealthFilter("all");
    setPriorityFilter("all");
    setTagFilter("all");
    setGroupFilter("all");
    setGroupBy(false);
    setGroupManageOpen(false);
    setShowCompleted(true);
    setRangeKey(DEFAULT_RANGE_KEY);
    setSort(DEFAULT_SORT);
    setDialog({ open: false, task: null });
    setDeleting(null);
    setBusyId(null);
    setTagLibraryOpen(false);
    setWorkloadDetail(null);
  }, [teamId]);

  const tasks = payload?.tasks ?? EMPTY_TASKS;
  const workloads = payload?.workloads ?? EMPTY_WORKLOADS;
  const summary = payload?.summary ?? EMPTY_SUMMARY;
  const meta = payload?.meta ?? EMPTY_META;
  const windowLabel = meta.windowLabel || "近 4 周";
  /** Round 9: 任务组（kind="task"），按 sortOrder 再按名称排序；旧 payload 无 groups 时兜底为空。 */
  const groups = useMemo(
    () =>
      (payload?.groups ?? EMPTY_GROUPS)
        .filter((group) => group.kind === "task")
        .slice()
        .sort(
          (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || compareNames(a.name, b.name),
        ),
    [payload?.groups],
  );
  const groupFilterOptions = useMemo(
    () => [
      { value: "all", label: "全部任务组" },
      { value: "none", label: "未分组" },
      ...groups.map((group) => ({ value: group.id, label: group.name, color: group.color })),
    ],
    [groups],
  );
  const taskGroupOptions = useMemo(
    () => [
      { value: "", label: "未分组" },
      ...groups.map((group) => ({ value: group.id, label: group.name, color: group.color })),
    ],
    [groups],
  );

  // 选中的任务组被删除后，筛选条件回退为「全部」，避免台账空白。
  useEffect(() => {
    if (groupFilter === "all" || groupFilter === "none") return;
    if (!groups.some((group) => group.id === groupFilter)) setGroupFilter("all");
  }, [groups, groupFilter]);

  /**
   * Archive id -> person id (the merged workload's main archive id). Tasks always
   * carry the archive row they belong to, while filters / options / dialogs are
   * person-based because aggregate scopes merge one person's rows into one card.
   */
  const personIdByMemberId = useMemo(() => {
    const map = new Map<string, string>();
    workloads.forEach((workload) => {
      map.set(workload.memberId, workload.memberId);
      (workload.memberIds ?? []).forEach((archiveId) => {
        if (archiveId && archiveId !== workload.memberId && !map.has(archiveId)) {
          map.set(archiveId, workload.memberId);
        }
      });
    });
    return map;
  }, [workloads]);

  const personIdOf = useCallback(
    (memberId: string) => personIdByMemberId.get(memberId) ?? memberId,
    [personIdByMemberId],
  );

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
      if (groupFilter === "none") {
        if (task.groupId) return false;
      } else if (groupFilter !== "all" && task.groupId !== groupFilter) return false;
      if (memberFilter !== "all" && personIdOf(task.memberId) !== memberFilter) return false;
      if (tagFilter !== "all" && !(task.tags ?? []).some((tag) => tag.id === tagFilter)) return false;
      if (keyword) {
        const tagText = (task.tags ?? []).map((tag) => tag.name).join(" ");
        const haystack =
          `${task.title} ${task.description} ${task.memberName} ${task.memberTitle} ${tagText}`.toLowerCase();
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
    groupFilter,
    memberFilter,
    tagFilter,
    personIdOf,
  ]);

  const sortedTasks = useMemo(
    () => [...filteredTasks].sort((a, b) => compareTasks(a, b, sort)),
    [filteredTasks, sort],
  );

  /**
   * Round 9：「按组显示」的分区数据。组按 sortOrder 排序，未分组固定置底；
   * 引用了已删除组的任务同样归入未分组，避免任务在列表里凭空消失。
   */
  const groupedSections = useMemo(() => {
    const knownIds = new Set(groups.map((group) => group.id));
    const sections = groups.map((group) => ({
      key: group.id,
      label: group.name,
      color: group.color,
      tasks: sortedTasks.filter((task) => task.groupId === group.id),
    }));
    sections.push({
      key: "none",
      label: "未分组",
      color: "",
      tasks: sortedTasks.filter((task) => !task.groupId || !knownIds.has(task.groupId)),
    });
    return sections.filter((section) => section.tasks.length);
  }, [groups, sortedTasks]);

  // Person-deduplicated member filter options (one entry per human, not per archive).
  const memberOptions = useMemo(() => {
    const map = new Map<string, { id: string; name: string }>();
    const add = (memberId: string, name: string) => {
      const personId = personIdByMemberId.get(memberId) ?? memberId;
      if (!personId) return;
      if (!map.has(personId)) map.set(personId, { id: personId, name: name || personId });
    };
    workloads.forEach((workload) => add(workload.memberId, workload.memberName));
    windowTasks.forEach((task) => add(task.memberId, task.memberName));
    return Array.from(map.values()).sort((a, b) => compareNames(a.name, b.name));
  }, [windowTasks, workloads, personIdByMemberId]);

  const dialogMembers = useMemo<TaskMemberOption[]>(() => {
    const map = new Map<string, TaskMemberOption>();
    const add = (option: TaskMemberOption) => {
      if (!option.id || map.has(option.id)) return;
      map.set(option.id, option);
    };
    // Task rows are authoritative for the archive ids in this team.
    tasks.forEach((task) => {
      add({
        id: task.memberId,
        name: task.memberName,
        title: task.memberTitle,
        avatar: task.memberAvatar,
        avatarColor: task.memberAvatarColor,
      });
    });
    workloads.forEach((workload) => {
      add({
        id: workload.memberId,
        name: workload.memberName,
        title: workload.memberTitle,
        avatar: workload.avatar,
        avatarColor: workload.avatarColor,
      });
    });
    if (dialog.task) {
      add({
        id: dialog.task.memberId,
        name: dialog.task.memberName,
        title: dialog.task.memberTitle,
        avatar: dialog.task.memberAvatar,
        avatarColor: dialog.task.memberAvatarColor,
      });
    }
    if (selfMemberId && !map.has(selfMemberId)) {
      const selfWorkload = workloads.find((workload) =>
        (workload.memberIds?.length ? workload.memberIds : [workload.memberId]).includes(
          selfMemberId,
        ),
      );
      add({
        id: selfMemberId,
        name: me?.name || selfWorkload?.memberName || selfMemberId,
        title: selfWorkload?.memberTitle || "",
        avatar: selfWorkload?.avatar || me?.avatar || "",
        avatarColor: selfWorkload?.avatarColor || me?.avatarColor || "#7c3aed",
      });
    }
    return Array.from(map.values());
  }, [tasks, workloads, dialog.task, selfMemberId, me]);

  // Creating a task defaults to my current-team archive; editing keeps the task's owner.
  const defaultMemberId = useMemo(() => {
    if (selfMemberId) {
      const direct = dialogMembers.find((option) => option.id === selfMemberId);
      if (direct) return direct.id;
      const personId = personIdByMemberId.get(selfMemberId) ?? selfMemberId;
      const merged = dialogMembers.find(
        (option) => option.id === personId || personIdByMemberId.get(option.id) === personId,
      );
      if (merged) return merged.id;
    }
    return dialogMembers[0]?.id ?? null;
  }, [selfMemberId, dialogMembers, personIdByMemberId]);

  // Non-admins may only manage their own tasks: fix the dialog to the task's own
  // archive row.
  const dialogSelfMemberId =
    !canManageActiveTeam && dialog.task ? dialog.task.memberId : selfMemberId;

  const filtersActive =
    Boolean(search.trim()) ||
    memberFilter !== "all" ||
    progressFilter !== "all" ||
    healthFilter !== "all" ||
    priorityFilter !== "all" ||
    groupFilter !== "all" ||
    tagFilter !== "all" ||
    !showCompleted;

  const canManageTask = useCallback(
    (task: MemberTask) =>
      Boolean(
        me?.authenticated &&
          (canManageActiveTeam || selfMemberIds.includes(task.memberId)),
      ),
    [me?.authenticated, canManageActiveTeam, selfMemberIds],
  );

  const resetFilters = () => {
    setSearch("");
    setMemberFilter("all");
    setProgressFilter("all");
    setHealthFilter("all");
    setPriorityFilter("all");
    setGroupFilter("all");
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
          current !== "all" && current !== personIdOf(saved.memberId) ? "all" : current,
        );
      }
      void loadTasks(true);
      void reload(true);
    },
    [dialog.task, loadTasks, reload, personIdOf],
  );

  const removeTask = async () => {
    if (!deleting) return;
    setBusyId(deleting.id);
    try {
      await api.deleteTask(teamId, deleting.id);
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

  /** Round 9：行内修改优先级 / 难度 / 分组，成功后局部替换并静默刷新汇总。 */
  const patchTask = useCallback(
    async (task: MemberTask, patch: Partial<MemberTask>, successMessage: string) => {
      setBusyId(task.id);
      try {
        const result = await api.updateTask(teamId, task.id, patch);
        setPayload((current) =>
          current
            ? {
                ...current,
                tasks: current.tasks.map((item) =>
                  item.id === result.task.id ? result.task : item,
                ),
              }
            : current,
        );
        toast(successMessage, "success");
        await loadTasks(true);
      } catch (err) {
        toast(messageOf(err, "保存失败，请稍后重试。"), "error");
      } finally {
        setBusyId(null);
      }
    },
    [teamId, toast, loadTasks],
  );

  const changeTaskPriority = (task: MemberTask, priority: TaskPriority) =>
    void patchTask(
      task,
      { priority },
      `已将「${task.title}」优先级改为${PRIORITY_META[priority].label}（${PRIORITY_META[priority].score} 分）`,
    );

  const changeTaskDifficulty = (task: MemberTask, difficulty: TaskDifficulty) =>
    void patchTask(
      task,
      { difficulty },
      `已将「${task.title}」难度改为${DIFFICULTY_META[difficulty].label}（${DIFFICULTY_META[difficulty].score} 分）`,
    );

  const changeTaskGroup = (task: MemberTask, groupId: string) =>
    void patchTask(
      task,
      { groupId },
      groupId
        ? `已将「${task.title}」归入「${groups.find((group) => group.id === groupId)?.name ?? "任务组"}」`
        : `已将「${task.title}」移出任务组（未分组）`,
    );

  if (!currentTeam) {
    return (
      <EmptyState
        title="还没有可查看的团队"
        description="请先在左侧导航选择一个团队，然后再回来查看团队任务总览。"
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

        <div className="tasks-filter-group">
          <span className="tasks-filter-label">
            <Layers size={11} /> 分组
          </span>
          <div className="tasks-group-filters">
            <div className="tasks-group-filter-select">
              <Select
                value={groupFilter}
                onChange={setGroupFilter}
                ariaLabel="按任务组筛选"
                size="sm"
                options={groupFilterOptions}
              />
            </div>
            <label className="switch tasks-groupby-switch">
              <input
                type="checkbox"
                checked={groupBy}
                onChange={(event) => setGroupBy(event.target.checked)}
              />
              <span className="switch-track" />
              <span>按组显示</span>
            </label>
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
    memberFilter,
    progressFilter,
    healthFilter,
    priorityFilter,
    groupFilter,
    groupBy ? "grouped" : "flat",
    tagFilter,
    showCompleted ? "1" : "0",
    search,
    sort.key,
    sort.direction,
  ].join("|");

  const renderTable = (rows: MemberTask[], sectionKey: string) => (
    <div className="table-wrap tasks-table-wrap" key={`table-${sectionKey}-${listKey}`}>
      <table className="data-table tasks-table">
        <thead>
          <tr>
            <SortableTh label="成员" sortKey="member" sort={sort} onSort={toggleSort} />
            <th scope="col">任务</th>
            <SortableTh
              label="优先级"
              sortKey="priority"
              sort={sort}
              onSort={toggleSort}
              title="按优先级排序（低 1 分 / 普通 2 分 / 高 3 分）"
            />
            <SortableTh
              label="难度"
              sortKey="difficulty"
              sort={sort}
              onSort={toggleSort}
              title="按难度排序（简单 1 分 / 中等 2 分 / 困难 3 分）"
            />
            <SortableTh label="进度" sortKey="progress" sort={sort} onSort={toggleSort} />
            <SortableTh label="健康度" sortKey="health" sort={sort} onSort={toggleSort} />
            <th scope="col">分组</th>
            <SortableTh label="预期完成" sortKey="expected" sort={sort} onSort={toggleSort} />
            <SortableTh
              label="负载"
              sortKey="load"
              sort={sort}
              onSort={toggleSort}
              title={`按负载分排序（负载分 = 优先级分 1-3 × 难度分 1-3，满分 ${TASK_MAX_POINTS}）`}
            />
            <SortableTh label="创建时间" sortKey="created" sort={sort} onSort={toggleSort} />
            <th scope="col">
              <span className="tasks-th-actions">操作</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((task, index) => {
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
                    <Avatar name={task.memberName} src={task.memberAvatar} color={task.memberAvatarColor} size="xs" />
                    <div className="tasks-member-copy">
                      <strong>{task.memberName}</strong>
                      <small>{task.memberTitle || "团队成员"}</small>
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
                  {manageable ? (
                    <Select
                      className="tasks-inline-select"
                      size="sm"
                      value={priorityKey}
                      onChange={(value) => {
                        if (!value || value === priorityKey) return;
                        changeTaskPriority(task, value as TaskPriority);
                      }}
                      options={PRIORITY_EDIT_OPTIONS}
                      ariaLabel={`设置任务「${task.title}」的优先级`}
                      disabled={busyId === task.id}
                    />
                  ) : (
                    <span
                      className={cn("tasks-tag", `is-priority-${priorityKey}`)}
                      title={`优先级 ${priority.label}（${priority.score} 分）`}
                    >
                      <i className="tasks-tag-dot" /> {priority.label}
                    </span>
                  )}
                </td>
                <td>
                  {manageable ? (
                    <Select
                      className="tasks-inline-select"
                      size="sm"
                      value={difficultyKey}
                      onChange={(value) => {
                        if (!value || value === difficultyKey) return;
                        changeTaskDifficulty(task, value as TaskDifficulty);
                      }}
                      options={DIFFICULTY_EDIT_OPTIONS}
                      ariaLabel={`设置任务「${task.title}」的难度`}
                      disabled={busyId === task.id}
                    />
                  ) : (
                    <span
                      className={cn("tasks-tag", `is-difficulty-${difficultyKey}`)}
                      title={`难度 ${difficulty.label}（${difficulty.score} 分）`}
                    >
                      <i className="tasks-tag-dot" /> {difficulty.label}
                    </span>
                  )}
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
                  {manageable ? (
                    <Select
                      className="tasks-inline-select tasks-group-inline-select"
                      size="sm"
                      value={task.groupId ?? ""}
                      onChange={(value) => {
                        if (value === (task.groupId ?? "")) return;
                        changeTaskGroup(task, value);
                      }}
                      options={taskGroupOptions}
                      ariaLabel={`设置任务「${task.title}」的分组`}
                      disabled={busyId === task.id}
                    />
                  ) : (
                    <span className={cn("tasks-group-label", !task.groupName && "is-empty")}>
                      <i
                        className="tasks-group-dot"
                        style={{
                          background:
                            groups.find((group) => group.id === task.groupId)?.color ||
                            "var(--border)",
                        }}
                      />
                      {task.groupName || "未分组"}
                    </span>
                  )}
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
                    title={`负载分 ${points} = 优先级分 ${priority.score} × 难度分 ${difficulty.score}（满分 ${TASK_MAX_POINTS}）`}
                  >
                    <span className="tasks-points-value">{formatPoints(points)}</span>
                    <span
                      className="tasks-points-meter"
                      role="img"
                      aria-label={`负载分 ${points} / ${TASK_MAX_POINTS}`}
                    >
                      {Array.from({ length: TASK_MAX_POINTS }, (_, index) => (
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

  const renderCards = (rows: MemberTask[], sectionKey: string) => (
    <div className="tasks-card-list" key={`cards-${sectionKey}-${listKey}`}>
      {rows.map((task, index) => {
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
                <Avatar name={task.memberName} src={task.memberAvatar} color={task.memberAvatarColor} size="sm" />
                <div className="tasks-member-copy">
                  <strong>{task.memberName}</strong>
                  <small>{task.memberTitle || "团队成员"}</small>
                </div>
              </div>
              <span className={cn("badge", progress.badge)}>{progress.label}</span>
            </header>
            <h3 className="tasks-card-title">{task.title}</h3>
            {task.description ? <p className="tasks-card-desc">{task.description}</p> : null}
            {renderTaskTags(task)}
            <div className="tasks-task-tags">
              {manageable ? (
                <>
                  <Select
                    className="tasks-inline-select"
                    size="sm"
                    value={priorityKey}
                    onChange={(value) => {
                      if (!value || value === priorityKey) return;
                      changeTaskPriority(task, value as TaskPriority);
                    }}
                    options={PRIORITY_EDIT_OPTIONS}
                    ariaLabel={`设置任务「${task.title}」的优先级`}
                    disabled={busyId === task.id}
                  />
                  <Select
                    className="tasks-inline-select"
                    size="sm"
                    value={difficultyKey}
                    onChange={(value) => {
                      if (!value || value === difficultyKey) return;
                      changeTaskDifficulty(task, value as TaskDifficulty);
                    }}
                    options={DIFFICULTY_EDIT_OPTIONS}
                    ariaLabel={`设置任务「${task.title}」的难度`}
                    disabled={busyId === task.id}
                  />
                  <Select
                    className="tasks-inline-select tasks-group-inline-select"
                    size="sm"
                    value={task.groupId ?? ""}
                    onChange={(value) => {
                      if (value === (task.groupId ?? "")) return;
                      changeTaskGroup(task, value);
                    }}
                    options={taskGroupOptions}
                    ariaLabel={`设置任务「${task.title}」的分组`}
                    disabled={busyId === task.id}
                  />
                </>
              ) : (
                <>
                  <span
                    className={cn("tasks-tag", `is-priority-${priorityKey}`)}
                    title={`优先级 ${priority.label}（${priority.score} 分）`}
                  >
                    <i className="tasks-tag-dot" /> 优先级 {priority.label}
                  </span>
                  <span
                    className={cn("tasks-tag", `is-difficulty-${difficultyKey}`)}
                    title={`难度 ${difficulty.label}（${difficulty.score} 分）`}
                  >
                    <i className="tasks-tag-dot" /> 难度 {difficulty.label}
                  </span>
                  <span className={cn("tasks-group-label", !task.groupName && "is-empty")}>
                    <i
                      className="tasks-group-dot"
                      style={{
                        background:
                          groups.find((group) => group.id === task.groupId)?.color ||
                          "var(--border)",
                      }}
                    />
                    {task.groupName || "未分组"}
                  </span>
                </>
              )}
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
                title={`负载分 ${points} = 优先级分 ${priority.score} × 难度分 ${difficulty.score}（满分 ${TASK_MAX_POINTS}）`}
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
            成员自主维护任务进度、健康状态与预期完成时间；负载分 = 优先级分（1-3）× 难度分（1-3），
            满分 {TASK_MAX_POINTS} 分，每人每周容量 {TASK_CAPACITY_POINTS} 分，帮助团队在过载前及时调整节奏。
            管理员可新建任务组，按组筛选或分区查看任务。
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
              description="当前团队还没有成员，添加成员后即可查看每个人的任务负载。"
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
            {canManageActiveTeam ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm tasks-group-manage-btn"
                onClick={() => setGroupManageOpen(true)}
                title="新建、重命名或删除任务组"
              >
                <FolderPlus size={13} /> 分组管理
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-secondary btn-sm tasks-tag-library-btn"
              onClick={() => setTagLibraryOpen(true)}
              title="管理当前团队的标签库"
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
            groupBy ? (
              <div className="tasks-group-sections">
                {groupedSections.map((section) => (
                  <section
                    className="tasks-group-section"
                    key={`section-${section.key}`}
                    aria-label={`任务组 ${section.label}`}
                  >
                    <header className="tasks-group-section-head">
                      <span
                        className="tasks-group-dot"
                        style={{ background: section.color || "var(--border)" }}
                      />
                      <h3>{section.label}</h3>
                      <span className="badge badge-gray">{section.tasks.length} 条</span>
                    </header>
                    {renderTable(section.tasks, section.key)}
                    {renderCards(section.tasks, section.key)}
                  </section>
                ))}
              </div>
            ) : (
              <>
                {renderTable(sortedTasks, "all")}
                {renderCards(sortedTasks, "all")}
              </>
            )
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
                      ? "为成员登记第一项任务，优先级分与难度分会自动换算成负载分计入团队负载。"
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
          : `负载分 = 优先级分（1-3）× 难度分（1-3），满分 ${TASK_MAX_POINTS} 分；每人每周容量 ${TASK_CAPACITY_POINTS} 分；`}
        任务台账按所选时间跨度（{range.label}）过滤活跃任务，点击表头可切换升/降序；{" "}
        {windowLabel}平均负载按滚动窗口统计，仅供团队节奏参考。
      </p>

      <TaskDialog
        open={dialog.open}
        task={dialog.task}
        teamId={teamId}
        members={dialogMembers}
        canAssignOthers={canManageActiveTeam}
        selfMemberId={dialogSelfMemberId}
        defaultMemberId={defaultMemberId}
        groups={groups}
        onClose={() => setDialog({ open: false, task: null })}
        onSaved={handleSaved}
      />

      <TagLibraryDialog
        open={tagLibraryOpen}
        onClose={() => setTagLibraryOpen(false)}
        teamId={teamId}
        teamName={currentTeam.name}
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
        onClose={() => setWorkloadDetail(null)}
        onFilterMember={(memberId) => setMemberFilter(memberId)}
        onOpenProfile={(memberId) => navigate("overview", { member: memberId })}
      />

      <GroupManagerDialog
        open={groupManageOpen}
        teamId={teamId}
        groups={groups}
        onClose={() => setGroupManageOpen(false)}
        onChanged={() => loadTasks(true)}
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
