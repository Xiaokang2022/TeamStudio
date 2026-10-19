import type {
  Announcement,
  AnnouncementsData,
  AppSettings,
  BootstrapData,
  EmailLog,
  EmailStatus,
  LinkItem,
  MatrixArea,
  Member,
  MemberTask,
  OverviewData,
  RedBlackBoard,
  RedBlackData,
  SettingsMeta,
  SettingsResponse,
  TaskOverviewData,
  Todo,
  ValidationDetail,
  WorkItem,
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
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      credentials: "include",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
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
  bootstrap: (teamId?: string, groupId?: string) =>
    request<BootstrapData>(`/api/bootstrap${q({ teamId, groupId })}`),
  me: () => request<BootstrapData["me"]>("/api/auth/me"),
  logout: () =>
    request<{ loggedOut: boolean; endSessionUrl?: string }>("/api/auth/logout", {
      method: "POST",
    }),
  loginHref: (next = "/") => `/api/auth/login?next=${encodeURIComponent(next)}`,

  overview: (teamId: string, groupId: string) =>
    request<OverviewData>(`${groupBase(teamId, groupId)}/overview`),

  tasks: (teamId: string, groupId: string) =>
    request<TaskOverviewData>(`${groupBase(teamId, groupId)}/tasks`),
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

  todos: (teamId: string, groupId: string, month?: string) =>
    request<{ todos: Todo[] }>(`${groupBase(teamId, groupId)}/todos${q({ month })}`),
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

  redblack: (teamId: string, groupId: string, month?: string) =>
    request<RedBlackData>(`${groupBase(teamId, groupId)}/redblack${q({ month })}`),
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

  links: (teamId: string, groupId: string) =>
    request<{ links: LinkItem[] }>(`${groupBase(teamId, groupId)}/links`),
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

  matrix: (teamId: string, groupId: string) =>
    request<{ areas: MatrixArea[] }>(`${groupBase(teamId, groupId)}/matrix`),
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

  announcements: (teamId: string, groupId: string) =>
    request<AnnouncementsData>(`${groupBase(teamId, groupId)}/announcements`),
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

  emailStatus: () => request<EmailStatus>("/api/email/status"),
  emailLogs: (limit = 50) =>
    request<{ logs: EmailLog[] }>(`/api/email/logs${q({ limit })}`),
  emailTest: (to?: string) =>
    request<{ sent: boolean; to: string }>("/api/email/test", {
      method: "POST",
      body: { to: to ?? "" },
    }),
  emailScan: () => request<Record<string, unknown>>("/api/email/scan", { method: "POST" }),
  emailPreview: () =>
    request<{ subject: string; body: string }>("/api/email/preview"),
};
