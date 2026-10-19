import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  Activity,
  ArrowRight,
  AtSign,
  Briefcase,
  CalendarDays,
  CheckCircle2,
  Clock,
  Layers3,
  ListTodo,
  Megaphone,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trophy,
  UserPlus,
  Users,
  WifiOff,
  X,
} from "lucide-react";
import { api, ApiError } from "../api";
import { useApp } from "../store";
import { useToast } from "../components/Toast";
import { Avatar } from "../components/Avatar";
import { EmptyState, LoadingBlock } from "../components/Feedback";
import { Modal } from "../components/Modal";
import { MemberDrawer } from "../components/MemberDrawer";
import {
  cn,
  formatFullDate,
  hashRoute,
  relativeTime,
  todayISO,
} from "../lib/utils";
import { formatPercent, formatPoints, WORKLOAD_LEVEL_META, workloadLevel } from "../lib/taskMeta";
import type { ActivityItem, Announcement, OverviewData } from "../types";
import "./OverviewPage.css";

const AVATAR_COLORS = ["#7c3aed", "#2563eb", "#0ea5e9", "#16a34a", "#ea8a14", "#dc2626", "#db2777"];
const MAX_SEARCH_ACTIVITY = 9;

const LEVEL_META: Record<string, { label: string; badge: string }> = {
  info: { label: "通知", badge: "badge-blue" },
  important: { label: "重要", badge: "badge-orange" },
  celebration: { label: "庆祝", badge: "badge-violet" },
};

const ACTIVITY_META: Record<string, { label: string; tone: string; icon: typeof Activity }> = {
  todo: { label: "待办", tone: "green", icon: CheckCircle2 },
  work: { label: "工作", tone: "violet", icon: Briefcase },
  announcement: { label: "公告", tone: "blue", icon: Megaphone },
  redblack: { label: "红黑榜", tone: "orange", icon: Trophy },
};

type ActivityRow = ActivityItem & { actorName?: string };

interface MemberFormState {
  id: string;
  name: string;
  title: string;
  role: string;
  email: string;
  avatarColor: string;
  tags: string;
  bio: string;
}

const EMPTY_MEMBER_FORM: MemberFormState = {
  id: "",
  name: "",
  title: "",
  role: "成员",
  email: "",
  avatarColor: "#7c3aed",
  tags: "",
  bio: "",
};

