/**
 * Data insights board (#12).
 *
 * Renders `InsightsData` from `GET .../insights`:
 *  - KPI cards (members / tasks / completion / overdue / blocked / load / todos)
 *  - range picker (1w, 2w, 1m, 3m, all)
 *  - pure CSS trend chart for created / completed / todos buckets
 *  - three sortable tables (members, development groups, teams)
 *
 * Everything reads the active browsing scope from the app store, so the board
 * follows the sidebar scope switcher and displays the scope badge returned by
 * the API (falling back to `scopeLabel` while the payload loads).
 */
import { useCallback, useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CalendarRange,
  ChartNoAxesColumn,
  CheckCircle2,
  Clock,
  Gauge,
  Globe2,
  ListChecks,
  ListTodo,
  RefreshCw,
  TrendingUp,
  Users,
  WifiOff,
} from "lucide-react";
import { api, ApiError } from "../api";
import { useApp } from "../store";
import { EmptyState, LoadingBlock } from "../components/Feedback";
import { cn } from "../lib/utils";
import { INSIGHTS_RANGES } from "../lib/scope";
import { formatPercent, formatPoints } from "../lib/taskMeta";
import type {
  InsightsData,
  InsightsGroupRow,
  InsightsMemberRow,
  InsightsRangeKey,
  InsightsSummary,
  InsightsTeamRow,
  ScopeMeta,
} from "../types";
import "./InsightsPage.css";

type SortDirection = "asc" | "desc";

interface SortState {
  key: string;
  direction: SortDirection;
}

const DEFAULT_RANGE_KEY: InsightsRangeKey = "1m";

const EMPTY_SUMMARY: InsightsSummary = {
  teams: 0,
  groups: 0,
  members: 0,
  tasks: 0,
  openTasks: 0,
  completedTasks: 0,
  overdueTasks: 0,
  blockedTasks: 0,
  completionRate: 0,
  todos: 0,
  completedTodos: 0,
  todoCompletionRate: 0,
  loadPoints: 0,
  capacityPoints: 0,
  averageLoadPercent: 0,
};

function messageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function rateTone(rate: number): "good" | "ok" | "warn" {
  if (rate >= 80) return "good";
  if (rate >= 50) return "ok";
  return "warn";
}

interface Column<T> {
  key: string;
  label: string;
  value: (row: T) => string | number;
  render?: (row: T) => ReactNode;
  numeric?: boolean;
  title?: string;
}

function compareRow<T>(a: T, b: T, column: Column<T>, direction: SortDirection): number {
  const left = column.value(a);
  const right = column.value(b);
  const result =
    typeof left === "number" && typeof right === "number"
      ? left - right
      : String(left).localeCompare(String(right), "zh-CN");
  return direction === "asc" ? result : -result;
}

