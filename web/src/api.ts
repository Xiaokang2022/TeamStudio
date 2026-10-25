import type {
  ActivationLink,
  Announcement,
  AnnouncementsData,
  AppSettings,
  AuthConfigData,
  BootstrapData,
  DomainSettingsData,
  DomainTeamSettings,
  EmailCodeRequestResponse,
  EmailCodeVerifyResponse,
  EmailLog,
  EmailStatus,
  InsightsData,
  InsightsRangeKey,
  LinkItem,
  ManagedTeam,
  MatrixArea,
  Member,
  MemberCandidate,
  MemberTask,
  ModuleFlags,
  OverviewData,
  ProfileData,
  RedBlackBoard,
  RedBlackData,
  SettingsMeta,
  SettingsResponse,
  SystemResetInfo,
  SystemResetResult,
  TagLibraryData,
  TaskOverviewData,
  TeamGroup,
  TeamGroupKind,
  TeamSettingsPayload,
  Todo,
  UserAccount,
  UsersData,
  ValidationDetail,
  WorkItem,
  WorkspaceManageData,
  WorkspaceOption,
} from "./types";

export class ApiError extends Error {
  status: number;
  code: string;
  details: ValidationDetail[] | unknown;

  constructor(message: string, status = 0, code = "network_error", details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type RequestOptions = Omit<RequestInit, "body"> & { body?: unknown };

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  const isForm = typeof FormData !== "undefined" && options.body instanceof FormData;
  if (options.body !== undefined && !isForm) headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      credentials: "include",
      headers,
      body:
        options.body === undefined
          ? undefined
          : isForm
            ? (options.body as FormData)
            : JSON.stringify(options.body),
    });
  } catch (error) {
    throw new ApiError(
      "无法连接服务端，请确认后端已启动。",
      0,
      "network_error",
      error instanceof Error ? error.message : undefined,
    );
  }
  const contentType = response.headers.get("content-type") ?? "";
  let payload: unknown = null;
  if (contentType.includes("application/json")) {
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
  } else {
    const text = await response.text();
    if (!response.ok) {
      throw new ApiError(text.slice(0, 200) || `请求失败 (${response.status})`, response.status);
    }
    return text as T;
  }
  const envelope = payload as
    | { ok?: boolean; data?: T; error?: { code?: string; message?: string; details?: unknown } }
    | null;
  if (!response.ok || !envelope?.ok) {
    throw new ApiError(
      envelope?.error?.message || `请求失败 (${response.status})`,
      response.status,
      envelope?.error?.code || "request_failed",
      envelope?.error?.details,
    );
  }
  return envelope.data as T;
}

const q = (params: Record<string, string | number | undefined | null>) => {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  });
  const text = search.toString();
  return text ? `?${text}` : "";
};

/** Every business endpoint is scoped by team only (round 8: no development groups). */
const teamBase = (teamId: string) => `/api/teams/${encodeURIComponent(teamId)}`;

