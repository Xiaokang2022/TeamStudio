/**
 * Task tag UI.
 *
 * A team-shared tag library: every logged-in member can create, rename,
 * recolor and delete labels. `TagPicker` is embedded in `TaskDialog`; the
 * `TagLibraryDialog` is opened from the task overview page and reuses the
 * same inline `TagManager` rows.
 *
 * The backend contract is:
 *   GET    /api/teams/{team}/task-tags              -> { tags }
 *   POST   /api/teams/{team}/task-tags { name, color } -> { tag }
 *   PATCH  /api/teams/{team}/task-tags/{id}         -> { tag }
 *   DELETE /api/teams/{team}/task-tags/{id}         -> { deleted }
 * While the endpoint is still being implemented the component degrades to an
 * inline error state instead of breaking the task dialog.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  AlertCircle,
  Ban,
  Check,
  Pencil,
  Plus,
  RefreshCw,
  Tags,
  Trash2,
  X,
} from "lucide-react";
import { api, ApiError } from "../api";
import { useToast } from "./Toast";
import { Modal } from "./Modal";
import { cn } from "../lib/utils";
import { TAG_COLORS, tagColorFor } from "../lib/utils";
import type { TaskTag } from "../types";
import "./TagPicker.css";

export interface TagLibraryApi {
  tags: TaskTag[];
  setTags: (tags: TaskTag[]) => void;
  loading: boolean;
  error: string;
  reload: (silent?: boolean) => Promise<void>;
}

const TAG_NAME_MAX = 20;
const MAX_TASK_TAGS = 8;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function messageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function tagStyle(color: string): CSSProperties {
  return { "--tag-color": HEX_COLOR.test(color || "") ? color : TAG_COLORS[0] } as CSSProperties;
}

function safeColor(color: string | undefined, index = 0): string {
  return color && HEX_COLOR.test(color) ? color : tagColorFor(index);
}

/** Load the tag library of one team. */
export function useTagLibrary(teamId: string): TagLibraryApi {
  const [tags, setTags] = useState<TaskTag[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef(0);

  const reload = useCallback(
    async (silent = false) => {
      if (!teamId) {
        setTags([]);
        setLoading(false);
        setError("");
        return;
      }
      const id = ++requestId.current;
      if (!silent) setLoading(true);
      try {
        const data = await api.taskTags(teamId);
        if (id !== requestId.current) return;
        setTags(data.tags ?? []);
        setError("");
      } catch (err) {
        if (id !== requestId.current) return;
        setTags([]);
        setError(messageOf(err, "标签库加载失败，请稍后重试。"));
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [teamId],
  );

  useEffect(() => {
    setTags([]);
    setError("");
    void reload();
  }, [reload]);

  return { tags, setTags, loading, error, reload };
}

/* ------------------------------------------------------------------ */
/* Chips used in the task table / mobile cards                         */
/* ------------------------------------------------------------------ */

export function TagChips({
  tags,
  max = 3,
  className,
}: {
  tags?: TaskTag[] | null;
  max?: number;
  className?: string;
}) {
  const list = tags ?? [];
  if (!list.length) return null;
  const visible = list.slice(0, max);
  const rest = list.length - visible.length;
  return (
    <span className={cn("tag-chips", className)}>
      {visible.map((tag) => (
        <span key={tag.id} className="tag-chip" style={tagStyle(tag.color)} title={tag.name}>
          <i className="tag-chip-dot" aria-hidden="true" />
          {tag.name}
        </span>
      ))}
      {rest > 0 ? (
        <span className="tag-chip is-more" title={list.slice(max).map((tag) => tag.name).join("、")}>
          +{rest}
        </span>
      ) : null}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Inline colour swatches                                              */
/* ------------------------------------------------------------------ */

function ColorSwatches({
  value,
  onChange,
  disabled,
  label = "选择标签颜色",
}: {
  value: string;
  onChange: (color: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <div className="tag-swatches" role="group" aria-label={label}>
      {TAG_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          className={cn("tag-swatch", value.toLowerCase() === color.toLowerCase() && "active")}
          style={{ "--tag-color": color } as CSSProperties}
          onClick={() => onChange(color)}
          disabled={disabled}
          aria-label={`使用颜色 ${color}`}
          aria-pressed={value.toLowerCase() === color.toLowerCase()}
        >
          {value.toLowerCase() === color.toLowerCase() ? <Check size={10} /> : null}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tag manager rows                                                    */
/* ------------------------------------------------------------------ */

interface TagManagerProps {
  teamId: string;
  library: TagLibraryApi;
  /** When provided the rows become multi-select checkboxes. */
  selected?: string[];
  onToggle?: (tagId: string) => void;
  maxSelected?: number;
  compact?: boolean;
  showUsage?: boolean;
  onChanged?: () => void;
}

function TagManager({
  teamId,
  library,
  selected,
  onToggle,
  maxSelected = MAX_TASK_TAGS,
  compact = false,
  showUsage = false,
  onChanged,
}: TagManagerProps) {
  const { toast } = useToast();
  const selectable = Boolean(onToggle);
  const [draftName, setDraftName] = useState("");
  const [draftColor, setDraftColor] = useState(TAG_COLORS[0]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState(TAG_COLORS[0]);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");

  const resetDraft = () => {
    setDraftName("");
    setDraftColor(tagColorFor(library.tags.length));
    setFormError("");
  };

  useEffect(() => {
    setDraftColor(tagColorFor(library.tags.length));
  }, [library.tags.length]);

  const createTag = async () => {
    if (busy) return;
    const name = draftName.trim();
    if (!name) {
      setFormError("请输入标签名称。");
      return;
    }
    if (name.length > TAG_NAME_MAX) {
      setFormError(`标签名称最多 ${TAG_NAME_MAX} 个字符。`);
      return;
    }
    if (library.tags.some((tag) => tag.name === name)) {
      setFormError("已存在同名标签，请换一个名称。");
      return;
    }
    setBusy(true);
    setFormError("");
    try {
      const result = await api.createTaskTag(teamId, { name, color: draftColor });
      await library.reload(true);
      resetDraft();
      toast(`标签「${result.tag.name}」已创建`, "success");
      onChanged?.();
      if (onToggle && selected && !selected.includes(result.tag.id) && selected.length < maxSelected) {
        onToggle(result.tag.id);
      }
    } catch (err) {
      setFormError(messageOf(err, "创建标签失败，请稍后重试。"));
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (tag: TaskTag, index: number) => {
    setEditingId(tag.id);
    setEditName(tag.name);
    setEditColor(safeColor(tag.color, index));
    setConfirmId(null);
    setFormError("");
  };

  const saveEdit = async (tag: TaskTag) => {
    if (busy) return;
    const name = editName.trim();
    if (!name) {
      setFormError("标签名称不能为空。");
      return;
    }
    if (name.length > TAG_NAME_MAX) {
      setFormError(`标签名称最多 ${TAG_NAME_MAX} 个字符。`);
      return;
    }
    setBusy(true);
    setFormError("");
    try {
      const body: { name?: string; color?: string } = {};
      if (name !== tag.name) body.name = name;
      if (editColor.toLowerCase() !== (tag.color || "").toLowerCase()) body.color = editColor;
      if (Object.keys(body).length) {
        await api.updateTaskTag(teamId, tag.id, body);
      }
      await library.reload(true);
      setEditingId(null);
      toast("标签已更新", "success");
      onChanged?.();
    } catch (err) {
      setFormError(messageOf(err, "更新标签失败，请稍后重试。"));
    } finally {
      setBusy(false);
    }
  };

  const removeTag = async (tag: TaskTag) => {
    if (busy) return;
    setBusy(true);
    setFormError("");
    try {
      await api.deleteTaskTag(teamId, tag.id);
      await library.reload(true);
      setConfirmId(null);
      if (selected?.includes(tag.id)) onToggle?.(tag.id);
      toast(`标签「${tag.name}」已删除`, "success");
      onChanged?.();
    } catch (err) {
      setFormError(messageOf(err, "删除标签失败，请稍后重试。"));
    } finally {
      setBusy(false);
    }
  };

  const atLimit = Boolean(selected && selected.length >= maxSelected);

  return (
    <div className={cn("tag-manager", compact && "is-compact")}>
      {library.error ? (
        <div className="tag-manager-error" role="alert">
          <AlertCircle size={14} />
          <span>{library.error}</span>
          <button
            type="button"
            className="text-button"
            onClick={() => void library.reload()}
            disabled={library.loading}
          >
            <RefreshCw size={12} className={library.loading ? "spin" : undefined} /> 重试
          </button>
        </div>
      ) : null}

      {library.loading && !library.tags.length ? (
        <p className="tag-manager-empty">正在加载标签库…</p>
      ) : null}

      {!library.loading && !library.tags.length && !library.error ? (
        <p className="tag-manager-empty">
          <Tags size={14} /> 标签库还是空的，创建第一个标签吧。
        </p>
      ) : null}

      <ul className="tag-manager-list">
        {library.tags.map((tag, index) => {
          const color = safeColor(tag.color, index);
          const checked = Boolean(selected?.includes(tag.id));
          const disabled = Boolean(selectable && !checked && atLimit);
          if (editingId === tag.id) {
            return (
              <li key={tag.id} className="tag-manager-row is-editing">
                <span className="tag-color-dot" style={{ background: color }} aria-hidden="true" />
                <input
                  className="tag-manager-input"
                  value={editName}
                  maxLength={TAG_NAME_MAX}
                  onChange={(event) => setEditName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void saveEdit(tag);
                    }
                    if (event.key === "Escape") setEditingId(null);
                  }}
                  aria-label={`标签「${tag.name}」的新名称`}
                  autoFocus
                />
                <ColorSwatches value={editColor} onChange={setEditColor} disabled={busy} />
                <span className="tag-manager-actions">
                  <button
                    type="button"
                    className="icon-button tag-manager-action is-accent"
                    onClick={() => void saveEdit(tag)}
                    disabled={busy}
                    aria-label="保存标签修改"
                    title="保存"
                  >
                    <Check size={13} />
                  </button>
                  <button
                    type="button"
                    className="icon-button tag-manager-action"
                    onClick={() => setEditingId(null)}
                    disabled={busy}
                    aria-label="取消标签编辑"
                    title="取消"
                  >
                    <X size={13} />
                  </button>
                </span>
              </li>
            );
          }
          if (confirmId === tag.id) {
            return (
              <li key={tag.id} className="tag-manager-row is-confirming">
                <span className="tag-color-dot" style={{ background: color }} aria-hidden="true" />
                <span className="tag-manager-confirm-text">
                  删除「{tag.name}」？该标签会从所有任务上移除。
                </span>
                <span className="tag-manager-actions">
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    onClick={() => void removeTag(tag)}
                    disabled={busy}
                  >
                    删除
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setConfirmId(null)}
                    disabled={busy}
                  >
                    取消
                  </button>
                </span>
              </li>
            );
          }
          return (
            <li
              key={tag.id}
              className={cn("tag-manager-row", checked && "is-selected", disabled && "is-disabled")}
            >
              {selectable ? (
                <label className="tag-manager-check">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={() => onToggle?.(tag.id)}
                    aria-label={`选择标签 ${tag.name}`}
                  />
                  <span className="tag-manager-dot" style={{ background: color }} />
                  <span className="tag-manager-name">{tag.name}</span>
                </label>
              ) : (
                <>
                  <span className="tag-manager-dot" style={{ background: color }} />
                  <span className="tag-manager-name">{tag.name}</span>
                </>
              )}
              {showUsage ? (
                <span className="tag-manager-usage" title="使用该标签的任务数">
                  {tag.usage ?? 0} 次使用
                </span>
              ) : null}
              <span className="tag-manager-actions">
                <button
                  type="button"
                  className="icon-button tag-manager-action"
                  onClick={() => startEdit(tag, index)}
                  disabled={busy}
                  aria-label={`重命名或换色标签 ${tag.name}`}
                  title="重命名 / 换色"
                >
                  <Pencil size={12} />
                </button>
                <button
                  type="button"
                  className="icon-button tag-manager-action danger"
                  onClick={() => {
                    setConfirmId(tag.id);
                    setEditingId(null);
                  }}
                  disabled={busy}
                  aria-label={`删除标签 ${tag.name}`}
                  title="删除标签"
                >
                  <Trash2 size={12} />
                </button>
              </span>
            </li>
          );
        })}
      </ul>

      <div className="tag-manager-create">
        <span className="tag-color-dot" style={{ background: draftColor }} aria-hidden="true" />
        <input
          className="tag-manager-input"
          value={draftName}
          maxLength={TAG_NAME_MAX}
          placeholder={`新建标签，最多 ${TAG_NAME_MAX} 字`}
          onChange={(event) => setDraftName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void createTag();
            }
          }}
          aria-label="新标签名称"
        />
        <ColorSwatches value={draftColor} onChange={setDraftColor} disabled={busy} label="新标签颜色" />
        <button
          type="button"
          className="btn btn-secondary btn-sm tag-manager-create-btn"
          onClick={() => void createTag()}
          disabled={busy || !draftName.trim()}
        >
          <Plus size={13} /> 新建
        </button>
      </div>

      {formError ? (
        <p className="tag-manager-form-error" role="alert">
          <AlertCircle size={12} /> {formError}
        </p>
      ) : null}

      {selectable ? (
        <p className="tag-manager-hint">
          <Ban size={11} /> 每个任务最多选择 {maxSelected} 个标签 · 所有人均可维护标签库
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* TagPicker (inside TaskDialog)                                       */
/* ------------------------------------------------------------------ */

export interface TagPickerProps {
  teamId: string;
  value: string[];
  onChange: (tagIds: string[]) => void;
  disabled?: boolean;
  max?: number;
}

export function TagPicker({
  teamId,
  value,
  onChange,
  disabled = false,
  max = MAX_TASK_TAGS,
}: TagPickerProps) {
  const library = useTagLibrary(teamId);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setOpen(false);
  }, [teamId]);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const tagMap = useMemo(() => new Map(library.tags.map((tag) => [tag.id, tag])), [library.tags]);
  const selectedTags = value.map((id) => tagMap.get(id)).filter((tag): tag is TaskTag => Boolean(tag));
  const missingCount = value.length - selectedTags.length;

  const toggle = (tagId: string) => {
    if (value.includes(tagId)) {
      onChange(value.filter((id) => id !== tagId));
      return;
    }
    if (value.length >= max) return;
    onChange([...value, tagId]);
  };

  const remove = (tagId: string) => onChange(value.filter((id) => id !== tagId));

  return (
    <div className="tag-picker" ref={wrapRef}>
      <div className={cn("tag-picker-field", open && "is-open", disabled && "is-disabled")}>
        {selectedTags.map((tag) => (
          <span key={tag.id} className="tag-chip tag-picker-chip" style={tagStyle(tag.color)}>
            <i className="tag-chip-dot" aria-hidden="true" />
            {tag.name}
            {!disabled ? (
              <button
                type="button"
                className="tag-chip-remove"
                onClick={() => remove(tag.id)}
                aria-label={`移除标签 ${tag.name}`}
                title="移除"
              >
                <X size={10} />
              </button>
            ) : null}
          </span>
        ))}
        {missingCount > 0 ? (
          <span className="tag-picker-missing" title="这些标签不在当前团队的标签库中">
            {missingCount} 个未知标签
          </span>
        ) : null}
        {!selectedTags.length && !missingCount ? (
          <span className="tag-picker-placeholder">暂未选择标签</span>
        ) : null}
        <button
          type="button"
          className="tag-picker-toggle"
          onClick={() => setOpen((current) => !current)}
          disabled={disabled}
          aria-expanded={open}
          aria-label={open ? "收起标签选择" : "展开标签选择"}
        >
          <Tags size={13} /> {open ? "收起" : "选择标签"}
        </button>
      </div>

      {open ? (
        <div className="tag-picker-panel">
          <TagManager
            teamId={teamId}
            library={library}
            selected={value}
            onToggle={toggle}
            maxSelected={max}
            compact
          />
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tag library management dialog (from the task overview page)         */
/* ------------------------------------------------------------------ */

export interface TagLibraryDialogProps {
  open: boolean;
  onClose: () => void;
  teamId: string;
  teamName?: string;
  onChanged?: () => void;
}

export function TagLibraryDialog({
  open,
  onClose,
  teamId,
  teamName,
  onChanged,
}: TagLibraryDialogProps) {
  const library = useTagLibrary(open ? teamId : "");

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="标签库管理"
      description="标签库按团队共享，所有登录成员都可以新建、改名、换色或删除标签。"
      size="lg"
      footer={
        <button className="btn btn-primary" onClick={onClose}>
          完成
        </button>
      }
    >
      <div className="tag-library-dialog">
        <p className="tag-library-group-static">
          <Tags size={13} /> {teamName ? `「${teamName}」` : "当前团队"}标签库
        </p>

        <TagManager
          teamId={teamId}
          library={library}
          showUsage
          onChanged={onChanged}
        />
      </div>
    </Modal>
  );
}
