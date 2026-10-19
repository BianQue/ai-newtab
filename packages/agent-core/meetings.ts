/** Public display data only. Credentials and authorization URLs never enter the page runtime. */
export const MEETING_RUNTIME_VERSION = 1 as const;

/** Output contract check; rendered behavior is verified at the preview boundary. */
export function hasMeetingRuntime(code: string): boolean {
  return /(?:^|;)\s*import\s*\{[^}]*\buseMeetingData\b[^}]*\}\s*from\s*["']@homepage\/meetings["']/m.test(code) &&
    /\buseMeetingData\s*\(\s*\)/.test(code);
}

export interface MeetingItem {
  id: string;
  meetingCode?: string;
  subject: string;
  startTime: string;
  endTime: string;
  status: "scheduled" | "ongoing" | "ended";
  joinUrl?: string;
}

export interface MeetingSummary {
  id: string;
  meetingCode?: string;
  subject: string;
  startTime: string;
  endTime: string;
  summary: string;
  summaryStatus: "available" | "missing" | "forbidden" | "error";
}

export interface MeetingSnapshot {
  schemaVersion: 1;
  revision: number;
  fetchedAt: string;
  timezone: "Asia/Shanghai";
  window: { todayStart: string; todayEnd: string; weekStart: string; now: string };
  status: "ready" | "partial" | "auth_required" | "unavailable";
  meetings: MeetingItem[];
  summaries: MeetingSummary[];
  error?: { kind: "authentication" | "permission" | "network" | "parse" | "unavailable"; message: string };
}

/** Trusted transport envelope. Account identity must not enter generated pages. */
export interface MeetingRefreshResult {
  snapshot: MeetingSnapshot;
  accountRevision?: string;
}

/** Trusted host contract. This object must never be passed directly to generated code or a model. */
export interface AuthState {
  status: "disconnected" | "pending" | "connected" | "expired" | "error";
  /** Trusted cache identity only; omitted from generated page/model projections. */
  accountRevision?: string;
  requestId?: string;
  authorizationUrl?: string;
  expiresAt?: string;
  message?: string;
}

export interface MeetingAuthorizationResult {
  status: AuthState["status"] | "unavailable";
}

export interface MeetingData {
  snapshot: MeetingSnapshot | null;
  loading: boolean;
  error: string | null;
  stale?: boolean;
  connectionStatus?: MeetingAuthorizationResult["status"];
  refresh(): void;
  connect(): void;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const date = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value));
const optionalString = (value: unknown) => value === undefined || typeof value === "string";
const oneOf = (value: unknown, choices: readonly string[]) => typeof value === "string" && choices.includes(value);
const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

/** Reject unknown fields as well as invalid values so secrets cannot cross the runtime boundary. */
export function isMeetingSnapshot(value: unknown): value is MeetingSnapshot {
  if (!record(value) || !onlyKeys(value, ["schemaVersion", "revision", "fetchedAt", "timezone", "window", "status", "meetings", "summaries", "error"])) return false;
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 ||
      !date(value.fetchedAt) || value.timezone !== "Asia/Shanghai" ||
      !oneOf(value.status, ["ready", "partial", "auth_required", "unavailable"])) return false;
  if (!record(value.window) || !onlyKeys(value.window, ["todayStart", "todayEnd", "weekStart", "now"]) ||
      !["todayStart", "todayEnd", "weekStart", "now"].every((key) => date((value.window as Record<string, unknown>)[key]))) return false;
  const common = (item: unknown): item is Record<string, unknown> => record(item) &&
    typeof item.id === "string" && item.id.length > 0 && typeof item.subject === "string" &&
    optionalString(item.meetingCode) && date(item.startTime) && date(item.endTime) &&
    Date.parse(item.endTime) >= Date.parse(item.startTime);
  if (!Array.isArray(value.meetings) || !value.meetings.every((item) => common(item) &&
      onlyKeys(item, ["id", "meetingCode", "subject", "startTime", "endTime", "status", "joinUrl"]) &&
      oneOf(item.status, ["scheduled", "ongoing", "ended"]) &&
      (item.joinUrl === undefined || isSafeMeetingLink(item.joinUrl)))) return false;
  if (!Array.isArray(value.summaries) || !value.summaries.every((item) => common(item) &&
      onlyKeys(item, ["id", "meetingCode", "subject", "startTime", "endTime", "summary", "summaryStatus"]) &&
      typeof item.summary === "string" && oneOf(item.summaryStatus, ["available", "missing", "forbidden", "error"]))) return false;
  return value.error === undefined || (record(value.error) && onlyKeys(value.error, ["kind", "message"]) &&
    oneOf(value.error.kind, ["authentication", "permission", "network", "parse", "unavailable"]) && typeof value.error.message === "string");
}

export function isSafeMeetingLink(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** The CLI's one authorization endpoint; generated content cannot choose a URL. */
export function isMeetingAuthorizationUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "meeting.tencent.com" &&
      !url.port && !url.username && !url.password && !url.hash &&
      url.pathname === "/marketplace/tencentmeeting-cli-auth.html" &&
      url.searchParams.size === 1 && Boolean(url.searchParams.get("code"));
  } catch { return false; }
}

export function isMeetingRefreshResult(value: unknown): value is MeetingRefreshResult {
  if (!record(value) || !onlyKeys(value, ["snapshot", "accountRevision"]) || !isMeetingSnapshot(value.snapshot)) return false;
  const identity = value.accountRevision;
  if (identity !== undefined && (typeof identity !== "string" || !/^[a-f0-9]{64}$/.test(identity))) return false;
  if (identity === undefined && (value.snapshot.meetings.length || value.snapshot.summaries.length)) return false;
  return !["ready", "partial"].includes(value.snapshot.status) || typeof identity === "string";
}

export function isAuthState(value: unknown): value is AuthState {
  return record(value) && onlyKeys(value, ["status", "accountRevision", "requestId", "authorizationUrl", "expiresAt", "message"]) &&
    oneOf(value.status, ["disconnected", "pending", "connected", "expired", "error"]) &&
    (value.accountRevision === undefined || (typeof value.accountRevision === "string" && /^[a-f0-9]{64}$/.test(value.accountRevision))) &&
    optionalString(value.requestId) && optionalString(value.message) &&
    (value.authorizationUrl === undefined || isSafeMeetingLink(value.authorizationUrl)) &&
    (value.expiresAt === undefined || date(value.expiresAt));
}