function splitList(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[,，、\n]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export default function OverviewPage() {
  const {
    data,
    config,
    currentTeam,
    currentGroup,
    canManageActiveGroup,
    scope,
    scopeLabel,
    navigate,
    reload,
  } = useApp();
  const { toast } = useToast();

  const teamId = currentTeam?.id ?? "";
  const groupId = currentGroup?.id ?? "";
  const me = data?.me ?? null;
  const isAggregated = scope !== "group";

  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [addMemberOpen, setAddMemberOpen] = useState(false);

  const load = useCallback(
    async (silent = false) => {
      if (!teamId || !groupId) return;
      if (silent) setRefreshing(true);
      else setLoading(true);
      setError("");
      try {
        const [overviewData, announcementData] = await Promise.all([
          api.overview(teamId, groupId, scope),
          api.announcements(teamId, groupId, scope),
        ]);
        setOverview(overviewData);
        setAnnouncements(announcementData.announcements);
      } catch (err) {
        setError(messageOf(err, "加载团队概览失败，请稍后重试。"));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [teamId, groupId, scope],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Support `#/overview?member=<id>` so the user menu can deep-link a member card.
  useEffect(() => {
    const syncFromHash = () => {
      const { page, params } = hashRoute();
      if (page !== "overview") return;
      setSelectedMemberId(params.get("member"));
    };
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, []);

  const members = overview?.members ?? [];
  const stats = overview?.stats ?? null;
  const group = overview?.group ?? null;
  const serverDate = data?.stats.serverDate || data?.serverTime || todayISO();

  const memberById = useMemo(() => new Map(members.map((member) => [member.id, member])), [members]);

  const workloads = useMemo(() => overview?.workloads ?? [], [overview?.workloads]);
  const workloadByMember = useMemo(
    () => new Map(workloads.map((workload) => [workload.memberId, workload])),
    [workloads],
  );

  const filteredMembers = useMemo(() => {
    const query = search.trim().toLowerCase();
    return members.filter((member) => {
      if (!query) return true;
      const haystack = [
        member.name,
        member.title,
        member.role,
        member.bio,
        member.email,
        ...(member.tags ?? []),
        ...(member.skills ?? []),
      ];
      return haystack.some((value) => value && value.toLowerCase().includes(query));
    });
  }, [members, search]);

  const pinned = useMemo(
    () => announcements.filter((item) => item.pinned).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [announcements],
  );
  const dashboardAnnouncements = config?.announcements.showOnDashboard !== false;
  const spotlight = dashboardAnnouncements ? pinned[0] ?? null : null;
  const pinnedRest = dashboardAnnouncements ? pinned.slice(1, 1 + Math.max(1, config?.announcements.dashboardLimit ?? 4)) : [];

  const activity = (overview?.recentActivity ?? []) as ActivityRow[];
  const selectedMember = selectedMemberId ? memberById.get(selectedMemberId) ?? null : null;

  // Group list for aggregated views: prefer the scope payload, then the bootstrap teams.
  // (Backend scope metadata may still be landing, so the fallback keeps counts truthful.)
  const scopeGroups = useMemo(() => {
    const fromMeta = overview?.scope?.groups ?? [];
    if (fromMeta.length) return fromMeta;
    const teams = scope === "all" ? data?.teams ?? [] : currentTeam ? [currentTeam] : [];
    return teams.flatMap((team) =>
      team.groups.map((group) => ({ id: group.id, name: group.name, color: group.color })),
    );
  }, [overview?.scope?.groups, scope, data?.teams, currentTeam]);

  const scopeTeamCount = useMemo(() => {
    const fromMeta = overview?.scope?.teamIds.length ?? 0;
    if (fromMeta) return fromMeta;
    return scope === "all" ? data?.teams.length ?? 0 : 1;
  }, [overview?.scope?.teamIds, scope, data?.teams]);

  // Group meta for aggregated views: prefer the scope payload, then bootstrap teams.
  const groupMetaById = useMemo(() => {
    const map = new Map<string, { name: string; color: string }>();
    for (const item of scopeGroups) map.set(item.id, { name: item.name, color: item.color });
    for (const team of data?.teams ?? []) {
      for (const item of team.groups) {
        if (!map.has(item.id)) map.set(item.id, { name: item.name, color: item.color });
      }
    }
    return map;
  }, [scopeGroups, data?.teams]);

  // Member edits always route to the member's own group/team, never the active one.
  const selectedMemberScope = useMemo(() => {
    const fallback = { teamId, groupId };
    if (!selectedMember) return fallback;
    const memberGroupId = selectedMember.groupId || groupId;
    for (const team of data?.teams ?? []) {
      if (team.groups.some((item) => item.id === memberGroupId)) {
        return { teamId: team.id, groupId: memberGroupId };
      }
    }
    return { teamId: selectedMember.teamId || teamId, groupId: memberGroupId };
  }, [selectedMember, data?.teams, teamId, groupId]);

  const heroStats = [
    { label: "团队成员", value: stats?.members ?? members.length, unit: "位伙伴", icon: Users },
    { label: "在途工作", value: stats?.currentWorks ?? 0, unit: "项推进中", icon: Activity },
    { label: "待跟进待办", value: stats?.openTodos ?? 0, unit: "条待办", icon: ListTodo },
    { label: "置顶公告", value: pinned.length, unit: "条信号", icon: Megaphone },
  ];

  const openMember = useCallback((memberId: string) => {
    setSelectedMemberId(memberId);
    const base = `${window.location.pathname}${window.location.search}`;
    window.history.replaceState({}, "", `${base}#/overview?member=${encodeURIComponent(memberId)}`);
  }, []);

  const closeMember = useCallback(() => {
    setSelectedMemberId(null);
    const base = `${window.location.pathname}${window.location.search}`;
    window.history.replaceState({}, "", `${base}#/overview`);
  }, []);

  const refreshEverything = useCallback(async () => {
    await Promise.all([load(true), reload(true)]);
  }, [load, reload]);

  const handleMemberCardKey = (event: KeyboardEvent<HTMLElement>, memberId: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openMember(memberId);
    }
  };

  const handleAddMemberSaved = async () => {
    await refreshEverything();
  };

  const clearFilters = () => {
    setSearch("");
  };

  if (!currentTeam || !currentGroup) {
    return (
      <EmptyState
        title="还没有可查看的开发组"
        description="请先在左侧导航选择一个团队与开发组，然后再回来查看团队概览。"
      />
    );
  }

  const isFiltered = search.trim().length > 0;

  return (
    <div className="ov-page">
      {error ? (
        <div className="inline-error" role="alert">
          <WifiOff size={16} />
          <span>{error}</span>
          <button className="text-button" onClick={() => void load()} disabled={refreshing}>
            重新加载
          </button>
        </div>
      ) : null}

      <section className="ov-hero" aria-labelledby="ov-hero-title">
        <div className="ov-hero-grid" aria-hidden="true" />
        <div className="ov-hero-glow" aria-hidden="true" />
        <div className="ov-hero-main">
          <div className="ov-hero-top">
            <span className="ov-hero-chip">
              <span
                className="dot"
                style={{
                  background: isAggregated ? currentGroup.color : group?.color ?? currentGroup.color,
                }}
              />
              {isAggregated ? scopeLabel : group?.name ?? currentGroup.name}
            </span>
            {isAggregated ? (
              <span className="ov-hero-chip is-muted">
                <Layers3 size={13} />
                {scope === "all" ? `${scopeTeamCount} 个团队` : `${scopeGroups.length} 个开发组`} · 聚合
              </span>
            ) : null}
            <span className="ov-hero-chip is-muted">
              <CalendarDays size={13} />
              {formatFullDate(serverDate)}
            </span>
            <span className="ov-hero-chip is-muted">
              <Users size={13} />
              {members.length} 位伙伴
            </span>
          </div>
          <p className="eyebrow ov-hero-eyebrow">
            <Sparkles size={12} />{" "}
            {scope === "all" ? "ALL TEAMS PULSE · 全局脉搏" : scope === "team" ? "TEAM PULSE · 团队脉搏" : "GROUP PULSE · 团队脉搏"}
          </p>
          <h1 id="ov-hero-title" className="ov-hero-title">
            {config?.site.tagline || "让协作被看见，让成长有回声。"}
          </h1>
          <p className="ov-hero-sub">
            {scope === "group" ? (
              <>
                {currentTeam.name}
                <span aria-hidden="true"> · </span>
                {group?.description || currentGroup.description || "一起把事情做得更漂亮。"}
              </>
            ) : scope === "team" ? (
              <>
                {currentTeam.name}
                <span aria-hidden="true"> · </span>
                {scopeLabel}：聚合 {scopeGroups.length} 个开发组的成员、工作与动态。
              </>
            ) : (
              <>
                全部团队
                <span aria-hidden="true"> · </span>
                {scopeTeamCount} 个团队 / {scopeGroups.length} 个开发组的聚合视图。
              </>
            )}
          </p>

          <dl className="ov-hero-stats">
            {heroStats.map((item) => {
              const Icon = item.icon;
              return (
                <div className="ov-hero-stat" key={item.label}>
                  <dt>
                    <Icon size={13} /> {item.label}
                  </dt>
                  <dd>
                    <strong>{item.value}</strong>
                    <span>{item.unit}</span>
                  </dd>
                </div>
              );
            })}
          </dl>

          <div className="ov-hero-foot">
            <div className="ov-avatar-stack" aria-hidden="true">
              {members.slice(0, 6).map((member) => (
                <Avatar
                  key={member.id}
                  name={member.name}
                  color={member.avatarColor}
                  size="sm"
                />
              ))}
              {members.length > 6 ? <span className="ov-avatar-more">+{members.length - 6}</span> : null}
            </div>
            <span className="ov-hero-note">
              {isAggregated
                ? `聚合视角：${scopeLabel} 的成员档案、负载与动态汇总展示，卡片会标注所属开发组。`
                : "协同视角下的团队档案：谁在做什么、进度如何，一眼可见。"}
            </span>
          </div>
        </div>

        <div className="ov-hero-side">
          {spotlight ? (
            <article className="ov-spotlight">
              <div className="ov-spotlight-head">
                <span className={cn("badge", LEVEL_META[spotlight.level]?.badge ?? "badge-blue")}>
                  {LEVEL_META[spotlight.level]?.label ?? "通知"}
                </span>
                <span className="ov-spotlight-pin">
                  <Megaphone size={13} /> 置顶公告
                </span>
              </div>
              <h2>{spotlight.title}</h2>
              <p>{spotlight.content}</p>
              <footer>
                <span>
                  {spotlight.authorName || "团队"} · {relativeTime(spotlight.createdAt) || "最近"}
                </span>
                <button className="ov-link-button" onClick={() => navigate("announcements")}>
                  今日公告 <ArrowRight size={13} />
                </button>
              </footer>
            </article>
          ) : (
            <article className="ov-spotlight is-empty">
              <span className="ov-empty-orb">
                <Megaphone size={19} />
              </span>
              <h2>还没有置顶公告</h2>
              <p>把重要信息置顶后，它会出现在这里作为团队的首要信号。</p>
              <button className="btn btn-secondary btn-sm" onClick={() => navigate("announcements")}>
                打开公告栏 <ArrowRight size={14} />
              </button>
            </article>
          )}
        </div>
      </section>

      {pinnedRest.length ? (
        <section className="ov-pinned" aria-labelledby="ov-pinned-title">
          <div className="section-heading">
            <div>
              <h2 id="ov-pinned-title">置顶公告</h2>
              <p>对齐团队节奏，别错过被标记为重要的消息。</p>
            </div>
            <button className="section-link" onClick={() => navigate("announcements")}>
              查看全部公告 <ArrowRight size={13} />
            </button>
          </div>
          <div className="ov-pinned-grid">
            {pinnedRest.map((item) => (
              <button
                key={item.id}
                type="button"
                className={cn("ov-pinned-card", `is-${item.level}`)}
                onClick={() => navigate("announcements")}
              >
                <span className="ov-pinned-top">
                  <span className={cn("badge", LEVEL_META[item.level]?.badge ?? "badge-blue")}>
                    {LEVEL_META[item.level]?.label ?? "通知"}
                  </span>
                  <span className="ov-pinned-meta">
                    {item.authorName || "团队"} · {relativeTime(item.createdAt) || "最近"}
                  </span>
                </span>
                <strong>{item.title}</strong>
                <p>{item.content}</p>
                <span className="ov-pinned-link">
                  查看详情 <ArrowRight size={12} />
                </span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <div className="ov-columns">
        <section className="ov-members" aria-labelledby="ov-members-title">
          <div className="ov-members-head">
            <div>
              <h2 id="ov-members-title" className="ov-section-title">
                成员档案
              </h2>
              <p className="ov-section-sub">
                共 {members.length} 位伙伴，正在推进 {stats?.currentWorks ?? 0} 项工作。
                {isAggregated ? ` · ${scopeLabel}` : ""}
              </p>
            </div>
            {canManageActiveGroup ? (
              <button className="btn btn-primary btn-sm" onClick={() => setAddMemberOpen(true)}>
                <UserPlus size={15} /> 添加成员
              </button>
            ) : null}
          </div>

          <div className="ov-toolbar">
            <label className="search-box ov-search">
              <Search size={15} />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索姓名、职位或标签"
                aria-label="搜索成员"
              />
              {search ? (
                <button
                  type="button"
                  className="icon-button ov-search-clear"
                  onClick={() => setSearch("")}
                  aria-label="清除搜索"
                >
                  <X size={13} />
                </button>
              ) : null}
            </label>
            <span className="ov-result" aria-live="polite">
              {filteredMembers.length} / {members.length}
            </span>
          </div>

          {loading && !overview ? (
            <div className="ov-member-grid" aria-busy="true">
              {Array.from({ length: 4 }, (_, index) => (
                <div className="ov-member-skeleton" key={index}>
                  <div className="skeleton ov-skeleton-avatar" />
                  <div className="skeleton skeleton-row" style={{ width: "58%" }} />
                  <div className="skeleton skeleton-row" style={{ width: "36%" }} />
                  <div className="skeleton ov-skeleton-block" />
                </div>
              ))}
            </div>
          ) : filteredMembers.length ? (
            <div className="ov-member-grid">
              {filteredMembers.map((member, index) => {
                const memberWorkload = workloadByMember.get(member.id) ?? null;
                const memberGroupMeta = isAggregated
                  ? groupMetaById.get(member.groupId ?? "") ?? null
                  : null;
                const memberGroupName = isAggregated
                  ? member.groupName || memberGroupMeta?.name || ""
                  : "";
                const memberGroupColor = memberGroupMeta?.color ?? currentGroup.color;
                const workloadMeta = memberWorkload
                  ? WORKLOAD_LEVEL_META[workloadLevel(memberWorkload.currentLoadPercent)] ??
                    WORKLOAD_LEVEL_META.balanced
                  : null;
                const visibleWorks = member.currentWorks.slice(0, 1);
                const hiddenWorkCount = Math.max(0, member.currentWorks.length - visibleWorks.length);
                return (
                  <article
                    key={member.id}
                    className="ov-member-card"
                    role="button"
                    tabIndex={0}
                    aria-label={`查看 ${member.name} 的成员档案`}
                    onClick={() => openMember(member.id)}
                    onKeyDown={(event) => handleMemberCardKey(event, member.id)}
                    style={{ "--ov-i": index } as CSSProperties}
                  >
                    <div className="ov-member-top">
                      <Avatar
                        name={member.name}
                        color={member.avatarColor}
                        size="lg"
                      />
                      <div className="ov-member-id">
                        <div className="ov-member-name-row">
                          <h3>{member.name}</h3>
                          {memberGroupName ? (
                            <span
                              className="badge ov-member-group"
                              style={{ "--group-color": memberGroupColor } as CSSProperties}
                              title={`所属开发组：${memberGroupName}`}
                            >
                              {memberGroupName}
                            </span>
                          ) : null}
                        </div>
                        <p className="ov-member-title">{member.title || "团队成员"}</p>
                        <span className="ov-member-role">{member.role || "成员"}</span>
                      </div>
                    </div>

                    <p className="ov-member-bio">
                      {member.bio || "这位伙伴还没有留下个人简介，点开档案了解更多。"}
                    </p>

                    {member.tags.length ? (
                      <div className="tag-list ov-member-tags">
                        {member.tags.slice(0, 2).map((tag) => (
                          <span className="chip" key={tag}>
                            #{tag}
                          </span>
                        ))}
                      </div>
                    ) : null}

                    {memberWorkload && workloadMeta ? (
                      <div className="workload ov-member-workload">
                        <div className="workload-head">
                          <span className="workload-title">当前负载</span>
                          <span className={cn("load-pill", workloadMeta.className)}>
                            {workloadMeta.label} · {formatPercent(memberWorkload.currentLoadPercent)}
                          </span>
                        </div>
                        <div
                          className="workload-bar"
                          role="img"
                          aria-label={`当前负载 ${formatPercent(memberWorkload.currentLoadPercent)}`}
                        >
                          <span
                            className={cn("workload-fill", workloadMeta.className)}
                            style={{
                              width: `${Math.min(100, Math.max(0, memberWorkload.currentLoadPercent))}%`,
                            }}
                          />
                        </div>
                        <div className="workload-meta">
                          <span>
                            {formatPoints(memberWorkload.currentPoints)} /{" "}
                            {formatPoints(memberWorkload.capacityPoints)}
                          </span>
                          <span>
                            近 {memberWorkload.windowWeeks} 周平均{" "}
                            {formatPoints(memberWorkload.averagePoints)} ·{" "}
                            {formatPercent(memberWorkload.averageLoadPercent)}
                          </span>
                        </div>
                      </div>
                    ) : null}

                    <div className="ov-member-work">
                      <div className="ov-member-work-head">
                        <span className="ov-member-work-label">
                          <Briefcase size={12} /> 正在推进
                        </span>
                        <span className="ov-member-work-count">
                          {member.currentWorks.length} 项
                        </span>
                      </div>
                      {visibleWorks.length ? (
                        <div className="ov-current-works">
                          {visibleWorks.map((work) => {
                            const workProgress = Math.max(0, Math.min(100, work.progress ?? 0));
                            const workMeta =
                              [work.category, work.period].filter(Boolean).join(" · ") || "未分类";
                            return (
                              <div className="ov-current-work" key={work.id}>
                                <div className="ov-current-work-head">
                                  <span className="ov-current-work-title">{work.title}</span>
                                  <span className="ov-current-work-meta">{workMeta}</span>
                                  <span className="ov-current-work-value">{workProgress}%</span>
                                </div>
                                <div
                                  className="ov-current-work-progress"
                                  role="img"
                                  aria-label={`${work.title} 进度 ${workProgress}%`}
                                >
                                  <span style={{ width: `${workProgress}%` }} />
                                </div>
                              </div>
                            );
                          })}
                          {hiddenWorkCount > 0 ? (
                            <button
                              type="button"
                              className="ov-current-work-more"
                              onClick={(event) => {
                                event.stopPropagation();
                                openMember(member.id);
                              }}
                            >
                              +{hiddenWorkCount} 项进行中 <ArrowRight size={12} />
                            </button>
                          ) : null}
                        </div>
                      ) : (
                        <p className="ov-member-work-empty">暂时没有进行中的工作</p>
                      )}
                    </div>

                    <div className="ov-member-foot">
                      <span className="ov-member-stat">
                        <Briefcase size={12} />
                        <strong>{member.stats.current}</strong> 在途
                      </span>
                      <span className="ov-member-stat">
                        <CheckCircle2 size={12} />
                        <strong>{member.stats.done}</strong> 已完成
                      </span>
                      <span className="ov-member-stat">
                        <ListTodo size={12} />
                        <strong>{member.stats.todos}</strong> 待办
                      </span>
                      <span className="ov-member-open">
                        查看档案 <ArrowRight size={12} />
                      </span>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <EmptyState
              title={isFiltered ? "没有匹配的成员" : "还没有成员档案"}
              description={
                isFiltered
                  ? "换一个关键词试试，也可以清除搜索查看全部伙伴。"
                  : "管理员添加第一位成员后，团队概览会自动生成成员卡片。"
              }
              action={
                isFiltered ? (
                  <button className="btn btn-secondary btn-sm" onClick={clearFilters}>
                    清除筛选
                  </button>
                ) : canManageActiveGroup ? (
                  <button className="btn btn-primary btn-sm" onClick={() => setAddMemberOpen(true)}>
                    <Plus size={14} /> 添加成员
                  </button>
                ) : null
              }
            />
          )}
        </section>

        <aside className="ov-side">
          <section className="panel ov-activity-panel" aria-labelledby="ov-activity-title">
            <header className="panel-header">
              <h2 id="ov-activity-title">
                <Activity size={15} /> 最近动态
              </h2>
              <button
                type="button"
                className="section-link"
                onClick={() => void load(true)}
                disabled={refreshing}
              >
                <RefreshCw size={12} className={refreshing ? "spin" : undefined} />
                {refreshing ? "刷新中" : "刷新"}
              </button>
            </header>
            <div className="panel-body">
              {loading && !overview ? (
                <LoadingBlock label="加载团队动态…" rows={4} />
              ) : activity.length ? (
                <ol className="ov-timeline">
                  {activity.slice(0, MAX_SEARCH_ACTIVITY).map((item) => {
                    const meta = ACTIVITY_META[item.type] ?? {
                      label: "动态",
                      tone: "gray",
                      icon: Sparkles,
                    };
                    const Icon = meta.icon;
                    const clickable = Boolean(item.memberId && memberById.has(item.memberId));
                    return (
                      <li key={`${item.id}-${item.at}`} className={cn("ov-timeline-item", `tone-${meta.tone}`)}>
                        <span className="ov-timeline-dot">
                          <Icon size={13} />
                        </span>
                        <button
                          type="button"
                          className="ov-timeline-body"
                          onClick={() => (clickable && item.memberId ? openMember(item.memberId) : undefined)}
                          disabled={!clickable}
                        >
                          <span className="ov-timeline-top">
                            <span className="ov-timeline-kind">{meta.label}</span>
                            <span className="ov-timeline-time">{relativeTime(item.at) || "刚刚"}</span>
                          </span>
                          <span className="ov-timeline-title">{item.title}</span>
                          {item.description ? <span className="ov-timeline-desc">{item.description}</span> : null}
                          <span className="ov-timeline-actor">
                            {item.actorName || item.memberName || "系统"}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <EmptyState
                  compact
                  title="还没有团队动态"
                  description="新工作、待办与公告的更新会实时出现在这里。"
                />
              )}
            </div>
          </section>

          <section className="ov-cta">
            <span className="ov-cta-icon">
              <CalendarDays size={18} />
            </span>
            <div className="ov-cta-copy">
              <strong>协作日历</strong>
              <span>{stats?.openTodos ?? 0} 条待办等待跟进</span>
            </div>
            <button className="btn btn-secondary btn-sm" onClick={() => navigate("calendar")}>
              打开
            </button>
          </section>

          {me?.source === "guest" ? (
            <p className="ov-guest-note">
              <AtSign size={13} /> 访客模式为只读视图，登录后可维护个人档案与自己的工作项。
            </p>
          ) : null}
        </aside>
      </div>

      <AddMemberDialog
        open={addMemberOpen}
        teamId={teamId}
        groupId={groupId}
        onClose={() => setAddMemberOpen(false)}
        onSaved={handleAddMemberSaved}
      />

      <MemberDrawer
        open={Boolean(selectedMember)}
        member={selectedMember}
        teamId={selectedMemberScope.teamId}
        groupId={selectedMemberScope.groupId}
        workload={selectedMember ? workloadByMember.get(selectedMember.id) ?? null : null}
        onClose={closeMember}
        onChanged={refreshEverything}
      />
    </div>
  );
}

interface AddMemberDialogProps {
  open: boolean;
  teamId: string;
  groupId: string;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}

function AddMemberDialog({ open, teamId, groupId, onClose, onSaved }: AddMemberDialogProps) {
  const { toast } = useToast();
  const { scope, currentGroup } = useApp();
  const [form, setForm] = useState<MemberFormState>(EMPTY_MEMBER_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setForm(EMPTY_MEMBER_FORM);
    setError("");
    setSaving(false);
  }, [open]);

  const setField = <Key extends keyof MemberFormState>(key: Key, value: MemberFormState[Key]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form.name.trim()) {
      setError("请填写成员姓名。");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await api.createMember(teamId, groupId, {
        id: form.id.trim() || undefined,
        name: form.name.trim(),
        title: form.title.trim(),
        role: form.role.trim(),
        email: form.email.trim(),
        avatarColor: form.avatarColor,
        bio: form.bio.trim(),
        tags: splitList(form.tags),
      });
      toast(`已添加成员「${form.name.trim()}」`, "success");
      await onSaved();
      onClose();
    } catch (err) {
      setError(messageOf(err, "添加成员失败，请稍后重试。"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="添加团队成员"
      description={
        scope === "group"
          ? "补全基础信息即可创建档案，工作项与待办可在档案中继续维护。"
          : `聚合视角下，新成员会创建到当前开发组「${currentGroup?.name ?? "当前开发组"}」，创建后可在成员档案中继续维护。`
      }
      size="md"
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button className="btn btn-primary" type="submit" form="ov-add-member-form" disabled={saving}>
            {saving ? "创建中…" : "创建成员"}
          </button>
        </>
      }
    >
      <form id="ov-add-member-form" className="form-grid" onSubmit={submit}>
        <div className="field">
          <label htmlFor="ov-add-name">姓名 *</label>
          <input
            id="ov-add-name"
            className="input"
            value={form.name}
            onChange={(event) => setField("name", event.target.value)}
            placeholder="例如：林知夏"
            maxLength={60}
            required
            autoFocus
          />
        </div>
        <div className="field">
          <label htmlFor="ov-add-id">成员 ID</label>
          <input
            id="ov-add-id"
            className="input"
            value={form.id}
            onChange={(event) => setField("id", event.target.value)}
            placeholder="留空自动生成"
            maxLength={80}
          />
          <span className="field-hint">仅支持字母、数字、下划线与连字符。</span>
        </div>
        <div className="field">
          <label htmlFor="ov-add-title">职位</label>
          <input
            id="ov-add-title"
            className="input"
            value={form.title}
            onChange={(event) => setField("title", event.target.value)}
            placeholder="例如：高级前端工程师"
            maxLength={60}
          />
        </div>
        <div className="field">
          <label htmlFor="ov-add-role">团队角色</label>
          <input
            id="ov-add-role"
            className="input"
            value={form.role}
            onChange={(event) => setField("role", event.target.value)}
            placeholder="例如：核心成员"
            maxLength={40}
          />
        </div>
        <div className="field">
          <label htmlFor="ov-add-email">邮箱</label>
          <input
            id="ov-add-email"
            className="input"
            type="email"
            value={form.email}
            onChange={(event) => setField("email", event.target.value)}
            placeholder="name@corp.example"
            maxLength={120}
          />
        </div>
        <div className="field span-2">
          <label htmlFor="ov-add-bio">个人简介</label>
          <textarea
            id="ov-add-bio"
            className="textarea"
            value={form.bio}
            onChange={(event) => setField("bio", event.target.value)}
            placeholder="一句话介绍这位伙伴擅长什么、正在关注什么。"
            maxLength={2000}
            rows={3}
          />
        </div>
        <div className="field span-2">
          <label htmlFor="ov-add-tags">标签</label>
          <input
            id="ov-add-tags"
            className="input"
            value={form.tags}
            onChange={(event) => setField("tags", event.target.value)}
            placeholder="用逗号分隔，例如：React, 设计系统, 性能优化"
          />
        </div>
        <div className="field span-2">
          <span className="field-label">头像颜色</span>
          <div className="ov-color-swatches" role="group" aria-label="选择头像颜色">
            {AVATAR_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className={cn("ov-color-swatch", form.avatarColor === color && "active")}
                style={{ background: color }}
                onClick={() => setField("avatarColor", color)}
                aria-label={`选择颜色 ${color}`}
                aria-pressed={form.avatarColor === color}
              />
            ))}
          </div>
        </div>
        {error ? (
          <p className="ov-form-error span-2" role="alert">
            {error}
          </p>
        ) : null}
        <div className="ov-form-meta span-2">
          <Clock size={12} />{" "}
          {scope === "group"
            ? "创建后会立即出现在成员档案与团队动态中。"
            : `将创建到：${currentGroup?.name ?? "当前开发组"}，创建后立即出现在成员档案中。`}
        </div>
      </form>
    </Modal>
  );
}
