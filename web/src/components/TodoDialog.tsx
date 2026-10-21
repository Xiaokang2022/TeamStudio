import { useEffect, useMemo, useState, type FormEvent } from "react";
import { AlertCircle, CalendarDays, Clock, UserRound } from "lucide-react";
import { api, ApiError } from "../api";
import { useToast } from "./Toast";
import { Modal } from "./Modal";
import { Select } from "./Select";
import { cn, PRIORITY_META, todayISO } from "../lib/utils";
import type { Member, Todo, TodoPriority } from "../types";

const PRIORITIES: TodoPriority[] = ["low", "normal", "high", "urgent"];
const DEFAULT_DUE_TIME = "18:00";

export interface TodoDialogProps {
  open: boolean;
  todo: Todo | null;
  teamId: string;
  members: Member[];
  defaultDate: string;
  defaultAssigneeId: string | null;
  canAssignOthers: boolean;
  allowPastDue: boolean;
  onClose: () => void;
  onSaved: (todo: Todo) => void;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export function TodoDialog({
  open,
  todo,
  teamId,
  members,
  defaultDate,
  defaultAssigneeId,
  canAssignOthers,
  allowPastDue,
  onClose,
  onSaved,
}: TodoDialogProps) {
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState(defaultDate);
  const [dueTime, setDueTime] = useState(DEFAULT_DUE_TIME);
  const [assigneeId, setAssigneeId] = useState<string | null>(null);
  const [priority, setPriority] = useState<TodoPriority>("normal");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const isEditing = Boolean(todo);

  useEffect(() => {
    if (!open) return;
    if (todo) {
      setTitle(todo.title);
      setDescription(todo.description);
      setDueDate(todo.dueDate || defaultDate);
      setDueTime(todo.dueTime || DEFAULT_DUE_TIME);
      setAssigneeId(todo.assigneeMemberId);
      setPriority(todo.priority);
    } else {
      setTitle("");
      setDescription("");
      setDueDate(defaultDate);
      setDueTime(DEFAULT_DUE_TIME);
      setAssigneeId(defaultAssigneeId);
      setPriority("normal");
    }
    setSaving(false);
    setError("");
  }, [open, todo, defaultDate, defaultAssigneeId]);

  const selectableMembers = canAssignOthers
    ? members
    : members.filter((member) => member.id === defaultAssigneeId);

  const assigneeOptions = useMemo(
    () => [
      { value: "", label: canAssignOthers ? "未指派" : "自动指派给我" },
      ...selectableMembers.map((member) => ({
        value: member.id,
        label: member.name,
        description: member.title || undefined,
        color: member.avatarColor,
        avatar: member.avatar,
      })),
    ],
    [canAssignOthers, selectableMembers],
  );

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError("请填写待办标题。");
      return;
    }
    if (!dueDate) {
      setError("请选择截止日期。");
      return;
    }
    if (!allowPastDue && dueDate < todayISO()) {
      setError("当前配置不允许把待办安排在过去的日期。");
      return;
    }
    if (!dueTime) {
      setError("请选择截止时间。");
      return;
    }
    setSaving(true);
    setError("");
    const payload = {
      title: trimmedTitle,
      description: description.trim(),
      dueDate,
      dueTime,
      assigneeMemberId: assigneeId || null,
      priority,
    };
    try {
      if (todo) {
        const result = await api.updateTodo(teamId, todo.id, payload);
        toast("待办已更新", "success");
        onSaved(result.todo);
      } else {
        const result = await api.createTodo(teamId, payload);
        toast("待办已创建", "success");
        onSaved(result.todo);
      }
      onClose();
    } catch (err) {
      setError(messageOf(err, "保存待办失败，请稍后重试。"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEditing ? "编辑待办" : "新建待办"}
      description={
        isEditing
          ? "调整截止时间、优先级或负责人，保存后日历会立即同步。"
          : "安排一件要完成的事，明确截止时间、优先级与负责人。"
      }
      size="md"
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button className="btn btn-primary" type="submit" form="td-todo-form" disabled={saving}>
            {saving ? "保存中…" : isEditing ? "保存待办" : "创建待办"}
          </button>
        </>
      }
    >
      <form id="td-todo-form" className="td-form" onSubmit={submit}>
        <div className="field">
          <label htmlFor="td-title">待办标题 *</label>
          <input
            id="td-title"
            className="input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="例如：完成首屏信息架构评审"
            maxLength={120}
            required
            autoFocus
          />
        </div>

        <div className="field">
          <label htmlFor="td-description">待办说明</label>
          <textarea
            id="td-description"
            className="textarea"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="补充背景、交付物或协作提示。"
            maxLength={2000}
            rows={3}
          />
        </div>

        <div className="form-grid td-grid">
          <div className="field">
            <label htmlFor="td-date">
              <CalendarDays size={12} /> 截止日期 *
            </label>
            <input
              id="td-date"
              className="input"
              type="date"
              value={dueDate}
              min={allowPastDue ? undefined : todayISO()}
              onChange={(event) => setDueDate(event.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="td-time">
              <Clock size={12} /> 截止时间 *
            </label>
            <input
              id="td-time"
              className="input"
              type="time"
              value={dueTime}
              onChange={(event) => setDueTime(event.target.value)}
              required
            />
          </div>
        </div>

        <div className="field">
          <label htmlFor="td-assignee">
            <UserRound size={12} /> 负责人
          </label>
          <Select
            id="td-assignee"
            value={assigneeId ?? ""}
            onChange={(next) => setAssigneeId(next || null)}
            options={assigneeOptions}
            disabled={!canAssignOthers}
            ariaLabel="负责人"
            placeholder={canAssignOthers ? "未指派" : "自动指派给我"}
            searchable={selectableMembers.length > 6}
          />
          <span className="field-hint">
            {canAssignOthers
              ? "管理员可以指派给任意成员；成员本人只能创建自己的待办。"
              : "普通成员只能创建或指派给自己的待办。"}
          </span>
        </div>

        <div className="field">
          <span className="field-label">优先级</span>
          <div className="td-priority" role="group" aria-label="待办优先级">
            {PRIORITIES.map((value) => (
              <button
                key={value}
                type="button"
                className={cn("td-priority-option", `is-${value}`, priority === value && "active")}
                onClick={() => setPriority(value)}
                aria-pressed={priority === value}
              >
                <i className="dot" />
                {PRIORITY_META[value].label}
              </button>
            ))}
          </div>
          <span className="field-hint">到期与逾期任务会在日历和列表中优先提示。</span>
        </div>

        {error ? (
          <p className="td-error" role="alert">
            <AlertCircle size={14} /> {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
