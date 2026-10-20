import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Building2,
  CalendarClock,
  Camera,
  Check,
  History,
  Layers3,
  ListTodo,
  Loader2,
  Mail,
  RotateCcw,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  Trophy,
  UserRound,
  Waypoints,
  X,
} from "lucide-react";
import { api, ApiError } from "../api";
import { useApp } from "../store";
import { useToast } from "../components/Toast";
import { Avatar } from "../components/Avatar";
import { EmptyState, PageLoading } from "../components/Feedback";
import {
  cn,
  dueLabel,
  formatDate,
  formatFullDate,
  hashRoute,
  PRIORITY_META as TODO_PRIORITY_META,
} from "../lib/utils";
import { PRIORITY_META as TASK_PRIORITY_META, TASK_PROGRESS_META } from "../lib/taskMeta";
import type {
  ProfileAdminScope,
  ProfileData,
  ProfileDuty,
  ProfileMember,
  ProfileTodo,
  TodoPriority,
} from "../types";
import "./ProfilePage.css";

const AVATAR_COLORS = ["#7c3aed", "#2563eb", "#0ea5e9", "#16a34a", "#ea8a14", "#dc2626", "#db2777", "#4f6f8f"];
const ACCEPTED_AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const MAX_SKILLS = 20;
const MAX_SKILL_LENGTH = 30;
const MAX_BIO_LENGTH = 2000;

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  return fallback;
}

function roleBadgeClass(role: string): string {
  if (role === "super") return "badge-green";
  if (role === "team_admin") return "badge-violet";
  if (role === "group_admin") return "badge-blue";
  return "badge-gray";
}

function todoPriorityBadge(priority: TodoPriority): string {
  if (priority === "urgent") return "badge-red";
  if (priority === "high") return "badge-orange";
  if (priority === "normal") return "badge-blue";
  return "badge-gray";
}

function uniqueNames(values: Array<string | undefined | null>): string[] {
  return Array.from(new Set(values.map((value) => (value || "").trim()).filter(Boolean)));
}

