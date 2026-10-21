import { useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Plus,
  Quote,
  RefreshCw,
  Sparkles,
  Trash2,
  TrendingDown,
  Trophy,
  WifiOff,
} from "lucide-react";
import { api, ApiError } from "../api";
import { useApp } from "../store";
import { useToast } from "../components/Toast";
import { Avatar } from "../components/Avatar";
import { Modal } from "../components/Modal";
import { Select } from "../components/Select";
import { EmptyState, LoadingBlock } from "../components/Feedback";
import { cn, formatDateTime, monthKey, monthLabel, shiftMonth, uid } from "../lib/utils";
import type { Member, RedBlackData, RedBlackEntry } from "../types";
import "./RedBlackPage.css";

type Side = "red" | "black";

interface DraftEntry {
  key: string;
  memberId: string;
  memberName: string;
  title: string;
  reason: string;
  score: string;
}

interface BoardDraft {
  theme: string;
  red: DraftEntry[];
  black: DraftEntry[];
}

const newEntry = (): DraftEntry => ({
  key: uid("rb"),
  memberId: "",
  memberName: "",
  title: "",
  reason: "",
  score: "",
});

const toDraftEntries = (entries: RedBlackEntry[]): DraftEntry[] =>
  entries.length
    ? entries.map((entry) => ({
        key: uid("rb"),
        memberId: entry.memberId ?? "",
        memberName: entry.memberName,
        title: entry.title,
        reason: entry.reason,
        score: entry.score ? String(entry.score) : "",
      }))
    : [newEntry()];

const mergeMonth = (months: string[], month: string): string[] =>
  Array.from(new Set([...months, month])).sort().reverse();

