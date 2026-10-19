import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  HandHelping,
  HeartHandshake,
  Network,
  Pencil,
  Plus,
  Table2,
  Target,
  Trash2,
  Users,
  Waypoints,
  WifiOff,
} from "lucide-react";
import { api, ApiError } from "../api";
import { useApp } from "../store";
import { useToast } from "../components/Toast";
import { Avatar } from "../components/Avatar";
import { Modal, ConfirmDialog } from "../components/Modal";
import { MatrixNetwork } from "../components/MatrixNetwork";
import { EmptyState, LoadingBlock } from "../components/Feedback";
import { cn } from "../lib/utils";
import type { MatrixArea, Member } from "../types";
import "./MatrixPage.css";

interface MatrixDraft {
  area: string;
  ownerMemberId: string;
  backupMemberId: string;
  sortOrder: string;
}

const emptyDraft = (): MatrixDraft => ({
  area: "",
  ownerMemberId: "",
  backupMemberId: "",
  sortOrder: "",
});

function MemberCell({
  memberId,
  name,
  color,
  emptyLabel,
  onNavigate,
}: {
  memberId: string | null;
  name: string;
  color?: string;
  emptyLabel: string;
  onNavigate?: (memberId: string) => void;
}) {
  if (!memberId || !name) {
    return <span className="mx-unassigned">{emptyLabel}</span>;
  }
  return (
    <button
      type="button"
      className="mx-member"
      onClick={() => onNavigate?.(memberId)}
      title={`查看 ${name} 的成员卡片`}
    >
      <Avatar name={name} color={color} size="xs" />
      <span>{name}</span>
      <ArrowUpRight size={12} className="mx-member-arrow" />
    </button>
  );
}

type MemberRole = "owner" | "backup" | "both";

const roleOfMember = (area: MatrixArea, memberId: string): MemberRole | null => {
  const isOwner = area.ownerMemberId === memberId;
  const isBackup = area.backupMemberId === memberId;
  if (isOwner && isBackup) return "both";
  if (isOwner) return "owner";
  if (isBackup) return "backup";
  return null;
};

function RoleBadge({ role }: { role: MemberRole | null }) {
  if (!role) return null;
  if (role === "both") {
    return <span className="badge badge-blue mx-role-badge">主责 + 备份</span>;
  }
  if (role === "owner") {
    return (
      <span className="badge badge-violet mx-role-badge">
        <Target size={10} /> 主责
      </span>
    );
  }
  return (
    <span className="badge badge-gray mx-role-badge">
      <HandHelping size={10} /> 备份
    </span>
  );
}

