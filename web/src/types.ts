export type AdminRole = "super" | "team_admin" | "group_admin" | null;
export type IdentitySource = "local" | "sso" | "ip" | "guest";

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  authenticated: boolean;
  source: IdentitySource;
  isDeviceAdmin: boolean;
  admin: {
    role: AdminRole;
    teamIds: string[];
    groupIds: string[];
  };
  linkedMemberId: string | null;
  linkedMemberName: string | null;
  ssoConfigured: boolean;
  permissions: {
    canEditSettings: boolean;
    canEditAny: boolean;
    canEditSelf: boolean;
    canManageEmail: boolean;
  };
}

export interface ThemeConfig {
  mode: "light" | "dark" | "auto";
  accent: string;
  accentSecondary: string;
  radius: number;
}

export interface SiteConfig {
  name: string;
  shortName: string;
  tagline: string;
  logoText: string;
  footerText: string;
  theme: ThemeConfig;
}

export interface ModuleFlags {
  overview: boolean;
  calendar: boolean;
  tasks: boolean;
  redblack: boolean;
  links: boolean;
  matrix: boolean;
  announcements: boolean;
  settings: boolean;
  email: boolean;
}

export interface PublicConfig {
  site: SiteConfig;
  modules: ModuleFlags;
  announcements: { maxPinned: number; dashboardLimit: number; showOnDashboard: boolean };
  calendar: {
    weekStartsOn: 0 | 1;
    showWeekends: boolean;
    defaultReminderOffsetsDays: number[];
    defaultReminderTime: string;
    allowPastDue: boolean;
    defaultEmailEnabled: boolean;
  };
  redblack: {
    showScores: boolean;
    monthlyThemeEnabled: boolean;
    redLabel: string;
    blackLabel: string;
  };
  features: {
    allowMemberSelfEdit: boolean;
    showGuestBanner: boolean;
    showDemoBadge: boolean;
    auditLog: boolean;
    allowGuestTodoCreate: boolean;
  };
  email: { enabled: boolean; remindersEnabled: boolean };
  auth: {
    guestMode: boolean;
    sso: { enabled: boolean; configured: boolean; providerName: string };
  };
}

export interface GroupRef {
  id: string;
  teamId: string;
  name: string;
  description: string;
  color: string;
  icon: string;
  memberCount: number;
  pinnedCount: number;
}

export interface TeamRef {
  id: string;
  name: string;
  shortName: string;
  description: string;
  color: string;
  groups: GroupRef[];
}

export interface BootstrapData {
  me: CurrentUser;
  config: PublicConfig;
  teams: TeamRef[];
  active: { team: TeamRef | null; group: GroupRef | null };
  stats: {
    teams: number;
    groups: number;
    members: number;
    todos: number;
    pinned: number;
    currentWorks?: number;
    serverDate?: string;
  };
  serverTime: string;
  deviceAdminName: string;
}

export type WorkStatus = "current" | "done" | "planned";

export interface WorkItem {
  id: string;
  memberId: string;
  title: string;
  description: string;
  status: WorkStatus;
  period: string;
  category: string;
  progress: number;
  updatedAt: string;
}

export interface Member {
  id: string;
  name: string;
  email: string;
  title: string;
  role: string;
  avatarColor: string;
  bio: string;
  tags: string[];
  skills: string[];
  status: "available" | "busy" | "remote" | "offline" | string;
  duties: string[];
  joinedAt: string;
  currentWorks: WorkItem[];
  historyWorks: WorkItem[];
  stats: { current: number; done: number; todos: number };
}

export interface GroupDetail {
  id: string;
  teamId: string;
  teamName: string;
  teamShortName?: string;
  name: string;
  description: string;
  color: string;
  icon: string;
  memberCount?: number;
}

export interface ActivityItem {
  id: string;
  type: string;
  title: string;
  description?: string;
  actorName?: string;
  memberId?: string | null;
  memberName?: string;
  at: string;
}

