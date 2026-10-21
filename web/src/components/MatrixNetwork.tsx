import { useEffect, useMemo, useState } from "react";
import { Network } from "lucide-react";
import { EmptyState } from "./Feedback";
import { cn } from "../lib/utils";
import type { MatrixArea } from "../types";
import "./MatrixNetwork.css";

interface MatrixNetworkProps {
  areas: MatrixArea[];
  selectedMemberId: string;
  onSelectMember: (memberId: string) => void;
}

type EdgeRole = "owner" | "backup";

interface PersonNode {
  id: string;
  name: string;
  avatar?: string;
  ownerOf: Set<string>;
  backupOf: Set<string>;
}

interface GraphEdge {
  key: string;
  personId: string;
  areaId: string;
  role: EdgeRole;
  d: string;
}

interface GraphLayout {
  persons: PersonNode[];
  areaNodes: MatrixArea[];
  height: number;
  personYs: Map<string, number>;
  areaYs: Map<string, number>;
  edges: GraphEdge[];
}

const VIEW_WIDTH = 900;
const MEMBER_X = 128;
const MEMBER_RADIUS = 19;
const AREA_X = 560;
const AREA_WIDTH = 300;
const AREA_HEIGHT = 38;

const displayMark = (name: string): string => {
  const trimmed = (name || "?").trim();
  if (!trimmed) return "?";
  if (/[\u4e00-\u9fa5]/.test(trimmed)) return trimmed.slice(0, 1);
  const parts = trimmed.split(/\s+/).filter(Boolean);
  return parts.length > 1 ? (parts[0][0] + parts[1][0]).toUpperCase() : trimmed.slice(0, 2).toUpperCase();
};

const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** All backup ids of one area, with a defensive legacy fallback. */
const backupIdsOf = (area: MatrixArea): string[] => {
  const list = Array.isArray(area.backupMemberIds) ? area.backupMemberIds.filter(Boolean) : [];
  if (list.length) return Array.from(new Set(list));
  const hydrated = Array.isArray(area.backups) ? area.backups.map((backup) => backup.id).filter(Boolean) : [];
  if (hydrated.length) return Array.from(new Set(hydrated));
  return area.backupMemberId ? [area.backupMemberId] : [];
};

const distribute = (count: number, top: number, bottom: number): number[] => {
  if (count <= 0) return [];
  const available = Math.max(bottom - top, 1);
  if (count === 1) return [top + available / 2];
  const gap = Math.min(62, available / (count - 1));
  const total = gap * (count - 1);
  const start = top + (available - total) / 2;
  return Array.from({ length: count }, (_, index) => start + index * gap);
};

const bezier = (fromX: number, fromY: number, toX: number, toY: number): string => {
  const bend = (toX - fromX) * 0.42;
  return `M ${fromX} ${fromY} C ${fromX + bend} ${fromY}, ${toX - bend} ${toY}, ${toX} ${toY}`;
};

