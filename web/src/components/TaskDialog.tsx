import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  CheckCheck,
  Flag,
  Gauge,
  Layers,
  Tags,
  UserRound,
} from "lucide-react";
import { api, ApiError } from "../api";
import { Avatar } from "./Avatar";
import { Modal } from "./Modal";
import { Select } from "./Select";
import { TagPicker } from "./TagPicker";
import { useToast } from "./Toast";
import { cn } from "../lib/utils";
import {
  DIFFICULTIES,
  DIFFICULTY_META,
  HEALTH_STATUSES,
  PRIORITIES,
  PRIORITY_META,
  PROGRESS_STATUSES,
  TASK_HEALTH_META,
  TASK_PROGRESS_META,
  formatPercent,
  formatPoints,
  taskLoadPoints,
} from "../lib/taskMeta";
import type {
  MemberTask,
  TaskDifficulty,
  TaskHealthStatus,
  TaskPriority,
  TaskProgressStatus,
} from "../types";

export interface TaskMemberOption {
  id: string;
  name: string;
  title: string;
  avatarColor: string;
}

export interface TaskDialogProps {
  open: boolean;
  /** Existing task when editing, null when creating. */
  task: MemberTask | null;
  /** Team/group the save request targets: task's own group when editing, current group when creating. */
  teamId: string;
  groupId: string;
  /** Display name of the target group (used for the aggregate-scope hint). */
  targetGroupName?: string;
  /** True when the sidebar browsing scope is team/all. */
  aggregate?: boolean;
  /** Every member of the active group (workload rail source). */
  members: TaskMemberOption[];
  /** Admins may assign any member; ordinary linked members are fixed to themselves. */
  canAssignOthers: boolean;
  selfMemberId: string | null;
  defaultMemberId: string | null;
  onClose: () => void;
  onSaved: (task: MemberTask) => void;
}

const DEFAULT_PRIORITY: TaskPriority = "normal";
const DEFAULT_DIFFICULTY: TaskDifficulty = "medium";

function messageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export function TaskDialog({
  open,
  task,
  teamId,
  groupId,
  targetGroupName,
  aggregate = false,
  members,
  canAssignOthers,
  selfMemberId,
  defaultMemberId,
  onClose,
  onSaved,
}: TaskDialogProps) {
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [memberId, setMemberId] = useState("");
  const [progressStatus, setProgressStatus] = useState<TaskProgressStatus>("pending");
  const [healthStatus, setHealthStatus] = useState<TaskHealthStatus>("normal");
  const [priority, setPriority] = useState<TaskPriority>(DEFAULT_PRIORITY);
  const [difficulty, setDifficulty] = useState<TaskDifficulty>(DEFAULT_DIFFICULTY);
  const [expectedDate, setExpectedDate] = useState("");
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const isEditing = Boolean(task);
  const memberKey = members.map((member) => member.id).join("|");

  useEffect(() => {
    if (!open) return;
    if (task) {
      setTitle(task.title);
      setDescription(task.description);
      setMemberId(task.memberId);
      setProgressStatus(task.progressStatus);
      setHealthStatus(task.healthStatus);
      setPriority(task.priority ?? DEFAULT_PRIORITY);
      setDifficulty(task.difficulty ?? DEFAULT_DIFFICULTY);
      setExpectedDate(task.expectedDate || "");
      setTagIds(task.tagIds ?? task.tags?.map((tag) => tag.id) ?? []);
    } else {
      const fallbackMemberId = canAssignOthers
        ? defaultMemberId || members[0]?.id || ""
        : selfMemberId || "";
      setTitle("");
      setDescription("");
      setMemberId(fallbackMemberId);
      setProgressStatus("pending");
      setHealthStatus("normal");
      setPriority(DEFAULT_PRIORITY);
      setDifficulty(DEFAULT_DIFFICULTY);
      setExpectedDate("");
      setTagIds([]);
    }
    setSaving(false);
    setError("");
    // `memberKey` keeps the reset effect stable when the member list loads asynchronously.
  }, [open, task, canAssignOthers, defaultMemberId, selfMemberId, memberKey, members]);

  const memberMap = useMemo(
    () => new Map(members.map((member) => [member.id, member])),
    [members],
  );
  const fixedMember = memberMap.get(selfMemberId ?? "") ?? null;

  const priorityMeta = PRIORITY_META[priority];
  const difficultyMeta = DIFFICULTY_META[difficulty];
  const loadPoints = taskLoadPoints(priority, difficulty);
  const capacityPercent = Math.round((loadPoints / 15) * 100);

  const closeSafely = () => {
    if (saving) return;
    onClose();
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;

    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError("请填写任务标题。");
      return;
    }
    if (trimmedTitle.length > 120) {
      setError("任务标题最多 120 个字符。");
      return;
    }
    if (!memberId) {
      setError("请选择任务所属成员。");
      return;
    }
    if (!canAssignOthers && selfMemberId && memberId !== selfMemberId) {
      setError("普通成员只能管理自己的任务。");
      return;
    }
    if (!PRIORITIES.includes(priority) || !DIFFICULTIES.includes(difficulty)) {
      setError("优先级或难度取值无效。");
      return;
    }

    setSaving(true);
    setError("");
    const payload = {
      memberId,
      title: trimmedTitle,
      description: description.trim(),
      progressStatus,
      healthStatus,
      priority,
      difficulty,
      expectedDate: expectedDate || "",
      tagIds,
    };
    try {
      if (task) {
        const result = await api.updateTask(teamId, groupId, task.id, payload);
        toast("任务已更新", "success");
        onSaved(result.task);
      } else {
        const result = await api.createTask(teamId, groupId, payload);
        toast("任务已创建", "success");
        onSaved(result.task);
      }
      onClose();
    } catch (err) {
      setError(messageOf(err, "保存任务失败，请稍后重试。"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={closeSafely}
      title={isEditing ? "编辑任务" : "新建任务"}
      description={
        isEditing
          ? "调整任务进度、健康状态或优先级/难度，保存后负载点数会自动重新计算。"
          : "为成员登记一项任务，优先级与难度会换算成负载点数计入该成员的周负载。"
      }
      size="md"
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={closeSafely} disabled={saving}>
            取消
          </button>
          <button className="btn btn-primary" type="submit" form="tasks-dialog-form" disabled={saving}>
            {saving ? "保存中…" : isEditing ? "保存任务" : "创建任务"}
          </button>
        </>
      }
    >
      <form id="tasks-dialog-form" className="td-form tasks-dialog-form" onSubmit={submit}>
        {aggregate && targetGroupName ? (
          <div className="tasks-dialog-group-hint" role="note">
            <ArrowRight size={13} />
            <span>
              {isEditing ? "该任务属于" : "将创建到"}：
              <strong>{targetGroupName}</strong>
              {isEditing
                ? "。标签库与成员均按任务所属开发组加载，保存会写回该组。"
                : "。聚合视角下新建任务总是写入当前选中的开发组。"}
            </span>
          </div>
        ) : null}

        <div className="field">
          <label htmlFor="tasks-title">任务标题 *</label>
          <input
            id="tasks-title"
            className="input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="例如：完成任务总览页交互评审"
            maxLength={120}
            required
            autoFocus
          />
        </div>

        <div className="field">
          <label htmlFor="tasks-description">任务说明</label>
          <textarea
            id="tasks-description"
            className="textarea"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="补充背景、交付标准或协作提示（可选）。"
            maxLength={2000}
            rows={3}
          />
        </div>

        <div className="field">
          <label htmlFor="tasks-member">
            <UserRound size={12} /> 所属成员 {canAssignOthers ? "*" : ""}
          </label>
          {canAssignOthers ? (
            <>
              <Select
                id="tasks-member"
                value={memberId}
                onChange={setMemberId}
                placeholder="请选择成员"
                ariaLabel="任务所属成员"
                options={members.map((member) => ({
                  value: member.id,
                  label: member.name,
                  description: member.title || undefined,
                  color: member.avatarColor,
                }))}
              />
              <span className="field-hint">
                管理员可以将任务指派给开发组内任意成员；普通成员只能管理自己的任务。
              </span>
            </>
          ) : (
            <div className="tasks-dialog-member" aria-label="任务所属成员">
              {fixedMember ? (
                <>
                  <Avatar name={fixedMember.name} color={fixedMember.avatarColor} size="sm" />
                  <div>
                    <strong>{fixedMember.name}</strong>
                    <small>{fixedMember.title || "开发组成员"}</small>
                  </div>
                </>
              ) : (
                <div>
                  <strong>{selfMemberId ? "我的任务" : "未关联成员"}</strong>
                  <small>当前身份还没有关联开发组成员档案，请联系管理员。</small>
                </div>
              )}
              <span className="badge badge-gray">仅本人</span>
            </div>
          )}
        </div>

        <div className="field">
          <span className="field-label">
            <Tags size={12} /> 任务标签
          </span>
          <TagPicker
            teamId={teamId}
            groupId={groupId}
            groupName={targetGroupName}
            value={tagIds}
            onChange={setTagIds}
            disabled={saving}
          />
          <span className="field-hint">
            标签按开发组共享，最多选择 8 个；可在选择面板中直接新建、改名、换色或删除。
          </span>
        </div>

        <div className="field">
          <span className="field-label">
            <Gauge size={12} /> 进度状态
          </span>
          <div className="tasks-dialog-choices" role="group" aria-label="进度状态">
            {PROGRESS_STATUSES.map((value) => (
              <button
                key={value}
                type="button"
                className={cn(
                  "tasks-dialog-choice",
                  `is-${value}`,
                  progressStatus === value && "active",
                )}
                onClick={() => setProgressStatus(value)}
                aria-pressed={progressStatus === value}
              >
                {value === "completed" ? <CheckCheck size={13} /> : <span className="tasks-dialog-dot" />}
                {TASK_PROGRESS_META[value].label}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span className="field-label">
            <AlertTriangle size={12} /> 健康状态
          </span>
          <div className="tasks-dialog-health" role="group" aria-label="健康状态">
            {HEALTH_STATUSES.map((value) => {
              const meta = TASK_HEALTH_META[value];
              return (
                <button
                  key={value}
                  type="button"
                  className={cn(
                    "tasks-dialog-health-option",
                    `is-${value}`,
                    healthStatus === value && "active",
                  )}
                  onClick={() => setHealthStatus(value)}
                  aria-pressed={healthStatus === value}
                >
                  <span className="tasks-dialog-health-top">
                    <i className="tasks-dialog-dot" />
                    <strong>{meta.label}</strong>
                  </span>
                  <small>{meta.description}</small>
                </button>
              );
            })}
          </div>
        </div>

        <div className="form-grid tasks-dialog-grid">
          <div className="field">
            <span className="field-label">
              <Flag size={12} /> 优先级
            </span>
            <div className="tasks-dialog-levels" role="group" aria-label="优先级">
              {PRIORITIES.map((value) => {
                const meta = PRIORITY_META[value];
                return (
                  <button
                    key={value}
                    type="button"
                    className={cn(
                      "tasks-dialog-level",
                      `is-priority-${value}`,
                      priority === value && "active",
                    )}
                    onClick={() => setPriority(value)}
                    aria-pressed={priority === value}
                  >
                    <i className="tasks-dialog-dot" />
                    <span>{meta.label}</span>
                    <small>+{meta.weight}</small>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="field">
            <span className="field-label">
              <Layers size={12} /> 难度
            </span>
            <div className="tasks-dialog-levels" role="group" aria-label="难度">
              {DIFFICULTIES.map((value) => {
                const meta = DIFFICULTY_META[value];
                return (
                  <button
                    key={value}
                    type="button"
                    className={cn(
                      "tasks-dialog-level",
                      `is-difficulty-${value}`,
                      difficulty === value && "active",
                    )}
                    onClick={() => setDifficulty(value)}
                    aria-pressed={difficulty === value}
                  >
                    <i className="tasks-dialog-dot" />
                    <span>{meta.label}</span>
                    <small>+{meta.weight}</small>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="tasks-dialog-points" aria-live="polite">
          <span className="tasks-dialog-points-icon" aria-hidden="true">
            <Gauge size={15} />
          </span>
          <div className="tasks-dialog-points-copy">
            <strong id="tasks-points-value">预计负载 {formatPoints(loadPoints)}</strong>
            <small>
              基础 1 分 + 优先级 {priorityMeta.label}（+{priorityMeta.weight}）+ 难度{" "}
              {difficultyMeta.label}（+{difficultyMeta.weight}）· 约占周容量{" "}
              {formatPercent(capacityPercent)}
            </small>
          </div>
          <span className="tasks-dialog-points-meter" aria-hidden="true">
            {Array.from({ length: 6 }, (_, index) => (
              <i key={index} className={index < loadPoints ? "is-on" : undefined} />
            ))}
          </span>
        </div>

        <div className="field">
          <label htmlFor="tasks-date">
            <CalendarDays size={12} /> 预期完成日期
          </label>
          <input
            id="tasks-date"
            className="input"
            type="date"
            value={expectedDate}
            onChange={(event) => setExpectedDate(event.target.value)}
          />
          <span className="field-hint">可留空；填写后用于逾期统计与负载窗口计算。</span>
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
