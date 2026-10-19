import { useEffect, useMemo, useState, type FormEvent } from "react";
import { AlertCircle, Bell, BellOff, CalendarDays, Clock, Layers3, Mail, Plus, UserRound, X } from "lucide-react";
import { api, ApiError } from "../api";
import { useToast } from "./Toast";
import { Modal } from "./Modal";
import { Select } from "./Select";
import { cn, PRIORITY_META, todayISO } from "../lib/utils";
import type { Member, Todo, TodoPriority } from "../types";

const PRESET_OFFSETS = [7, 3, 1, 0];
const PRIORITIES: TodoPriority[] = ["low", "normal", "high", "urgent"];
const DEFAULT_DUE_TIME = "18:00";

export interface TodoDialogProps {
  open: boolean;
  todo: Todo | null;
  teamId: string;
  groupId: string;
  /** Aggregate scope: new todos are written to the current group; show it. */
  createGroupName?: string;
  members: Member[];
  defaultDate: string;
  defaultAssigneeId: string | null;
  canAssignOthers: boolean;
  allowPastDue: boolean;
  defaultReminderOffsetsDays: number[];
  defaultReminderTime: string;
  defaultEmailEnabled: boolean;
  emailAvailable: boolean;
  onClose: () => void;
  onSaved: (todo: Todo) => void;
}

function offsetLabel(days: number): string {
  return days === 0 ? "当天" : `提前 ${days} 天`;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export function TodoDialog({
  open,
  todo,
  teamId,
  groupId,
  createGroupName,
  members,
  defaultDate,
  defaultAssigneeId,
  canAssignOthers,
  allowPastDue,
  defaultReminderOffsetsDays,
  defaultReminderTime,
  defaultEmailEnabled,
  emailAvailable,
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
  const [offsets, setOffsets] = useState<number[]>([]);
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [customOffset, setCustomOffset] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const defaultOffsetsKey = defaultReminderOffsetsDays.join(",");
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
      setOffsets(todo.reminderOffsetsDays ?? []);
      setEmailEnabled(todo.emailEnabled && emailAvailable);
    } else {
      setTitle("");
      setDescription("");
      setDueDate(defaultDate);
      setDueTime(DEFAULT_DUE_TIME);
      setAssigneeId(defaultAssigneeId);
      setPriority("normal");
      setOffsets(
        defaultOffsetsKey
          .split(",")
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value) && value >= 0 && value <= 60),
      );
      setEmailEnabled(defaultEmailEnabled && emailAvailable);
    }
    setCustomOffset("");
    setSaving(false);
    setError("");
  }, [open, todo, defaultDate, defaultAssigneeId, defaultOffsetsKey, defaultEmailEnabled, emailAvailable]);

  const offsetOptions = useMemo(
    () => Array.from(new Set([...PRESET_OFFSETS, ...offsets])).sort((a, b) => b - a),
    [offsets],
  );

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
      })),
    ],
    [canAssignOthers, selectableMembers],
  );

  const toggleOffset = (days: number) => {
    setOffsets((current) =>
      current.includes(days)
        ? current.filter((value) => value !== days)
        : [...current, days].sort((a, b) => b - a),
    );
  };

  const addCustomOffset = () => {
    const value = Number(customOffset);
    if (!Number.isInteger(value) || value < 0 || value > 60) {
      setError("自定义提醒天数需要是 0-60 之间的整数。");
      return;
    }
    if (!offsets.includes(value)) {
      setOffsets((current) => [...current, value].sort((a, b) => b - a));
    }
    setCustomOffset("");
    setError("");
  };

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
      reminderOffsetsDays: [...offsets].sort((a, b) => b - a),
      emailEnabled: emailAvailable ? emailEnabled : false,
    };
    try {
      if (todo) {
        const result = await api.updateTodo(teamId, groupId, todo.id, payload);
        toast("待办已更新", "success");
        onSaved(result.todo);
      } else {
        const result = await api.createTodo(teamId, groupId, payload);
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
          ? "调整截止时间、负责人或提醒节奏，保存后日历会立即同步。"
          : "安排一件要完成的事，并决定在什么时候提醒团队。"
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
        {!isEditing && createGroupName ? (
          <p className="td-target-hint" role="status">
            <Layers3 size={13} /> 将创建到：<strong>{createGroupName}</strong>
          </p>
        ) : null}
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
        </div>

        <div className="field">
          <span className="field-label">
            <Bell size={12} /> 邮件提醒节奏
          </span>
          <div className="td-offsets">
            {offsetOptions.map((days) => {
              const active = offsets.includes(days);
              return (
                <button
                  key={days}
                  type="button"
                  className={cn("td-offset-chip", active && "active")}
                  onClick={() => toggleOffset(days)}
                  aria-pressed={active}
                >
                  {offsetLabel(days)}
                  {active ? <X size={11} /> : <Plus size={11} />}
                </button>
              );
            })}
          </div>
          <div className="td-custom-offset">
            <input
              className="input"
              type="number"
              min={0}
              max={60}
              step={1}
              value={customOffset}
              onChange={(event) => setCustomOffset(event.target.value)}
              placeholder="自定义天数"
              aria-label="自定义提醒提前天数"
            />
            <button type="button" className="btn btn-secondary btn-sm" onClick={addCustomOffset}>
              添加
            </button>
          </div>
          <span className="field-hint">
            {offsets.length
              ? `发送节点：${offsets.map(offsetLabel).join("、")} · 默认 ${defaultReminderTime || "09:00"} 发送。`
              : "未选择提醒节点，待办到期时不会发送邮件。"}
          </span>
        </div>

        <label className="switch td-switch">
          <input
            type="checkbox"
            checked={emailEnabled}
            onChange={(event) => setEmailEnabled(event.target.checked)}
            disabled={!emailAvailable}
          />
          <span className="switch-track" />
          <span className="td-switch-copy">
            <strong>{emailEnabled ? "开启邮件提醒" : "关闭邮件提醒"}</strong>
            <small>
              {emailAvailable
                ? "提醒会发送给负责人；系统会在发送后记录已发节点。"
                : "邮件提醒未启用，可在「工作室设置 → 邮件提醒」中开启。"}
            </small>
          </span>
          {emailAvailable ? <Mail size={15} className="td-switch-icon" /> : <BellOff size={15} className="td-switch-icon" />}
        </label>

        {error ? (
          <p className="td-error" role="alert">
            <AlertCircle size={14} /> {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
