export type AdminRole = "super" | "team_admin" | null;
export type UserRole = "member" | "team_admin" | "super";
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
  };
  /** Archive id of this account inside the currently active team (null when none). */
  linkedMemberId: string | null;
  /**
   * Every member archive id of this account across all teams. Used to decide
   * "this is me" for archives in any team.
   */
  linkedMemberIds: string[];
  linkedMemberName: string | null;
  ssoConfigured: boolean;
  /** True when the request comes from the deployment device. */
  deployDevice: boolean;
  /** True while the browser is using the built-in device Admin identity. */
  deviceAdminActive: boolean;
  permissions: {
    canEditSettings: boolean;
    canEditAny: boolean;
    canEditSelf: boolean;
    canManageUsers: boolean;
    canManageWorkspace: boolean;
  };
}

export interface ThemeConfig {
  /** Kept for settings-file compatibility only — never decides light/dark. */
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
  /**
   * Round 9: the settings entry is permission-based (super / team admins) and is never
   * hidden by a module switch. The server pins this to `true`; it is only kept for
   * configuration compatibility.
   */
  settings: boolean;
  insights: boolean;
}

export interface PublicConfig {
  site: SiteConfig;
  modules: ModuleFlags;
  /** Modules the anonymous guest may access (settings is always false). */
  guestModules: ModuleFlags;
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
      precreatedActivationMinutes: number;
    };
    sessionDays: number;
    sso: { enabled: boolean; configured: boolean; providerName: string };
  };
}

/** A team is the only organization unit in round 8 (no development groups). */
export interface TeamRef {
  id: string;
  name: string;
  shortName: string;
  description: string;
  color: string;
  memberCount: number;
  pinnedCount: number;
}