export function MatrixNetwork({ areas, selectedMemberId, onSelectMember }: MatrixNetworkProps) {
  const [focusedAreaId, setFocusedAreaId] = useState<string | null>(null);

  const graph = useMemo<GraphLayout>(() => {
    const personMap = new Map<string, PersonNode>();
    const ensurePerson = (id: string, name: string, avatar?: string): PersonNode => {
      let person = personMap.get(id);
      if (!person) {
        person = {
          id,
          name: name || "未命名",
          avatar,
          ownerOf: new Set<string>(),
          backupOf: new Set<string>(),
        };
        personMap.set(id, person);
      } else {
        if (!person.name && name) person.name = name;
        if (!person.avatar && avatar) person.avatar = avatar;
      }
      return person;
    };

    // Hydrated backup names/avatars come with the area payload; legacy fields
    // cover an older payload while the backend rollout is in flight.
    const backupNames = new Map<string, string>();
    const backupAvatars = new Map<string, string>();
    areas.forEach((area) => {
      if (!Array.isArray(area.backups)) return;
      area.backups.forEach((backup) => {
        if (!backup?.id) return;
        if (backup.name) backupNames.set(backup.id, backup.name);
        if (backup.avatar) backupAvatars.set(backup.id, backup.avatar);
      });
    });
    const backupNameOf = (area: MatrixArea, backupId: string): string =>
      backupNames.get(backupId) ||
      (area.backupMemberId === backupId ? area.backupName || "" : "") ||
      "未命名成员";
    const backupAvatarOf = (area: MatrixArea, backupId: string): string | undefined =>
      backupAvatars.get(backupId) ||
      (area.backupMemberId === backupId ? area.backupAvatar || "" : "") ||
      undefined;

    areas.forEach((area) => {
      if (area.ownerMemberId) {
        ensurePerson(area.ownerMemberId, area.ownerName, area.ownerAvatar || undefined).ownerOf.add(area.id);
      }
      // Include backup-only members as person nodes and count every backup area.
      backupIdsOf(area).forEach((backupId) => {
        ensurePerson(
          backupId,
          backupNameOf(area, backupId),
          backupAvatarOf(area, backupId),
        ).backupOf.add(area.id);
      });
    });

    const persons = Array.from(personMap.values()).sort((a, b) => {
      const engagement = b.ownerOf.size + b.backupOf.size - (a.ownerOf.size + a.backupOf.size);
      return engagement || a.name.localeCompare(b.name, "zh-CN");
    });
    const areaNodes = [...areas].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.area.localeCompare(b.area, "zh-CN"),
    );

    const height = Math.max(560, 120 + Math.max(persons.length, areaNodes.length, 1) * 56);
    const personList = distribute(persons.length, 78, height - 42);
    const areaList = distribute(areaNodes.length, 78, height - 42);
    const personYs = new Map<string, number>();
    persons.forEach((person, index) => personYs.set(person.id, personList[index]));
    const areaYs = new Map<string, number>();
    areaNodes.forEach((area, index) => areaYs.set(area.id, areaList[index]));

    const edges: GraphEdge[] = [];
    areaNodes.forEach((area) => {
      const areaY = areaYs.get(area.id) ?? 0;
      const pushEdge = (personId: string, role: EdgeRole, offset: number) => {
        const personY = personYs.get(personId) ?? 0;
        edges.push({
          key: `${area.id}-${personId}-${role}-${offset}`,
          personId,
          areaId: area.id,
          role,
          d: bezier(MEMBER_X + MEMBER_RADIUS, personY + offset, AREA_X, areaY + offset),
        });
      };
      if (area.ownerMemberId) pushEdge(area.ownerMemberId, "owner", 0);
      // One dashed edge per backup member; fan them out slightly so overlapping
      // endpoints stay readable.
      const backupIds = backupIdsOf(area);
      backupIds.forEach((backupId, index) => {
        const offset = 3 + (index - (backupIds.length - 1) / 2) * 2.4;
        pushEdge(backupId, "backup", offset);
      });
    });

    return { persons, areaNodes, height, personYs, areaYs, edges };
  }, [areas]);

  // Hydrated backup names for the area tooltip (same defensive fallback as the graph).
  const backupNameMap = useMemo(() => {
    const map = new Map<string, string>();
    areas.forEach((area) => {
      if (!Array.isArray(area.backups)) return;
      area.backups.forEach((backup) => {
        if (backup?.id && backup.name) map.set(backup.id, backup.name);
      });
    });
    return map;
  }, [areas]);

  // A new member filter starts from a clean canvas.
  useEffect(() => {
    setFocusedAreaId(null);
  }, [selectedMemberId]);

  if (!areas.length || !graph.persons.length) {
    return (
      <div className="mx-network">
        <EmptyState
          compact
          title="暂无可视化关系"
          description="给责任田指定负责人或备份成员后，这里会自动生成协作网络。"
          icon={<Network size={22} />}
        />
      </div>
    );
  }

  const selectedPerson = graph.persons.find((person) => person.id === selectedMemberId) ?? null;
  const selectedAreaIds = selectedPerson
    ? new Set<string>([...selectedPerson.ownerOf, ...selectedPerson.backupOf])
    : null;
  const focusedPersonIds = focusedAreaId
    ? new Set(graph.edges.filter((edge) => edge.areaId === focusedAreaId).map((edge) => edge.personId))
    : null;
  const hasEmphasis = Boolean(selectedPerson || focusedAreaId);

  const personIsRelated = (person: PersonNode) =>
    person.id === selectedMemberId || Boolean(focusedPersonIds?.has(person.id));
  const personIsDimmed = (person: PersonNode) => hasEmphasis && !personIsRelated(person);
  const areaIsRelated = (area: MatrixArea) =>
    Boolean(selectedAreaIds?.has(area.id)) || focusedAreaId === area.id;
  const areaIsDimmed = (area: MatrixArea) => hasEmphasis && !areaIsRelated(area);
  const edgeIsRelated = (edge: GraphEdge) =>
    Boolean(selectedPerson && edge.personId === selectedPerson.id) ||
    Boolean(focusedAreaId && edge.areaId === focusedAreaId);

  const edgeClass = (edge: GraphEdge) => {
    const related = edgeIsRelated(edge);
    return cn(
      "mx-network-edge",
      edge.role === "owner" ? "is-owner" : "is-backup",
      hasEmphasis && related && "is-active",
      hasEmphasis && !related && "is-dimmed",
    );
  };

  const renderEdge = (edge: GraphEdge) => <path key={edge.key} d={edge.d} className={edgeClass(edge)} />;

  return (
    <div className="mx-network">
      <div className="mx-network-head">
        <div className="mx-network-legend" aria-label="连线与图例说明">
          <span className="mx-network-legend-item">
            <i className="mx-network-legend-line" aria-hidden="true" /> 主责连线（实线）
          </span>
          <span className="mx-network-legend-item">
            <i className="mx-network-legend-line is-backup" aria-hidden="true" /> 备份连线（虚线）
          </span>
        </div>
        <p className="mx-network-hint">点击成员节点筛选其责任田，点击领域节点聚焦相关连线</p>
      </div>

      <div className="mx-network-scroll">
        <svg
          className="mx-network-canvas"
          viewBox={`0 0 ${VIEW_WIDTH} ${graph.height}`}
          role="img"
          aria-label="成员与业务责任田的协作网络图"
        >
          <defs>
            <pattern id="mx-network-dots" width="28" height="28" patternUnits="userSpaceOnUse">
              <circle cx="1.4" cy="1.4" r="1.4" className="mx-network-dot-grid" />
            </pattern>
          </defs>
          <rect
            className="mx-network-canvas-bg"
            width={VIEW_WIDTH}
            height={graph.height}
            fill="url(#mx-network-dots)"
          />
          <text x={MEMBER_X} y={34} textAnchor="middle" className="mx-network-column-label">
            成员
          </text>
          <text x={AREA_X + AREA_WIDTH / 2} y={34} textAnchor="middle" className="mx-network-column-label">
            业务责任田
          </text>

          <g className="mx-network-edges" aria-hidden="true">
            {graph.edges.filter((edge) => edge.role === "backup").map(renderEdge)}
            {graph.edges.filter((edge) => edge.role === "owner").map(renderEdge)}
          </g>

          <g className="mx-network-nodes">
            {graph.persons.map((person, personIndex) => {
              const y = graph.personYs.get(person.id) ?? 0;
              const isSelected = person.id === selectedMemberId;
              return (
                <g
                  key={person.id}
                  className={cn(
                    "mx-network-node",
                    "mx-network-person",
                    isSelected && "is-selected",
                    personIsRelated(person) && "is-related",
                    personIsDimmed(person) && "is-dimmed",
                  )}
                  transform={`translate(${MEMBER_X} ${y})`}
                  role="button"
                  tabIndex={0}
                  aria-pressed={isSelected}
                  aria-label={`按成员筛选：${person.name}`}
                  onClick={() => onSelectMember(person.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelectMember(person.id);
                    }
                  }}
                >
                  <title>{`${person.name} · 主责 ${person.ownerOf.size} 块 · 备份 ${person.backupOf.size} 块`}</title>
                  {isSelected ? <circle r={MEMBER_RADIUS + 7} className="mx-network-focus-ring" /> : null}
                  {person.avatar ? (
                    <>
                      <clipPath id={`mx-person-clip-${personIndex}`}>
                        <circle r={MEMBER_RADIUS} />
                      </clipPath>
                      <circle r={MEMBER_RADIUS} className="mx-network-person-dot" />
                      <image
                        href={person.avatar}
                        x={-MEMBER_RADIUS}
                        y={-MEMBER_RADIUS}
                        width={MEMBER_RADIUS * 2}
                        height={MEMBER_RADIUS * 2}
                        clipPath={`url(#mx-person-clip-${personIndex})`}
                        preserveAspectRatio="xMidYMid slice"
                      />
                    </>
                  ) : (
                    <>
                      <circle r={MEMBER_RADIUS} className="mx-network-person-dot" />
                      <text textAnchor="middle" y={3.5} className="mx-network-person-initial">
                        {displayMark(person.name)}
                      </text>
                    </>
                  )}
                  <text x={MEMBER_RADIUS + 10} y={-1} className="mx-network-person-label">
                    {truncate(person.name, 10)}
                  </text>
                  <text x={MEMBER_RADIUS + 10} y={14} className="mx-network-count">
                    主责 {person.ownerOf.size} · 备份 {person.backupOf.size}
                  </text>
                </g>
              );
            })}

            {graph.areaNodes.map((area) => {
              const y = graph.areaYs.get(area.id) ?? 0;
              const isFocused = focusedAreaId === area.id;
              const areaBackupNames = backupIdsOf(area).map(
                (backupId) =>
                  backupNameMap.get(backupId) ||
                  (area.backupMemberId === backupId ? area.backupName || "" : "") ||
                  "未命名成员",
              );
              const description = area.description?.trim() ?? "";
              const tooltip = [
                area.area,
                `主责 ${area.ownerName || "待认领"}`,
                `备份 ${areaBackupNames.length ? areaBackupNames.join("、") : "暂无"}`,
                description ? `描述 ${description}` : "",
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <g
                  key={area.id}
                  className={cn(
                    "mx-network-node",
                    "mx-network-area",
                    isFocused && "is-focused",
                    areaIsRelated(area) && "is-related",
                    areaIsDimmed(area) && "is-dimmed",
                  )}
                  transform={`translate(${AREA_X} ${y})`}
                  role="button"
                  tabIndex={0}
                  aria-pressed={isFocused}
                  aria-label={`聚焦责任田：${area.area}`}
                  onClick={() => setFocusedAreaId((prev) => (prev === area.id ? null : area.id))}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setFocusedAreaId((prev) => (prev === area.id ? null : area.id));
                    }
                  }}
                >
                  <title>{tooltip}</title>
                  <rect
                    className="mx-network-area-rect"
                    x={0}
                    y={-AREA_HEIGHT / 2}
                    width={AREA_WIDTH}
                    height={AREA_HEIGHT}
                    rx={12}
                  />
                  <text x={16} y={4} className="mx-network-area-label">
                    {truncate(area.area, areaBackupNames.length ? 15 : 19)}
                  </text>
                  <text x={AREA_WIDTH - 14} y={4} textAnchor="end" className="mx-network-area-state">
                    {area.ownerMemberId
                      ? areaBackupNames.length
                        ? `已认领 · 备份 ${areaBackupNames.length}`
                        : "已认领"
                      : "待认领"}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    </div>
  );
}

export default MatrixNetwork;
