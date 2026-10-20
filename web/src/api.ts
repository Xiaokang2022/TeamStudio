import type {
  ActivationLink,
  Announcement,
  AnnouncementsData,
  AppSettings,
  AuthConfigData,
  BootstrapData,
  DomainSettingsData,
  DomainGroupSettings,
  DomainTeamSettings,
  EmailCodeRequestResponse,
  EmailCodeVerifyResponse,
  EmailLog,
  EmailStatus,
  InsightsData,
  InsightsRangeKey,
  LinkItem,
  ManagedGroup,
  ManagedTeam,
  MatrixArea,
  Member,
  MemberTask,
  OverviewData,
  ProfileData,
  RedBlackBoard,
  RedBlackData,
  ScopeKind,
  SettingsMeta,
  SettingsResponse,
  TagLibraryData,
  TaskOverviewData,
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

const groupBase = (teamId: string, groupId: string) =>
  `/api/teams/${encodeURIComponent(teamId)}/groups/${encodeURIComponent(groupId)}`;

export const api = {
  /* ---------------------------------------------------------------- */
  /* Bootstrap / identity                                              */
  /* ---------------------------------------------------------------- */
  bootstrap: (teamId?: string, groupId?: string) =>
    request<BootstrapData>(`/api/bootstrap${q({ teamId, groupId })}`),
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
    groupIds?: string[];
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
    body: { name?: string; role?: string; teamIds?: string[]; groupIds?: string[] },
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
  /* Feature reads / writes                                           */
  /* ---------------------------------------------------------------- */
  overview: (teamId: string, groupId: string, scope: ScopeKind = "group") =>
    request<OverviewData>(`${groupBase(teamId, groupId)}/overview${q({ scope })}`),

  tasks: (teamId: string, groupId: string, scope: ScopeKind = "group") =>
    request<TaskOverviewData>(`${groupBase(teamId, groupId)}/tasks${q({ scope })}`),
  taskTags: (teamId: string, groupId: string, scope: ScopeKind = "group") =>
    request<TagLibraryData>(`${groupBase(teamId, groupId)}/task-tags${q({ scope })}`),
  createTaskTag: (
    teamId: string,
    groupId: string,
    body: { name: string; color?: string },
  ) =>
    request<{ tag: import("./types").TaskTag }>(`${groupBase(teamId, groupId)}/task-tags`, {
      method: "POST",
      body,
    }),
  updateTaskTag: (
    teamId: string,
    groupId: string,
    tagId: string,
    body: { name?: string; color?: string },
  ) =>
    request<{ tag: import("./types").TaskTag }>(
      `${groupBase(teamId, groupId)}/task-tags/${tagId}`,
      { method: "PATCH", body },
    ),
  deleteTaskTag: (teamId: string, groupId: string, tagId: string) =>
    request<{ deleted: boolean }>(`${groupBase(teamId, groupId)}/task-tags/${tagId}`, {
      method: "DELETE",
    }),
  createTask: (teamId: string, groupId: string, body: Partial<MemberTask>) =>
    request<{ task: MemberTask }>(`${groupBase(teamId, groupId)}/tasks`, {
      method: "POST",
      body,
    }),
  updateTask: (teamId: string, groupId: string, taskId: string, body: Partial<MemberTask>) =>
    request<{ task: MemberTask }>(`${groupBase(teamId, groupId)}/tasks/${taskId}`, {
      method: "PATCH",
      body,
    }),
  deleteTask: (teamId: string, groupId: string, taskId: string) =>
    request<{ deleted: boolean }>(`${groupBase(teamId, groupId)}/tasks/${taskId}`, {
      method: "DELETE",
    }),

  updateMember: (teamId: string, groupId: string, memberId: string, body: Partial<Member>) =>
    request<{ member: Member }>(`${groupBase(teamId, groupId)}/members/${memberId}`, {
      method: "PATCH",
      body,
    }),
  createMember: (teamId: string, groupId: string, body: Partial<Member>) =>
    request<{ member: Member }>(`${groupBase(teamId, groupId)}/members`, {
      method: "POST",
      body,
    }),
  deleteMember: (teamId: string, groupId: string, memberId: string) =>
    request<{ deleted: boolean }>(`${groupBase(teamId, groupId)}/members/${memberId}`, {
      method: "DELETE",
    }),
  createWork: (teamId: string, groupId: string, memberId: string, body: Partial<WorkItem>) =>
    request<{ work: WorkItem }>(`${groupBase(teamId, groupId)}/members/${memberId}/works`, {
      method: "POST",
      body,
    }),
  updateWork: (
    teamId: string,
    groupId: string,
    memberId: string,
    workId: string,
    body: Partial<WorkItem>,
  ) =>
    request<{ work: WorkItem }>(
      `${groupBase(teamId, groupId)}/members/${memberId}/works/${workId}`,
      { method: "PATCH", body },
    ),
  deleteWork: (teamId: string, groupId: string, memberId: string, workId: string) =>
    request<{ deleted: boolean }>(
      `${groupBase(teamId, groupId)}/members/${memberId}/works/${workId}`,
      { method: "DELETE" },
    ),

  todos: (teamId: string, groupId: string, month?: string, scope: ScopeKind = "group") =>
    request<{ todos: Todo[]; scope?: import("./types").ScopeMeta }>(
      `${groupBase(teamId, groupId)}/todos${q({ month, scope })}`,
    ),
  createTodo: (teamId: string, groupId: string, body: Partial<Todo>) =>
    request<{ todo: Todo }>(`${groupBase(teamId, groupId)}/todos`, {
      method: "POST",
      body,
    }),
  updateTodo: (teamId: string, groupId: string, todoId: string, body: Partial<Todo>) =>
    request<{ todo: Todo }>(`${groupBase(teamId, groupId)}/todos/${todoId}`, {
      method: "PATCH",
      body,
    }),
  deleteTodo: (teamId: string, groupId: string, todoId: string) =>
    request<{ deleted: boolean }>(`${groupBase(teamId, groupId)}/todos/${todoId}`, {
      method: "DELETE",
    }),

  redblack: (teamId: string, groupId: string, month?: string, scope: ScopeKind = "group") =>
    request<RedBlackData>(`${groupBase(teamId, groupId)}/redblack${q({ month, scope })}`),
  saveRedblack: (
    teamId: string,
    groupId: string,
    body: { month: string; theme: string; red: unknown[]; black: unknown[] },
  ) =>
    request<{ board: RedBlackBoard }>(`${groupBase(teamId, groupId)}/redblack`, {
      method: "PUT",
      body,
    }),
  rolloverRedblack: (teamId: string, groupId: string, month: string) =>
    request<{ board?: RedBlackBoard; month: string }>(
      `${groupBase(teamId, groupId)}/redblack/rollover`,
      { method: "POST", body: { month } },
    ),

  links: (teamId: string, groupId: string, scope: ScopeKind = "group") =>
    request<{ links: LinkItem[]; scope?: import("./types").ScopeMeta }>(
      `${groupBase(teamId, groupId)}/links${q({ scope })}`,
    ),
  createLink: (teamId: string, groupId: string, body: Partial<LinkItem>) =>
    request<{ link: LinkItem }>(`${groupBase(teamId, groupId)}/links`, {
      method: "POST",
      body,
    }),
  updateLink: (teamId: string, groupId: string, linkId: string, body: Partial<LinkItem>) =>
    request<{ link: LinkItem }>(`${groupBase(teamId, groupId)}/links/${linkId}`, {
      method: "PATCH",
      body,
    }),
  deleteLink: (teamId: string, groupId: string, linkId: string) =>
    request<{ deleted: boolean }>(`${groupBase(teamId, groupId)}/links/${linkId}`, {
      method: "DELETE",
    }),

  matrix: (teamId: string, groupId: string, scope: ScopeKind = "group") =>
    request<{ areas: MatrixArea[]; scope?: import("./types").ScopeMeta }>(
      `${groupBase(teamId, groupId)}/matrix${q({ scope })}`,
    ),
  createMatrix: (teamId: string, groupId: string, body: Partial<MatrixArea>) =>
    request<{ area: MatrixArea }>(`${groupBase(teamId, groupId)}/matrix`, {
      method: "POST",
      body,
    }),
  updateMatrix: (teamId: string, groupId: string, areaId: string, body: Partial<MatrixArea>) =>
    request<{ area: MatrixArea }>(`${groupBase(teamId, groupId)}/matrix/${areaId}`, {
      method: "PATCH",
      body,
    }),
  deleteMatrix: (teamId: string, groupId: string, areaId: string) =>
    request<{ deleted: boolean }>(`${groupBase(teamId, groupId)}/matrix/${areaId}`, {
      method: "DELETE",
    }),

  announcements: (teamId: string, groupId: string, scope: ScopeKind = "group") =>
    request<AnnouncementsData>(`${groupBase(teamId, groupId)}/announcements${q({ scope })}`),
  createAnnouncement: (teamId: string, groupId: string, body: Partial<Announcement>) =>
    request<{ announcement: Announcement }>(
      `${groupBase(teamId, groupId)}/announcements`,
      { method: "POST", body },
    ),
  updateAnnouncement: (
    teamId: string,
    groupId: string,
    announcementId: string,
    body: Partial<Announcement>,
  ) =>
    request<{ announcement: Announcement }>(
      `${groupBase(teamId, groupId)}/announcements/${announcementId}`,
      { method: "PATCH", body },
    ),
  deleteAnnouncement: (teamId: string, groupId: string, announcementId: string) =>
    request<{ deleted: boolean }>(
      `${groupBase(teamId, groupId)}/announcements/${announcementId}`,
      { method: "DELETE" },
    ),

  insights: (params: {
    teamId: string;
    groupId: string;
    scope?: ScopeKind;
    range?: InsightsRangeKey;
  }) =>
    request<InsightsData>(
      `${groupBase(params.teamId, params.groupId)}/insights${q({
        scope: params.scope ?? "group",
        range: params.range ?? "1m",
      })}`,
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

  domainSettings: () => request<DomainSettingsData>("/api/settings/domain"),
  updateDomainTeam: (
    teamId: string,
    body: { name?: string; shortName?: string; description?: string; color?: string },
  ) =>
    request<{ team: DomainTeamSettings }>(
      `/api/settings/teams/${encodeURIComponent(teamId)}`,
      { method: "PATCH", body },
    ),
  updateDomainGroup: (
    teamId: string,
    groupId: string,
    body: { name?: string; description?: string; color?: string; icon?: string },
  ) =>
    request<{ group: DomainGroupSettings }>(
      `/api/settings/teams/${encodeURIComponent(teamId)}/groups/${encodeURIComponent(groupId)}`,
      { method: "PATCH", body },
    ),

  /* ---------------------------------------------------------------- */
  /* Workspace administration: create / delete teams and groups.      */
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
  createGroup: (
    teamId: string,
    body: { name: string; description?: string; color?: string; icon?: string },
  ) =>
    request<{ group: ManagedGroup }>(
      `/api/workspace/teams/${encodeURIComponent(teamId)}/groups`,
      { method: "POST", body },
    ),
  deleteGroup: (teamId: string, groupId: string, confirmName: string) =>
    request<{ deleted: boolean; id: string }>(
      `/api/workspace/teams/${encodeURIComponent(teamId)}/groups/${encodeURIComponent(groupId)}`,
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