export interface BootstrapData {
  me: CurrentUser;
  config: PublicConfig;
  teams: TeamRef[];
  active: { team: TeamRef | null };
  stats: {
    teams: number;
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
  teamId?: string;
  teamName?: string;
}

/**
 * One team membership row of a person. The same registered account may own one
 * `members` row per team; aggregate read models merge them into a single person
 * card and describe each row here.
 */
export interface MemberMembership {
  memberId: string;
  memberName?: string;
  teamId: string;
  teamName: string;
  title?: string;
  role?: string;
  joinedAt?: string;
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
  duties: string[];
  joinedAt: string;
  currentWorks: WorkItem[];
  historyWorks: WorkItem[];
  stats: { current: number; done: number; todos: number };
  teamId?: string;
  teamName?: string;
  /** Every member archive id merged into this person card (main archive first). */
  memberIds?: string[];
  /** One entry per team-membership row. */
  memberships?: MemberMembership[];
  teamIds?: string[];
  teamNames?: string[];
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
  team: TeamRef;
  members: Member[];
  works: WorkItem[];
  recentActivity: ActivityItem[];
  workloads: Workload[];
  workloadSummary: WorkloadSummary;
  stats: {
    members: number;
    works: number;
    currentWorks: number;
    doneWorks: number;
    plannedWorks: number;
    todos: number;
    openTodos: number;
    doneTodos: number;
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
  teamId?: string;
  teamName?: string;
  memberId: string;
  memberName: string;
  memberTitle: string;
  /** Real member avatar URL (empty string when the member has none). */
  memberAvatar: string;
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
  /** Real member avatar URL (empty string when the member has none). */
  avatar: string;
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
  /** Every member archive id merged into this person workload (main archive first). */
  memberIds?: string[];
  /** One entry per team-membership row. */
  memberships?: MemberMembership[];
  teamIds?: string[];
  teamNames?: string[];
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
  teamId?: string;
  teamName?: string;
  title: string;
  description: string;
  dueDate: string;
  dueTime: string;
  assigneeMemberId: string | null;
  assigneeName?: string;
  assigneeEmail?: string;
  /** Real assignee avatar URL (empty string when the member has none). */
  assigneeAvatar?: string;
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
  /** Real member avatar URL (empty string when the member has none). */
  memberAvatar?: string;
  title: string;
  reason: string;
  score: number;
  teamId?: string;
  teamName?: string;
  createdAt?: string;
}

export interface RedBlackBoard {
  id: string | null;
  teamId?: string | null;
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
  /** Real backup-member avatar URL (empty string when the member has none). */
  avatar?: string;
}

export interface MatrixArea {
  id: string;
  area: string;
  description: string;
  /** Exactly one primary owner per area (null means unclaimed). */
  ownerMemberId: string | null;
  ownerName: string;
  ownerColor?: string;
  /** Real owner avatar URL (empty string when the member has none). */
  ownerAvatar?: string;
  /** Multiple backups are allowed and may also own other areas. */
  backupMemberIds: string[];
  backups: MatrixBackupMember[];
  /** Legacy single-backup projection (first backup) kept for compatibility. */
  backupMemberId?: string | null;
  backupName?: string;
  backupColor?: string;
  backupAvatar?: string;
  channel: string;
  contact: string;
  sortOrder: number;
}

/* ------------------------------------------------------------------ */
/* Workspace administration (teams only in round 8)                   */
/* ------------------------------------------------------------------ */

export interface ManagedTeam {
  id: string;
  name: string;
  shortName: string;
  description: string;
  color: string;
  memberCount: number;
  canDelete: boolean;
}

export interface WorkspaceManageData {
  teams: ManagedTeam[];
  permissions: {
    canCreateTeam: boolean;
    canManageAnyTeam: boolean;
  };
}

export interface Announcement {
  id: string;
  title: string;
  content: string;
  pinned: boolean;
  level: "info" | "important" | "celebration" | string;
  authorName: string;
  /** Real author avatar URL (empty string when the author has none). */
  authorAvatar?: string;
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
  guestModules: ModuleFlags;
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
      precreatedActivationMinutes: number;
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
  role: "team_admin";
  teamId: string;
  note: string;
}

export interface AdminIpEntry {
  ip: string;
  name: string;
  role: "team_admin";
  teamId: string;
  note: string;
}

export interface SettingsResponse {
  settings: AppSettings;
  meta: SettingsMeta;
}

/* ------------------------------------------------------------------ */
/* Whole-system factory reset (deployment device Admin only)          */
/* ------------------------------------------------------------------ */

export interface SystemResetStats {
  teams: number;
  members: number;
  works: number;
  todos: number;
  tasks: number;
  boards: number;
  entries: number;
  links: number;
  matrix: number;
  announcements: number;
  tags: number;
  accounts: number;
  emailCodes: number;
  activationTokens: number;
  emailLogs: number;
  auditLogs: number;
}

export interface SystemResetInfo {
  deviceAdmin: true;
  canReset: true;
  siteName: string;
  siteShortName: string;
  defaultSiteName: string;
  defaultSiteShortName: string;
  stats: SystemResetStats;
  lastResetAt: string | null;
  lastResetBy: string;
}

export interface SystemResetResult {
  reset: true;
  resetAt: string;
  sessionSecretRotated: boolean;
  uploadsRemoved: number;
  cleared: SystemResetStats;
  siteName: string;
  siteShortName: string;
}

export interface WorkspaceOption {
  teams: { id: string; name: string; short_name: string; color: string }[];
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

/**
 * A registered account (including pre-created, not-yet-activated accounts)
 * that can still be added to a team's member roster.
 */
export interface MemberCandidate {
  id: string;
  name: string;
  email: string;
  avatar: string;
  avatarColor: string;
  role: UserRole;
  roleLabel: string;
  emailVerified: boolean;
  skills: string[];
}

export interface ActivationLink {
  url: string;
  expiresAt: string;
  expiresInMinutes: number;
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
  teamId: string;
  teamName: string;
}

export interface ProfileRedBlackEntry extends RedBlackEntry {
  month: string;
  teamId: string;
  teamName: string;
}

export interface ProfileAdminScopeTeam {
  id: string;
  name: string;
}

/**
 * Public administrator scope shown on the personal home page: which teams this
 * account administers. `super` intentionally keeps an empty array.
 */
export interface ProfileAdminScope {
  role: "super" | "team_admin" | "member";
  roleLabel: string;
  summary: string;
  teams: ProfileAdminScopeTeam[];
  isDeviceAdmin: boolean;
}

export interface ProfileData {
  user: UserAccount & { isDeviceAdmin: boolean };
  adminScope: ProfileAdminScope;
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

export interface DomainTeamSettings {
  id: string;
  name: string;
  shortName: string;
  description: string;
  color: string;
  canEdit: boolean;
}

export interface DomainSettingsData {
  teams: DomainTeamSettings[];
  permissions: {
    canEditSite: boolean;
    canEditStructure: boolean;
    canEditTeam: boolean;
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
/* Task tags and insights                                             */
/* ------------------------------------------------------------------ */

export interface TaskTag {
  id: string;
  name: string;
  color: string;
  usage?: number;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface TagLibraryData {
  tags: TaskTag[];
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
  /** Real member avatar URL (empty string when the member has none). */
  avatar: string;
  avatarColor: string;
  teamId: string;
  teamName: string;
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

export interface InsightsTrendPoint {
  label: string;
  start: string;
  created: number;
  completed: number;
  todos: number;
}

export interface InsightsData {
  range: InsightsRange;
  summary: InsightsSummary;
  members: InsightsMemberRow[];
  trend: {
    granularity: "day" | "week";
    buckets: InsightsTrendPoint[];
  };
}
