import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import {
  AtSign,
  Briefcase,
  Building2,
  CalendarDays,
  CheckCircle2,
  Clock,
  Gauge,
  History,
  ListTodo,
  Mail,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert,
  UserRound,
  UserX,
  X,
} from "lucide-react";
import { api, ApiError } from "../api";
import { useApp } from "../store";
import { useToast } from "./Toast";
import { Avatar } from "./Avatar";
import { ConfirmDialog, Modal } from "./Modal";
import { EmptyState } from "./Feedback";
import { Select } from "./Select";
import {
  canEditPersonalInfo,
  cn,
  formatDate,
  formatDateTime,
  isLinkedMember,
  relativeTime,
} from "../lib/utils";
import { formatPercent, formatPoints, WORKLOAD_LEVEL_META, workloadLevel } from "../lib/taskMeta";
import type { Member, MemberMembership, WorkItem, WorkStatus, Workload } from "../types";

const WORK_STATUS_META: Record<WorkStatus, { label: string; badge: string }> = {
  current: { label: "进行中", badge: "badge-violet" },
  done: { label: "已完成", badge: "badge-green" },
  planned: { label: "计划中", badge: "badge-gray" },
};

const WORK_STATUS_OPTIONS: WorkStatus[] = ["current", "planned", "done"];

const AVATAR_COLORS = ["#7c3aed", "#2563eb", "#0ea5e9", "#16a34a", "#ea8a14", "#dc2626", "#db2777"];

/** Exit animation budget (#5): keep the drawer mounted for a short slide/fade. */
const CLOSE_ANIMATION_MS = 190;

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

export interface MemberDrawerProps {
  open: boolean;
  member: Member | null;
  teamId: string;
  workload?: Workload | null;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}