function GroupBadges({ teamName, groupName }: { teamName?: string | null; groupName?: string | null }) {
  if (!teamName && !groupName) return null;
  return (
    <span className="profile-group-badges">
      {teamName ? (
        <span className="badge badge-gray" title={`团队：${teamName}`}>
          <Building2 size={11} /> {teamName}
        </span>
      ) : null}
      {groupName ? (
        <span className="badge badge-blue" title={`开发组：${groupName}`}>
          <Layers3 size={11} /> {groupName}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Public administrator scope: which teams / development groups this account
 * administers. Super administrators intentionally get no extra chips (their
 * role badge already says everything); regular members get nothing either.
 * The data is public, so it renders on other people's profile pages too.
 */
function AdminScopeChips({ scope }: { scope: ProfileAdminScope }) {
  if (scope.role === "team_admin") {
    if (!scope.teams.length) return null;
    return (
      <div className="profile-admin-scope" role="group" aria-label="管理员管理范围">
        <span className="profile-admin-scope-label">
          <ShieldCheck size={12} /> 管理范围
        </span>
        {scope.teams.map((team) => (
          <span className="chip profile-admin-scope-chip" key={team.id} title={`管理团队：${team.name}`}>
            <Building2 size={11} />
            <span>{team.name}</span>
            <span className="profile-admin-scope-role">· 团队管理员</span>
          </span>
        ))}
      </div>
    );
  }
  if (scope.role === "group_admin") {
    if (!scope.groups.length) return null;
    return (
      <div className="profile-admin-scope" role="group" aria-label="管理员管理范围">
        <span className="profile-admin-scope-label">
          <ShieldCheck size={12} /> 管理范围
        </span>
        {scope.groups.map((group) => (
          <span
            className="chip profile-admin-scope-chip"
            key={group.id}
            title={
              group.teamName
                ? `${group.name} · 开发组管理员（所属团队：${group.teamName}）`
                : `${group.name} · 开发组管理员`
            }
          >
            <Layers3 size={11} />
            <span>{group.name}</span>
            <span className="profile-admin-scope-role">· 开发组管理员</span>
            {group.teamName ? (
              <span className="profile-chip-muted">· 团队：{group.teamName}</span>
            ) : null}
          </span>
        ))}
      </div>
    );
  }
  return null;
}

function SectionCard({
  icon,
  title,
  count,
  wide = false,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  count: number;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("card profile-section", wide && "profile-section-wide")}>
      <div className="profile-section-head">
        <div className="profile-section-title">
          <span className="profile-section-icon">{icon}</span>
          <h2>{title}</h2>
          <span className="badge badge-gray">{count}</span>
        </div>
      </div>
      {children}
    </section>
  );
}

function MemberChips({ members }: { members: ProfileMember[] }) {
  if (!members.length) {
    return <span className="chip">暂未关联成员档案</span>;
  }
  return (
    <>
      {members.map((member) => (
        <span className="chip" key={member.id} title={`${member.teamName} / ${member.groupName}`}>
          <UserRound size={11} /> {member.name}
          {member.groupName ? <span className="profile-chip-muted">· {member.groupName}</span> : null}
        </span>
      ))}
    </>
  );
}

export default function ProfilePage() {
  const { data, navigate, reload } = useApp();
  const { toast } = useToast();
  const [params, setParams] = useState<URLSearchParams>(() => hashRoute().params);
  const targetUserId = (params.get("userId") || "").trim();

  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [skillDraft, setSkillDraft] = useState("");
  const [form, setForm] = useState({ name: "", avatarColor: "#7c3aed", bio: "", skills: [] as string[] });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      setError("");
      try {
        const result = targetUserId ? await api.getUserProfile(targetUserId) : await api.getProfile();
        setProfile(result);
        setForm({
          name: result.user.name || "",
          avatarColor: result.user.avatarColor || "#7c3aed",
          bio: result.user.bio || "",
          skills: [...(result.user.skills || [])],
        });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          setError("请先登录后再查看个人主页");
        } else {
          setError(errorMessage(err, "加载个人主页失败，请稍后重试"));
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [targetUserId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onHashChange = () => setParams(hashRoute().params);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const teamNames = useMemo(() => uniqueNames(profile?.members.map((m) => m.teamName) ?? []), [profile]);
  const groupNames = useMemo(() => uniqueNames(profile?.members.map((m) => m.groupName) ?? []), [profile]);
  const isSelf = Boolean(profile?.isSelf);
  const canEdit = Boolean(profile?.isSelf && profile?.canEdit);
  const readOnlySuperView = Boolean(profile && !profile.isSelf && profile.canEdit);
  const me = data?.me;

  const dirty = Boolean(
    profile &&
      (form.name !== (profile.user.name || "") ||
        form.bio !== (profile.user.bio || "") ||
        form.avatarColor !== (profile.user.avatarColor || "") ||
        form.skills.slice().sort().join("\u0001") !== [...(profile.user.skills || [])].sort().join("\u0001")),
  );

  const setField = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const addSkill = () => {
    const value = skillDraft.trim();
    if (!value) return;
    if (value.length > MAX_SKILL_LENGTH) {
      toast(`单个技能标签不能超过 ${MAX_SKILL_LENGTH} 个字符`, "error");
      return;
    }
    if (form.skills.includes(value)) {
      toast("该技能标签已存在", "info");
      setSkillDraft("");
      return;
    }
    if (form.skills.length >= MAX_SKILLS) {
      toast(`技能标签最多 ${MAX_SKILLS} 个`, "error");
      return;
    }
    setField("skills", [...form.skills, value]);
    setSkillDraft("");
  };

  const removeSkill = (skill: string) => {
    setField("skills", form.skills.filter((item) => item !== skill));
  };

  const resetForm = () => {
    if (!profile) return;
    setForm({
      name: profile.user.name || "",
      avatarColor: profile.user.avatarColor || "#7c3aed",
      bio: profile.user.bio || "",
      skills: [...(profile.user.skills || [])],
    });
  };

  const handleSave = async () => {
    const name = form.name.trim();
    if (!name) {
      toast("用户名不能为空", "error");
      return;
    }
    if (name.length > 60) {
      toast("用户名长度需在 1–60 个字符之间", "error");
      return;
    }
    if (form.bio.length > MAX_BIO_LENGTH) {
      toast(`个人简介不能超过 ${MAX_BIO_LENGTH} 个字符`, "error");
      return;
    }
    setSaving(true);
    try {
      const result = await api.updateProfile({
        name,
        avatarColor: form.avatarColor,
        bio: form.bio,
        skills: form.skills,
      });
      setProfile((current) =>
        current ? { ...current, user: { ...current.user, ...result.user } } : current,
      );
      toast("个人资料已保存", "success");
      await reload(true);
      await load(true);
    } catch (err) {
      toast(errorMessage(err, "保存个人资料失败，请稍后重试"), "error");
    } finally {
      setSaving(false);
    }
  };

  const handleAvatarFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!ACCEPTED_AVATAR_TYPES.includes(file.type)) {
      toast("头像仅支持 PNG / JPEG / WebP / GIF 格式", "error");
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      toast("头像图片不能超过 2MB", "error");
      return;
    }
    setUploading(true);
    try {
      const result = await api.uploadAvatar(file);
      setProfile((current) =>
        current ? { ...current, user: { ...current.user, avatar: result.avatar } } : current,
      );
      toast("头像已更新", "success");
      await reload(true);
    } catch (err) {
      toast(errorMessage(err, "头像上传失败，请稍后重试"), "error");
    } finally {
      setUploading(false);
    }
  };

  const handleDeleteAvatar = async () => {
    setUploading(true);
    try {
      await api.deleteAvatar();
      setProfile((current) => (current ? { ...current, user: { ...current.user, avatar: "" } } : current));
      toast("已恢复默认头像", "success");
      await reload(true);
    } catch (err) {
      toast(errorMessage(err, "恢复默认头像失败，请稍后重试"), "error");
    } finally {
      setUploading(false);
    }
  };

  if (loading && !profile) return <PageLoading />;

  if (error && !profile) {
    return (
      <div className="profile-page">
        <EmptyState
          icon={<UserRound size={24} />}
          title="无法打开个人主页"
          description={error}
          action={
            <div className="profile-error-actions">
              <button className="btn btn-primary btn-sm" onClick={() => void load()}>
                <RotateCcw size={14} /> 重试
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => navigate("login")}>
                前往登录
              </button>
            </div>
          }
        />
      </div>
    );
  }

  if (!profile) return null;

  const user = profile.user;
  const displayName = user.name || user.email || "未命名成员";
  const stats = [
    { label: "责任田", value: profile.stats.duties },
    { label: "当前任务", value: profile.stats.currentTasks },
    { label: "历史任务", value: profile.stats.completedTasks },
    { label: "待办", value: profile.stats.openTodos },
    { label: "红榜", value: profile.stats.redEntries },
    { label: "黑榜", value: profile.stats.blackEntries },
  ];
  const redEntries = profile.redblack.red;
  const blackEntries = profile.redblack.black;
  const memberTaskCount = profile.members.length;

  return (
    <div className="profile-page fade-up">
      <header className="page-header">
        <div className="page-heading">
          <span className="eyebrow">
            <Sparkles size={12} /> MEMBER PROFILE
          </span>
          <h1 className="page-title">{isSelf ? "个人主页" : `${displayName} 的主页`}</h1>
          <p className="page-subtitle">
            {isSelf
              ? "维护个人信息，并查看你关联的责任田、任务、待办与红黑榜记录。"
              : "查看成员的基础信息与协作记录。他人的个人资料仅本人或超级管理员可修改。"}
          </p>
        </div>
        <div className="page-actions">
          {readOnlySuperView ? (
            <span className="badge badge-gray">
              <ShieldCheck size={12} /> 只读查看 · 账号管理可修改资料
            </span>
          ) : null}
          <button className="btn btn-secondary btn-sm" onClick={() => navigate("overview")}>
            返回团队概览
          </button>
          {canEdit ? (
            <button
              className="btn btn-primary btn-sm"
              onClick={() => document.getElementById("profile-settings")?.scrollIntoView({ behavior: "smooth" })}
            >
              编辑个人资料
            </button>
          ) : null}
        </div>
      </header>

      <section className="card profile-hero">
        <div className="profile-hero-main">
          <Avatar name={displayName} src={user.avatar} color={user.avatarColor || "#7c3aed"} size="xl" />
          <div className="profile-identity">
            <div className="profile-name-row">
              <h2>{displayName}</h2>
              <span className={cn("badge", roleBadgeClass(user.role))}>
                <ShieldCheck size={12} />{" "}
                {user.isDeviceAdmin ? "超级管理员" : user.roleLabel || "成员"}
              </span>
              {user.isDeviceAdmin ? <span className="badge badge-green">系统内置</span> : null}
              {user.isDeviceAdmin ? null : user.emailVerified ? (
                <span className="badge badge-blue">邮箱已验证</span>
              ) : (
                <span className="badge badge-orange">待激活</span>
              )}
              {!isSelf ? <span className="badge badge-gray">他人主页</span> : null}
            </div>
            <p className="profile-email">
              <Mail size={14} /> {user.email || "未绑定邮箱"}
            </p>
            {profile.adminScope ? <AdminScopeChips scope={profile.adminScope} /> : null}
            <div className="profile-chip-row">
              {teamNames.map((name) => (
                <span className="chip" key={`team-${name}`}>
                  <Building2 size={11} /> {name}
                </span>
              ))}
              {groupNames.map((name) => (
                <span className="chip" key={`group-${name}`}>
                  <Layers3 size={11} /> {name}
                </span>
              ))}
              <MemberChips members={profile.members} />
            </div>
            <p className="profile-joined">
              {user.createdAt
                ? `加入时间：${formatFullDate(user.createdAt)} · 关联 ${memberTaskCount} 个成员档案`
                : "系统内置身份 · 未关联成员档案"}
            </p>
          </div>
        </div>
        <div className="profile-stats">
          {stats.map((item) => (
            <div className="profile-stat" key={item.label}>
              <strong>{item.value}</strong>
              <span>{item.label}</span>
            </div>
          ))}
        </div>
      </section>

      {canEdit ? (
        <section className="card profile-settings" id="profile-settings">
          <div className="profile-section-head">
            <div className="profile-section-title">
              <span className="profile-section-icon">
                <UserRound size={16} />
              </span>
              <h2>个人设置</h2>
              <span className="badge badge-gray">仅本人与超级管理员可编辑</span>
            </div>
            <div className="profile-settings-actions">
              <button className="btn btn-ghost btn-sm" onClick={resetForm} disabled={saving || !dirty}>
                <RotateCcw size={14} /> 重置
              </button>
              <button className="btn btn-primary btn-sm" onClick={() => void handleSave()} disabled={saving || !dirty}>
                {saving ? <Loader2 size={14} className="spin" /> : <Save size={14} />}
                {saving ? "保存中…" : "保存修改"}
              </button>
            </div>
          </div>

          <div className="profile-settings-body">
            <div className="profile-avatar-editor">
              <Avatar
                name={form.name || displayName}
                src={user.avatar}
                color={form.avatarColor}
                size="xl"
              />
              <div className="profile-avatar-actions">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  hidden
                  onChange={(event) => void handleAvatarFile(event)}
                />
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                >
                  {uploading ? <Loader2 size={14} className="spin" /> : <Camera size={14} />} 上传头像
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => void handleDeleteAvatar()}
                  disabled={uploading || !user.avatar}
                >
                  <Trash2 size={14} /> 恢复默认头像
                </button>
                <span className="field-hint">支持 PNG / JPEG / WebP / GIF，单张不超过 2MB。</span>
              </div>
            </div>

            <div className="profile-settings-grid">
              <div className="field">
                <label htmlFor="profile-name">用户名</label>
                <input
                  id="profile-name"
                  className="input"
                  value={form.name}
                  maxLength={60}
                  placeholder="请输入用户名"
                  onChange={(event) => setField("name", event.target.value)}
                />
                <span className="field-hint">用户名会同步展示在关联的成员档案中。</span>
              </div>
              <div className="field">
                <label htmlFor="profile-email">登录邮箱</label>
                <input id="profile-email" className="input" value={user.email || "未绑定邮箱"} disabled readOnly />
                <span className="field-hint">登录邮箱由账号体系管理，如需变更请联系超级管理员。</span>
              </div>

              <div className="field profile-field-full">
                <span className="field-label">头像颜色</span>
                <div className="profile-color-row">
                  <div className="profile-color-swatches" role="group" aria-label="选择头像颜色">
                    {AVATAR_COLORS.map((color) => (
                      <button
                        key={color}
                        type="button"
                        className={cn("profile-color-swatch", form.avatarColor === color && "active")}
                        style={{ background: color }}
                        onClick={() => setField("avatarColor", color)}
                        aria-label={`头像颜色 ${color}`}
                        aria-pressed={form.avatarColor === color}
                      >
                        {form.avatarColor === color ? <Check size={12} /> : null}
                      </button>
                    ))}
                  </div>
                  <input
                    type="color"
                    className="profile-color-input"
                    value={form.avatarColor}
                    aria-label="自定义头像颜色"
                    onChange={(event) => setField("avatarColor", event.target.value)}
                  />
                </div>
              </div>

              <div className="field profile-field-full">
                <span className="field-label">
                  技能标签 <span className="profile-field-count">{form.skills.length}/{MAX_SKILLS}</span>
                </span>
                <div className="profile-skill-editor">
                  <div className="tag-list">
                    {form.skills.length ? (
                      form.skills.map((skill) => (
                        <span className="chip profile-skill-chip" key={skill}>
                          {skill}
                          <button
                            type="button"
                            className="profile-skill-remove"
                            onClick={() => removeSkill(skill)}
                            aria-label={`移除技能 ${skill}`}
                          >
                            <X size={11} />
                          </button>
                        </span>
                      ))
                    ) : (
                      <span className="profile-field-empty">还没有技能标签，添加后展示在你的个人主页。</span>
                    )}
                  </div>
                  <div className="profile-skill-input">
                    <input
                      className="input"
                      value={skillDraft}
                      maxLength={MAX_SKILL_LENGTH}
                      placeholder="例如：前端开发、数据分析"
                      onChange={(event) => setSkillDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          addSkill();
                        }
                      }}
                    />
                    <button
                      className="btn btn-secondary btn-sm"
                      type="button"
                      onClick={addSkill}
                      disabled={!skillDraft.trim() || form.skills.length >= MAX_SKILLS}
                    >
                      添加
                    </button>
                  </div>
                  <span className="field-hint">
                    最多 {MAX_SKILLS} 个标签，单个标签不超过 {MAX_SKILL_LENGTH} 个字符。
                  </span>
                </div>
              </div>

              <div className="field profile-field-full">
                <label htmlFor="profile-bio">
                  个人简介 <span className="profile-field-count">{form.bio.length}/{MAX_BIO_LENGTH}</span>
                </label>
                <textarea
                  id="profile-bio"
                  className="textarea"
                  rows={4}
                  maxLength={MAX_BIO_LENGTH}
                  placeholder="介绍一下你的职责、专长与协作方式…"
                  value={form.bio}
                  onChange={(event) => setField("bio", event.target.value)}
                />
              </div>
            </div>
          </div>
        </section>
      ) : null}

      <div className="profile-grid">
        <SectionCard icon={<Waypoints size={16} />} title="责任田" count={profile.duties.length}>
          {profile.duties.length ? (
            <div className="profile-list">
              {profile.duties.map((duty: ProfileDuty) => (
                <div className="profile-row" key={duty.id}>
                  <div className="profile-row-main">
                    <div className="profile-row-title">
                      <strong>{duty.area}</strong>
                      <span className={cn("badge", duty.role === "owner" ? "badge-green" : "badge-blue")}>
                        {duty.role === "owner" ? "负责人" : "备份"}
                      </span>
                    </div>
                    <span className="profile-row-desc">{duty.description || "暂无职责说明"}</span>
                    {duty.channel || duty.contact ? (
                      <span className="profile-row-meta">
                        {[duty.channel, duty.contact].filter(Boolean).join(" · ")}
                      </span>
                    ) : null}
                  </div>
                  <GroupBadges teamName={duty.teamName} groupName={duty.groupName} />
                </div>
              ))}
            </div>
          ) : (
            <div className="profile-empty">暂无责任田记录</div>
          )}
        </SectionCard>

        <SectionCard icon={<ListTodo size={16} />} title="当前任务" count={profile.currentTasks.length}>
          {profile.currentTasks.length ? (
            <div className="profile-list">
              {profile.currentTasks.map((task) => (
                <div className="profile-row" key={task.id}>
                  <div className="profile-row-main">
                    <div className="profile-row-title">
                      <strong>{task.title}</strong>
                      <span className={cn("badge", TASK_PROGRESS_META[task.progressStatus].badge)}>
                        {TASK_PROGRESS_META[task.progressStatus].label}
                      </span>
                    </div>
                    <span className="profile-row-desc">{task.description || "暂无任务描述"}</span>
                    <div className="profile-row-meta">
                      <span className={cn("badge", TASK_PRIORITY_META[task.priority].badge)}>
                        {TASK_PRIORITY_META[task.priority].label}优先级
                      </span>
                      <span>预计 {formatDate(task.expectedDate)}</span>
                      {task.overdue ? <span className="badge badge-red">已逾期</span> : null}
                      {memberTaskCount > 1 ? <span>{task.memberName}</span> : null}
                    </div>
                  </div>
                  <GroupBadges teamName={task.teamName} groupName={task.groupName} />
                </div>
              ))}
            </div>
          ) : (
            <div className="profile-empty">暂无进行中的任务</div>
          )}
        </SectionCard>

        <SectionCard icon={<History size={16} />} title="历史任务" count={profile.historyTasks.length}>
          {profile.historyTasks.length ? (
            <div className="profile-list">
              {profile.historyTasks.map((task) => (
                <div className="profile-row" key={task.id}>
                  <div className="profile-row-main">
                    <div className="profile-row-title">
                      <strong>{task.title}</strong>
                      <span className="badge badge-green">已完成</span>
                    </div>
                    <span className="profile-row-desc">{task.description || "暂无任务描述"}</span>
                    <div className="profile-row-meta">
                      <span>
                        {task.completedAt ? `完成于 ${formatDate(task.completedAt)}` : `预计 ${formatDate(task.expectedDate)}`}
                      </span>
                      {task.tags?.length ? (
                        <span className="tag-list">
                          {task.tags.map((tag) => (
                            <span className="chip" key={tag.id}>
                              {tag.name}
                            </span>
                          ))}
                        </span>
                      ) : null}
                      {memberTaskCount > 1 ? <span>{task.memberName}</span> : null}
                    </div>
                  </div>
                  <GroupBadges teamName={task.teamName} groupName={task.groupName} />
                </div>
              ))}
            </div>
          ) : (
            <div className="profile-empty">暂无历史任务</div>
          )}
        </SectionCard>

        <SectionCard icon={<CalendarClock size={16} />} title="待办" count={profile.todos.length}>
          {profile.todos.length ? (
            <div className="profile-list">
              {profile.todos.map((todo: ProfileTodo) => {
                const due = dueLabel(todo);
                const dueTone =
                  due.tone === "danger"
                    ? "badge-red"
                    : due.tone === "warning"
                      ? "badge-orange"
                      : due.tone === "muted"
                        ? "badge-gray"
                        : "badge-blue";
                return (
                  <div className="profile-row" key={todo.id}>
                    <div className="profile-row-main">
                      <div className="profile-row-title">
                        <strong className={cn(todo.status === "done" && "profile-done-text")}>{todo.title}</strong>
                        <span className={cn("badge", todoPriorityBadge(todo.priority))}>
                          {TODO_PRIORITY_META[todo.priority].label}
                        </span>
                      </div>
                      <div className="profile-row-meta">
                        <span className={cn("badge", dueTone)}>{due.label}</span>
                        <span>截止 {formatDate(todo.dueDate)}</span>
                        {todo.status === "done" ? <span className="badge badge-green">已完成</span> : null}
                      </div>
                    </div>
                    <GroupBadges teamName={todo.teamName} groupName={todo.groupName} />
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="profile-empty">暂无待办事项</div>
          )}
        </SectionCard>

        <SectionCard icon={<Trophy size={16} />} title="红黑榜记录" count={redEntries.length + blackEntries.length} wide>
          {redEntries.length || blackEntries.length ? (
            <div className="profile-rb">
              <div className="profile-rb-column">
                <div className="profile-rb-heading is-red">红榜 · {redEntries.length}</div>
                {redEntries.length ? (
                  redEntries.map((entry) => (
                    <div className="profile-rb-entry" key={entry.id}>
                      <div className="profile-row-title">
                        <strong>{entry.title}</strong>
                        <span className="badge badge-red">红榜</span>
                        <span className="profile-rb-month">{entry.month}</span>
                      </div>
                      <span className="profile-row-desc">{entry.reason || "暂无上榜理由"}</span>
                      <div className="profile-row-meta">
                        <span>{entry.memberName}</span>
                        <GroupBadges teamName={entry.teamName} groupName={entry.groupName} />
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="profile-empty">暂无红榜记录</div>
                )}
              </div>
              <div className="profile-rb-column">
                <div className="profile-rb-heading is-black">黑榜 · {blackEntries.length}</div>
                {blackEntries.length ? (
                  blackEntries.map((entry) => (
                    <div className="profile-rb-entry" key={entry.id}>
                      <div className="profile-row-title">
                        <strong>{entry.title}</strong>
                        <span className="badge badge-gray">黑榜</span>
                        <span className="profile-rb-month">{entry.month}</span>
                      </div>
                      <span className="profile-row-desc">{entry.reason || "暂无上榜理由"}</span>
                      <div className="profile-row-meta">
                        <span>{entry.memberName}</span>
                        <GroupBadges teamName={entry.teamName} groupName={entry.groupName} />
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="profile-empty">暂无黑榜记录</div>
                )}
              </div>
            </div>
          ) : (
            <div className="profile-empty">暂无红黑榜记录</div>
          )}
        </SectionCard>
      </div>

      {me && isSelf && !canEdit ? (
        <div className="profile-readonly-hint">
          <ShieldCheck size={14} />
          当前身份不支持在此修改个人资料（例如系统内置管理员），如有需要请联系超级管理员。
        </div>
      ) : null}
    </div>
  );
}