export const api = {
  /* ---------------------------------------------------------------- */
  /* Bootstrap / identity                                              */
  /* ---------------------------------------------------------------- */
  bootstrap: (teamId?: string) => request<BootstrapData>(`/api/bootstrap${q({ teamId })}`),
  me: () => request<BootstrapData["me"]>("/api/auth/me"),
  authConfig: () => request<AuthConfigData>("/api/auth/config"),
  requestEmailCode: (email: string) =>
    request<EmailCodeRequestResponse>("/api/auth/email/request", {
      method: "POST",
      body: { email },
    }),
  verifyEmailCode: (email: string, code: string) =>
    request<EmailCodeVerifyResponse>("/api/auth/email/verify", {
      method: "POST",
      body: { email, code },
    }),
  logout: () =>
    request<{ loggedOut: boolean; endSessionUrl?: string }>("/api/auth/logout", {
      method: "POST",
    }),
  deviceLogin: () =>
    request<{ deviceAdmin: boolean; authenticated: boolean }>("/api/auth/device/login", {
      method: "POST",
    }),
  ssoLoginHref: (next = "/") => `/api/auth/login?next=${encodeURIComponent(next)}`,

  /* ---------------------------------------------------------------- */
  /* Account administration (super administrators)                     */
  /* ---------------------------------------------------------------- */
  listUsers: () => request<UsersData>("/api/users"),
  createUser: (body: {
    email: string;
    name?: string;
    role?: string;
    teamIds?: string[];
  }) =>
    request<{ user: UserAccount; activation: ActivationLink | null }>("/api/users", {
      method: "POST",
      body,
    }),
  createActivationLink: (userId: string) =>
    request<{ activation: ActivationLink }>(
      `/api/users/${encodeURIComponent(userId)}/activation-link`,
      { method: "POST" },
    ),
  updateUser: (
    userId: string,
    body: { name?: string; role?: string; teamIds?: string[] },
  ) =>
    request<{ user: UserAccount }>(`/api/users/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      body,
    }),
  deleteUser: (userId: string) =>
    request<{ deleted: boolean; id: string }>(`/api/users/${encodeURIComponent(userId)}`, {
      method: "DELETE",
    }),

  /* ---------------------------------------------------------------- */
  /* Personal home page                                                */
  /* ---------------------------------------------------------------- */
  getProfile: () => request<ProfileData>("/api/profile"),
  getUserProfile: (userId: string) =>
    request<ProfileData>(`/api/users/${encodeURIComponent(userId)}/profile`),
  updateProfile: (body: {
    name?: string;
    avatarColor?: string;
    bio?: string;
    skills?: string[];
  }) => request<{ user: UserAccount }>("/api/profile", { method: "PATCH", body }),
  uploadAvatar: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<{ avatar: string; user: UserAccount }>("/api/profile/avatar", {
      method: "POST",
      body: form,
    });
  },
  deleteAvatar: () =>
    request<{ user: UserAccount }>("/api/profile/avatar", { method: "DELETE" }),

  /* ---------------------------------------------------------------- */
  /* Team-scoped feature reads / writes                                */
  /* ---------------------------------------------------------------- */
  overview: (teamId: string) =>
    request<OverviewData>(`${teamBase(teamId)}/overview`),

  tasks: (teamId: string) => request<TaskOverviewData>(`${teamBase(teamId)}/tasks`),
  taskTags: (teamId: string) => request<TagLibraryData>(`${teamBase(teamId)}/task-tags`),
  createTaskTag: (teamId: string, body: { name: string; color?: string }) =>
    request<{ tag: import("./types").TaskTag }>(`${teamBase(teamId)}/task-tags`, {
      method: "POST",
      body,
    }),
  updateTaskTag: (
    teamId: string,
    tagId: string,
    body: { name?: string; color?: string },
  ) =>
    request<{ tag: import("./types").TaskTag }>(
      `${teamBase(teamId)}/task-tags/${tagId}`,
      { method: "PATCH", body },
    ),
  deleteTaskTag: (teamId: string, tagId: string) =>
    request<{ deleted: boolean }>(`${teamBase(teamId)}/task-tags/${tagId}`, {
      method: "DELETE",
    }),
  createTask: (teamId: string, body: Partial<MemberTask>) =>
    request<{ task: MemberTask }>(`${teamBase(teamId)}/tasks`, {
      method: "POST",
      body,
    }),
  updateTask: (teamId: string, taskId: string, body: Partial<MemberTask>) =>
    request<{ task: MemberTask }>(`${teamBase(teamId)}/tasks/${taskId}`, {
      method: "PATCH",
      body,
    }),
  deleteTask: (teamId: string, taskId: string) =>
    request<{ deleted: boolean }>(`${teamBase(teamId)}/tasks/${taskId}`, {
      method: "DELETE",
    }),

  updateMember: (teamId: string, memberId: string, body: Partial<Member>) =>
    request<{ member: Member }>(`${teamBase(teamId)}/members/${memberId}`, {
      method: "PATCH",
      body,
    }),
  /** Registered accounts that are not yet on this team's member roster. */
  memberCandidates: (teamId: string, search?: string) =>
    request<{ candidates: MemberCandidate[]; total: number }>(
      `${teamBase(teamId)}/member-candidates${q({ search })}`,
    ),
  createMember: (
    teamId: string,
    body: { userId: string; title?: string; role?: string },
  ) =>
    request<{ member: Member }>(`${teamBase(teamId)}/members`, {
      method: "POST",
      body,
    }),
  deleteMember: (teamId: string, memberId: string) =>
    request<{ deleted: boolean }>(`${teamBase(teamId)}/members/${memberId}`, {
      method: "DELETE",
    }),
  createWork: (teamId: string, memberId: string, body: Partial<WorkItem>) =>
    request<{ work: WorkItem }>(`${teamBase(teamId)}/members/${memberId}/works`, {
      method: "POST",
      body,
    }),
  updateWork: (
    teamId: string,
    memberId: string,
    workId: string,
    body: Partial<WorkItem>,
  ) =>
    request<{ work: WorkItem }>(
      `${teamBase(teamId)}/members/${memberId}/works/${workId}`,
      { method: "PATCH", body },
    ),
  deleteWork: (teamId: string, memberId: string, workId: string) =>
    request<{ deleted: boolean }>(
      `${teamBase(teamId)}/members/${memberId}/works/${workId}`,
      { method: "DELETE" },
    ),

  todos: (teamId: string, month?: string) =>
    request<{ todos: Todo[] }>(`${teamBase(teamId)}/todos${q({ month })}`),
  createTodo: (teamId: string, body: Partial<Todo>) =>
    request<{ todo: Todo }>(`${teamBase(teamId)}/todos`, {
      method: "POST",
      body,
    }),
  updateTodo: (teamId: string, todoId: string, body: Partial<Todo>) =>
    request<{ todo: Todo }>(`${teamBase(teamId)}/todos/${todoId}`, {
      method: "PATCH",
      body,
    }),
  deleteTodo: (teamId: string, todoId: string) =>
    request<{ deleted: boolean }>(`${teamBase(teamId)}/todos/${todoId}`, {
      method: "DELETE",
    }),

  redblack: (teamId: string, month?: string) =>
    request<RedBlackData>(`${teamBase(teamId)}/redblack${q({ month })}`),
  saveRedblack: (
    teamId: string,
    body: { month: string; theme: string; red: unknown[]; black: unknown[] },
  ) =>
    request<{ board: RedBlackBoard }>(`${teamBase(teamId)}/redblack`, {
      method: "PUT",
      body,
    }),
  rolloverRedblack: (teamId: string, month: string) =>
    request<{ board?: RedBlackBoard; month: string }>(
      `${teamBase(teamId)}/redblack/rollover`,
      { method: "POST", body: { month } },
    ),

  links: (teamId: string) =>
    request<{ links: LinkItem[] }>(`${teamBase(teamId)}/links`),
  createLink: (teamId: string, body: Partial<LinkItem>) =>
    request<{ link: LinkItem }>(`${teamBase(teamId)}/links`, {
      method: "POST",
      body,
    }),
  updateLink: (teamId: string, linkId: string, body: Partial<LinkItem>) =>
    request<{ link: LinkItem }>(`${teamBase(teamId)}/links/${linkId}`, {
      method: "PATCH",
      body,
    }),
  deleteLink: (teamId: string, linkId: string) =>
    request<{ deleted: boolean }>(`${teamBase(teamId)}/links/${linkId}`, {
      method: "DELETE",
    }),

  matrix: (teamId: string) =>
    request<{ areas: MatrixArea[] }>(`${teamBase(teamId)}/matrix`),
  createMatrix: (teamId: string, body: Partial<MatrixArea>) =>
    request<{ area: MatrixArea }>(`${teamBase(teamId)}/matrix`, {
      method: "POST",
      body,
    }),
  updateMatrix: (teamId: string, areaId: string, body: Partial<MatrixArea>) =>
    request<{ area: MatrixArea }>(`${teamBase(teamId)}/matrix/${areaId}`, {
      method: "PATCH",
      body,
    }),
  deleteMatrix: (teamId: string, areaId: string) =>
    request<{ deleted: boolean }>(`${teamBase(teamId)}/matrix/${areaId}`, {
      method: "DELETE",
    }),

  announcements: (teamId: string) =>
    request<AnnouncementsData>(`${teamBase(teamId)}/announcements`),
  createAnnouncement: (teamId: string, body: Partial<Announcement>) =>
    request<{ announcement: Announcement }>(
      `${teamBase(teamId)}/announcements`,
      { method: "POST", body },
    ),
  updateAnnouncement: (
    teamId: string,
    announcementId: string,
    body: Partial<Announcement>,
  ) =>
    request<{ announcement: Announcement }>(
      `${teamBase(teamId)}/announcements/${announcementId}`,
      { method: "PATCH", body },
    ),
  deleteAnnouncement: (teamId: string, announcementId: string) =>
    request<{ deleted: boolean }>(
      `${teamBase(teamId)}/announcements/${announcementId}`,
      { method: "DELETE" },
    ),

  insights: (params: { teamId: string; range?: InsightsRangeKey }) =>
    request<InsightsData>(
      `${teamBase(params.teamId)}/insights${q({ range: params.range ?? "1m" })}`,
    ),

  /* ---------------------------------------------------------------- */
  /* Settings                                                          */
  /* ---------------------------------------------------------------- */
  getSettings: () => request<SettingsResponse>("/api/settings"),
  saveSettings: (settings: AppSettings) =>
    request<SettingsResponse & { message: string }>("/api/settings", {
      method: "PUT",
      body: settings,
    }),
  validateSettings: (settings: unknown) =>
    request<{ valid: boolean; settings: AppSettings }>("/api/settings/validate", {
      method: "POST",
      body: settings,
    }),
  settingsSchema: () =>
    request<{ schema: Record<string, unknown>; meta: SettingsMeta }>("/api/settings/schema"),
  settingsDefaults: () => request<AppSettings>("/api/settings/defaults"),
  settingsWorkspace: () => request<WorkspaceOption>("/api/settings/workspace"),

  /* ---------------------------------------------------------------- */
  /* Round 9: custom groups, member ordering, team-level settings      */
  /* ---------------------------------------------------------------- */
  listGroups: (teamId: string, kind?: TeamGroupKind) =>
    request<{ groups: TeamGroup[] }>(`${teamBase(teamId)}/groups${q({ kind })}`),
  createGroup: (
    teamId: string,
    body: { kind: TeamGroupKind; name: string; color?: string },
  ) =>
    request<{ group: TeamGroup }>(`${teamBase(teamId)}/groups`, {
      method: "POST",
      body,
    }),
  updateGroup: (
    teamId: string,
    groupId: string,
    body: { kind?: TeamGroupKind; name?: string; color?: string },
  ) =>
    request<{ group: TeamGroup }>(`${teamBase(teamId)}/groups/${groupId}`, {
      method: "PATCH",
      body,
    }),
  deleteGroup: (teamId: string, groupId: string) =>
    request<{ deleted: boolean }>(`${teamBase(teamId)}/groups/${groupId}`, {
      method: "DELETE",
    }),
  /** Round 9: persist the admin-defined order of the team member cards. */
  reorderMembers: (teamId: string, memberIds: string[]) =>
    request<{ members: Member[] }>(`${teamBase(teamId)}/members/order`, {
      method: "PATCH",
      body: { memberIds },
    }),
  getTeamSettings: (teamId: string) =>
    request<TeamSettingsPayload>(`${teamBase(teamId)}/settings`),
  updateTeamSettings: (
    teamId: string,
    body: { modules?: Partial<ModuleFlags>; guestModules?: Partial<ModuleFlags> },
  ) =>
    request<TeamSettingsPayload>(`${teamBase(teamId)}/settings`, {
      method: "PUT",
      body,
    }),


  /* ---------------------------------------------------------------- */
  /* Whole-system reset (deployment device Admin only)                 */
  /* ---------------------------------------------------------------- */
  systemResetInfo: () => request<SystemResetInfo>("/api/system/reset"),
  resetSystem: (body: { confirmName: string; acknowledge: boolean }) =>
    request<SystemResetResult>("/api/system/reset", { method: "POST", body }),

  domainSettings: () => request<DomainSettingsData>("/api/settings/domain"),
  updateDomainTeam: (
    teamId: string,
    body: { name?: string; shortName?: string; description?: string; color?: string },
  ) =>
    request<{ team: DomainTeamSettings }>(
      `/api/settings/teams/${encodeURIComponent(teamId)}`,
      { method: "PATCH", body },
    ),

  /* ---------------------------------------------------------------- */
  /* Workspace administration: create / delete teams                   */
  /* ---------------------------------------------------------------- */
  manageWorkspace: () => request<WorkspaceManageData>("/api/workspace/manage"),
  createTeam: (body: {
    name: string;
    shortName?: string;
    description?: string;
    color?: string;
  }) =>
    request<{ team: ManagedTeam }>("/api/workspace/teams", {
      method: "POST",
      body,
    }),
  deleteTeam: (teamId: string, confirmName: string) =>
    request<{ deleted: boolean; id: string }>(
      `/api/workspace/teams/${encodeURIComponent(teamId)}`,
      { method: "DELETE", body: { confirmName } },
    ),

  /* ---------------------------------------------------------------- */
  /* SMTP relay diagnostics (super administrators)                     */
  /* ---------------------------------------------------------------- */
  emailStatus: () => request<EmailStatus>("/api/email/status"),
  emailLogs: (limit = 30) =>
    request<{ logs: EmailLog[] }>(`/api/email/logs${q({ limit })}`),
  emailTest: (to?: string) =>
    request<{ sent: boolean; to: string }>("/api/email/test", {
      method: "POST",
      body: { to: to ?? "" },
    }),
};