function SortableTable<T>({
  rows,
  columns,
  sort,
  onSort,
  rowKey,
  emptyTitle,
  emptyDescription,
}: {
  rows: T[];
  columns: Column<T>[];
  sort: SortState;
  onSort: (key: string) => void;
  rowKey: (row: T) => string;
  emptyTitle: string;
  emptyDescription: string;
}) {
  if (!rows.length) {
    return (
      <EmptyState
        compact
        icon={<ChartNoAxesColumn size={20} />}
        title={emptyTitle}
        description={emptyDescription}
      />
    );
  }
  const activeColumn = columns.find((column) => column.key === sort.key) ?? columns[0];
  const sorted = [...rows].sort((a, b) => compareRow(a, b, activeColumn, sort.direction));

  return (
    <div className="table-wrap ins-table-wrap">
      <table className="data-table ins-table">
        <thead>
          <tr>
            {columns.map((column) => {
              const active = sort.key === column.key;
              const ariaSort: "ascending" | "descending" | "none" = active
                ? sort.direction === "asc"
                  ? "ascending"
                  : "descending"
                : "none";
              return (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={ariaSort}
                  className={cn(column.numeric && "is-numeric", active && "is-active")}
                >
                  <button
                    type="button"
                    className={cn("ins-sort-btn", active && "is-active")}
                    onClick={() => onSort(column.key)}
                    title={column.title ?? `按${column.label}排序`}
                    aria-label={`按${column.label}排序`}
                  >
                    <span>{column.label}</span>
                    {active ? (
                      sort.direction === "asc" ? (
                        <ArrowUp size={10} aria-hidden="true" />
                      ) : (
                        <ArrowDown size={10} aria-hidden="true" />
                      )
                    ) : (
                      <ArrowUpDown size={10} className="ins-sort-idle" aria-hidden="true" />
                    )}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) => (
                <td key={column.key} className={cn(column.numeric && "is-numeric")}>
                  {column.render ? column.render(row) : column.value(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RateCell({ rate }: { rate: number }) {
  const safe = Math.max(0, Math.min(100, Math.round(rate || 0)));
  return (
    <div className={cn("ins-rate", `is-${rateTone(safe)}`)}>
      <span className="ins-rate-track" aria-hidden="true">
        <i style={{ width: `${safe}%` }} />
      </span>
      <strong>{formatPercent(safe)}</strong>
    </div>
  );
}

function CountCell({ value, tone }: { value: number; tone?: "danger" | "warn" | "muted" }) {
  return <span className={cn("ins-count", tone && `is-${tone}`)}>{value}</span>;
}

function MemberCell({ row }: { row: InsightsMemberRow }) {
  return (
    <div className="ins-person">
      <span className="ins-avatar" style={{ background: row.avatarColor || "var(--accent)" }}>
        {(row.memberName || "?").slice(-2)}
      </span>
      <span className="ins-person-copy">
        <strong>{row.memberName}</strong>
        <small>{row.memberTitle || "开发组成员"}</small>
      </span>
    </div>
  );
}

function GroupCell({ name, color }: { name: string; color?: string }) {
  return (
    <span className="ins-group-cell">
      <i style={{ background: color || "var(--accent)" }} aria-hidden="true" />
      {name}
    </span>
  );
}

type KpiItem = {
  key: string;
  label: string;
  value: string;
  unit: string;
  hint: string;
  icon: ComponentType<{ size?: number | string }>;
  tone: string;
};

function KpiStrip({ kpis }: { kpis: KpiItem[] }) {
  return (
    <div className="ins-kpis">
      {kpis.map((kpi) => {
        const Icon = kpi.icon;
        return (
          <article className={cn("ins-kpi", `is-${kpi.tone}`)} key={kpi.key}>
            <div className="ins-kpi-top">
              <span className="ins-kpi-icon">
                <Icon size={15} />
              </span>
              <span className="ins-kpi-label">{kpi.label}</span>
            </div>
            <div className="ins-kpi-value">
              <strong>{kpi.value}</strong>
              {kpi.unit ? <small>{kpi.unit}</small> : null}
            </div>
            <span className="ins-kpi-hint">{kpi.hint}</span>
          </article>
        );
      })}
    </div>
  );
}

export default function InsightsPage() {
  const { data, currentTeam, currentGroup, scope, scopeLabel } = useApp();
  const teamId = currentTeam?.id ?? "";
  const groupId = currentGroup?.id ?? "";

  const [payload, setPayload] = useState<InsightsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [errorStatus, setErrorStatus] = useState(0);
  const [rangeKey, setRangeKey] = useState<InsightsRangeKey>(DEFAULT_RANGE_KEY);

  const [memberSort, setMemberSort] = useState<SortState>({ key: "tasks", direction: "desc" });
  const [groupSort, setGroupSort] = useState<SortState>({ key: "tasks", direction: "desc" });
  const [teamSort, setTeamSort] = useState<SortState>({ key: "tasks", direction: "desc" });

  const range = useMemo(
    () => INSIGHTS_RANGES.find((option) => option.key === rangeKey) ?? INSIGHTS_RANGES[2],
    [rangeKey],
  );

  const load = useCallback(
    async (silent = false) => {
      if (!teamId || !groupId) {
        setLoading(false);
        return;
      }
      if (silent) setRefreshing(true);
      else {
        setLoading(true);
        setPayload(null);
      }
      setError("");
      setErrorStatus(0);
      try {
        const result = await api.insights({ teamId, groupId, scope, range: rangeKey });
        setPayload(result);
      } catch (err) {
        setError(messageOf(err, "加载数据洞察失败，请稍后重试。"));
        setErrorStatus(err instanceof ApiError ? err.status : 0);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [teamId, groupId, scope, rangeKey],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const summary = payload?.summary ?? EMPTY_SUMMARY;
  const scopeMeta: ScopeMeta | null = payload?.scope ?? null;
  const scopeLabelText = scopeMeta?.label || scopeLabel;
  const buckets = payload?.trend?.buckets ?? [];
  const granularity = payload?.trend?.granularity ?? "day";

  const trendMax = useMemo(
    () =>
      Math.max(1, ...buckets.flatMap((bucket) => [bucket.created, bucket.completed, bucket.todos])),
    [buckets],
  );

  const isEmpty = useMemo(() => {
    if (!payload) return false;
    const membersEmpty = !(payload.members ?? []).length;
    return (
      summary.tasks === 0 &&
      summary.todos === 0 &&
      membersEmpty &&
      !(payload.groups ?? []).length &&
      !(payload.teams ?? []).length
    );
  }, [payload, summary.tasks, summary.todos]);

  const kpis = useMemo<KpiItem[]>(
    () => [
      {
        key: "members",
        label: "成员",
        value: String(summary.members),
        unit: "人",
        hint: `${summary.groups} 个开发组 · ${summary.teams} 个团队`,
        icon: Users,
        tone: "neutral",
      },
      {
        key: "tasks",
        label: "任务",
        value: String(summary.tasks),
        unit: "条",
        hint: `未完成 ${summary.openTasks} · 已完成 ${summary.completedTasks}`,
        icon: ListTodo,
        tone: "blue",
      },
      {
        key: "completion",
        label: "任务完成率",
        value: formatPercent(summary.completionRate),
        unit: "",
        hint: `${summary.completedTasks} / ${summary.tasks} 条任务已完成`,
        icon: CheckCircle2,
        tone: summary.completionRate >= 60 ? "green" : "amber",
      },
      {
        key: "overdue",
        label: "逾期任务",
        value: String(summary.overdueTasks),
        unit: "条",
        hint: summary.overdueTasks ? "超过预期完成时间，需要关注" : "全部按预期推进",
        icon: Clock,
        tone: summary.overdueTasks ? "red" : "green",
      },
      {
        key: "blocked",
        label: "阻塞任务",
        value: String(summary.blockedTasks),
        unit: "条",
        hint: summary.blockedTasks ? "存在依赖或问题待协调" : "没有阻塞任务",
        icon: AlertTriangle,
        tone: summary.blockedTasks ? "amber" : "green",
      },
      {
        key: "load",
        label: "平均负载",
        value: formatPercent(summary.averageLoadPercent),
        unit: "",
        hint: `负载 ${formatPoints(summary.loadPoints)} / 容量 ${formatPoints(
          summary.capacityPoints,
        )}`,
        icon: Gauge,
        tone: "blue",
      },
      {
        key: "todos",
        label: "待办完成率",
        value: formatPercent(summary.todoCompletionRate),
        unit: "",
        hint: `${summary.completedTodos} / ${summary.todos} 条待办已完成`,
        icon: ListChecks,
        tone: summary.todoCompletionRate >= 60 ? "green" : "amber",
      },
    ],
    [summary],
  );

  const memberColumns = useMemo<Column<InsightsMemberRow>[]>(() => {
    const columns: Column<InsightsMemberRow>[] = [
      {
        key: "memberName",
        label: "成员",
        value: (row) => row.memberName,
        render: (row) => <MemberCell row={row} />,
      },
    ];
    if (scope !== "group") {
      columns.push({
        key: "groupName",
        label: "开发组",
        value: (row) => row.groupName || "",
        render: (row) => <GroupCell name={row.groupName || "—"} />,
      });
    }
    if (scope === "all") {
      columns.push({
        key: "teamName",
        label: "团队",
        value: (row) => row.teamName || "",
        render: (row) => <span className="ins-muted">{row.teamName || "—"}</span>,
      });
    }
    columns.push(
      {
        key: "tasks",
        label: "任务",
        value: (row) => row.tasks,
        numeric: true,
        render: (row) => <CountCell value={row.tasks} />,
      },
      {
        key: "completedTasks",
        label: "已完成",
        value: (row) => row.completedTasks,
        numeric: true,
        render: (row) => <CountCell value={row.completedTasks} />,
      },
      {
        key: "completionRate",
        label: "完成率",
        value: (row) => row.completionRate,
        numeric: true,
        render: (row) => <RateCell rate={row.completionRate} />,
      },
      {
        key: "overdueTasks",
        label: "逾期",
        value: (row) => row.overdueTasks,
        numeric: true,
        render: (row) => (
          <CountCell value={row.overdueTasks} tone={row.overdueTasks ? "danger" : "muted"} />
        ),
      },
      {
        key: "blockedTasks",
        label: "阻塞",
        value: (row) => row.blockedTasks,
        numeric: true,
        render: (row) => (
          <CountCell value={row.blockedTasks} tone={row.blockedTasks ? "warn" : "muted"} />
        ),
      },
      {
        key: "loadPoints",
        label: "负载",
        value: (row) => row.loadPoints,
        numeric: true,
        title: "按负载点数排序",
        render: (row) => <span className="ins-num">{formatPoints(row.loadPoints)}</span>,
      },
      {
        key: "todos",
        label: "待办",
        value: (row) => row.todos,
        numeric: true,
        render: (row) => (
          <span className="ins-num">
            {row.completedTodos}/{row.todos}
          </span>
        ),
      },
    );
    return columns;
  }, [scope]);

  const groupColumns = useMemo<Column<InsightsGroupRow>[]>(() => {
    const columns: Column<InsightsGroupRow>[] = [
      {
        key: "groupName",
        label: "开发组",
        value: (row) => row.groupName,
        render: (row) => <GroupCell name={row.groupName} color={row.color} />,
      },
    ];
    if (scope === "all") {
      columns.push({
        key: "teamName",
        label: "团队",
        value: (row) => row.teamName || "",
        render: (row) => <span className="ins-muted">{row.teamName || "—"}</span>,
      });
    }
    columns.push(
      {
        key: "members",
        label: "成员",
        value: (row) => row.members,
        numeric: true,
        render: (row) => <CountCell value={row.members} />,
      },
      {
        key: "tasks",
        label: "任务",
        value: (row) => row.tasks,
        numeric: true,
        render: (row) => <CountCell value={row.tasks} />,
      },
      {
        key: "completedTasks",
        label: "已完成",
        value: (row) => row.completedTasks,
        numeric: true,
        render: (row) => <CountCell value={row.completedTasks} />,
      },
      {
        key: "completionRate",
        label: "完成率",
        value: (row) => row.completionRate,
        numeric: true,
        render: (row) => <RateCell rate={row.completionRate} />,
      },
      {
        key: "overdueTasks",
        label: "逾期",
        value: (row) => row.overdueTasks,
        numeric: true,
        render: (row) => (
          <CountCell value={row.overdueTasks} tone={row.overdueTasks ? "danger" : "muted"} />
        ),
      },
      {
        key: "blockedTasks",
        label: "阻塞",
        value: (row) => row.blockedTasks,
        numeric: true,
        render: (row) => (
          <CountCell value={row.blockedTasks} tone={row.blockedTasks ? "warn" : "muted"} />
        ),
      },
      {
        key: "loadPoints",
        label: "负载",
        value: (row) => row.loadPoints,
        numeric: true,
        render: (row) => <span className="ins-num">{formatPoints(row.loadPoints)}</span>,
      },
      {
        key: "averageLoadPercent",
        label: "平均负载",
        value: (row) => row.averageLoadPercent,
        numeric: true,
        render: (row) => <span className="ins-num">{formatPercent(row.averageLoadPercent)}</span>,
      },
      {
        key: "todos",
        label: "待办",
        value: (row) => row.todos,
        numeric: true,
        render: (row) => (
          <span className="ins-num">
            {row.completedTodos}/{row.todos}
          </span>
        ),
      },
    );
    return columns;
  }, [scope]);

  const teamColumns = useMemo<Column<InsightsTeamRow>[]>(
    () => [
      {
        key: "teamName",
        label: "团队",
        value: (row) => row.teamName,
        render: (row) => <GroupCell name={row.teamName} color={row.color} />,
      },
      {
        key: "groups",
        label: "开发组",
        value: (row) => row.groups,
        numeric: true,
        render: (row) => <CountCell value={row.groups} />,
      },
      {
        key: "members",
        label: "成员",
        value: (row) => row.members,
        numeric: true,
        render: (row) => <CountCell value={row.members} />,
      },
      {
        key: "tasks",
        label: "任务",
        value: (row) => row.tasks,
        numeric: true,
        render: (row) => <CountCell value={row.tasks} />,
      },
      {
        key: "completedTasks",
        label: "已完成",
        value: (row) => row.completedTasks,
        numeric: true,
        render: (row) => <CountCell value={row.completedTasks} />,
      },
      {
        key: "completionRate",
        label: "完成率",
        value: (row) => row.completionRate,
        numeric: true,
        render: (row) => <RateCell rate={row.completionRate} />,
      },
      {
        key: "overdueTasks",
        label: "逾期",
        value: (row) => row.overdueTasks,
        numeric: true,
        render: (row) => (
          <CountCell value={row.overdueTasks} tone={row.overdueTasks ? "danger" : "muted"} />
        ),
      },
      {
        key: "loadPoints",
        label: "负载",
        value: (row) => row.loadPoints,
        numeric: true,
        render: (row) => <span className="ins-num">{formatPoints(row.loadPoints)}</span>,
      },
    ],
    [],
  );

  const toggleSort = (
    setter: (updater: (current: SortState) => SortState) => void,
    key: string,
  ) => {
    setter((previous) =>
      previous.key === key
        ? { key, direction: previous.direction === "asc" ? "desc" : "asc" }
        : { key, direction: "desc" },
    );
  };

  if (!currentTeam || !currentGroup) {
    return (
      <EmptyState
        title="还没有可查看的开发组"
        description="请先在左侧导航选择一个团队与开发组，然后再回来查看数据洞察。"
      />
    );
  }

  const header = (
    <header className="page-header">
      <div className="page-heading">
        <span className="eyebrow">
          <ChartNoAxesColumn size={12} /> DATA INSIGHTS
        </span>
        <h1 className="page-title">数据统计与分析</h1>
        <p className="page-subtitle">
          汇总{scopeLabelText}的成员、开发组与团队数据，结合时间范围观察任务完成、逾期与负载趋势。
        </p>
      </div>
      <div className="page-actions ins-page-actions">
        <span className="badge badge-blue ins-scope-badge" title="当前浏览视角">
          <Globe2 size={11} /> {scopeLabelText}
        </span>
        <div className="ins-ranges" role="group" aria-label="数据范围">
          {INSIGHTS_RANGES.map((option) => (
            <button
              key={option.key}
              type="button"
              className={cn("ins-range-btn", rangeKey === option.key && "active")}
              onClick={() => setRangeKey(option.key)}
              aria-pressed={rangeKey === option.key}
              title={`查看${option.label}的数据`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => void load(true)}
          disabled={loading || refreshing}
        >
          <RefreshCw size={14} className={loading || refreshing ? "spin" : undefined} /> 刷新
        </button>
      </div>
    </header>
  );

  const rangeNote = (
    <p className="ins-range-note">
      <CalendarRange size={12} /> 统计范围：{range.label}
      {payload?.range?.start ? `（自 ${payload.range.start} 起）` : ""}
      {payload?.range?.days ? ` · 近 ${payload.range.days} 天` : " · 全部历史数据"}
      <span className="ins-range-note-sep">·</span>
      <TrendingUp size={12} /> 趋势按{granularity === "day" ? "天" : "周"}汇总
    </p>
  );

  const body =
    loading && !payload ? (
      <div className="panel ins-loading-panel">
        <LoadingBlock label="正在汇总数据洞察…" rows={4} />
      </div>
    ) : error && !payload ? (
      <div className="panel ins-error-panel">
        <EmptyState
          icon={<WifiOff size={24} />}
          title={errorStatus === 404 ? "数据洞察接口尚未就绪" : "数据洞察暂时不可用"}
          description={
            errorStatus === 404
              ? "后端 /insights 接口仍在开发中（404）。前端已按 InsightsData 契约完成，接口就绪后刷新即可查看真实数据。"
              : error
          }
          action={
            <button className="btn btn-primary btn-sm" onClick={() => void load()}>
              <RefreshCw size={14} /> 重新加载
            </button>
          }
        />
      </div>
    ) : isEmpty ? (
      <>
        <KpiStrip kpis={kpis} />
        <div className="panel ins-empty-panel">
          <EmptyState
            icon={<ChartNoAxesColumn size={24} />}
            title="当前范围内还没有数据"
            description="切换更长的时间范围或浏览视角，或者先在任务台账中登记任务与待办。"
          />
        </div>
      </>
    ) : (
      <>
        <KpiStrip kpis={kpis} />

        {rangeNote}

        <section className="panel ins-trend-panel" aria-labelledby="ins-trend-title">
          <header className="panel-header ins-panel-head">
            <div className="ins-panel-heading">
              <h2 id="ins-trend-title">
                <TrendingUp size={15} /> 任务与待办趋势
              </h2>
              <p className="ins-panel-sub">
                {range.label} · 按{granularity === "day" ? "天" : "周"}汇总，悬停或聚焦柱体查看数值
              </p>
            </div>
            <div className="ins-legend" aria-label="图例">
              <span className="ins-legend-item is-created">
                <i /> 新建任务
              </span>
              <span className="ins-legend-item is-completed">
                <i /> 完成任务
              </span>
              <span className="ins-legend-item is-todos">
                <i /> 新建待办
              </span>
              <span className="ins-trend-peak">峰值 {trendMax}</span>
            </div>
          </header>
          <div className="panel-body ins-trend-body">
            {buckets.length ? (
              <div className="ins-chart-scroll">
                <div
                  className="ins-chart"
                  style={{ minWidth: `${Math.max(360, buckets.length * 58)}px` }}
                  role="img"
                  aria-label={`${range.label}任务与待办趋势，共 ${buckets.length} 个${granularity === "day" ? "天" : "周"}分组`}
                >
                  <div className="ins-chart-grid" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                    <span />
                  </div>
                  <div className="ins-chart-cols">
                    {buckets.map((bucket, index) => {
                      const created = Math.max(0, bucket.created);
                      const completed = Math.max(0, bucket.completed);
                      const todos = Math.max(0, bucket.todos);
                      const heightOf = (value: number) =>
                        value > 0 ? Math.max(6, Math.round((value / trendMax) * 100)) : 2;
                      return (
                        <div
                          key={`${bucket.start}-${index}`}
                          className="ins-chart-col"
                          tabIndex={0}
                          aria-label={`${bucket.label}：新建任务 ${created}，完成任务 ${completed}，新建待办 ${todos}`}
                        >
                          <div className="ins-chart-bars">
                            <i
                              className="ins-bar is-created"
                              style={{ height: `${heightOf(created)}%` }}
                            />
                            <i
                              className="ins-bar is-completed"
                              style={{ height: `${heightOf(completed)}%` }}
                            />
                            <i
                              className="ins-bar is-todos"
                              style={{ height: `${heightOf(todos)}%` }}
                            />
                          </div>
                          <span className="ins-chart-label">{bucket.label}</span>
                          <span className="ins-chart-tip" role="tooltip">
                            <strong>{bucket.label}</strong>
                            <span>
                              <i className="is-created" /> 新建任务 <b>{created}</b>
                            </span>
                            <span>
                              <i className="is-completed" /> 完成任务 <b>{completed}</b>
                            </span>
                            <span>
                              <i className="is-todos" /> 新建待办 <b>{todos}</b>
                            </span>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            ) : (
              <EmptyState
                compact
                icon={<TrendingUp size={20} />}
                title="这个范围内没有趋势数据"
                description="换一个时间范围，或者先登记任务/待办后再查看趋势。"
              />
            )}
          </div>
        </section>

        <section className="panel ins-table-panel" aria-labelledby="ins-members-title">
          <header className="panel-header ins-panel-head">
            <div className="ins-panel-heading">
              <h2 id="ins-members-title">
                <Users size={15} /> 成员表现
              </h2>
              <p className="ins-panel-sub">共 {summary.members} 位成员 · 点击表头按任意指标升/降序</p>
            </div>
            <span className="badge badge-gray ins-table-count">
              {payload?.members?.length ?? 0} 行
            </span>
          </header>
          <div className="panel-body ins-table-body">
            <SortableTable
              rows={payload?.members ?? []}
              columns={memberColumns}
              sort={memberSort}
              onSort={(key) => toggleSort(setMemberSort, key)}
              rowKey={(row) => row.memberId}
              emptyTitle="没有成员数据"
              emptyDescription="当前范围内没有活跃任务或待办的成员。"
            />
          </div>
        </section>

        <section className="panel ins-table-panel" aria-labelledby="ins-groups-title">
          <header className="panel-header ins-panel-head">
            <div className="ins-panel-heading">
              <h2 id="ins-groups-title">
                <Gauge size={15} /> 开发组对比
              </h2>
              <p className="ins-panel-sub">按开发组汇总任务完成、逾期、阻塞与负载</p>
            </div>
            <span className="badge badge-gray ins-table-count">
              {payload?.groups?.length ?? 0} 行
            </span>
          </header>
          <div className="panel-body ins-table-body">
            <SortableTable
              rows={payload?.groups ?? []}
              columns={groupColumns}
              sort={groupSort}
              onSort={(key) => toggleSort(setGroupSort, key)}
              rowKey={(row) => row.groupId}
              emptyTitle="没有开发组数据"
              emptyDescription="当前范围内没有开发组包含活跃任务或待办。"
            />
          </div>
        </section>

        <section className="panel ins-table-panel" aria-labelledby="ins-teams-title">
          <header className="panel-header ins-panel-head">
            <div className="ins-panel-heading">
              <h2 id="ins-teams-title">
                <Globe2 size={15} /> 团队汇总
              </h2>
              <p className="ins-panel-sub">跨团队对比总任务量与完成率</p>
            </div>
            <span className="badge badge-gray ins-table-count">
              {payload?.teams?.length ?? 0} 行
            </span>
          </header>
          <div className="panel-body ins-table-body">
            <SortableTable
              rows={payload?.teams ?? []}
              columns={teamColumns}
              sort={teamSort}
              onSort={(key) => toggleSort(setTeamSort, key)}
              rowKey={(row) => row.teamId}
              emptyTitle="没有团队数据"
              emptyDescription="当前范围内没有团队包含活跃任务或待办。"
            />
          </div>
        </section>
      </>
    );

  return (
    <div className="insights-page">
      {header}
      {body}
      <p className="ins-page-note">
        <ChartNoAxesColumn size={12} /> 完成率 = 已完成任务 / 范围内任务；待办完成率 = 已完成待办 /
        范围内待办。数据随浏览视角「{scopeLabelText}」与时间范围「{range.label}」变化
        {data?.stats?.serverDate ? ` · 服务器日期 ${data.stats.serverDate}` : ""}。
      </p>
    </div>
  );
}
