import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  Building2,
  Check,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UsersRound,
} from "lucide-react";
import { api, ApiError } from "../api";
import { useApp } from "../store";
import { useToast } from "./Toast";
import { ConfirmInputDialog, Modal } from "./Modal";
import { EmptyState } from "./Feedback";
import { cn } from "../lib/utils";
import type { ManagedTeam, WorkspaceManageData } from "../types";
import "./WorkspaceManager.css";

/* ------------------------------------------------------------------ */
/* Types & constants                                                   */
/* ------------------------------------------------------------------ */

interface WorkspaceManagerProps {
  open: boolean;
  onClose: () => void;
}

interface CreateTeamPayload {
  name: string;
  shortName?: string;
  description?: string;
  color?: string;
}

const TEAM_COLORS = ["#0a59f7", "#7c3aed", "#0ea5e9", "#16a34a", "#f59e0b", "#ef4444", "#64748b"];

function messageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/* ------------------------------------------------------------------ */
/* Small building blocks                                               */
/* ------------------------------------------------------------------ */

function ColorSwatches({
  colors,
  value,
  onChange,
  disabled,
}: {
  colors: string[];
  value: string;
  onChange: (color: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="wm-swatches" role="group" aria-label="标识色">
      {colors.map((color) => {
        const active = color.toLowerCase() === value.toLowerCase();
        return (
          <button
            key={color}
            type="button"
            className={cn("wm-swatch", active && "is-active")}
            style={{ background: color }}
            onClick={() => onChange(color)}
            disabled={disabled}
            aria-label={`使用颜色 ${color}`}
            aria-pressed={active}
            title={color}
          >
            {active ? <Check size={13} /> : null}
          </button>
        );
      })}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="wm-loading" aria-busy="true" aria-label="正在加载工作区数据">
      <div className="wm-loading-label">
        <Loader2 size={15} className="spin" />
        <span>正在加载团队数据…</span>
      </div>
      {[0, 1].map((index) => (
        <div className="wm-skeleton-card" key={index}>
          <div className="wm-skeleton-head">
            <span className="skeleton" style={{ width: 40, height: 40, borderRadius: 12 }} />
            <span className="skeleton skeleton-row" style={{ width: 168, height: 15 }} />
          </div>
          <div className="skeleton skeleton-row" style={{ width: "86%" }} />
          <div className="skeleton skeleton-row" style={{ width: "68%" }} />
          <div className="skeleton skeleton-row" style={{ width: "92%" }} />
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Inline create form                                                  */
/* ------------------------------------------------------------------ */

function CreateTeamForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (payload: CreateTeamPayload) => Promise<boolean>;
}) {
  const uid = useId();
  const [name, setName] = useState("");
  const [shortName, setShortName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState(TEAM_COLORS[0]);
  const [saving, setSaving] = useState(false);
  const trimmedName = name.trim();
  const canSubmit = trimmedName.length > 0 && !saving;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    const ok = await onSubmit({
      name: trimmedName,
      shortName: shortName.trim() || undefined,
      description: description.trim() || undefined,
      color,
    });
    // On success the parent closes and unmounts this form; only react to failures.
    if (!ok) setSaving(false);
  };

  return (
    <form className="wm-create-form" onSubmit={submit}>
      <header className="wm-form-head">
        <span className="wm-form-icon">
          <Building2 size={17} />
        </span>
        <div>
          <strong>新建团队</strong>
          <span>团队是工作区的唯一组织单位，成员、任务、日历与责任田都按团队隔离。</span>
        </div>
      </header>
      <div className="form-grid wm-form-grid">
        <div className="field">
          <label htmlFor={`${uid}-name`}>团队名称 *</label>
          <input
            id={`${uid}-name`}
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：产品团队"
            maxLength={40}
            required
            autoFocus
            disabled={saving}
          />
        </div>
        <div className="field">
          <label htmlFor={`${uid}-short`}>团队简称</label>
          <input
            id={`${uid}-short`}
            className="input"
            value={shortName}
            onChange={(event) => setShortName(event.target.value)}
            placeholder="留空默认取名称前 4 个字符"
            maxLength={12}
            disabled={saving}
          />
        </div>
        <div className="field span-2">
          <label htmlFor={`${uid}-desc`}>团队简介</label>
          <textarea
            id={`${uid}-desc`}
            className="textarea"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="一句话说明团队的职责或业务方向（可选）。"
            maxLength={120}
            rows={2}
            disabled={saving}
          />
        </div>
        <div className="field span-2">
          <span className="field-label">团队标识色</span>
          <ColorSwatches colors={TEAM_COLORS} value={color} onChange={setColor} disabled={saving} />
        </div>
      </div>
      <div className="wm-form-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={saving}>
          取消
        </button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={!canSubmit}>
          {saving ? "创建中…" : "创建团队"}
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Workspace manager modal                                             */
/* ------------------------------------------------------------------ */

export function WorkspaceManager({ open, onClose }: WorkspaceManagerProps) {
  const { reload } = useApp();
  const { toast } = useToast();
  const [data, setData] = useState<WorkspaceManageData | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [teamFormOpen, setTeamFormOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ManagedTeam | null>(null);
  const [deleting, setDeleting] = useState(false);
  const requestId = useRef(0);

  const load = useCallback(
    async (silent = false) => {
      const id = ++requestId.current;
      if (silent) setRefreshing(true);
      else setLoading(true);
      setError("");
      try {
        const result = await api.manageWorkspace();
        if (id !== requestId.current) return;
        setData(result);
      } catch (err) {
        if (id !== requestId.current) return;
        const message = messageOf(err, "加载工作区数据失败，请稍后重试。");
        if (silent) toast(message, "error");
        else setError(message);
      } finally {
        if (id === requestId.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [toast],
  );

  // Reload on every open so permission changes and other admins' edits are visible.
  useEffect(() => {
    if (!open) {
      setTeamFormOpen(false);
      setPendingDelete(null);
      return;
    }
    void load(false);
  }, [open, load]);

  // A mutation invalidates both the manager payload and the sidebar team list.
  const refreshAll = useCallback(async () => {
    await Promise.all([load(true), reload(true)]);
  }, [load, reload]);

  const handleCreateTeam = async (payload: CreateTeamPayload): Promise<boolean> => {
    try {
      const result = await api.createTeam(payload);
      setTeamFormOpen(false);
      toast(`团队「${result.team.name}」已创建`, "success");
      await refreshAll();
      return true;
    } catch (err) {
      toast(messageOf(err, "创建团队失败，请稍后重试。"), "error");
      return false;
    }
  };

  const handleConfirmDelete = async () => {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    try {
      await api.deleteTeam(pendingDelete.id, pendingDelete.name);
      toast(`团队「${pendingDelete.name}」已删除`, "success");
      setPendingDelete(null);
      // The backend resolves a fallback team when the active one was deleted,
      // so the bootstrap reload keeps the sidebar selection pointing at real data.
      await refreshAll();
    } catch (err) {
      toast(messageOf(err, "删除失败，请稍后重试。"), "error");
    } finally {
      setDeleting(false);
    }
  };

  const teams = data?.teams ?? [];
  const permissions = data?.permissions;
  const memberTotal = teams.reduce((total, team) => total + team.memberCount, 0);
  const initialLoading = loading && !data;

  let deleteMessage: ReactNode = null;
  if (pendingDelete) {
    deleteMessage = (
      <>
        <p>
          即将删除团队 <strong>{pendingDelete.name}</strong>，其下 {pendingDelete.memberCount} 位成员会一并移除。
        </p>
        <p className="wm-cascade-warning">
          删除团队会同时删除该团队下的成员、任务、日历、责任田等内容，且无法恢复。
        </p>
      </>
    );
  }

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title="工作区管理"
        description="创建或删除团队；删除操作不可恢复，需要输入名称二次确认。"
        size="lg"
        className="wm-modal"
        footer={
          <>
            {data ? (
              <span className="wm-footer-note">共 {teams.length} 个团队</span>
            ) : null}
            <button className="btn btn-secondary" onClick={onClose}>
              关闭
            </button>
          </>
        }
      >
        <div className="wm">
          {initialLoading ? (
            <LoadingSkeleton />
          ) : error && !data ? (
            <EmptyState
              icon={<AlertTriangle size={24} />}
              title="无法加载工作区数据"
              description={error}
              action={
                <button className="btn btn-primary btn-sm" onClick={() => void load(false)}>
                  <RefreshCw size={14} /> 重新加载
                </button>
              }
            />
          ) : data ? (
            <>
              <div className="wm-toolbar">
                <div className="wm-stats">
                  <span className="wm-stat">
                    <Building2 size={14} />
                    <strong>{teams.length}</strong>
                    <span>个团队</span>
                  </span>
                  <span className="wm-stat">
                    <UsersRound size={14} />
                    <strong>{memberTotal}</strong>
                    <span>位成员</span>
                  </span>
                </div>
                <div className="wm-toolbar-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => void load(true)}
                    disabled={loading || refreshing}
                  >
                    <RefreshCw size={14} className={refreshing || loading ? "spin" : undefined} />
                    刷新
                  </button>
                  {permissions?.canCreateTeam && !teamFormOpen ? (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => setTeamFormOpen(true)}
                    >
                      <Plus size={15} /> 新建团队
                    </button>
                  ) : null}
                </div>
              </div>

              <p className="wm-permission-note">
                <ShieldCheck size={13} />
                {permissions?.canCreateTeam
                  ? "系统内置管理员视图：可创建或删除任意团队。"
                  : permissions?.canManageAnyTeam
                    ? "团队管理员视图：可编辑所属团队，创建或删除团队需系统内置管理员操作。"
                    : "当前身份仅可查看团队信息。"}
              </p>

              {teamFormOpen ? (
                <CreateTeamForm
                  onCancel={() => setTeamFormOpen(false)}
                  onSubmit={handleCreateTeam}
                />
              ) : null}

              {teams.length === 0 ? (
                <EmptyState
                  icon={<Building2 size={24} />}
                  title="暂无团队"
                  description={
                    permissions?.canCreateTeam
                      ? "当前工作区还没有团队。创建第一个团队后，即可添加成员与协作内容。"
                      : "当前权限范围内还没有可管理的团队，请联系系统内置管理员创建团队。"
                  }
                  action={
                    permissions?.canCreateTeam && !teamFormOpen ? (
                      <button className="btn btn-primary btn-sm" onClick={() => setTeamFormOpen(true)}>
                        <Plus size={15} /> 新建团队
                      </button>
                    ) : undefined
                  }
                />
              ) : (
                <div className="wm-teams">
                  {teams.map((team) => (
                    <section className="wm-team" key={team.id} aria-label={`团队 ${team.name}`}>
                      <span className="wm-team-stripe" style={{ background: team.color }} />
                      <header className="wm-team-head">
                        <span className="wm-team-mark" style={{ color: team.color }}>
                          <Building2 size={19} />
                        </span>
                        <div className="wm-team-copy">
                          <div className="wm-team-title">
                            <h3>{team.name}</h3>
                            <span className="badge badge-gray">{team.shortName}</span>
                          </div>
                          <p className="wm-team-desc">{team.description || "暂无团队简介"}</p>
                          <div className="wm-team-meta">
                            <span>
                              <UsersRound size={12} /> {team.memberCount} 位成员
                            </span>
                          </div>
                        </div>
                        <div className="wm-team-actions">
                          {team.canDelete ? (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm wm-delete"
                              onClick={() => setPendingDelete(team)}
                            >
                              <Trash2 size={14} /> 删除团队
                            </button>
                          ) : null}
                        </div>
                      </header>
                    </section>
                  ))}
                </div>
              )}
            </>
          ) : null}
        </div>
      </Modal>

      <ConfirmInputDialog
        open={Boolean(pendingDelete)}
        title={pendingDelete ? `删除团队「${pendingDelete.name}」？` : "确认删除"}
        description="请仔细核对名称，该操作不可撤销。"
        message={deleteMessage}
        expected={pendingDelete?.name ?? ""}
        inputLabel="请输入团队名称以确认"
        confirmLabel="删除团队"
        loading={deleting}
        onClose={() => {
          if (!deleting) setPendingDelete(null);
        }}
        onConfirm={() => void handleConfirmDelete()}
      />
    </>
  );
}
