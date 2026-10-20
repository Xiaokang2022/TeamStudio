export type AdminRole = "super" | "team_admin" | "group_admin" | null;
export type UserRole = "member" | "group_admin" | "team_admin" | "super";
export type IdentitySource = "local" | "sso" | "email" | "ip" | "guest";

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  avatar: string;
  avatarColor: string;
  bio: string;
  skills: string[];
  authenticated: boolean;
  source: IdentitySource;
  isDeviceAdmin: boolean;
  isSuperAdmin: boolean;
  userRole: UserRole | null;
  emailVerified: boolean;
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
    canManageUsers: boolean;
    canViewAllScope: boolean;
    canManageWorkspace: boolean;
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
  insights: boolean;
}

export interface PublicConfig {
  site: SiteConfig;
  modules: ModuleFlags;
  announcements: { maxPinned: number; dashboardLimit: number; showOnDashboard: boolean };
  calendar: {
    weekStartsOn: 0 | 1;
    showWeekends: boolean;
    allowPastDue: boolean;
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
  email: { enabled: boolean; configured: boolean; fromEmail: string; fromName: string };
  auth: {
    guestMode: boolean;
    allowGuestRead: boolean;
    emailLogin: {
      enabled: boolean;
      codeLength: number;
      codeExpiryMinutes: number;
      resendSeconds: number;
    };
    sessionDays: number;
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
  avatar?: string;
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
  groupId?: string;
  groupName?: string;
  teamId?: string;
  teamName?: string;
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
  scope?: ScopeMeta;
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
  groupName?: string;
  teamId?: string;
  teamName?: string;
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
  tagIds?: string[];
  tags?: TaskTag[];
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
  scope?: ScopeMeta;
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
  groupName?: string;
  teamId?: string;
  teamName?: string;
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
  groupId?: string;
  groupName?: string;
  teamId?: string;
  teamName?: string;
  createdAt?: string;
}

export interface RedBlackBoard {
  id: string | null;
  groupId?: string | null;
  month: string;
  theme: string;
  updatedAt: string | null;
  red: RedBlackEntry[];
  black: RedBlackEntry[];
  exists?: boolean;
}

export interface RedBlackGroupBoard {
  groupId: string;
  groupName: string;
  teamId: string;
  teamName: string;
  theme: string;
  red: RedBlackEntry[];
  black: RedBlackEntry[];
  updatedAt?: string | null;
}

export interface RedBlackData {
  month: string;
  scope?: ScopeMeta;
  board: RedBlackBoard | null;
  boards?: RedBlackGroupBoard[];
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

export interface MatrixBackupMember {
  id: string;
  name: string;
  color: string;
}

export interface MatrixArea {
  id: string;
  groupId: string;
  area: string;
  description: string;
  /** Exactly one primary owner per area (null means unclaimed). */
  ownerMemberId: string | null;
  ownerName: string;
  ownerColor?: string;
  /** Multiple backups are allowed and may also own other areas. */
  backupMemberIds: string[];
  backups: MatrixBackupMember[];
  /** Legacy single-backup projection (first backup) kept for compatibility. */
  backupMemberId?: string | null;
  backupName?: string;
  backupColor?: string;
  channel: string;
  contact: string;
  sortOrder: number;
}

/* ------------------------------------------------------------------ */
/* Workspace administration (teams / development groups)              */
/* ------------------------------------------------------------------ */

export interface ManagedGroup {
  id: string;
  teamId: string;
  name: string;
  description: string;
  color: string;
  icon: string;
  memberCount: number;
  canDelete: boolean;
}

export interface ManagedTeam {
  id: string;
  name: string;
  shortName: string;
  description: string;
  color: string;
  groupCount: number;
  memberCount: number;
  canDelete: boolean;
  canCreateGroup: boolean;
  groups: ManagedGroup[];
}

export interface WorkspaceManageData {
  teams: ManagedTeam[];
  permissions: {
    canCreateTeam: boolean;
    canCreateGroup: boolean;
    canManageAnyTeam: boolean;
  };
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

export interface SmtpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  fromEmail: string;
  fromName: string;
  useStartTls: boolean;
  useSsl: boolean;
  timeoutSeconds: number;
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
    smtp: SmtpConfig;
    subjectTemplate: string;
    bodyTemplate: string;
  };
  auth: {
    guestMode: boolean;
    allowGuestRead: boolean;
    emailLogin: {
      enabled: boolean;
      codeLength: number;
      codeExpiryMinutes: number;
      resendSeconds: number;
      maxAttempts: number;
    };
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

/* ------------------------------------------------------------------ */
/* Accounts, personal home page, domain settings and SMTP             */
/* ------------------------------------------------------------------ */

export interface UserAccount {
  id: string;
  email: string;
  name: string;
  avatar: string;
  avatarColor: string;
  bio: string;
  skills: string[];
  role: UserRole;
  roleLabel: string;
  teamIds: string[];
  groupIds: string[];
  emailVerified: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  isDeviceAdmin?: boolean;
  canManage?: boolean;
  isSelf?: boolean;
}

export interface UsersData {
  users: UserAccount[];
  deviceAdminName: string;
  permissions: { canManageUsers: boolean };
}

export interface ProfileMember {
  id: string;
  name: string;
  email: string;
  title: string;
  role: string;
  avatarColor: string;
  avatar: string;
  bio: string;
  tags: string[];
  skills: string[];
  status: string;
  groupId: string;
  groupName: string;
  teamId: string;
  teamName: string;
}

export interface ProfileDuty {
  id: string;
  area: string;
  description: string;
  role: "owner" | "backup";
  channel: string;
  contact: string;
  groupId: string;
  groupName: string;
  teamId: string;
  teamName: string;
}

export interface ProfileTodo {
  id: string;
  title: string;
  description: string;
  dueDate: string;
  dueTime: string;
  status: "todo" | "done";
  priority: TodoPriority;
  groupId: string;
  groupName: string;
  teamId: string;
  teamName: string;
}

export interface ProfileRedBlackEntry extends RedBlackEntry {
  month: string;
  groupId: string;
  groupName: string;
  teamId: string;
  teamName: string;
}

export interface ProfileData {
  user: UserAccount & { isDeviceAdmin: boolean };
  members: ProfileMember[];
  duties: ProfileDuty[];
  currentTasks: MemberTask[];
  historyTasks: MemberTask[];
  todos: ProfileTodo[];
  redblack: { red: ProfileRedBlackEntry[]; black: ProfileRedBlackEntry[] };
  stats: {
    duties: number;
    currentTasks: number;
    completedTasks: number;
    openTodos: number;
    redEntries: number;
    blackEntries: number;
  };
  canEdit: boolean;
  isSelf: boolean;
}

export interface DomainGroupSettings {
  id: string;
  teamId: string;
  name: string;
  description: string;
  color: string;
  icon: string;
  canEdit: boolean;
}

export interface DomainTeamSettings {
  id: string;
  name: string;
  shortName: string;
  description: string;
  color: string;
  canEdit: boolean;
  groups: DomainGroupSettings[];
}

export interface DomainSettingsData {
  teams: DomainTeamSettings[];
  permissions: {
    canEditSite: boolean;
    canEditStructure: boolean;
    canEditTeam: boolean;
    canEditGroup: boolean;
    isSuperAdmin: boolean;
    isDeviceAdmin: boolean;
  };
}

export interface EmailStatus {
  enabled: boolean;
  configured: boolean;
  host: string;
  port: number;
  username: string;
  fromEmail: string;
  fromName: string;
  useStartTls: boolean;
  useSsl: boolean;
  timeoutSeconds: number;
  lastSentAt: string | null;
  lastError: string;
  sentToday: number;
}

export interface EmailLog {
  id: string;
  kind: string;
  recipient: string;
  subject: string;
  status: "sent" | "failed";
  error: string;
  created_at: string;
}

export interface AuthConfigData {
  guestMode: boolean;
  allowGuestRead: boolean;
  emailLogin: {
    enabled: boolean;
    codeLength: number;
    codeExpiryMinutes: number;
    resendSeconds: number;
  };
  sessionDays: number;
  sso: { enabled: boolean; configured: boolean; providerName: string };
  emailService: { enabled: boolean; configured: boolean };
}

export interface EmailCodeRequestResponse {
  sent: boolean;
  email: string;
  purpose: "login" | "register";
  registered: boolean;
  expiresInSeconds: number;
  resendAfterSeconds: number;
  codeLength: number;
}

export interface EmailCodeVerifyResponse {
  loggedIn: boolean;
  isNewUser: boolean;
  user: UserAccount;
  sessionDays: number;
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

/* ------------------------------------------------------------------ */
/* Multi-scope browsing, task tags and insights                       */
/* ------------------------------------------------------------------ */

export type ScopeKind = "group" | "team" | "all";

export interface ScopeGroupRef {
  id: string;
  teamId: string;
  teamName: string;
  teamShortName?: string;
  name: string;
  color: string;
  icon?: string;
}

export interface ScopeMeta {
  kind: ScopeKind;
  label: string;
  teamIds: string[];
  groupIds: string[];
  groups: ScopeGroupRef[];
  team: { id: string; name: string; shortName: string; color: string } | null;
  group: { id: string; teamId: string; name: string; color: string } | null;
}

export interface TaskTag {
  id: string;
  groupId: string;
  groupName?: string;
  name: string;
  color: string;
  usage?: number;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface TagLibraryData {
  tags: TaskTag[];
  scope?: ScopeMeta;
}

export type InsightsRangeKey = "1w" | "2w" | "1m" | "2m" | "3m" | "all";

export interface InsightsRange {
  key: InsightsRangeKey;
  label: string;
  days: number | null;
  start: string | null;
}

export interface InsightsSummary {
  teams: number;
  groups: number;
  members: number;
  tasks: number;
  openTasks: number;
  completedTasks: number;
  overdueTasks: number;
  blockedTasks: number;
  completionRate: number;
  todos: number;
  completedTodos: number;
  todoCompletionRate: number;
  loadPoints: number;
  capacityPoints: number;
  averageLoadPercent: number;
}

export interface InsightsMemberRow {
  memberId: string;
  memberName: string;
  memberTitle: string;
  avatarColor: string;
  teamId: string;
  teamName: string;
  groupId: string;
  groupName: string;
  tasks: number;
  openTasks: number;
  completedTasks: number;
  overdueTasks: number;
  blockedTasks: number;
  completionRate: number;
  loadPoints: number;
  todos: number;
  completedTodos: number;
}

export interface InsightsGroupRow {
  groupId: string;
  groupName: string;
  teamId: string;
  teamName: string;
  color: string;
  members: number;
  tasks: number;
  openTasks: number;
  completedTasks: number;
  overdueTasks: number;
  blockedTasks: number;
  completionRate: number;
  loadPoints: number;
  averageLoadPercent: number;
  todos: number;
  completedTodos: number;
}

export interface InsightsTeamRow {
  teamId: string;
  teamName: string;
  color: string;
  groups: number;
  members: number;
  tasks: number;
  openTasks: number;
  completedTasks: number;
  overdueTasks: number;
  completionRate: number;
  loadPoints: number;
}

export interface InsightsTrendPoint {
  label: string;
  start: string;
  created: number;
  completed: number;
  todos: number;
}

export interface InsightsData {
  scope: ScopeMeta;
  range: InsightsRange;
  summary: InsightsSummary;
  members: InsightsMemberRow[];
  groups: InsightsGroupRow[];
  teams: InsightsTeamRow[];
  trend: {
    granularity: "day" | "week";
    buckets: InsightsTrendPoint[];
  };
}
