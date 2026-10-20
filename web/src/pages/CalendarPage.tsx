import { useCallback, useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent } from "react";
import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Circle,
  Clock,
  Eye,
  ListTodo,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  UserRound,
  WifiOff,
} from "lucide-react";
import { api, ApiError } from "../api";
import { useApp } from "../store";
import { useToast } from "../components/Toast";
import { Avatar } from "../components/Avatar";
import { EmptyState, LoadingBlock } from "../components/Feedback";
import { ConfirmDialog } from "../components/Modal";
import { TodoDialog } from "../components/TodoDialog";
import {
  buildCalendar,
  cn,
  daysUntil,
  dueLabel,
  formatFullDate,
  groupBy,
  hashRoute,
  monthKey,
  monthLabel,
  PRIORITY_META,
  shiftMonth,
  todayISO,
} from "../lib/utils";
import type { CalendarCell } from "../lib/utils";
import type { Member, Todo, TodoPriority } from "../types";
import "./CalendarPage.css";

const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];
const PRIORITY_ORDER: Record<TodoPriority, number> = { urgent: 3, high: 2, normal: 1, low: 0 };

function messageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function priorityBadgeClass(priority: TodoPriority): string {
  if (priority === "urgent") return "badge-red";
  if (priority === "high") return "badge-orange";
  if (priority === "low") return "badge-gray";
  return "badge-violet";
}

