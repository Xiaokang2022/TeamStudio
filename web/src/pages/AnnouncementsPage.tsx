import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  Info,
  Megaphone,
  PartyPopper,
  Pencil,
  Pin,
  Plus,
  Trash2,
  TriangleAlert,
  WifiOff,
} from "lucide-react";
import { api, ApiError } from "../api";
import { useApp } from "../store";
import { useToast } from "../components/Toast";
import { Avatar } from "../components/Avatar";
import { Modal, ConfirmDialog } from "../components/Modal";
import { EmptyState, LoadingBlock } from "../components/Feedback";
import { cn, formatDateTime, relativeTime } from "../lib/utils";
import type { Announcement } from "../types";
import "./AnnouncementsPage.css";

interface AnnouncementDraft {
  title: string;
  content: string;
  level: string;
  pinned: boolean;
}

const LEVEL_DESCRIPTIONS: Record<string, string> = {
  info: "常规通知与提醒",
  important: "需要重点关注的变更",
  celebration: "里程碑与值得庆祝的事",
};

const emptyDraft = (): AnnouncementDraft => ({ title: "", content: "", level: "info", pinned: false });

function levelMeta(level: string) {
  if (level === "important") return { label: "重要", tone: "important", icon: <TriangleAlert size={13} /> };
  if (level === "celebration") return { label: "庆祝", tone: "celebration", icon: <PartyPopper size={13} /> };
  return { label: "通知", tone: "info", icon: <Info size={13} /> };
}

const isExpandable = (content: string): boolean =>
  content.trim().length > 180 || content.split("\n").length > 4;

function GroupBadge({ name, color }: { name: string; color: string }) {
  return (
    <span className="badge badge-gray ann-group-badge" title={`所属开发组：${name}`}>
      <i className="dot" style={{ background: color }} />
      {name}
    </span>
  );
}