function BoardColumn({
  side,
  label,
  hint,
  entries,
  showScores,
  colorOf,
}: {
  side: Side;
  label: string;
  hint: string;
  entries: RedBlackEntry[];
  showScores: boolean;
  colorOf: (memberId: string | null) => string | undefined;
}) {
  return (
    <section className={cn("card rb-column", `rb-column-${side}`)}>
      <header className="rb-column-head">
        <span className="rb-column-icon">
          {side === "red" ? <Trophy size={17} /> : <TrendingDown size={17} />}
        </span>
        <div className="rb-column-copy">
          <h2>{label}</h2>
          <p>{hint}</p>
        </div>
        <span className="rb-column-count">{entries.length}</span>
      </header>
      {entries.length === 0 ? (
        <div className="rb-column-empty">
          {side === "red"
            ? "红榜虚位以待，等待下一个被看见的名字。"
            : "暂无复盘记录。把踩过的坑记下来，是下一次做对的开始。"}
        </div>
      ) : (
        <ol className="rb-entry-list">
          {entries.map((entry, index) => (
            <li className="rb-entry" key={entry.id}>
              <span className="rb-rank">{String(index + 1).padStart(2, "0")}</span>
              <Avatar
                name={entry.memberName || "匿名"}
                src={entry.memberAvatar}
                color={colorOf(entry.memberId)}
                size="sm"
              />
              <div className="rb-entry-body">
                <div className="rb-entry-top">
                  <strong>{entry.title}</strong>
                  {showScores ? (
                    <span className="rb-score">
                      {entry.score}
                      <small>分</small>
                    </span>
                  ) : null}
                </div>
                <span className="rb-entry-name">{entry.memberName || "未署名"}</span>
                {entry.reason ? <p className="rb-entry-reason">{entry.reason}</p> : null}
                {entry.createdAt ? (
                  <time className="rb-entry-date" dateTime={entry.createdAt}>
                    {formatDateTime(entry.createdAt)}
                  </time>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function DraftColumn({
  side,
  label,
  entries,
  members,
  showScores,
  onAdd,
  onRemove,
  onUpdate,
  onPickMember,
}: {
  side: Side;
  label: string;
  entries: DraftEntry[];
  members: Member[];
  showScores: boolean;
  onAdd: (side: Side) => void;
  onRemove: (side: Side, key: string) => void;
  onUpdate: (side: Side, key: string, patch: Partial<DraftEntry>) => void;
  onPickMember: (side: Side, key: string, memberId: string) => void;
}) {
  const memberOptions = useMemo(
    () => [
      { value: "", label: "手动填写" },
      ...members.map((member) => ({
        value: member.id,
        label: member.name,
        description: member.title || undefined,
        avatar: member.avatar,
        color: member.avatarColor,
      })),
    ],
    [members],
  );
  return (
    <section className={cn("rb-draft", `rb-draft-${side}`)}>
      <header className="rb-draft-head">
        <span className="rb-draft-icon">
          {side === "red" ? <Trophy size={14} /> : <TrendingDown size={14} />}
        </span>
        <strong>{label}</strong>
        <small>{entries.length} 条</small>
      </header>
      <div className="rb-draft-list">
        {entries.map((entry, index) => (
          <div className="rb-draft-row" key={entry.key}>
            <div className="rb-draft-row-head">
              <span>#{index + 1}</span>
              <button
                type="button"
                className="icon-button rb-draft-remove"
                onClick={() => onRemove(side, entry.key)}
                aria-label="删除该条目"
              >
                <Trash2 size={14} />
              </button>
            </div>
            <div className="rb-draft-grid">
              <div className="field">
                <span className="field-label">选择成员</span>
                <Select
                  value={entry.memberId}
                  onChange={(next) => onPickMember(side, entry.key, next)}
                  options={memberOptions}
                  ariaLabel="选择成员"
                  placeholder="手动填写"
                  searchable={members.length > 6}
                />
              </div>
              <div className="field">
                <span className="field-label">姓名</span>
                <input
                  className="input"
                  value={entry.memberName}
                  maxLength={60}
                  placeholder="成员姓名"
                  onChange={(event) => onUpdate(side, entry.key, { memberName: event.target.value })}
                />
              </div>
              <div className={cn("field", !showScores && "span-2")}>
                <span className="field-label">标题</span>
                <input
                  className="input"
                  value={entry.title}
                  maxLength={160}
                  placeholder={side === "red" ? "做对了什么？" : "需要改进什么？"}
                  onChange={(event) => onUpdate(side, entry.key, { title: event.target.value })}
                />
              </div>
              {showScores ? (
                <div className="field">
                  <span className="field-label">评分 (0–100)</span>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={entry.score}
                    placeholder="0"
                    onChange={(event) => onUpdate(side, entry.key, { score: event.target.value })}
                  />
                </div>
              ) : null}
              <div className="field span-2">
                <span className="field-label">上榜理由</span>
                <textarea
                  className="textarea"
                  rows={2}
                  value={entry.reason}
                  maxLength={1000}
                  placeholder="发生了什么，带来了什么影响？"
                  onChange={(event) => onUpdate(side, entry.key, { reason: event.target.value })}
                />
              </div>
            </div>
          </div>
        ))}
        <button type="button" className="btn btn-secondary btn-sm rb-draft-add" onClick={() => onAdd(side)}>
          <Plus size={14} /> 添加{label}条目
        </button>
      </div>
    </section>
  );
}

export default function RedBlackPage() {
  const { currentTeam, canManageActiveTeam, config } = useApp();
  const { toast } = useToast();

  const teamId = currentTeam?.id ?? "";
  const showScores = config?.redblack.showScores ?? true;
  const redLabel = config?.redblack.redLabel || "红榜 · 高光时刻";
  const blackLabel = config?.redblack.blackLabel || "黑榜 · 待改进";
  // Everyone can read the board; only team administrators may edit it.
  const canEditBoard = canManageActiveTeam;

  const [data, setData] = useState<RedBlackData | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [monthSelector, setMonthSelector] = useState("");
  const [refreshTick, setRefreshTick] = useState(0);
  const [editorOpen, setEditorOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rolling, setRolling] = useState(false);
  const [draft, setDraft] = useState<BoardDraft>({ theme: "", red: [newEntry()], black: [newEntry()] });

  const lastTeamRef = useRef("");
  const requestRef = useRef(0);

  useEffect(() => {
    if (!teamId) return;
    if (lastTeamRef.current !== teamId) {
      lastTeamRef.current = teamId;
      setEditorOpen(false);
      setDraft({ theme: "", red: [newEntry()], black: [newEntry()] });
      setData(null);
      setMembers([]);
      if (monthSelector) {
        // Reset to the server's current month when the active team changes.
        setLoading(true);
        setMonthSelector("");
        return;
      }
    }
    let cancelled = false;
    const seq = ++requestRef.current;
    setLoading(true);
    setError("");
    void Promise.all([
      api.redblack(teamId, monthSelector || undefined),
      api.overview(teamId).catch(() => null),
    ])
      .then(([boardData, overview]) => {
        if (cancelled || seq !== requestRef.current) return;
        setData(boardData);
        setMembers(overview?.members ?? []);
      })
      .catch((err: unknown) => {
        if (cancelled || seq !== requestRef.current) return;
        const message = err instanceof ApiError ? err.message : "红黑榜加载失败，请稍后重试。";
        setError(message);
        toast(message, "error");
      })
      .finally(() => {
        if (!cancelled && seq === requestRef.current) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, monthSelector, refreshTick, toast]);

  const memberById = useMemo(() => new Map(members.map((member) => [member.id, member])), [members]);
  const colorOf = (memberId: string | null) => (memberId ? memberById.get(memberId)?.avatarColor : undefined);

  const board = data?.board ?? null;
  const month = data?.month ?? monthSelector ?? "";
  const totalEntries = board ? board.red.length + board.black.length : 0;
  const isEmptyBoard = !board || (!board.theme && totalEntries === 0);
  const monthOptions = useMemo(() => {
    const months = data?.availableMonths ?? [];
    return Array.from(new Set(month ? [month, ...months] : months)).sort().reverse();
  }, [data?.availableMonths, month]);

  const reload = () => setRefreshTick((value) => value + 1);

  const shiftTo = (delta: number) => {
    const current = data?.month ?? monthSelector ?? monthKey();
    setMonthSelector(shiftMonth(current, delta));
  };

  const openEditor = () => {
    setDraft({
      theme: board?.theme ?? "",
      red: toDraftEntries(board?.red ?? []),
      black: toDraftEntries(board?.black ?? []),
    });
    setEditorOpen(true);
  };

  const updateEntry = (side: Side, key: string, patch: Partial<DraftEntry>) => {
    setDraft((prev) => ({
      ...prev,
      [side]: prev[side].map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)),
    }));
  };

  const addEntry = (side: Side) => {
    setDraft((prev) => ({ ...prev, [side]: [...prev[side], newEntry()] }));
  };

  const removeEntry = (side: Side, key: string) => {
    setDraft((prev) => ({ ...prev, [side]: prev[side].filter((entry) => entry.key !== key) }));
  };

  const pickMember = (side: Side, key: string, memberId: string) => {
    const member = memberById.get(memberId);
    setDraft((prev) => ({
      ...prev,
      [side]: prev[side].map((entry) =>
        entry.key === key ? { ...entry, memberId, memberName: member?.name ?? entry.memberName } : entry,
      ),
    }));
  };

  const handleSave = async () => {
    if (!teamId || !canEditBoard) return;
    const normalize = (list: DraftEntry[]) =>
      list
        .filter((entry) => entry.memberName.trim() || entry.title.trim() || entry.reason.trim())
        .map((entry) => ({
          memberId: entry.memberId || null,
          memberName: entry.memberName.trim(),
          title: entry.title.trim(),
          reason: entry.reason.trim(),
          rawScore: entry.score.trim(),
        }));
    const red = normalize(draft.red);
    const black = normalize(draft.black);
    if ([...red, ...black].some((entry) => !entry.memberName)) {
      toast("请为每条榜单填写成员姓名", "error");
      return;
    }
    if ([...red, ...black].some((entry) => !entry.title)) {
      toast("请为每条榜单填写标题", "error");
      return;
    }
    if (showScores) {
      const invalid = [...red, ...black].find(
        (entry) => entry.rawScore !== "" && (!Number.isFinite(Number(entry.rawScore)) || Number(entry.rawScore) < 0 || Number(entry.rawScore) > 100),
      );
      if (invalid) {
        toast("评分需为 0–100 之间的数字", "error");
        return;
      }
    }
    const body = {
      month: data?.month ?? monthSelector ?? monthKey(),
      theme: draft.theme.trim(),
      red: red.map((entry) => ({
        memberId: entry.memberId,
        memberName: entry.memberName,
        title: entry.title,
        reason: entry.reason,
        score: showScores ? Number(entry.rawScore) || 0 : 0,
      })),
      black: black.map((entry) => ({
        memberId: entry.memberId,
        memberName: entry.memberName,
        title: entry.title,
        reason: entry.reason,
        score: showScores ? Number(entry.rawScore) || 0 : 0,
      })),
    };
    setSaving(true);
    try {
      const result = await api.saveRedblack(teamId, body);
      setData((prev) =>
        prev
          ? {
              ...prev,
              month: result.board.month,
              board: result.board,
              availableMonths: mergeMonth(prev.availableMonths, result.board.month),
            }
          : prev,
      );
      setEditorOpen(false);
      toast("红黑榜已保存", "success");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "保存失败，请稍后重试", "error");
    } finally {
      setSaving(false);
    }
  };

  const handleRollover = async () => {
    if (!teamId || !canEditBoard) return;
    setRolling(true);
    try {
      const source = data?.month ?? monthKey();
      const result = await api.rolloverRedblack(teamId, source);
      if (result.board) {
        setData((prev) =>
          prev
            ? {
                ...prev,
                month: result.month,
                board: result.board ?? prev.board,
                availableMonths: mergeMonth(prev.availableMonths, result.month),
              }
            : prev,
        );
      }
      toast(`已切换到 ${monthLabel(result.month)} 红黑榜`, "success");
      setMonthSelector(result.month);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "生成下月榜单失败", "error");
    } finally {
      setRolling(false);
    }
  };

  if (!currentTeam) {
    return (
      <EmptyState
        title="尚未选择团队"
        description="请从左侧导航选择一个团队，再查看它的红黑榜。"
        icon={<Trophy size={24} />}
      />
    );
  }

  return (
    <div className="rb-page fade-up">
      <header className="page-header">
        <div className="page-heading">
          <span className="eyebrow">
            <Sparkles size={12} /> CULTURE / RECOGNITION
          </span>
          <h1 className="page-title">红黑榜</h1>
          <p className="page-subtitle">
            每月一次公开复盘：把值得被看见的高光与需要改进的教训写进团队叙事，让成长有迹可循。
          </p>
        </div>
        <div className="page-actions">
          <div className="rb-monthbar">
            <button
              type="button"
              className="icon-button rb-month-arrow"
              onClick={() => shiftTo(-1)}
              aria-label="上一月"
              disabled={loading}
            >
              <ChevronLeft size={16} />
            </button>
            <select
              className="select rb-month-select"
              value={month}
              onChange={(event) => setMonthSelector(event.target.value)}
              aria-label="选择月份"
              disabled={!monthOptions.length}
            >
              {monthOptions.map((item) => (
                <option key={item} value={item}>
                  {monthLabel(item)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="icon-button rb-month-arrow"
              onClick={() => shiftTo(1)}
              aria-label="下一月"
              disabled={loading}
            >
              <ChevronRight size={16} />
            </button>
          </div>
          {canEditBoard ? (
            <>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => void handleRollover()}
                disabled={rolling || loading || !data}
                title="以当前月为模板创建下月榜单"
              >
                <RefreshCw size={15} className={rolling ? "spin" : undefined} /> 生成下月
              </button>
              <button type="button" className="btn btn-primary" onClick={openEditor} disabled={loading}>
                <Pencil size={15} /> 编辑榜单
              </button>
            </>
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

      {loading && !data ? (
        <div className="panel">
          <div className="panel-body">
            <LoadingBlock label="正在加载红黑榜…" rows={5} />
          </div>
        </div>
      ) : !data ? (
        <EmptyState
          title="红黑榜暂时无法加载"
          description={error || "请检查网络后重新加载。"}
          icon={<WifiOff size={24} />}
          action={
            <button type="button" className="btn btn-primary" onClick={reload}>
              重新加载
            </button>
          }
        />
      ) : (
        <>
          <section className="rb-hero">
            <div className="rb-hero-main">
              <span className="rb-hero-badge">
                <CalendarRange size={13} /> {monthLabel(month)}
              </span>
              <div className="rb-hero-theme">
                <Quote size={22} className="rb-quote" />
                <h2>{board?.theme?.trim() || "本月主题征集中"}</h2>
              </div>
              <p className="rb-hero-note">
                {isEmptyBoard
                  ? "这个月还没有记录。被忽略的贡献值得补记，踩过的坑也值得复盘的勇气。"
                  : `本期共记录 ${totalEntries} 条上榜与复盘条目，每一次坦诚都是团队的一次升级。`}
              </p>
            </div>
            <div className="rb-hero-stats">
              <div className="rb-hero-stat rb-tone-red">
                <span>{redLabel}</span>
                <strong>{board?.red.length ?? 0}</strong>
              </div>
              <div className="rb-hero-stat rb-tone-black">
                <span>{blackLabel}</span>
                <strong>{board?.black.length ?? 0}</strong>
              </div>
              <div className="rb-hero-stat">
                <span>最近更新</span>
                <strong className="rb-hero-date">{board?.updatedAt ? formatDateTime(board.updatedAt) : "—"}</strong>
              </div>
            </div>
          </section>

          {isEmptyBoard ? (
            <EmptyState
              title="这个月还没有红黑榜"
              description={
                canEditBoard
                  ? "创建本月榜单，写下值得被看见的名字与值得复盘的教训。"
                  : "管理员还没有发布本月榜单，稍后再来看看吧。"
              }
              icon={<Trophy size={24} />}
              action={
                canEditBoard ? (
                  <button type="button" className="btn btn-primary" onClick={openEditor}>
                    <Plus size={15} /> 创建本月榜单
                  </button>
                ) : undefined
              }
            />
          ) : (
            <div className="rb-columns" key={month}>
              <BoardColumn
                side="red"
                label={redLabel}
                hint="值得被看见的高光时刻"
                entries={board?.red ?? []}
                showScores={showScores}
                colorOf={colorOf}
              />
              <BoardColumn
                side="black"
                label={blackLabel}
                hint="值得被记住的教训复盘"
                entries={board?.black ?? []}
                showScores={showScores}
                colorOf={colorOf}
              />
            </div>
          )}
        </>
      )}

      <Modal
        open={editorOpen && canEditBoard}
        onClose={() => {
          if (!saving) setEditorOpen(false);
        }}
        title={`编辑 ${monthLabel(data?.month ?? monthKey())} 红黑榜`}
        description="覆盖保存后立即生效；只填写了部分内容的空行会被自动忽略。"
        size="xl"
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setEditorOpen(false)} disabled={saving}>
              取消
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void handleSave()} disabled={saving}>
              {saving ? "保存中…" : "保存榜单"}
            </button>
          </>
        }
      >
        <div className="rb-editor">
          <div className="field">
            <span className="field-label">月度主题</span>
            <input
              className="input"
              value={draft.theme}
              maxLength={120}
              placeholder="例如：把复杂留给自己，把简单留给队友"
              onChange={(event) => setDraft((prev) => ({ ...prev, theme: event.target.value }))}
            />
            <span className="field-hint">主题会作为本期引言展示在红黑榜顶部，留空则显示「本月主题征集中」。</span>
          </div>
          <div className="rb-editor-columns">
            <DraftColumn
              side="red"
              label={redLabel}
              entries={draft.red}
              members={members}
              showScores={showScores}
              onAdd={addEntry}
              onRemove={removeEntry}
              onUpdate={updateEntry}
              onPickMember={pickMember}
            />
            <DraftColumn
              side="black"
              label={blackLabel}
              entries={draft.black}
              members={members}
              showScores={showScores}
              onAdd={addEntry}
              onRemove={removeEntry}
              onUpdate={updateEntry}
              onPickMember={pickMember}
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