export interface OverviewData {
  group: GroupDetail;
  members: Member[];
  works: WorkItem[];
  recentActivity: ActivityItem[];
  workloads: Workload[];
  workloadSummary: WorkloadSummary;
  stats: {
    members: number;
    currentWorks: number;
    doneWorks: number;
    openTodos: number;
    pinned: number;
    [key: string]: number;
  };
}

export type TaskProgressStatus = "pending" | "in_progress" | "completed";
export type TaskHealthStatus = "normal" | "delayed" | "blocked";
export type TaskPriority = "low" | "normal" | "high" | "urgent";
export type TaskDifficulty = "easy" | "medium" | "hard";
export type WorkloadLevel = "low" | "balanced" | "high" | "overload";

export interface MemberTask {
  id: string;
  groupId: string;
  memberId: string;
  memberName: string;
  memberTitle: string;
  memberAvatarColor: string;
  title: string;
  description: string;
  progressStatus: TaskProgressStatus;
  healthStatus: TaskHealthStatus;
  priority: TaskPriority;
  difficulty: TaskDifficulty;
  loadPoints: number;
  expectedDate: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  overdue: boolean;
}

export interface Workload {
  memberId: string;
  memberName: string;
  memberTitle: string;
  avatarColor: string;
  currentPoints: number;
  currentLoadPercent: number;
  averagePoints: number;
  averageLoadPercent: number;
  capacityPoints: number;
  windowWeeks: number;
  openTasks: number;
  completedTasks: number;
  blockedTasks: number;
  overdueTasks: number;
  level: WorkloadLevel;
}

export interface WorkloadSummary {
  members: number;
  tasks: number;
  openTasks: number;
  completedTasks: number;
  blockedTasks: number;
  overdueTasks: number;
  currentPoints: number;
  averagePoints: number;
  averageLoadPercent: number;
  capacityPoints: number;
  windowWeeks: number;
}

export interface TaskOverviewData {
  tasks: MemberTask[];
  workloads: Workload[];
  summary: WorkloadSummary;
  meta: {
    capacityPoints: number;
    windowWeeks: number;
    windowLabel: string;
    scoring: string;
  };
}

export type TodoPriority = "low" | "normal" | "high" | "urgent";

