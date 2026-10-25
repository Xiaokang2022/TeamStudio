import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CalendarDays,
  CheckCheck,
  Flag,
  Folder,
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
  TASK_CAPACITY_POINTS,
  TASK_HEALTH_META,
  TASK_MAX_POINTS,
  TASK_PROGRESS_META,
  formatPercent,
  taskLoadPoints,
} from "../lib/taskMeta";
import type {
  MemberTask,
  TaskDifficulty,
  TaskHealthStatus,
  TaskPriority,
  TaskProgressStatus,
  TeamGroup,
} from "../types";

export interface TaskMemberOption {
  id: string;
  name: string;
  title: string;
  avatar?: string;
  avatarColor: string;
}

export interface TaskDialogProps {
  open: boolean;
  /** Existing task when editing, null when creating. */
  task: MemberTask | null;
  /** Team the save request targets. */
  teamId: string;
  /** Every member of the active team (workload rail source). */
  members: TaskMemberOption[];
  /** Admins may assign any member; ordinary linked members are fixed to themselves. */
  canAssignOthers: boolean;
  selfMemberId: string | null;
  defaultMemberId: string | null;
  /** 可选的任务组（kind="task"），提交时带 groupId；空值 = 未分组。 */
  groups?: TeamGroup[];
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
  members,
  canAssignOthers,
  selfMemberId,
  defaultMemberId,
  groups = [],
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
  const [groupId, setGroupId] = useState("");
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
      setGroupId(task.groupId ?? "");
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
      setGroupId("");
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
  const capacityPercent = Math.round((loadPoints / TASK_CAPACITY_POINTS) * 100);

  const taskGroups = useMemo(
    () => groups.filter((group) => group.kind === "task"),
    [groups],
  );
  // 选中的组可能已被管理员删除：回退为「未分组」，避免提交失效的 groupId。
  const groupValue = taskGroups.some((group) => group.id === groupId) ? groupId : "";
  const groupOptions = useMemo(
    () => [
      { value: "", label: "未分组" },
      ...taskGroups.map((group) => ({ value: group.id, label: group.name, color: group.color })),
    ],
    [taskGroups],
  );

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
      groupId: groupValue,
      tagIds,
    };
    try {
      if (task) {
        const result = await api.updateTask(teamId, task.id, payload);
        toast("任务已更新", "success");
        onSaved(result.task);
      } else {
        const result = await api.createTask(teamId, payload);
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
                  avatar: member.avatar,
                }))}
              />
              <span className="field-hint">
                管理员可以将任务指派给团队内任意成员；普通成员只能管理自己的任务。
              </span>
            </>
          ) : (
            <div className="tasks-dialog-member" aria-label="任务所属成员">
              {fixedMember ? (
                <>
                  <Avatar
                    name={fixedMember.name}
                    src={fixedMember.avatar}
                    color={fixedMember.avatarColor}
                    size="sm"
                  />
                  <div>
                    <strong>{fixedMember.name}</strong>
                    <small>{fixedMember.title || "团队成员"}</small>
                  </div>
                </>
              ) : (
                <div>
                  <strong>{selfMemberId ? "我的任务" : "未关联成员"}</strong>
                  <small>当前身份还没有关联团队成员档案，请联系管理员。</small>
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
            value={tagIds}
            onChange={setTagIds}
            disabled={saving}
          />
          <span className="field-hint">
            标签按团队共享，最多选择 8 个；可在选择面板中直接新建、改名、换色或删除。
          </span>
        </div>

        <div className="field">
          <label htmlFor="tasks-group">
            <Folder size={12} /> 任务分组
          </label>
          <Select
            id="tasks-group"
            value={groupValue}
            onChange={setGroupId}
            ariaLabel="任务分组"
            disabled={saving}
            options={groupOptions}
          />
          <span className="field-hint">
            分组用于任务总览的筛选与分区显示；留空即为未分组，可在任务总览中管理分组。
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
                    <small>{meta.score} 分</small>
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
                    <small>{meta.score} 分</small>
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
            <strong id="tasks-points-value">
              预计负载 {loadPoints} / {TASK_MAX_POINTS} 分
            </strong>
            <small>
              负载分 = 优先级分（1-3）× 难度分（1-3），满分 {TASK_MAX_POINTS}；当前{" "}
              {priorityMeta.label} {priorityMeta.score} 分 × {difficultyMeta.label}{" "}
              {difficultyMeta.score} 分 · 约占周容量 {formatPercent(capacityPercent)}
            </small>
          </div>
          <span className="tasks-dialog-points-meter" aria-hidden="true">
            {Array.from({ length: TASK_MAX_POINTS }, (_, index) => (
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