export function MemberDrawer({
  open,
  member: memberProp,
  teamId,
  workload: workloadProp = null,
  onClose,
  onChanged,
}: MemberDrawerProps) {
  const { data, navigate, canManageActiveTeam, currentTeam } = useApp();
  const { toast } = useToast();
  const user = data?.me ?? null;

  const [profileOpen, setProfileOpen] = useState(false);
  const [workDialog, setWorkDialog] = useState<{ open: boolean; work: WorkItem | null }>({
    open: false,
    work: null,
  });
  const [workToDelete, setWorkToDelete] = useState<WorkItem | null>(null);
  const [deleteMemberOpen, setDeleteMemberOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // #5 close animation: stay mounted for one exit beat instead of returning null.
  const [closing, setClosing] = useState(false);
  const [visibleMember, setVisibleMember] = useState<Member | null>(open ? memberProp : null);
  const [visibleWorkload, setVisibleWorkload] = useState<Workload | null>(workloadProp);
  const closeTimer = useRef<number | null>(null);
  const lastMemberRef = useRef<Member | null>(open ? memberProp : null);

  useEffect(() => {
    setProfileOpen(false);
    setWorkDialog({ open: false, work: null });
    setWorkToDelete(null);
    setDeleteMemberOpen(false);
    setDeleting(false);
  }, [memberProp?.id]);

  useEffect(() => {
    if (open && memberProp) lastMemberRef.current = memberProp;
  }, [open, memberProp]);

  useEffect(() => {
    if (open) {
      // Re-opening during the exit beat cancels the close.
      if (closeTimer.current !== null) {
        window.clearTimeout(closeTimer.current);
        closeTimer.current = null;
      }
      setClosing(false);
      setVisibleMember(memberProp ?? lastMemberRef.current);
      return;
    }
    const snapshot = lastMemberRef.current;
    if (!snapshot) return;
    setVisibleMember((current) => current ?? snapshot);
    setClosing(true);
    if (closeTimer.current === null) {
      closeTimer.current = window.setTimeout(() => {
        closeTimer.current = null;
        setClosing(false);
        setVisibleMember(null);
        setVisibleWorkload(null);
      }, CLOSE_ANIMATION_MS);
    }
  }, [open, memberProp]);

  useEffect(() => {
    if (open) setVisibleWorkload(workloadProp);
  }, [open, workloadProp]);

  useEffect(
    () => () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    },
    [],
  );

  const mounted = open || closing;

  useEffect(() => {
    if (!mounted) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [mounted, onClose]);

  const handleDeleteWork = useCallback(async () => {
    if (!workToDelete) return;
    setDeleting(true);
    try {
      await api.deleteWork(teamId, workToDelete.memberId, workToDelete.id);
      toast("工作项已删除", "success");
      setWorkToDelete(null);
      await onChanged();
    } catch (error) {
      toast(messageOf(error, "删除工作项失败，请稍后重试。"), "error");
    } finally {
      setDeleting(false);
    }
  }, [workToDelete, teamId, toast, onChanged]);

  const handleDeleteMember = useCallback(async () => {
    if (!memberProp) return;
    setDeleting(true);
    try {
      await api.deleteMember(teamId, memberProp.id);
      toast(`成员「${memberProp.name}」已删除`, "success");
      setDeleteMemberOpen(false);
      onClose();
      await onChanged();
    } catch (error) {
      toast(messageOf(error, "删除成员失败，请稍后重试。"), "error");
    } finally {
      setDeleting(false);
    }
  }, [memberProp, teamId, toast, onClose, onChanged]);

  // Keep the last member/workload snapshot rendered while the drawer slides out.
  const shownMember = (open ? memberProp : null) ?? visibleMember;
  if (!shownMember) return null;

  const member = shownMember;
  const workload = (open ? workloadProp : null) ?? visibleWorkload;
  const isAdmin = canManageActiveTeam;
  const canEditPersonal = canEditPersonalInfo(user, member);
  const canEditOrg = canManageActiveTeam;
  // Work items are maintained by team admins or the linked owner.
  const canEdit = canEditOrg || canEditPersonal;
  const isSelf = isLinkedMember(user, member);

  // Every team archive of this person. The backend returns `memberships` for the
  // team read model; fall back to the member's own team fields.
  const memberships: MemberMembership[] = member.memberships?.length
    ? member.memberships
    : member.teamId || member.teamName
      ? [
          {
            memberId: member.id,
            teamId: member.teamId ?? teamId,
            teamName: member.teamName ?? currentTeam?.name ?? "",
            title: member.title,
            role: member.role,
            joinedAt: member.joinedAt,
          },
        ]
      : [];
  const primaryMembership = memberships[0] ?? null;
  const membershipsTitle = memberships.length
    ? `所属团队：${memberships.map((item) => item.teamName).filter(Boolean).join("、")}`
    : undefined;
  const membershipMeta = (item: MemberMembership) => {
    const title = item.title || (item.memberId === member.id ? member.title : "");
    const role = item.role || (item.memberId === member.id ? member.role : "");
    return [title, role].filter(Boolean).join(" · ") || "团队成员";
  };

  const workloadLevelMeta = workload
    ? WORKLOAD_LEVEL_META[workloadLevel(workload.currentLoadPercent)] ?? WORKLOAD_LEVEL_META.balanced
    : null;
  const latestUpdate = [...member.currentWorks, ...member.historyWorks]
    .map((work) => work.updatedAt)
    .filter(Boolean)
    .sort()
    .pop();
  const extraSkills = member.skills.filter((skill) => !member.tags.includes(skill));

  const handleWorkSaved = async () => {
    setWorkDialog({ open: false, work: null });
    await onChanged();
  };

  const handleProfileSaved = async () => {
    setProfileOpen(false);
    await onChanged();
  };

  return createPortal(
    <div className={cn("md-layer", closing && "is-closing")} role="presentation" aria-hidden={closing || undefined}>
      <button className="md-scrim" type="button" onClick={onClose} aria-label="关闭成员档案" />
      <aside
        className="md-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="md-title"
      >
        <header className="md-hero">
          <div className="md-hero-glow" aria-hidden="true" />
          <div className="md-hero-top">
            <span className="md-hero-label">
              <UserRound size={13} /> MEMBER PROFILE · 成员档案
            </span>
            <button className="icon-button md-close" type="button" onClick={onClose} aria-label="关闭成员档案">
              <X size={18} />
            </button>
          </div>
          <div className="md-hero-main">
            <Avatar
              name={member.name}
              src={member.avatar}
              color={member.avatarColor}
              size="xl"
              className="md-hero-avatar"
            />
            <div className="md-hero-copy">
              <h2 id="md-title">{member.name}</h2>
              <p>
                {member.title || "团队成员"}
                {member.role ? ` · ${member.role}` : ""}
              </p>
              <div className="md-hero-badges">
                {primaryMembership?.teamName ? (
                  <span className="badge" title={membershipsTitle}>
                    <Building2 size={11} /> {primaryMembership.teamName}
                  </span>
                ) : null}
                {isSelf ? <span className="badge">这是我</span> : null}
                {isAdmin ? <span className="badge">{isSelf ? "管理员" : "管理员视角"}</span> : null}
                {!canEdit ? <span className="badge">只读</span> : null}
              </div>
            </div>
          </div>
          <div className="md-hero-stats">
            <div>
              <strong>{member.stats.current}</strong>
              <span>进行中</span>
            </div>
            <div>
              <strong>{member.stats.done}</strong>
              <span>已完成</span>
            </div>
            <div>
              <strong>{member.stats.todos}</strong>
              <span>待办</span>
            </div>
          </div>
        </header>

        <div className="md-body">
          <section className="md-section">
            <div className="md-meta-grid">
              <div className="md-meta">
                <span className="md-meta-icon">
                  <Mail size={14} />
                </span>
                <span>
                  <small>邮箱</small>
                  <strong>{member.email || "未填写"}</strong>
                </span>
              </div>
              <div className="md-meta">
                <span className="md-meta-icon">
                  <CalendarDays size={14} />
                </span>
                <span>
                  <small>加入时间</small>
                  <strong>
                    {member.joinedAt
                      ? formatDate(member.joinedAt, { year: "numeric", month: "long", day: "numeric" })
                      : "—"}
                  </strong>
                </span>
              </div>
              <div className="md-meta">
                <span className="md-meta-icon">
                  <AtSign size={14} />
                </span>
                <span>
                  <small>团队角色</small>
                  <strong>{member.role || "成员"}</strong>
                </span>
              </div>
              <div className="md-meta">
                <span className="md-meta-icon">
                  <Clock size={14} />
                </span>
                <span>
                  <small>最近更新</small>
                  <strong>{latestUpdate ? relativeTime(latestUpdate) : "—"}</strong>
                </span>
              </div>
            </div>
          </section>

          <section className="md-section">
            <h3 className="md-section-title">
              <Building2 size={15} /> 所属团队
              <span className="md-section-count">{memberships.length}</span>
            </h3>
            {memberships.length ? (
              <ul className="md-memberships" aria-label="所属团队">
                {memberships.map((item, index) => {
                  const isPrimary = index === 0;
                  return (
                    <li
                      className="md-membership"
                      key={`${item.teamId || item.memberId || "team"}-${index}`}
                    >
                      <span className="md-membership-dot" aria-hidden="true" />
                      <div className="md-membership-main">
                        <div className="md-membership-head">
                          <span className="badge md-membership-team">
                            <Building2 size={10} /> {item.teamName || "未命名团队"}
                          </span>
                          {isPrimary ? <span className="badge">主档案</span> : null}
                        </div>
                        <span className="md-membership-meta">{membershipMeta(item)}</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="md-bio">暂未关联任何团队档案。</p>
            )}
          </section>

          {workload && workloadLevelMeta ? (
            <section className="md-section">
              <h3 className="md-section-title">
                <Gauge size={15} /> 工作量负载
              </h3>
              <div className="workload">
                <div className="workload-head">
                  <span className="workload-title">当前负载</span>
                  <span className={cn("load-pill", workloadLevelMeta.className)}>
                    {workloadLevelMeta.label} · {formatPercent(workload.currentLoadPercent)}
                  </span>
                </div>
                <div
                  className="workload-bar"
                  role="img"
                  aria-label={`当前负载 ${formatPercent(workload.currentLoadPercent)}`}
                >
                  <span
                    className={cn("workload-fill", workloadLevelMeta.className)}
                    style={{ width: `${Math.min(100, Math.max(0, workload.currentLoadPercent))}%` }}
                  />
                </div>
                <div className="workload-meta">
                  <span>
                    {formatPoints(workload.currentPoints)} / {formatPoints(workload.capacityPoints)}
                  </span>
                  <span>
                    近 {workload.windowWeeks} 周平均 {formatPoints(workload.averagePoints)} ·{" "}
                    {formatPercent(workload.averageLoadPercent)}
                  </span>
                </div>
              </div>
              <div className="md-meta-grid">
                <div className="md-meta">
                  <span className="md-meta-icon">
                    <ListTodo size={14} />
                  </span>
                  <span>
                    <small>未完成任务</small>
                    <strong>{workload.openTasks}</strong>
                  </span>
                </div>
                <div className="md-meta">
                  <span className="md-meta-icon">
                    <CheckCircle2 size={14} />
                  </span>
                  <span>
                    <small>已完成任务</small>
                    <strong>{workload.completedTasks}</strong>
                  </span>
                </div>
                <div className="md-meta">
                  <span className="md-meta-icon">
                    <TriangleAlert size={14} />
                  </span>
                  <span>
                    <small>阻塞任务</small>
                    <strong>{workload.blockedTasks}</strong>
                  </span>
                </div>
                <div className="md-meta">
                  <span className="md-meta-icon">
                    <Clock size={14} />
                  </span>
                  <span>
                    <small>逾期任务</small>
                    <strong>{workload.overdueTasks}</strong>
                  </span>
                </div>
              </div>
            </section>
          ) : null}

          <section className="md-section">
            <h3 className="md-section-title">
              <UserRound size={15} /> 个人简介
            </h3>
            <p className="md-bio">{member.bio || "这位成员还没有填写个人简介。"}</p>
            {member.tags.length ? (
              <div className="tag-list md-tags" aria-label="个人标签">
                {member.tags.map((tag) => (
                  <span className="chip" key={tag}>
                    #{tag}
                  </span>
                ))}
              </div>
            ) : null}
            {extraSkills.length ? (
              <div className="tag-list md-tags" aria-label="技能标签">
                {extraSkills.map((skill) => (
                  <span className="chip" key={`skill-${skill}`}>
                    <CheckCircle2 size={10} /> {skill}
                  </span>
                ))}
              </div>
            ) : null}
            {member.duties.length ? (
              <div className="tag-list md-tags" aria-label="职责">
                {member.duties.map((duty) => (
                  <span className="chip" key={`duty-${duty}`}>
                    {duty}
                  </span>
                ))}
              </div>
            ) : null}
          </section>

          <section className="md-section">
            <div className="md-section-head">
              <h3 className="md-section-title">
                <Briefcase size={15} /> 当前工作
                <span className="md-section-count">{member.currentWorks.length}</span>
              </h3>
              {canEdit ? (
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => setWorkDialog({ open: true, work: null })}
                >
                  <Plus size={14} /> 添加工作
                </button>
              ) : null}
            </div>
            {member.currentWorks.length ? (
              <div className="md-work-list">
                {member.currentWorks.map((work) => (
                  <WorkCard
                    key={work.id}
                    work={work}
                    canEdit={canEdit}
                    onEdit={() => setWorkDialog({ open: true, work })}
                    onDelete={() => setWorkToDelete(work)}
                  />
                ))}
              </div>
            ) : (
              <EmptyState
                compact
                icon={<Briefcase size={22} />}
                title="暂时没有进行中的工作"
                description={canEdit ? "记录正在推进的事情，团队动态也会同步更新。" : "负责人更新后会显示在这里。"}
                action={
                  canEdit ? (
                    <button className="btn btn-secondary btn-sm" onClick={() => setWorkDialog({ open: true, work: null })}>
                      <Plus size={14} /> 添加工作
                    </button>
                  ) : null
                }
              />
            )}
          </section>

          <section className="md-section">
            <div className="md-section-head">
              <h3 className="md-section-title">
                <History size={15} /> 历史工作
                <span className="md-section-count">{member.historyWorks.length}</span>
              </h3>
            </div>
            {member.historyWorks.length ? (
              <ol className="md-history">
                {member.historyWorks.map((work) => (
                  <li className="md-history-item" key={work.id}>
                    <span className="md-history-dot">
                      <CheckCircle2 size={13} />
                    </span>
                    <div className="md-history-body">
                      <div className="md-history-head">
                        <strong>{work.title}</strong>
                        <div className="md-history-actions">
                          {canEdit ? (
                            <>
                              <button
                                className="icon-button"
                                type="button"
                                onClick={() => setWorkDialog({ open: true, work })}
                                aria-label={`编辑历史工作 ${work.title}`}
                              >
                                <Pencil size={12} />
                              </button>
                              <button
                                className="icon-button danger"
                                type="button"
                                onClick={() => setWorkToDelete(work)}
                                aria-label={`删除历史工作 ${work.title}`}
                              >
                                <Trash2 size={12} />
                              </button>
                            </>
                          ) : null}
                        </div>
                      </div>
                      <div className="md-history-meta">
                        {[work.category, work.period].filter(Boolean).join(" · ") || "未分类"}
                        <span>·</span>
                        <span>{formatDateTime(work.updatedAt)}</span>
                      </div>
                      {work.description ? <p className="md-history-desc">{work.description}</p> : null}
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <EmptyState
                compact
                icon={<History size={22} />}
                title="还没有历史工作"
                description="完成的工作会沉淀在这里，成为成长轨迹的一部分。"
              />
            )}
          </section>
        </div>

        <footer className="md-footer">
          <p className="md-footer-note">
            {canEdit
              ? isSelf
                ? canEditOrg
                  ? "你可以维护自己的个人资料、当前工作与历史工作，也可以调整组织信息。"
                  : "你可以维护自己的个人资料、当前工作与历史工作。"
                : canEditPersonal
                  ? "超级管理员可以维护该成员的全部档案信息。"
                  : "你可以维护该成员的职位与团队角色。"
              : "只读视图，仅本人或管理员可以编辑。"}
          </p>
          <div className="md-footer-actions">
            {isSelf ? (
              <button className="btn btn-ghost" onClick={() => navigate("profile")}>
                <UserRound size={15} /> 个人主页
              </button>
            ) : null}
            {canEdit ? (
              <button className="btn btn-secondary" onClick={() => setProfileOpen(true)}>
                <Pencil size={15} /> 编辑资料
              </button>
            ) : null}
            {isAdmin ? (
              <button
                className="btn btn-danger"
                onClick={() => setDeleteMemberOpen(true)}
                disabled={isSelf}
                title={isSelf ? "不能删除与当前登录身份关联的成员" : undefined}
              >
                <UserX size={15} /> 删除成员
              </button>
            ) : null}
          </div>
        </footer>
      </aside>

      <ProfileEditDialog
        open={open && profileOpen && Boolean(member)}
        member={member}
        teamId={teamId}
        personalEditable={canEditPersonal}
        orgEditable={canEditOrg}
        onClose={() => setProfileOpen(false)}
        onSaved={handleProfileSaved}
      />

      <WorkEditDialog
        open={open && workDialog.open}
        work={workDialog.work}
        memberId={member.id}
        teamId={teamId}
        onClose={() => setWorkDialog({ open: false, work: null })}
        onSaved={handleWorkSaved}
      />

      <ConfirmDialog
        open={open && Boolean(workToDelete)}
        title="删除工作项"
        message={`确定删除「${workToDelete?.title ?? ""}」吗？删除后无法恢复。`}
        confirmLabel="删除工作项"
        loading={deleting}
        onClose={() => setWorkToDelete(null)}
        onConfirm={() => void handleDeleteWork()}
      />

      <ConfirmDialog
        open={open && deleteMemberOpen}
        title="删除成员"
        message={`确定删除成员「${member.name}」吗？该成员的档案与工作项会被移除，相关待办将变为未指派。`}
        confirmLabel="删除成员"
        loading={deleting}
        onClose={() => setDeleteMemberOpen(false)}
        onConfirm={() => void handleDeleteMember()}
      />
    </div>,
    document.body,
  );
}

interface WorkCardProps {
  work: WorkItem;
  canEdit: boolean;
  onEdit: () => void;
  onDelete: () => void;
}

function WorkCard({ work, canEdit, onEdit, onDelete }: WorkCardProps) {
  const meta = WORK_STATUS_META[work.status] ?? WORK_STATUS_META.current;
  const progress = Math.max(0, Math.min(100, work.progress));
  return (
    <article className="md-work">
      <div className="md-work-head">
        <div>
          <strong>{work.title}</strong>
          <span className="md-work-meta">
            {[work.category, work.period].filter(Boolean).join(" · ") || "未分类"}
          </span>
        </div>
        <span className={cn("badge", meta.badge)}>{meta.label}</span>
      </div>
      {work.description ? <p>{work.description}</p> : null}
      <div className="md-progress">
        <div className="md-progress-track">
          <span style={{ width: `${progress}%` }} />
        </div>
        <span>{progress}%</span>
      </div>
      <div className="md-work-foot">
        <span>更新于 {formatDateTime(work.updatedAt)}</span>
        {canEdit ? (
          <div className="md-work-actions">
            <button
              className="icon-button"
              type="button"
              onClick={onEdit}
              aria-label={`编辑工作 ${work.title}`}
            >
              <Pencil size={13} />
            </button>
            <button
              className="icon-button danger"
              type="button"
              onClick={onDelete}
              aria-label={`删除工作 ${work.title}`}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

interface ProfileEditDialogProps {
  open: boolean;
  member: Member;
  teamId: string;
  /** Personal fields (name / email / bio / tags / skills / avatar color). */
  personalEditable: boolean;
  /** Organizational fields (title / role). */
  orgEditable: boolean;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}

function ProfileEditDialog({
  open,
  member,
  teamId,
  personalEditable,
  orgEditable,
  onClose,
  onSaved,
}: ProfileEditDialogProps) {
  const { toast } = useToast();
  const [name, setName] = useState(member.name);
  const [title, setTitle] = useState(member.title);
  const [role, setRole] = useState(member.role);
  const [email, setEmail] = useState(member.email);
  const [bio, setBio] = useState(member.bio);
  const [tags, setTags] = useState(member.tags.join(", "));
  const [skills, setSkills] = useState(member.skills.join(", "));
  const [avatarColor, setAvatarColor] = useState(member.avatarColor || AVATAR_COLORS[0]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(member.name);
    setTitle(member.title);
    setRole(member.role);
    setEmail(member.email);
    setBio(member.bio);
    setTags(member.tags.join(", "));
    setSkills(member.skills.join(", "));
    setAvatarColor(member.avatarColor || AVATAR_COLORS[0]);
    setSaving(false);
    setError("");
  }, [open, member]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (personalEditable && !name.trim()) {
      setError("姓名不能为空。");
      return;
    }
    // Only send the field groups the current identity may change; the backend
    // rejects organisational admins who touch personal information.
    const payload: Partial<Member> = {};
    if (personalEditable) {
      payload.name = name.trim();
      payload.email = email.trim();
      payload.bio = bio.trim();
      payload.tags = splitList(tags);
      payload.skills = splitList(skills);
      payload.avatarColor = avatarColor;
    }
    if (orgEditable) {
      payload.title = title.trim();
      payload.role = role.trim();
    }
    if (!Object.keys(payload).length) {
      setError("当前身份没有可编辑的字段。");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await api.updateMember(teamId, member.id, payload);
      toast("成员资料已更新", "success");
      await onSaved();
      onClose();
    } catch (err) {
      setError(messageOf(err, "保存成员资料失败，请稍后重试。"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={personalEditable ? "编辑成员资料" : "编辑组织信息"}
      description={
        personalEditable
          ? `正在编辑 ${member.name} 的个人档案与组织信息。`
          : `正在编辑 ${member.name} 的职位与团队角色。`
      }
      size="md"
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button className="btn btn-primary" type="submit" form="md-profile-form" disabled={saving}>
            {saving ? "保存中…" : "保存资料"}
          </button>
        </>
      }
    >
      <form id="md-profile-form" className="form-grid" onSubmit={submit}>
        {!personalEditable || !orgEditable ? (
          <p className="md-perm-note span-2" role="note">
            <TriangleAlert size={13} />
            <span>
              {!personalEditable
                ? "姓名、邮箱、个人简介、标签、技能与头像颜色属于个人信息，仅本人或超级管理员可以修改。"
                : "职位与团队角色由团队管理员维护。"}
            </span>
          </p>
        ) : null}

        <p className="md-form-group-title span-2">个人信息</p>
        <div className="field">
          <label htmlFor="md-profile-name">姓名 *</label>
          <input
            id="md-profile-name"
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={60}
            required
            disabled={!personalEditable}
          />
        </div>
        <div className="field">
          <label htmlFor="md-profile-email">邮箱</label>
          <input
            id="md-profile-email"
            className="input"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            maxLength={120}
            disabled={!personalEditable}
          />
        </div>
        <div className="field span-2">
          <label htmlFor="md-profile-bio">个人简介</label>
          <textarea
            id="md-profile-bio"
            className="textarea"
            value={bio}
            onChange={(event) => setBio(event.target.value)}
            maxLength={2000}
            rows={3}
            disabled={!personalEditable}
          />
        </div>
        <div className="field span-2">
          <label htmlFor="md-profile-tags">标签</label>
          <input
            id="md-profile-tags"
            className="input"
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder="用逗号分隔，例如：React, 设计系统"
            disabled={!personalEditable}
          />
        </div>
        <div className="field span-2">
          <label htmlFor="md-profile-skills">技能</label>
          <input
            id="md-profile-skills"
            className="input"
            value={skills}
            onChange={(event) => setSkills(event.target.value)}
            placeholder="用逗号分隔，例如：TypeScript, 可视化"
            disabled={!personalEditable}
          />
        </div>
        <div className="field span-2">
          <span className="field-label">头像颜色</span>
          <div className="ov-color-swatches" role="group" aria-label="选择头像颜色">
            {AVATAR_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className={cn("ov-color-swatch", avatarColor === color && "active")}
                style={{ background: color }}
                onClick={() => setAvatarColor(color)}
                aria-label={`选择颜色 ${color}`}
                aria-pressed={avatarColor === color}
                disabled={!personalEditable}
              />
            ))}
          </div>
        </div>

        <p className="md-form-group-title span-2">组织信息</p>
        <div className="field">
          <label htmlFor="md-profile-title">职位</label>
          <input
            id="md-profile-title"
            className="input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={60}
            disabled={!orgEditable}
          />
        </div>
        <div className="field">
          <label htmlFor="md-profile-role">团队角色</label>
          <input
            id="md-profile-role"
            className="input"
            value={role}
            onChange={(event) => setRole(event.target.value)}
            maxLength={40}
            disabled={!orgEditable}
          />
        </div>

        {error ? (
          <p className="md-form-error" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

interface WorkEditDialogProps {
  open: boolean;
  work: WorkItem | null;
  memberId: string;
  teamId: string;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}

function WorkEditDialog({ open, work, memberId, teamId, onClose, onSaved }: WorkEditDialogProps) {
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<WorkStatus>("current");
  const [period, setPeriod] = useState("");
  const [category, setCategory] = useState("");
  const [progress, setProgress] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setTitle(work?.title ?? "");
    setDescription(work?.description ?? "");
    setStatus(work?.status ?? "current");
    setPeriod(work?.period ?? "");
    setCategory(work?.category ?? "");
    setProgress(work?.progress ?? (work?.status === "done" ? 100 : 0));
    setSaving(false);
    setError("");
  }, [open, work]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!title.trim()) {
      setError("请填写工作标题。");
      return;
    }
    setSaving(true);
    setError("");
    const payload = {
      title: title.trim(),
      description: description.trim(),
      status,
      period: period.trim(),
      category: category.trim(),
      progress: Math.max(0, Math.min(100, Math.round(progress))),
    };
    try {
      if (work) {
        await api.updateWork(teamId, memberId, work.id, payload);
        toast("工作项已更新", "success");
      } else {
        await api.createWork(teamId, memberId, payload);
        toast("工作项已添加", "success");
      }
      await onSaved();
      onClose();
    } catch (err) {
      setError(messageOf(err, "保存工作项失败，请稍后重试。"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={work ? "编辑工作项" : "添加工作项"}
      description="当前工作会展示在成员卡片上，历史工作会沉淀为成长轨迹。"
      size="md"
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button className="btn btn-primary" type="submit" form="md-work-form" disabled={saving}>
            {saving ? "保存中…" : work ? "保存工作" : "添加工作"}
          </button>
        </>
      }
    >
      <form id="md-work-form" className="form-grid" onSubmit={submit}>
        <div className="field span-2">
          <label htmlFor="md-work-title">工作标题 *</label>
          <input
            id="md-work-title"
            className="input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="例如：协作日历 2.0 重构"
            maxLength={120}
            required
            autoFocus
          />
        </div>
        <div className="field">
          <label htmlFor="md-work-status">状态</label>
          <Select
            id="md-work-status"
            value={status}
            onChange={(value) => setStatus((value || "current") as WorkStatus)}
            options={WORK_STATUS_OPTIONS.map((value) => ({
              value,
              label: WORK_STATUS_META[value].label,
            }))}
            ariaLabel="工作状态"
          />
        </div>
        <div className="field">
          <label htmlFor="md-work-period">周期</label>
          <input
            id="md-work-period"
            className="input"
            value={period}
            onChange={(event) => setPeriod(event.target.value)}
            placeholder="例如：2026 Q4"
            maxLength={60}
          />
        </div>
        <div className="field span-2">
          <label htmlFor="md-work-category">分类</label>
          <input
            id="md-work-category"
            className="input"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            placeholder="例如：体验工程"
            maxLength={60}
          />
        </div>
        <div className="field span-2">
          <span className="field-label">
            <ListTodo size={12} /> 进度
          </span>
          <div className="md-range-row">
            <input
              id="md-work-progress"
              className="md-range"
              type="range"
              min={0}
              max={100}
              step={5}
              value={progress}
              onChange={(event) => setProgress(Number(event.target.value))}
              aria-label="工作进度"
            />
            <span className="md-range-value">{progress}%</span>
          </div>
        </div>
        <div className="field span-2">
          <label htmlFor="md-work-description">工作描述</label>
          <textarea
            id="md-work-description"
            className="textarea"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="补充目标、进展或协作说明。"
            maxLength={2000}
            rows={3}
          />
        </div>
        {error ? (
          <p className="md-form-error" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