export default function CalendarPage() {
  const { data, config, currentTeam, currentGroup, canManageActiveGroup, navigate, scope, scopeLabel } = useApp();
  const { toast } = useToast();
  const me = data?.me ?? null;
  const teamId = currentTeam?.id ?? "";
  const groupId = currentGroup?.id ?? "";
  const aggregate = scope !== "group";

  // Group metadata lookup: aggregate payloads carry `groupId`; resolve its
  // team/name/color to render badges and route item-level writes correctly.
  const groupIndex = useMemo(() => {
    const map = new Map<string, { teamId: string; name: string; color: string }>();
    data?.teams.forEach((team) =>
      team.groups.forEach((group) =>
        map.set(group.id, { teamId: team.id, name: group.name, color: group.color }),
      ),
    );
    return map;
  }, [data?.teams]);

  const targetOf = useCallback(
    (todo: Todo) => {
      const meta = todo.groupId ? groupIndex.get(todo.groupId) : undefined;
      return {
        teamId: meta?.teamId || teamId,
        groupId: todo.groupId || groupId,
        groupName: meta?.name || currentGroup?.name || "",
        groupColor: meta?.color || "#8b8c88",
      };
    },
    [groupIndex, teamId, groupId, currentGroup?.name],
  );

  const weekStartsOn: 0 | 1 = config?.calendar.weekStartsOn ?? 1;
  const showWeekends = config?.calendar.showWeekends !== false;
  const allowPastDue = config?.calendar.allowPastDue !== false;

  const [month, setMonth] = useState(() => monthKey(new Date()));
  const [todos, setTodos] = useState<Todo[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [selectedDate, setSelectedDate] = useState(todayISO());
  const [dialog, setDialog] = useState<{ open: boolean; todo: Todo | null }>({ open: false, todo: null });
  const [deleting, setDeleting] = useState<Todo | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadTodos = useCallback(
    async (silent = false) => {
      if (!teamId || !groupId) return;
      if (silent) setRefreshing(true);
      else setLoading(true);
      setError("");
      try {
        const result = await api.todos(teamId, groupId, month, scope);
        setTodos(result.todos);
      } catch (err) {
        setError(messageOf(err, "加载协作日历失败，请稍后重试。"));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [teamId, groupId, month, scope],
  );

  useEffect(() => {
    setTodos([]);
    void loadTodos();
  }, [loadTodos]);

  useEffect(() => {
    if (!teamId || !groupId) return;
    let cancelled = false;
    api
      .overview(teamId, groupId, scope)
      .then((result) => {
        if (!cancelled) setMembers(result.members);
      })
      .catch(() => {
        if (!cancelled) setMembers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, groupId, scope]);

  // `#/calendar?new=1` (topbar quick-create) opens the create dialog once.
  useEffect(() => {
    const openFromHash = () => {
      const { page, params } = hashRoute();
      if (page !== "calendar") return;
      if (params.get("new") !== "1") return;
      setSelectedDate(todayISO());
      setDialog({ open: true, todo: null });
      const base = `${window.location.pathname}${window.location.search}`;
      window.history.replaceState({}, "", `${base}#/calendar`);
    };
    openFromHash();
    window.addEventListener("hashchange", openFromHash);
    return () => window.removeEventListener("hashchange", openFromHash);
  }, []);

  const myMember = useMemo(
    () => members.find((member) => member.id === me?.linkedMemberId) ?? null,
    [members, me?.linkedMemberId],
  );
  const guestCreate = Boolean(!me?.authenticated && config?.features.allowGuestTodoCreate);
  const canCreate = Boolean(canManageActiveGroup || myMember || guestCreate);
  const defaultAssigneeId = myMember?.id ?? null;

  const canEditTodo = useCallback(
    (todo: Todo) => {
      if (!me) return false;
      if (canManageActiveGroup) return true;
      if (todo.createdBy && todo.createdBy === me.id) return true;
      return Boolean(
        me.permissions.canEditSelf &&
          me.linkedMemberId &&
          todo.assigneeMemberId === me.linkedMemberId,
      );
    },
    [me, canManageActiveGroup],
  );

  const memberById = useMemo(() => new Map(members.map((member) => [member.id, member])), [members]);

  // In aggregate scope, a new todo lands in the current group: only offer the
  // members of the group the dialog is actually writing to.
  const dialogMembers = useMemo(() => {
    if (!aggregate) return members;
    const targetGroupId = dialog.todo ? targetOf(dialog.todo).groupId : currentGroup?.id;
    const scoped = members.filter(
      (member) => (member.groupId ?? currentGroup?.id ?? "") === (targetGroupId ?? ""),
    );
    return scoped.length ? scoped : members;
  }, [aggregate, members, dialog.todo, targetOf, currentGroup?.id]);

  const [yearText, monthText] = month.split("-");
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;

  const cells = useMemo(() => buildCalendar(year, monthIndex, weekStartsOn), [year, monthIndex, weekStartsOn]);
  const visibleCells = useMemo(
    () => (showWeekends ? cells : cells.filter((cell) => !cell.isWeekend)),
    [cells, showWeekends],
  );

  const weekdayDays = useMemo(() => {
    const all = Array.from({ length: 7 }, (_, index) => (index + weekStartsOn) % 7);
    return showWeekends ? all : all.filter((day) => day !== 0 && day !== 6);
  }, [weekStartsOn, showWeekends]);

  const todosByDate = useMemo(() => groupBy(todos, (todo) => todo.dueDate), [todos]);

  const selectedTodos = useMemo(() => {
    const list = todosByDate[selectedDate] ?? [];
    return [...list].sort((a, b) => {
      const timeCompare = (a.dueTime || "99:99").localeCompare(b.dueTime || "99:99");
      if (timeCompare !== 0) return timeCompare;
      return PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority];
    });
  }, [todosByDate, selectedDate]);

  const summary = useMemo(() => {
    const total = todos.length;
    const done = todos.filter((todo) => todo.status === "done").length;
    const overdue = todos.filter((todo) => todo.status !== "done" && todo.dueDate < todayISO()).length;
    const thisWeek = todos.filter((todo) => {
      const days = daysUntil(todo.dueDate);
      return todo.status !== "done" && days >= 0 && days <= 7;
    }).length;
    return { total, done, open: total - done, overdue, thisWeek };
  }, [todos]);

  const moveMonth = (amount: number) => {
    const next = shiftMonth(month, amount);
    const today = todayISO();
    setMonth(next);
    setSelectedDate(today.startsWith(next) ? today : `${next}-01`);
  };

  const goToday = () => {
    const today = todayISO();
    setMonth(monthKey(new Date()));
    setSelectedDate(today);
  };

  const openCreate = (date: string) => {
    if (!canCreate) {
      toast("当前身份为只读，无法创建待办。", "info");
      return;
    }
    setSelectedDate(date);
    setDialog({ open: true, todo: null });
  };

  const openTodo = (todo: Todo) => {
    setSelectedDate(todo.dueDate);
    if (canEditTodo(todo)) setDialog({ open: true, todo });
  };

  const toggleTodo = async (todo: Todo) => {
    if (!canEditTodo(todo)) return;
    const target = targetOf(todo);
    setBusyId(todo.id);
    try {
      const result = await api.updateTodo(target.teamId, target.groupId, todo.id, {
        status: todo.status === "done" ? "todo" : "done",
      });
      setTodos((current) => current.map((item) => (item.id === todo.id ? result.todo : item)));
      toast(result.todo.status === "done" ? "已标记为完成" : "已恢复为待办", "success");
    } catch (err) {
      toast(messageOf(err, "更新待办状态失败，请稍后重试。"), "error");
    } finally {
      setBusyId(null);
    }
  };

  const removeTodo = async () => {
    if (!deleting) return;
    const target = targetOf(deleting);
    setBusyId(deleting.id);
    try {
      await api.deleteTodo(target.teamId, target.groupId, deleting.id);
      setTodos((current) => current.filter((item) => item.id !== deleting.id));
      setDeleting(null);
      toast("待办已删除", "success");
    } catch (err) {
      toast(messageOf(err, "删除待办失败，请稍后重试。"), "error");
    } finally {
      setBusyId(null);
    }
  };

  const handleSaved = useCallback(
    async (saved: Todo) => {
      setSelectedDate(saved.dueDate);
      if (saved.dueDate.slice(0, 7) !== month) {
        setMonth(saved.dueDate.slice(0, 7));
        return;
      }
      await loadTodos(true);
    },
    [month, loadTodos],
  );

  if (!currentTeam || !currentGroup) {
    return (
      <EmptyState
        title="还没有可查看的开发组"
        description="请先在左侧导航选择一个团队与开发组，然后再回来查看协作日历。"
      />
    );
  }

  const stats = [
    { label: "本月待办", value: summary.total, hint: `已完成 ${summary.done}`, color: "#7c3aed" },
    { label: "待完成", value: summary.open, hint: "需要跟进", color: "#2563eb" },
    { label: "已逾期", value: summary.overdue, hint: "尽早处理", color: "#dc2626" },
    { label: "7 天内到期", value: summary.thisWeek, hint: "按优先级推进", color: "#0ea5e9" },
  ];

  return (
    <div className="cal-page">
      {error ? (
        <div className="inline-error" role="alert">
          <WifiOff size={16} />
          <span>{error}</span>
          <button className="text-button" onClick={() => void loadTodos()} disabled={refreshing}>
            重新加载
          </button>
        </div>
      ) : null}

      <header className="page-header">
        <div className="page-heading">
          <span className="eyebrow">
            <CalendarDays size={12} /> COLLABORATION CALENDAR
          </span>
          <h1 className="page-title">协作日历</h1>
          <p className="page-subtitle">
            把计划、到期与优先级放进同一张时间表，让团队的节奏清晰可见。
          </p>
        </div>
        <div className="page-actions">
          {!canCreate ? (
            <span className="badge badge-gray cal-readonly">
              <Eye size={12} /> 只读视图
            </span>
          ) : null}
          <button className="btn btn-secondary btn-sm" onClick={goToday}>
            回到今天
          </button>
          {canCreate ? (
            <button className="btn btn-primary btn-sm" onClick={() => openCreate(todayISO())}>
              <Plus size={15} /> 新建待办
            </button>
          ) : null}
        </div>
      </header>

      <div className="cal-stats">
        {stats.map((item) => (
          <div className="stat-card" key={item.label} style={{ "--stat-color": item.color } as CSSProperties}>
            <small>{item.label}</small>
            <div className="stat-value">
              <strong>{item.value}</strong>
              <span>条</span>
            </div>
            <span className="cal-stat-hint">{item.hint}</span>
          </div>
        ))}
      </div>

      <div className="cal-layout">
        <section className="panel cal-month" aria-labelledby="cal-month-title">
          <header className="cal-month-head">
            <div className="cal-month-nav">
              <button className="icon-button" type="button" onClick={() => moveMonth(-1)} aria-label="上一个月">
                <ChevronLeft size={18} />
              </button>
              <div className="cal-month-label">
                <span className="eyebrow">MONTH VIEW</span>
                <h2 id="cal-month-title">{monthLabel(month)}</h2>
              </div>
              <button className="icon-button" type="button" onClick={() => moveMonth(1)} aria-label="下一个月">
                <ChevronRight size={18} />
              </button>
            </div>
            <div className="cal-month-meta">
              <span className="cal-month-count">
                <ListTodo size={13} /> {summary.open} 条待完成
              </span>
              <button
                className="icon-button"
                type="button"
                onClick={() => void loadTodos(true)}
                disabled={refreshing}
                aria-label="刷新当前月份"
                title="刷新"
              >
                <RefreshCw size={16} className={refreshing ? "spin" : undefined} />
              </button>
            </div>
          </header>

          <div
            className="cal-weekdays"
            style={{ gridTemplateColumns: `repeat(${weekdayDays.length}, minmax(0, 1fr))` }}
            role="row"
          >
            {weekdayDays.map((day) => (
              <span
                key={day}
                className={cn("cal-weekday", (day === 0 || day === 6) && "is-weekend")}
                role="columnheader"
              >
                周{WEEKDAY_LABELS[day]}
              </span>
            ))}
          </div>

          {loading ? (
            <div className="cal-loading">
              <LoadingBlock label="加载本月待办…" rows={5} />
            </div>
          ) : (
            <div
              key={month}
              className={cn("cal-grid", !showWeekends && "is-compact")}
              style={{ gridTemplateColumns: `repeat(${weekdayDays.length}, minmax(0, 1fr))` }}
              role="grid"
              aria-label={`${monthLabel(month)}待办日历`}
            >
              {visibleCells.map((cell) => (
                <CalendarDayCell
                  key={cell.iso}
                  cell={cell}
                  todos={todosByDate[cell.iso] ?? []}
                  selected={cell.iso === selectedDate}
                  onSelect={setSelectedDate}
                  onOpenTodo={openTodo}
                  groupOf={
                    aggregate
                      ? (todo) => {
                          const target = targetOf(todo);
                          return { name: target.groupName, color: target.groupColor };
                        }
                      : undefined
                  }
                />
              ))}
            </div>
          )}

          <footer className="cal-legend">
            <span className="cal-legend-title">优先级</span>
            {(["urgent", "high", "normal", "low"] as TodoPriority[]).map((priority) => (
              <span key={priority} className={cn("cal-legend-item", `priority-${priority}`)}>
                <i /> {PRIORITY_META[priority].label}
              </span>
            ))}
            <span className="cal-legend-note">
              {showWeekends ? "按到期时间排序，逾期任务优先提示" : "已按配置隐藏周末"}
            </span>
          </footer>
        </section>

        <aside className="cal-side panel" aria-labelledby="cal-side-title" key={selectedDate}>
          <header className="cal-side-head">
            <div>
              <span className="eyebrow">DAY PLAN</span>
              <h2 id="cal-side-title">{formatFullDate(selectedDate)}</h2>
              <p>
                {selectedTodos.length
                  ? `${selectedTodos.length} 条安排 · 点击左侧圆点可切换完成`
                  : "这一天暂时空闲"}
                {aggregate ? ` · 聚合视角：${scopeLabel}` : ""}
              </p>
            </div>
            {canCreate ? (
              <button className="btn btn-primary btn-sm" onClick={() => openCreate(selectedDate)}>
                <Plus size={14} /> 添加
              </button>
            ) : null}
          </header>

          <div className="cal-side-body">
            {loading ? (
              <LoadingBlock label="加载当日安排…" rows={3} />
            ) : selectedTodos.length ? (
              <ul className="cal-todo-list">
                {selectedTodos.map((todo) => (
                  <TodoRow
                    key={todo.id}
                    todo={todo}
                    canEdit={canEditTodo(todo)}
                    busy={busyId === todo.id}
                    member={todo.assigneeMemberId ? memberById.get(todo.assigneeMemberId) : undefined}
                    group={
                      aggregate
                        ? { name: targetOf(todo).groupName, color: targetOf(todo).groupColor }
                        : null
                    }
                    onToggle={(item) => void toggleTodo(item)}
                    onEdit={openTodo}
                    onDelete={setDeleting}
                  />
                ))}
              </ul>
            ) : (
              <EmptyState
                compact
                icon={<CalendarDays size={22} />}
                title="这天还没有安排"
                description={
                  canCreate
                    ? "把想推进的事情放进日历，明确到期时间、优先级与负责人。"
                    : "访客模式为只读视图，暂无待办安排。"
                }
                action={
                  canCreate ? (
                    <button className="btn btn-secondary btn-sm" onClick={() => openCreate(selectedDate)}>
                      <Plus size={14} /> 添加待办
                    </button>
                  ) : null
                }
              />
            )}
          </div>

          <footer className="cal-side-foot">
            <span className="cal-side-hint">
              <Clock size={12} /> 按到期时间排序，同刻按优先级
            </span>
            {!canCreate ? (
              <span className="cal-side-readonly">
                <Eye size={12} /> 只读
              </span>
            ) : null}
          </footer>
        </aside>
      </div>

      <TodoDialog
        open={dialog.open}
        todo={dialog.todo}
        teamId={dialog.todo ? targetOf(dialog.todo).teamId : teamId}
        groupId={dialog.todo ? targetOf(dialog.todo).groupId : groupId}
        createGroupName={aggregate ? currentGroup?.name : undefined}
        members={dialogMembers}
        defaultDate={selectedDate}
        defaultAssigneeId={defaultAssigneeId}
        canAssignOthers={canManageActiveGroup}
        allowPastDue={allowPastDue}
        onClose={() => setDialog({ open: false, todo: null })}
        onSaved={(saved) => {
          void handleSaved(saved);
        }}
      />

      <ConfirmDialog
        open={Boolean(deleting)}
        title="删除待办"
        message={`确定删除「${deleting?.title ?? ""}」吗？删除后无法恢复。`}
        confirmLabel="删除待办"
        loading={Boolean(deleting && busyId === deleting.id)}
        onClose={() => setDeleting(null)}
        onConfirm={() => void removeTodo()}
      />

      <p className="cal-page-note">
        <ListTodo size={12} /> 待办按截止日期归档展示，逾期与高优先级会优先提示。
        <button className="text-button" onClick={() => navigate("announcements")}>
          查看团队公告
        </button>
      </p>
    </div>
  );
}

function GroupBadge({ name, color }: { name: string; color: string }) {
  return (
    <span className="badge badge-gray cal-group-badge" title={`所属开发组：${name}`}>
      <i className="dot" style={{ background: color }} />
      {name}
    </span>
  );
}

interface CalendarDayCellProps {
  cell: CalendarCell;
  todos: Todo[];
  selected: boolean;
  onSelect: (iso: string) => void;
  onOpenTodo: (todo: Todo) => void;
  groupOf?: (todo: Todo) => { name: string; color: string } | null;
}

function CalendarDayCell({ cell, todos, selected, onSelect, onOpenTodo, groupOf }: CalendarDayCellProps) {
  const visibleTodos = todos.slice(0, 3);
  const doneCount = todos.filter((todo) => todo.status === "done").length;
  const handleKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(cell.iso);
    }
  };

  return (
    <div
      className={cn(
        "cal-cell",
        !cell.inMonth && "is-outside",
        cell.isToday && "is-today",
        cell.isWeekend && "is-weekend",
        selected && "is-selected",
      )}
      role="gridcell"
      aria-selected={selected}
      aria-label={`${formatFullDate(cell.iso)}，${todos.length} 条待办${doneCount ? `，已完成 ${doneCount} 条` : ""}`}
      tabIndex={cell.inMonth ? 0 : -1}
      onClick={() => onSelect(cell.iso)}
      onKeyDown={handleKey}
    >
      <div className="cal-cell-top">
        <span className="cal-day-number">{cell.day}</span>
        {todos.length ? (
          <span className="cal-day-count" title={`${doneCount} 已完成 / ${todos.length} 条`}>
            {todos.length}
          </span>
        ) : null}
      </div>
      <div className="cal-cell-body">
        {visibleTodos.map((todo) => (
          <button
            key={todo.id}
            type="button"
            className={cn("cal-chip", `priority-${todo.priority}`, todo.status === "done" && "is-done")}
            onClick={(event) => {
              event.stopPropagation();
              onOpenTodo(todo);
            }}
            title={`${todo.title}${todo.assigneeName ? ` · ${todo.assigneeName}` : ""}`}
            aria-label={`${todo.title}，${PRIORITY_META[todo.priority].label}优先级${
              todo.status === "done" ? "，已完成" : ""
            }`}
          >
            <i className="cal-chip-dot" />
            <span className="cal-chip-title">{todo.title}</span>
            {groupOf
              ? (() => {
                  const group = groupOf(todo);
                  return group ? (
                    <span className="cal-chip-group" title={`所属开发组：${group.name}`}>
                      {group.name}
                    </span>
                  ) : null;
                })()
              : null}
            {todo.assigneeName ? <span className="cal-chip-assignee">{todo.assigneeName}</span> : null}
          </button>
        ))}
        {todos.length > visibleTodos.length ? (
          <span className="cal-more">+{todos.length - visibleTodos.length} 条</span>
        ) : null}
      </div>
    </div>
  );
}

interface TodoRowProps {
  todo: Todo;
  canEdit: boolean;
  busy: boolean;
  member?: Member;
  group?: { name: string; color: string } | null;
  onToggle: (todo: Todo) => void;
  onEdit: (todo: Todo) => void;
  onDelete: (todo: Todo) => void;
}

function TodoRow({ todo, canEdit, busy, member, group, onToggle, onEdit, onDelete }: TodoRowProps) {
  const priority = PRIORITY_META[todo.priority] ?? PRIORITY_META.normal;
  const due = dueLabel(todo);
  const done = todo.status === "done";
  return (
    <li className={cn("cal-todo", `priority-${todo.priority}`, done && "is-done")}>
      <button
        type="button"
        className="cal-check"
        onClick={() => onToggle(todo)}
        disabled={!canEdit || busy}
        aria-pressed={done}
        aria-label={done ? `将「${todo.title}」恢复为待办` : `将「${todo.title}」标记为完成`}
      >
        {busy ? (
          <Loader2 size={15} className="spin" />
        ) : done ? (
          <Check size={14} strokeWidth={2.6} />
        ) : (
          <Circle size={14} strokeWidth={1.8} />
        )}
      </button>
      <div className="cal-todo-main">
        <div className="cal-todo-title-row">
          <span className="cal-todo-title">{todo.title}</span>
          <span className={cn("badge", priorityBadgeClass(todo.priority))}>{priority.label}</span>
        </div>
        <div className="cal-todo-meta">
          {group && group.name ? <GroupBadge name={group.name} color={group.color} /> : null}
          {member ? (
            <span className="cal-todo-assignee">
              <Avatar name={member.name} color={member.avatarColor} size="xs" />
              {member.name}
            </span>
          ) : (
            <span className="cal-todo-assignee is-muted">
              <UserRound size={11} /> 未指派
            </span>
          )}
          <span>
            <Clock size={11} /> {todo.dueTime || "18:00"}
          </span>
          <span className={cn("cal-todo-due", `tone-${due.tone}`)}>{due.label}</span>
        </div>
        {todo.description ? <p className="cal-todo-desc">{todo.description}</p> : null}
      </div>
      {canEdit ? (
        <div className="cal-todo-actions">
          <button
            className="icon-button"
            type="button"
            onClick={() => onEdit(todo)}
            aria-label={`编辑待办 ${todo.title}`}
          >
            <Pencil size={13} />
          </button>
          <button
            className="icon-button danger"
            type="button"
            onClick={() => onDelete(todo)}
            aria-label={`删除待办 ${todo.title}`}
          >
            <Trash2 size={13} />
          </button>
        </div>
      ) : null}
    </li>
  );
}