export interface Todo {
  id: string;
  groupId: string;
  title: string;
  description: string;
  dueDate: string;
  dueTime: string;
  assigneeMemberId: string | null;
  assigneeName?: string;
  assigneeEmail?: string;
  assigneeColor?: string;
  priority: TodoPriority;
  status: "todo" | "done";
  reminderOffsetsDays: number[];
  emailEnabled: boolean;
  remindersSent?: number[];
  overdue?: boolean;
  createdBy: string;
  createdByName?: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface RedBlackEntry {
  id: string;
  side: "red" | "black";
  memberId: string | null;
  memberName: string;
  title: string;
  reason: string;
  score: number;
  createdAt?: string;
}

export interface RedBlackBoard {
  id: string;
  groupId?: string;
  month: string;
  theme: string;
  updatedAt: string | null;
  red: RedBlackEntry[];
  black: RedBlackEntry[];
  exists?: boolean;
}

export interface RedBlackData {
  month: string;
  board: RedBlackBoard | null;
  availableMonths: string[];
}

export interface LinkItem {
  id: string;
  groupId: string;
  title: string;
  url: string;
  description: string;
  category: string;
  color: string;
  sortOrder: number;
}

export interface MatrixArea {
  id: string;
  groupId: string;
  area: string;
  description: string;
  ownerMemberId: string | null;
  ownerName: string;
  ownerColor?: string;
  backupMemberId: string | null;
  backupName: string;
  backupColor?: string;
  channel: string;
  contact: string;
  sortOrder: number;
}

export interface Announcement {
  id: string;
  groupId: string;
  title: string;
  content: string;
  pinned: boolean;
  level: "info" | "important" | "celebration" | string;
  authorName: string;
  createdAt: string;
  updatedAt: string;
}

export interface AnnouncementsData {
  announcements: Announcement[];
  maxPinned: number;
  pinnedCount: number;
}

export interface SettingsMeta {
  path: string;
  updatedAt: string;
  schemaVersion: number;
  deviceAdminName: string;
}

export interface AppSettings {
  version: number;
  site: SiteConfig;
  modules: ModuleFlags;
  announcements: { maxPinned: number; dashboardLimit: number; showOnDashboard: boolean };
  calendar: PublicConfig["calendar"];
  redblack: PublicConfig["redblack"];
  email: {
    enabled: boolean;
    smtp: {
      host: string;
      port: number;
      username: string;
      password: string;
      fromEmail: string;
      fromName: string;
      useStartTls: boolean;
      useSsl: boolean;
      timeoutSeconds: number;
    };
    reminders: {
      enabled: boolean;
      offsetsDays: number[];
      sendTime: string;
      scanIntervalSeconds: number;
      notifyAssignee: boolean;
      additionalRecipients: string[];
      includeAnnouncements: boolean;
      includeTodoDescription: boolean;
      includeExtra: boolean;
      extraContent: string;
      subjectTemplate: string;
      bodyTemplate: string;
    };
  };
  auth: {
    guestMode: boolean;
    allowGuestRead: boolean;
    sso: {
      enabled: boolean;
      providerName: string;
      issuer: string;
      clientId: string;
      clientSecret: string;
      scopes: string;
      redirectUri: string;
      authorizationEndpoint: string;
      tokenEndpoint: string;
      userinfoEndpoint: string;
      endSessionEndpoint: string;
      claimId: string;
      claimName: string;
      claimEmail: string;
      allowedEmailDomains: string[];
      autoProvision: boolean;
    };
    adminWhitelist: {
      ips: AdminIpEntry[];
      ids: AdminIdEntry[];
    };
    session: { cookieName: string; maxAgeDays: number; secureCookie: boolean };
  };
  features: PublicConfig["features"];
}

export interface AdminIdEntry {
  id: string;
  name: string;
  role: "team_admin" | "group_admin";
  teamId: string;
  groupIds: string[];
  note: string;
}

export interface AdminIpEntry {
  ip: string;
  name: string;
  role: "team_admin" | "group_admin";
  teamId: string;
  groupIds: string[];
  note: string;
}

export interface SettingsResponse {
  settings: AppSettings;
  meta: SettingsMeta;
}

export interface WorkspaceOption {
  teams: { id: string; name: string; short_name: string; color: string }[];
  groups: { id: string; team_id: string; name: string; color: string }[];
  members: { id: string; team_id: string; group_id: string; name: string; email: string; title: string }[];
}

export interface EmailStatus {
  enabled: boolean;
  remindersEnabled: boolean;
  smtpConfigured: boolean;
  fromEmail: string;
  lastScanAt: string | null;
  pendingReminders: number;
  sentToday: number;
  failedToday: number;
  scheduler: {
    running: boolean;
    lastScanAt: string | null;
    nextScanAt: string | null;
    lastError: string;
  };
  templatePreview: { subject: string; body: string };
}

export interface EmailLog {
  id: string;
  group_id: string;
  todo_id: string;
  kind: string;
  recipient: string;
  subject: string;
  status: "sent" | "failed";
  error: string;
  detail: string;
  created_at: string;
}

export interface ApiEnvelope<T> {
  ok: boolean;
  data: T;
  error?: { code: string; message: string; details?: unknown };
}

export interface ValidationDetail {
  path: string;
  message: string;
}

export interface ActivityEntry {
  id: string;
  actor: string;
  action: string;
  entity: string;
  entityId: string;
  detail?: string;
  createdAt: string;
}