export default function MatrixPage() {
  const { currentTeam, currentGroup, canManageActiveGroup, navigate } = useApp();
  const { toast } = useToast();

  const teamId = currentTeam?.id ?? "";
  const groupId = currentGroup?.id ?? "";

  const [areas, setAreas] = useState<MatrixArea[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshTick, setRefreshTick] = useState(0);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<MatrixArea | null>(null);
  const [draft, setDraft] = useState<MatrixDraft>(emptyDraft());
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MatrixArea | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [view, setView] = useState<"table" | "network">("table");
  const [selectedMemberId, setSelectedMemberId] = useState("");

  const lastGroupRef = useRef("");

  useEffect(() => {
    if (!teamId || !groupId) return;
    if (lastGroupRef.current !== groupId) {
      lastGroupRef.current = groupId;
      setEditorOpen(false);
      setDeleteTarget(null);
      setSelectedMemberId("");
      setAreas([]);
      setMembers([]);
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    void Promise.all([api.matrix(teamId, groupId), api.overview(teamId, groupId).catch(() => null)])
      .then(([matrixResult, overview]) => {
        if (cancelled) return;
        setAreas(matrixResult.areas);
        setMembers(overview?.members ?? []);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof ApiError ? err.message : "责任田矩阵加载失败，请稍后重试。";
        setError(message);
        toast(message, "error");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, groupId, refreshTick, toast]);

  const memberById = useMemo(() => new Map(members.map((member) => [member.id, member])), [members]);
  const colorOf = (memberId: string | null) => (memberId ? memberById.get(memberId)?.avatarColor : undefined);

  const sortedAreas = useMemo(
    () => [...areas].sort((a, b) => a.sortOrder - b.sortOrder || a.area.localeCompare(b.area, "zh-CN")),
    [areas],
  );

  const ownerCount = useMemo(() => areas.filter((area) => Boolean(area.ownerMemberId)).length, [areas]);
  const backupCount = useMemo(() => areas.filter((area) => Boolean(area.backupMemberId)).length, [areas]);

  const filterMembers = useMemo(() => {
    const seen = new Set<string>();
    const list: { id: string; name: string }[] = [];
    for (const member of members) {
      if (seen.has(member.id)) continue;
      seen.add(member.id);
      list.push({ id: member.id, name: member.name });
    }
    for (const area of areas) {
      if (area.ownerMemberId && !seen.has(area.ownerMemberId)) {
        seen.add(area.ownerMemberId);
        list.push({ id: area.ownerMemberId, name: area.ownerName || "未命名" });
      }
      if (area.backupMemberId && !seen.has(area.backupMemberId)) {
        seen.add(area.backupMemberId);
        list.push({ id: area.backupMemberId, name: area.backupName || "未命名" });
      }
    }
    return list.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }, [members, areas]);

  useEffect(() => {
    if (!selectedMemberId) return;
    if (!filterMembers.some((member) => member.id === selectedMemberId)) setSelectedMemberId("");
  }, [filterMembers, selectedMemberId]);

  const visibleAreas = useMemo(
    () =>
      selectedMemberId
        ? sortedAreas.filter((area) => roleOfMember(area, selectedMemberId) !== null)
        : sortedAreas,
    [sortedAreas, selectedMemberId],
  );

  const selection = useMemo(() => {
    if (!selectedMemberId) return null;
    const person = filterMembers.find((member) => member.id === selectedMemberId);
    const owned = areas.filter((area) => area.ownerMemberId === selectedMemberId).length;
    const backed = areas.filter((area) => area.backupMemberId === selectedMemberId).length;
    return { name: person?.name ?? "该成员", owned, backed };
  }, [selectedMemberId, filterMembers, areas]);

  const reload = () => setRefreshTick((value) => value + 1);

  const goToMember = (memberId: string) => navigate("overview", { member: memberId });

  const openCreate = () => {
    setEditing(null);
    setDraft(emptyDraft());
    setEditorOpen(true);
  };

  const openEdit = (area: MatrixArea) => {
    setEditing(area);
    setDraft({
      area: area.area,
      ownerMemberId: area.ownerMemberId ?? "",
      backupMemberId: area.backupMemberId ?? "",
      sortOrder: String(area.sortOrder ?? 0),
    });
    setEditorOpen(true);
  };

  const handleSave = async () => {
    if (!teamId || !groupId) return;
    const areaName = draft.area.trim();
    if (!areaName) {
      toast("请填写业务领域名称", "error");
      return;
    }
    const sortOrder = draft.sortOrder.trim();
    if (sortOrder !== "" && !Number.isFinite(Number(sortOrder))) {
      toast("排序需要是数字", "error");
      return;
    }
    if (draft.ownerMemberId && draft.ownerMemberId === draft.backupMemberId) {
      toast("负责人与备份人不能是同一人", "error");
      return;
    }
    setSaving(true);
    try {
      const body = {
        area: areaName,
        ownerMemberId: draft.ownerMemberId || null,
        backupMemberId: draft.backupMemberId || null,
        sortOrder: sortOrder === "" ? undefined : Number(sortOrder),
      };
      if (editing) {
        const result = await api.updateMatrix(teamId, groupId, editing.id, body);
        setAreas((prev) => prev.map((item) => (item.id === result.area.id ? result.area : item)));
        toast("责任田已更新", "success");
      } else {
        const result = await api.createMatrix(teamId, groupId, body);
        setAreas((prev) => [...prev, result.area]);
        toast("责任田已创建", "success");
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
    setDeleting(true);
    try {
      await api.deleteMatrix(teamId, groupId, deleteTarget.id);
      setAreas((prev) => prev.filter((item) => item.id !== deleteTarget.id));
      toast("责任田已删除", "success");
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
        description="请从左侧导航选择一个开发组，再查看它的业务责任田。"
        icon={<Waypoints size={24} />}
      />
    );
  }

  return (
    <div className="mx-page fade-up">
      <header className="page-header">
        <div className="page-heading">
          <span className="eyebrow">
            <Waypoints size={12} /> COLLABORATION / OWNERSHIP
          </span>
          <h1 className="page-title">责任田矩阵</h1>
          <p className="page-subtitle">
            把业务拆成一块块清晰的责任田，主责到人、备份补位——让「这件事找谁」不再靠猜。
          </p>
        </div>
        <div className="page-actions">
          {canManageActiveGroup ? (
            <button type="button" className="btn btn-primary" onClick={openCreate}>
              <Plus size={15} /> 新增责任田
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

      <section className="mx-help">
        <span className="mx-help-icon">
          <HeartHandshake size={20} />
        </span>
        <div className="mx-help-copy">
          <h2>什么是「业务责任田」？</h2>
          <p>
            责任田是一张团队内部的分工地图：每个业务领域都写清楚谁主责、谁备份，
            协作时直接找对人，避免事情在交接处空转。
          </p>
          <div className="mx-help-points">
            <span>
              <Target size={13} /> 唯一主责：每块领域只认一个负责人
            </span>
            <span>
              <HandHelping size={13} /> 备份补位：负责人不在时由备份人接手
            </span>
          </div>
        </div>
      </section>

      <div className="mx-stats">
        <div className="mx-stat">
          <span className="mx-stat-icon is-accent">
            <Waypoints size={16} />
          </span>
          <div>
            <small>业务责任田</small>
            <strong>{areas.length}</strong>
          </div>
        </div>
        <div className="mx-stat">
          <span className="mx-stat-icon is-green">
            <Target size={16} />
          </span>
          <div>
            <small>已认领负责人</small>
            <strong>
              {ownerCount}
              <em> / {areas.length}</em>
            </strong>
          </div>
        </div>
        <div className="mx-stat">
          <span className="mx-stat-icon is-blue">
            <HandHelping size={16} />
          </span>
          <div>
            <small>已配置备份</small>
            <strong>
              {backupCount}
              <em> / {areas.length}</em>
            </strong>
          </div>
        </div>
      </div>

      {loading && !areas.length ? (
        <div className="panel">
          <div className="panel-body">
            <LoadingBlock label="正在加载责任田…" rows={5} />
          </div>
        </div>
      ) : !loading && !areas.length ? (
        <EmptyState
          title="还没有划分业务责任田"
          description={
            canManageActiveGroup
              ? "从最常被问到「这个找谁」的领域开始，为每块田指定负责人与备份人。"
              : "管理员还没有整理业务责任田，稍后再来看看吧。"
          }
          icon={<Waypoints size={24} />}
          action={
            canManageActiveGroup ? (
              <button type="button" className="btn btn-primary" onClick={openCreate}>
                <Plus size={15} /> 创建第一块责任田
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="panel mx-panel">
          <div className="panel-header mx-panel-header">
            <div className="toolbar">
              <h2>
                <Waypoints size={15} /> 业务责任田
              </h2>
              <span className="badge badge-violet">{visibleAreas.length} 块</span>
              {selection ? (
                <span className="badge badge-blue">
                  {selection.name} · 主责 {selection.owned} / 备份 {selection.backed}
                </span>
              ) : null}
            </div>
            <div className="toolbar">
              <select
                className="select mx-member-filter"
                value={selectedMemberId}
                onChange={(event) => setSelectedMemberId(event.target.value)}
                aria-label="按成员筛选责任田"
              >
                <option value="">全部成员</option>
                {filterMembers.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>
              <div className="segmented mx-view-switch" role="group" aria-label="切换责任田视图">
                <button
                  type="button"
                  className={cn(view === "table" && "active")}
                  aria-pressed={view === "table"}
                  onClick={() => setView("table")}
                >
                  <Table2 size={13} /> 表格视图
                </button>
                <button
                  type="button"
                  className={cn(view === "network" && "active")}
                  aria-pressed={view === "network"}
                  onClick={() => setView("network")}
                >
                  <Network size={13} /> 网络视图
                </button>
              </div>
            </div>
          </div>

          {selectedMemberId && !visibleAreas.length ? (
            <div className="panel-body">
              <EmptyState
                compact
                title="该成员暂无责任田"
                description="在当前开发组中，这位成员既不是任何责任田的主责人，也不是备份人。"
                icon={<Users size={22} />}
                action={
                  <button type="button" className="btn btn-secondary" onClick={() => setSelectedMemberId("")}>
                    查看全部成员
                  </button>
                }
              />
            </div>
          ) : view === "table" ? (
            <>
              <div className="table-wrap mx-table-wrap">
                <table className="data-table mx-table">
                  <thead>
                    <tr>
                      <th>业务领域</th>
                      {selectedMemberId ? <th className="mx-role-col">与该成员的关系</th> : null}
                      <th>负责人</th>
                      <th>备份人</th>
                      {canManageActiveGroup ? <th className="mx-th-actions">操作</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleAreas.map((area, index) => (
                      <tr key={area.id}>
                        <td>
                          <div className="mx-area">
                            <span className="mx-area-index">{String(index + 1).padStart(2, "0")}</span>
                            <strong>{area.area}</strong>
                          </div>
                        </td>
                        {selectedMemberId ? (
                          <td>
                            <RoleBadge role={roleOfMember(area, selectedMemberId)} />
                          </td>
                        ) : null}
                        <td>
                          <MemberCell
                            memberId={area.ownerMemberId}
                            name={area.ownerName}
                            color={colorOf(area.ownerMemberId)}
                            emptyLabel="待认领"
                            onNavigate={goToMember}
                          />
                        </td>
                        <td>
                          <MemberCell
                            memberId={area.backupMemberId}
                            name={area.backupName}
                            color={colorOf(area.backupMemberId)}
                            emptyLabel="暂无备份"
                            onNavigate={goToMember}
                          />
                        </td>
                        {canManageActiveGroup ? (
                          <td>
                            <div className="mx-row-actions">
                              <button
                                type="button"
                                className="icon-button mx-row-action"
                                onClick={() => openEdit(area)}
                                title="编辑"
                                aria-label={`编辑 ${area.area}`}
                              >
                                <Pencil size={14} />
                              </button>
                              <button
                                type="button"
                                className="icon-button mx-row-action danger"
                                onClick={() => setDeleteTarget(area)}
                                title="删除"
                                aria-label={`删除 ${area.area}`}
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mx-cards">
                {visibleAreas.map((area, index) => (
                  <article className="mx-card" key={area.id}>
                    <header className="mx-card-head">
                      <div className="mx-card-title">
                        <span className="mx-card-index">{String(index + 1).padStart(2, "0")}</span>
                        <strong>{area.area}</strong>
                        {selectedMemberId ? (
                          <RoleBadge role={roleOfMember(area, selectedMemberId)} />
                        ) : null}
                      </div>
                    </header>
                    <div className="mx-card-people">
                      <div>
                        <small>负责人</small>
                        <MemberCell
                          memberId={area.ownerMemberId}
                          name={area.ownerName}
                          color={colorOf(area.ownerMemberId)}
                          emptyLabel="待认领"
                          onNavigate={goToMember}
                        />
                      </div>
                      <div>
                        <small>备份人</small>
                        <MemberCell
                          memberId={area.backupMemberId}
                          name={area.backupName}
                          color={colorOf(area.backupMemberId)}
                          emptyLabel="暂无备份"
                          onNavigate={goToMember}
                        />
                      </div>
                    </div>
                    {canManageActiveGroup ? (
                      <footer className="mx-card-actions">
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => openEdit(area)}>
                          <Pencil size={13} /> 编辑
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm mx-danger"
                          onClick={() => setDeleteTarget(area)}
                        >
                          <Trash2 size={13} /> 删除
                        </button>
                      </footer>
                    ) : null}
                  </article>
                ))}
              </div>
            </>
          ) : (
            <MatrixNetwork
              areas={sortedAreas}
              selectedMemberId={selectedMemberId}
              onSelectMember={(memberId) => setSelectedMemberId((prev) => (prev === memberId ? "" : memberId))}
            />
          )}
        </div>
      )}

      <Modal
        open={editorOpen}
        onClose={() => {
          if (!saving) setEditorOpen(false);
        }}
        title={editing ? "编辑责任田" : "新增责任田"}
        description="负责人决定这块领域谁拍板，备份人保证负责人缺席时仍有人接住。"
        size="lg"
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setEditorOpen(false)} disabled={saving}>
              取消
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void handleSave()} disabled={saving}>
              {saving ? "保存中…" : editing ? "保存修改" : "创建责任田"}
            </button>
          </>
        }
      >
        <div className="mx-form">
          <div className="form-grid">
            <div className="field span-2">
              <span className="field-label">业务领域</span>
              <input
                className="input"
                value={draft.area}
                maxLength={80}
                placeholder="例如：前端架构 / 数据看板 / 客户对接"
                onChange={(event) => setDraft((prev) => ({ ...prev, area: event.target.value }))}
                autoFocus
              />
            </div>
            <div className="field">
              <span className="field-label">负责人</span>
              <select
                className="select"
                value={draft.ownerMemberId}
                onChange={(event) => setDraft((prev) => ({ ...prev, ownerMemberId: event.target.value }))}
              >
                <option value="">待认领</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <span className="field-label">备份人</span>
              <select
                className="select"
                value={draft.backupMemberId}
                onChange={(event) => setDraft((prev) => ({ ...prev, backupMemberId: event.target.value }))}
              >
                <option value="">暂无备份</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>
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
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除责任田"
        message={`确定删除「${deleteTarget?.area ?? ""}」这块责任田吗？删除后相关成员将看不到这条分工信息。`}
        confirmLabel="删除责任田"
        onClose={() => {
          if (!deleting) setDeleteTarget(null);
        }}
        onConfirm={() => void handleDelete()}
        loading={deleting}
      />
    </div>
  );
}