export default function AnnouncementsPage() {
  const { data, currentTeam, currentGroup, canManageActiveGroup, config, scope } = useApp();
  const { toast } = useToast();

  const teamId = currentTeam?.id ?? "";
  const groupId = currentGroup?.id ?? "";
  const aggregate = scope !== "group";
  const configuredMax = config?.announcements.maxPinned ?? 3;
  const maxPinned = Math.max(0, Math.min(3, configuredMax));

  // Resolve an announcement's owning group for badges and write routing.
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
    (announcement: Announcement) => {
      const meta = announcement.groupId ? groupIndex.get(announcement.groupId) : undefined;
      return {
        teamId: meta?.teamId || teamId,
        groupId: announcement.groupId || groupId,
        groupName: meta?.name || currentGroup?.name || "",
        groupColor: meta?.color || "#8b8c88",
      };
    },
    [groupIndex, teamId, groupId, currentGroup?.name],
  );

  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshTick, setRefreshTick] = useState(0);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Announcement | null>(null);
  const [draft, setDraft] = useState<AnnouncementDraft>(emptyDraft());
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Announcement | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [expandedIds, setExpandedIds] = useState<string[]>([]);

  const lastGroupRef = useRef("");

  useEffect(() => {
    if (!teamId || !groupId) return;
    if (lastGroupRef.current !== groupId) {
      lastGroupRef.current = groupId;
      setEditorOpen(false);
      setDeleteTarget(null);
      setExpandedIds([]);
      setAnnouncements([]);
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    void api
      .announcements(teamId, groupId, scope)
      .then((result) => {
        if (!cancelled) setAnnouncements(result.announcements);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof ApiError ? err.message : "公告加载失败，请稍后重试。";
        setError(message);
        toast(message, "error");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, groupId, scope, refreshTick, toast]);

  const sorted = useMemo(
    () =>
      [...announcements].sort((a, b) => {
        if (a.pinned !== b.pinned) return Number(b.pinned) - Number(a.pinned);
        const left = new Date(a.createdAt).getTime();
        const right = new Date(b.createdAt).getTime();
        if (Number.isNaN(left) || Number.isNaN(right)) return 0;
        return right - left;
      }),
    [announcements],
  );

  const pinnedCount = useMemo(() => announcements.filter((item) => item.pinned).length, [announcements]);
  const pinnedRemaining = Math.max(0, maxPinned - pinnedCount);

  const pinnedExcludingEditing = useMemo(
    () => announcements.filter((item) => item.pinned && item.id !== editing?.id).length,
    [announcements, editing?.id],
  );
  const pinLimitReached = pinnedExcludingEditing >= maxPinned;
  const pinDisabled = pinLimitReached && !draft.pinned;

  const reload = () => setRefreshTick((value) => value + 1);

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  const openCreate = () => {
    setEditing(null);
    setDraft(emptyDraft());
    setEditorOpen(true);
  };

  const openEdit = (announcement: Announcement) => {
    setEditing(announcement);
    setDraft({
      title: announcement.title,
      content: announcement.content ?? "",
      level: announcement.level || "info",
      pinned: Boolean(announcement.pinned),
    });
    setEditorOpen(true);
  };

  const handleSave = async () => {
    if (!teamId || !groupId) return;
    const title = draft.title.trim();
    if (!title) {
      toast("请填写公告标题", "error");
      return;
    }
    setSaving(true);
    try {
      const body = {
        title,
        content: draft.content.trim(),
        level: draft.level,
        pinned: draft.pinned,
      };
      if (editing) {
        const target = targetOf(editing);
        const result = await api.updateAnnouncement(target.teamId, target.groupId, editing.id, body);
        setAnnouncements((prev) => prev.map((item) => (item.id === result.announcement.id ? result.announcement : item)));
        toast("公告已更新", "success");
      } else {
        const result = await api.createAnnouncement(teamId, groupId, body);
        setAnnouncements((prev) => [result.announcement, ...prev]);
        toast(
          aggregate && currentGroup
            ? `公告已发布到「${currentGroup.name}」${draft.pinned ? "并置顶" : ""}`
            : draft.pinned
              ? "公告已发布并置顶"
              : "公告已发布",
          "success",
        );
      }
      setEditorOpen(false);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "保存失败，请稍后重试", "error");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!teamId || !groupId || !deleteTarget) return;
    const target = targetOf(deleteTarget);
    setDeleting(true);
    try {
      await api.deleteAnnouncement(target.teamId, target.groupId, deleteTarget.id);
      setAnnouncements((prev) => prev.filter((item) => item.id !== deleteTarget.id));
      setExpandedIds((prev) => prev.filter((id) => id !== deleteTarget.id));
      toast("公告已删除", "success");
      setDeleteTarget(null);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "删除失败，请稍后重试", "error");
    } finally {
      setDeleting(false);
    }
  };

  if (!currentTeam || !currentGroup) {
    return (
      <EmptyState
        title="尚未选择开发组"
        description="请从左侧导航选择一个开发组，再查看它的公告栏。"
        icon={<Megaphone size={24} />}
      />
    );
  }

  return (
    <div className="ann-page fade-up">
      <header className="page-header">
        <div className="page-heading">
          <span className="eyebrow">
            <Megaphone size={12} /> CULTURE / BROADCAST
          </span>
          <h1 className="page-title">公告栏</h1>
          <p className="page-subtitle">
            团队的重要通知、变更与里程碑都留在这里；置顶公告会同步出现在首页，确保关键信息不被刷走。
          </p>
        </div>
        <div className="page-actions">
          <div className="ann-slotmeter" title={`置顶 ${pinnedCount} / ${maxPinned}`}>
            <span className="ann-slotmeter-icon">
              <Pin size={13} />
            </span>
            <div className="ann-slotmeter-track">
              {Array.from({ length: maxPinned }, (_, index) => (
                <i key={index} className={index < pinnedCount ? "filled" : undefined} />
              ))}
            </div>
            <span className="ann-slotmeter-text">
              置顶 {pinnedCount} / {maxPinned}
            </span>
          </div>
          {canManageActiveGroup ? (
            <button type="button" className="btn btn-primary" onClick={openCreate}>
              <Plus size={15} /> 发布公告
            </button>
          ) : null}
        </div>
      </header>

      {error ? (
        <div className="inline-error">
          <WifiOff size={16} />
          <span>{error}</span>
          <button type="button" className="text-button" onClick={reload}>
            重试
          </button>
        </div>
      ) : null}

      {!loading && announcements.length > 0 ? (
        <div className="ann-statusline">
          <span>
            <Pin size={12} /> 置顶 {pinnedCount} / {maxPinned}
          </span>
          <span className={cn(pinnedRemaining === 0 && "is-full")}>
            {maxPinned === 0
              ? "设置中未开启置顶"
              : pinnedRemaining > 0
                ? `还可置顶 ${pinnedRemaining} 条`
                : "置顶位已满"}
          </span>
          <span className="ann-statusline-total">共 {announcements.length} 条公告</span>
        </div>
      ) : null}

      {loading && !announcements.length ? (
        <div className="panel">
          <div className="panel-body">
            <LoadingBlock label="正在加载公告…" rows={5} />
          </div>
        </div>
      ) : !loading && !announcements.length ? (
        <EmptyState
          title="公告栏还是空的"
          description={
            canManageActiveGroup
              ? "发布第一条公告，把重要的事固定下来——置顶后还会出现在首页。"
              : "管理员还没有发布公告，稍后再来看看吧。"
          }
          icon={<Megaphone size={24} />}
          action={
            canManageActiveGroup ? (
              <button type="button" className="btn btn-primary" onClick={openCreate}>
                <Plus size={15} /> 发布第一条公告
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="ann-list">
          {sorted.map((item) => {
            const meta = levelMeta(item.level);
            const expanded = expandedIds.includes(item.id);
            const expandable = isExpandable(item.content ?? "");
            return (
              <article
                key={item.id}
                className={cn("ann-card", `ann-${meta.tone}`, item.pinned && "is-pinned")}
              >
                <span className="ann-rail" />
                <div className="ann-body">
                  <header className="ann-head">
                    <span className="ann-level">
                      {meta.icon} {meta.label}
                    </span>
                    {item.pinned ? (
                      <span className="ann-pinned">
                        <Pin size={11} /> 置顶
                      </span>
                    ) : null}
                    {aggregate ? (
                      <GroupBadge name={targetOf(item).groupName} color={targetOf(item).groupColor} />
                    ) : null}
                    <time className="ann-time" dateTime={item.createdAt}>
                      {formatDateTime(item.createdAt)}
                    </time>
                    {canManageActiveGroup ? (
                      <div className="ann-actions">
                        <button
                          type="button"
                          className="icon-button ann-action"
                          onClick={() => openEdit(item)}
                          title="编辑公告"
                          aria-label={`编辑 ${item.title}`}
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          type="button"
                          className="icon-button ann-action danger"
                          onClick={() => setDeleteTarget(item)}
                          title="删除公告"
                          aria-label={`删除 ${item.title}`}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ) : null}
                  </header>
                  <h2 className="ann-title">{item.title}</h2>
                  {item.content ? (
                    <>
                      <p className={cn("ann-content", expandable && !expanded && "is-clamped")}>{item.content}</p>
                      {expandable ? (
                        <button type="button" className="ann-expand" onClick={() => toggleExpanded(item.id)}>
                          {expanded ? "收起" : "展开全文"}
                          <ChevronDown size={13} className={expanded ? "is-open" : undefined} />
                        </button>
                      ) : null}
                    </>
                  ) : null}
                  <footer className="ann-foot">
                    <Avatar name={item.authorName || "Admin"} size="xs" />
                    <strong>{item.authorName || "Admin"}</strong>
                    <span className="ann-foot-dot">·</span>
                    <time title={formatDateTime(item.createdAt)}>{relativeTime(item.createdAt)}</time>
                    {item.updatedAt && item.updatedAt !== item.createdAt ? (
                      <span className="ann-edited">已编辑</span>
                    ) : null}
                  </footer>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <Modal
        open={editorOpen}
        onClose={() => {
          if (!saving) setEditorOpen(false);
        }}
        title={editing ? "编辑公告" : "发布公告"}
        description={
          editing && aggregate
            ? `当前在聚合视角编辑「${targetOf(editing).groupName}」的公告，保存会写回该开发组。`
            : !editing && aggregate
              ? `聚合视角下发布的公告会写入当前开发组：${currentGroup?.name ?? "当前开发组"}。`
              : "公告发布后所有成员都能看到；置顶公告会同时出现在首页。"
        }
        size="lg"
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setEditorOpen(false)} disabled={saving}>
              取消
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void handleSave()} disabled={saving}>
              {saving ? "保存中…" : editing ? "保存修改" : draft.pinned ? "发布并置顶" : "发布公告"}
            </button>
          </>
        }
      >
        <div className="ann-form">
          <div className="field">
            <span className="field-label">标题</span>
            <input
              className="input"
              value={draft.title}
              maxLength={120}
              placeholder="例如：周五 16:00 全员同步会，请提前更新周报"
              onChange={(event) => setDraft((prev) => ({ ...prev, title: event.target.value }))}
              autoFocus
            />
          </div>
          <div className="field">
            <span className="field-label">内容</span>
            <textarea
              className="textarea ann-content-input"
              rows={7}
              maxLength={8000}
              value={draft.content}
              placeholder="写清楚背景、时间与需要大家做的事；支持换行，会保留段落格式。"
              onChange={(event) => setDraft((prev) => ({ ...prev, content: event.target.value }))}
            />
          </div>
          <div className="field">
            <span className="field-label">公告级别</span>
            <div className="ann-levels">
              {(["info", "important", "celebration"] as const).map((level) => {
                const meta = levelMeta(level);
                return (
                  <button
                    key={level}
                    type="button"
                    className={cn("ann-level-option", `ann-${meta.tone}`, draft.level === level && "active")}
                    onClick={() => setDraft((prev) => ({ ...prev, level }))}
                  >
                    <span className="ann-level-option-icon">{meta.icon}</span>
                    <span className="ann-level-option-copy">
                      <strong>{meta.label}</strong>
                      <small>{LEVEL_DESCRIPTIONS[level]}</small>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className={cn("ann-pin-row", pinDisabled && "is-disabled")}>
            <label className="switch">
              <input
                type="checkbox"
                checked={draft.pinned}
                disabled={pinDisabled}
                onChange={(event) => setDraft((prev) => ({ ...prev, pinned: event.target.checked }))}
              />
              <span className="switch-track" />
              <span className="ann-pin-label">
                <Pin size={13} /> 置顶这条公告
              </span>
            </label>
            <p className="ann-pin-hint">
              {maxPinned === 0
                ? "工作室设置中未开启公告置顶。"
                : pinLimitReached
                  ? `置顶位已满（最多 ${maxPinned} 条），请先取消其他公告的置顶。`
                  : `当前已有 ${pinnedExcludingEditing} 条置顶，最多可置顶 ${maxPinned} 条。`}
            </p>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除公告"
        message={`确定删除「${deleteTarget?.title ?? ""}」吗？删除后成员将无法再看到这条公告。`}
        confirmLabel="删除公告"
        onClose={() => {
          if (!deleting) setDeleteTarget(null);
        }}
        onConfirm={() => void handleDelete()}
        loading={deleting}
      />
    </div>
  );
}
