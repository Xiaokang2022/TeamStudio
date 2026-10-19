import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  ArrowUpRight,
  Copy,
  ExternalLink,
  Layers,
  Link2,
  Pencil,
  Plus,
  Search,
  Trash2,
  WifiOff,
  X,
} from "lucide-react";
import { api, ApiError } from "../api";
import { useApp } from "../store";
import { useToast } from "../components/Toast";
import { Modal, ConfirmDialog } from "../components/Modal";
import { EmptyState, LoadingBlock } from "../components/Feedback";
import { cn, copyText } from "../lib/utils";
import type { LinkItem } from "../types";
import "./LinksPage.css";

interface LinkDraft {
  title: string;
  url: string;
  description: string;
  category: string;
  color: string;
  sortOrder: string;
}

const COLOR_PRESETS = ["#5865f2", "#7c3aed", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#ec4899", "#14b8a6"];

const emptyDraft = (category: string, color: string): LinkDraft => ({
  title: "",
  url: "",
  description: "",
  category,
  color,
  sortOrder: "",
});

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

const linkMark = (title: string): string => {
  const trimmed = title.trim();
  if (!trimmed) return "链";
  if (/[\u4e00-\u9fa5]/.test(trimmed)) return trimmed.slice(0, 1);
  const parts = trimmed.split(/\s+/).filter(Boolean);
  return parts.length > 1 ? (parts[0][0] + parts[1][0]).toUpperCase() : trimmed.slice(0, 2).toUpperCase();
};

function GroupBadge({ name, color }: { name: string; color: string }) {
  return (
    <span className="badge badge-gray links-group-badge" title={`所属开发组：${name}`}>
      <i className="dot" style={{ background: color }} />
      {name}
    </span>
  );
}

export default function LinksPage() {
  const { data, currentTeam, currentGroup, canManageActiveGroup, config, scope } = useApp();
  const { toast } = useToast();

  const teamId = currentTeam?.id ?? "";
  const groupId = currentGroup?.id ?? "";
  const accent = config?.site.theme.accent || "#5865f2";
  const aggregate = scope !== "group";

  // Resolve a link's owning group for badges and item-level write routing.
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
    (link: LinkItem) => {
      const meta = link.groupId ? groupIndex.get(link.groupId) : undefined;
      return {
        teamId: meta?.teamId || teamId,
        groupId: link.groupId || groupId,
        groupName: meta?.name || currentGroup?.name || "",
        groupColor: meta?.color || "#8b8c88",
      };
    },
    [groupIndex, teamId, groupId, currentGroup?.name],
  );

  const [links, setLinks] = useState<LinkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshTick, setRefreshTick] = useState(0);
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<LinkItem | null>(null);
  const [draft, setDraft] = useState<LinkDraft>(emptyDraft("常用", "#5865f2"));
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<LinkItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const lastGroupRef = useRef("");

  useEffect(() => {
    if (!teamId || !groupId) return;
    if (lastGroupRef.current !== groupId) {
      lastGroupRef.current = groupId;
      setEditorOpen(false);
      setDeleteTarget(null);
      setLinks([]);
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    void api
      .links(teamId, groupId, scope)
      .then((result) => {
        if (!cancelled) setLinks(result.links);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof ApiError ? err.message : "常用链接加载失败，请稍后重试。";
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

  const sortedLinks = useMemo(
    () => [...links].sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title, "zh-CN")),
    [links],
  );

  const categories = useMemo(() => {
    const map = new Map<string, number>();
    sortedLinks.forEach((link) => {
      const name = link.category?.trim() || "常用";
      map.set(name, (map.get(name) ?? 0) + 1);
    });
    return Array.from(map, ([name, count]) => ({ name, count })).sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"),
    );
  }, [sortedLinks]);

  useEffect(() => {
    if (!activeCategory) return;
    if (!categories.some((category) => category.name === activeCategory)) setActiveCategory("");
  }, [activeCategory, categories]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return sortedLinks.filter((link) => {
      const category = link.category?.trim() || "常用";
      if (activeCategory && category !== activeCategory) return false;
      if (!keyword) return true;
      return `${link.title} ${link.description} ${link.url} ${category}`.toLowerCase().includes(keyword);
    });
  }, [sortedLinks, activeCategory, query]);

  const reload = () => setRefreshTick((value) => value + 1);

  const openCreate = () => {
    setEditing(null);
    setDraft(emptyDraft(activeCategory || categories[0]?.name || "常用", accent));
    setEditorOpen(true);
  };

  const openEdit = (link: LinkItem) => {
    setEditing(link);
    setDraft({
      title: link.title,
      url: link.url,
      description: link.description ?? "",
      category: link.category || "常用",
      color: link.color || accent,
      sortOrder: String(link.sortOrder ?? 0),
    });
    setEditorOpen(true);
  };

  const handleCopy = async (url: string) => {
    const ok = await copyText(url);
    toast(ok ? "链接已复制到剪贴板" : "复制失败，请手动选择链接", ok ? "success" : "error");
  };

  const handleSave = async () => {
    if (!teamId || !groupId) return;
    const title = draft.title.trim();
    const url = draft.url.trim();
    if (!title) {
      toast("请填写链接标题", "error");
      return;
    }
    if (!/^https?:\/\/.+/i.test(url)) {
      toast("链接地址需以 http:// 或 https:// 开头", "error");
      return;
    }
    const sortOrder = draft.sortOrder.trim();
    if (sortOrder !== "" && !Number.isFinite(Number(sortOrder))) {
      toast("排序需要是数字", "error");
      return;
    }
    setSaving(true);
    try {
      const body = {
        title,
        url,
        description: draft.description.trim(),
        category: draft.category.trim() || "常用",
        color: draft.color,
        sortOrder: sortOrder === "" ? undefined : Number(sortOrder),
      };
      if (editing) {
        const target = targetOf(editing);
        const result = await api.updateLink(target.teamId, target.groupId, editing.id, body);
        setLinks((prev) => prev.map((item) => (item.id === result.link.id ? result.link : item)));
        toast("链接已更新", "success");
      } else {
        const result = await api.createLink(teamId, groupId, body);
        setLinks((prev) => [...prev, result.link]);
        toast(
          aggregate && currentGroup ? `链接已添加到「${currentGroup.name}」` : "链接已添加",
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
      await api.deleteLink(target.teamId, target.groupId, deleteTarget.id);
      setLinks((prev) => prev.filter((item) => item.id !== deleteTarget.id));
      toast("链接已删除", "success");
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
        description="请从左侧导航选择一个开发组，再查看它的常用链接。"
        icon={<Link2 size={24} />}
      />
    );
  }

  const hasFilters = Boolean(query.trim()) || Boolean(activeCategory);

  return (
    <div className="links-page fade-up">
      <header className="page-header">
        <div className="page-heading">
          <span className="eyebrow">
            <Layers size={12} /> WORKSPACE / BOOKMARKS
          </span>
          <h1 className="page-title">常用链接</h1>
          <p className="page-subtitle">
            把团队反复用到的文档、看板与工具收进同一块看板，少问一句「链接发我一下」。
          </p>
        </div>
        <div className="page-actions">
          <label className="search-box links-search">
            <Search size={15} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索标题、描述或域名"
              aria-label="搜索链接"
            />
            {query ? (
              <button type="button" className="links-search-clear" onClick={() => setQuery("")} aria-label="清空搜索">
                <X size={13} />
              </button>
            ) : null}
          </label>
          {canManageActiveGroup ? (
            <button type="button" className="btn btn-primary" onClick={openCreate}>
              <Plus size={15} /> 添加链接
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

      {!loading && links.length > 0 ? (
        <div className="links-filterbar">
          <div className="links-chips">
            <button
              type="button"
              className={cn("links-chip", activeCategory === "" && "active")}
              onClick={() => setActiveCategory("")}
            >
              <span>全部</span>
              <small>{sortedLinks.length}</small>
            </button>
            {categories.map((category) => (
              <button
                key={category.name}
                type="button"
                className={cn("links-chip", activeCategory === category.name && "active")}
                onClick={() => setActiveCategory(category.name)}
              >
                <span>{category.name}</span>
                <small>{category.count}</small>
              </button>
            ))}
          </div>
          <span className="links-result-count">
            {hasFilters ? `筛选出 ${filtered.length} 个链接` : `共 ${sortedLinks.length} 个链接 · ${categories.length} 个分类`}
          </span>
        </div>
      ) : null}

      {loading && !links.length ? (
        <div className="panel">
          <div className="panel-body">
            <LoadingBlock label="正在加载常用链接…" rows={5} />
          </div>
        </div>
      ) : !loading && !links.length ? (
        <EmptyState
          title="还没有常用链接"
          description={
            canManageActiveGroup
              ? "把文档、看板、设计稿的入口添加到这里，团队就不用再到处找链接了。"
              : "管理员还没有整理常用链接，稍后再来看看吧。"
          }
          icon={<Link2 size={24} />}
          action={
            canManageActiveGroup ? (
              <button type="button" className="btn btn-primary" onClick={openCreate}>
                <Plus size={15} /> 添加第一个链接
              </button>
            ) : undefined
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          title="没有匹配的链接"
          description="试试其他关键词，或切换分类查看。"
          icon={<Search size={24} />}
          action={
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setQuery("");
                setActiveCategory("");
              }}
            >
              清除筛选
            </button>
          }
        />
      ) : (
        <div className="links-grid" key={`${activeCategory}|${query}|${filtered.length}`}>
          {filtered.map((link) => (
            <article
              className="links-card"
              key={link.id}
              style={{ "--link-color": link.color || accent } as CSSProperties}
            >
              <div className="links-card-top">
                <span className="links-favicon">{linkMark(link.title)}</span>
                <div className="links-card-titles">
                  <a
                    className="links-card-title"
                    href={link.url}
                    target="_blank"
                    rel="noreferrer"
                    title={link.title}
                  >
                    <span>{link.title}</span>
                    <ArrowUpRight size={13} />
                  </a>
                  <span className="links-card-host">{hostOf(link.url)}</span>
                </div>
              </div>
              <p className={cn("links-card-desc", !link.description && "muted")}>
                {link.description || "暂无描述"}
              </p>
              <footer className="links-card-foot">
                <span className="links-cat">
                  <Layers size={12} /> {link.category || "常用"}
                </span>
                {aggregate ? (
                  <GroupBadge name={targetOf(link).groupName} color={targetOf(link).groupColor} />
                ) : null}
                <div className="links-card-actions">
                  <button
                    type="button"
                    className="icon-button links-action"
                    onClick={() => void handleCopy(link.url)}
                    title="复制链接"
                    aria-label={`复制 ${link.title} 的链接`}
                  >
                    <Copy size={14} />
                  </button>
                  <a
                    className="icon-button links-action"
                    href={link.url}
                    target="_blank"
                    rel="noreferrer"
                    title="在新标签页打开"
                    aria-label={`打开 ${link.title}`}
                  >
                    <ExternalLink size={14} />
                  </a>
                  {canManageActiveGroup ? (
                    <>
                      <button
                        type="button"
                        className="icon-button links-action"
                        onClick={() => openEdit(link)}
                        title="编辑链接"
                        aria-label={`编辑 ${link.title}`}
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        type="button"
                        className="icon-button links-action danger"
                        onClick={() => setDeleteTarget(link)}
                        title="删除链接"
                        aria-label={`删除 ${link.title}`}
                      >
                        <Trash2 size={14} />
                      </button>
                    </>
                  ) : null}
                </div>
              </footer>
            </article>
          ))}
        </div>
      )}

      <Modal
        open={editorOpen}
        onClose={() => {
          if (!saving) setEditorOpen(false);
        }}
        title={editing ? "编辑链接" : "添加链接"}
        description={
          editing && aggregate
            ? `当前在聚合视角编辑「${targetOf(editing).groupName}」的链接，保存会写回该开发组。`
            : !editing && aggregate
              ? `聚合视角下新增的链接会写入当前开发组：${currentGroup?.name ?? "当前开发组"}。`
              : "链接会按分类展示在团队常用链接看板中，分类留空时归入「常用」。"
        }
        size="lg"
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setEditorOpen(false)} disabled={saving}>
              取消
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void handleSave()} disabled={saving}>
              {saving ? "保存中…" : editing ? "保存修改" : "添加链接"}
            </button>
          </>
        }
      >
        <div className="links-form">
          <div className="form-grid">
            <div className="field span-2">
              <span className="field-label">标题</span>
              <input
                className="input"
                value={draft.title}
                maxLength={80}
                placeholder="例如：团队周报模板"
                onChange={(event) => setDraft((prev) => ({ ...prev, title: event.target.value }))}
                autoFocus
              />
            </div>
            <div className="field span-2">
              <span className="field-label">链接地址</span>
              <input
                className="input"
                value={draft.url}
                maxLength={500}
                placeholder="https://"
                onChange={(event) => setDraft((prev) => ({ ...prev, url: event.target.value }))}
              />
              <span className="field-hint">需要是完整的 http(s) 地址，保存前会做一次校验。</span>
            </div>
            <div className="field">
              <span className="field-label">分类</span>
              <input
                className="input"
                list="links-category-options"
                value={draft.category}
                maxLength={40}
                placeholder="常用"
                onChange={(event) => setDraft((prev) => ({ ...prev, category: event.target.value }))}
              />
              <datalist id="links-category-options">
                {categories.map((category) => (
                  <option key={category.name} value={category.name} />
                ))}
              </datalist>
            </div>
            <div className="field">
              <span className="field-label">排序（可选）</span>
              <input
                className="input"
                type="number"
                min={0}
                max={100000}
                value={draft.sortOrder}
                placeholder="自动追加"
                onChange={(event) => setDraft((prev) => ({ ...prev, sortOrder: event.target.value }))}
              />
            </div>
            <div className="field span-2">
              <span className="field-label">描述</span>
              <textarea
                className="textarea"
                rows={3}
                maxLength={500}
                value={draft.description}
                placeholder="一句话说明这个链接的用途"
                onChange={(event) => setDraft((prev) => ({ ...prev, description: event.target.value }))}
              />
            </div>
            <div className="field span-2">
              <span className="field-label">强调色</span>
              <div className="links-swatches">
                {COLOR_PRESETS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={cn("links-swatch", draft.color.toLowerCase() === color && "active")}
                    style={{ background: color }}
                    onClick={() => setDraft((prev) => ({ ...prev, color }))}
                    aria-label={`使用颜色 ${color}`}
                    title={color}
                  />
                ))}
                <label className="links-swatch-custom" title="自定义颜色">
                  <input
                    type="color"
                    value={draft.color}
                    onChange={(event) => setDraft((prev) => ({ ...prev, color: event.target.value }))}
                  />
                  <span>自定义</span>
                </label>
              </div>
            </div>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除链接"
        message={`确定删除「${deleteTarget?.title ?? ""}」吗？删除后其他成员将无法再看到该入口。`}
        confirmLabel="删除链接"
        onClose={() => {
          if (!deleting) setDeleteTarget(null);
        }}
        onConfirm={() => void handleDelete()}
        loading={deleting}
      />
    </div>
  );
}
