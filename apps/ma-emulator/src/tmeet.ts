import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuthState, MeetingItem, MeetingRefreshResult, MeetingSnapshot, MeetingSummary } from "@homepage/agent-core";
import { isSafeMeetingLink } from "@homepage/agent-core";
import { authorizationUrl, classifyFailure, MeetingError, parseCliJson, type MeetingCli } from "./tmeet-cli";

const DAY = 86_400_000;
export function meetingWindow(now: number): MeetingSnapshot["window"] {
  const today = Math.floor((now + 8 * 3_600_000) / DAY) * DAY - 8 * 3_600_000;
  return { todayStart: new Date(today).toISOString(), todayEnd: new Date(today + DAY).toISOString(), weekStart: new Date(now - 7 * DAY).toISOString(), now: new Date(now).toISOString() };
}
function time(value: unknown): string {
  const n = typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value)) ? Number(value) * 1000 : Date.parse(String(value));
  if (!Number.isFinite(n)) throw new MeetingError("parse", "A meeting has invalid timestamps.");
  return new Date(n).toISOString();
}
const failure = (error: unknown) => error instanceof MeetingError ? error : new MeetingError("unavailable", "Meeting integration is unavailable.");
function originalText(value: unknown): string[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(originalText);
  if (typeof value === "object" && typeof (value as { content?: unknown }).content === "string")
    return [(value as { content: string }).content];
  throw new MeetingError("parse", "The CLI returned an unsupported summary format.");
}

export class MeetingService {
  private auth: AuthState = { status: "disconnected" };
  private snapshot?: MeetingSnapshot;
  private revision = 0;
  private account?: string;
  private enabled = false;
  private nextCheckAt = 0;
  private failures = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private queue: Promise<unknown> = Promise.resolve();
  private refreshTask?: Promise<MeetingRefreshResult>;
  private connectTask?: Promise<AuthState>;
  private login?: AbortController;
  private stopped = false;
  private recovered = false;
  private abort = new AbortController();
  private operationSignal = this.abort.signal;
  private readonly statePath: string;

  constructor(private cli: MeetingCli, dataDir: string, private now = Date.now) {
    this.statePath = join(dataDir, "tmeet-schedule.json");
    mkdirSync(dataDir, { recursive: true });
    try {
      const state = JSON.parse(readFileSync(this.statePath, "utf8"));
      this.enabled = state.enabled === true;
      this.nextCheckAt = Number(state.nextCheckAt) || 0;
    } catch {}
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const task = this.queue.then(work, work);
    this.queue = task.catch(() => {});
    return task;
  }
  private persist() {
    writeFileSync(this.statePath + ".tmp", JSON.stringify({ enabled: this.enabled, nextCheckAt: this.nextCheckAt }), { mode: 0o600 });
    renameSync(this.statePath + ".tmp", this.statePath);
  }
  recover() {
    if (this.recovered) return;
    this.recovered = true;
    if (this.enabled) this.runCheck();
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.login?.abort();
    this.abort.abort();
    await this.queue;
  }
  private schedule(delay: number) {
    clearTimeout(this.timer);
    if (this.stopped || !this.enabled) return;
    this.nextCheckAt = this.now() + delay;
    this.persist();
    // Periodic wake checks also cover system resume without accumulating missed work.
    const wake = () => {
      if (this.now() >= this.nextCheckAt) this.runCheck();
      else this.timer = setTimeout(wake, Math.min(60_000, this.nextCheckAt - this.now()));
    };
    this.timer = setTimeout(wake, Math.min(delay, 60_000));
  }
  private async inspect(): Promise<AuthState> {
    const result = await this.cli.run(["auth", "status"], this.operationSignal);
    if (result.code !== 0) throw classifyFailure(result.stdout + result.stderr);
    const text = result.stdout + result.stderr;
    if (/Not logged in|Session has expired/i.test(text)) {
      this.account = undefined; this.snapshot = undefined;
      return this.auth = { status: "disconnected" };
    }
    if (!/Logged in/i.test(text)) throw new MeetingError("parse", "The meeting CLI returned an invalid authentication status.");
    const identity = /OpenId:\s*(\S+)/i.exec(text)?.[1];
    if (!identity) throw new MeetingError("parse", "The meeting CLI did not identify the connected account.");
    const account = createHash("sha256").update(identity).digest("hex");
    if (this.account && account !== this.account) this.snapshot = undefined;
    this.account = account;
    const expired = /RefreshToken:\s*expired/i.test(text);
    // CLI formats expiry in the local process timezone.
    const rawExpiry = /AccessToken:\s*(?:valid \(expires at|expired \(at)\s*(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/i.exec(text)?.[1];
    const expiry = rawExpiry && Date.parse(rawExpiry.replace(" ", "T"));
    if (!expiry) throw new MeetingError("parse", "The meeting CLI did not return a credential expiry.");
    return this.auth = { status: expired ? "expired" : "connected", expiresAt: new Date(expiry).toISOString(), accountRevision: account };
  }
  private runCheck() {
    void this.check().catch(() => {
      this.enabled = false;
      clearTimeout(this.timer);
      this.auth = { status: "error", message: "The meeting renewal schedule could not be saved." };
    });
  }
  async status(): Promise<AuthState> {
    if (this.login || this.stopped) return { ...this.auth };
    return this.serial(async () => {
      if (this.login) return { ...this.auth };
      try { return await this.inspect(); }
      catch (error) { return this.auth = { status: "error", message: failure(error).message }; }
    });
  }
  private async check() {
    return this.serial(async () => {
      if (this.login || this.stopped) return;
      try {
        const auth = await this.inspect();
        if (auth.status !== "connected") { this.enabled = false; this.persist(); return; }
        // This REST query invokes the CLI's RefreshToken hook; status alone is not a renewal guarantee.
        parseCliJson(await this.cli.run(["meeting", "list", "--page-size", "1"], this.abort.signal));
        const fresh = await this.inspect();
        if (fresh.status !== "connected") throw new MeetingError("authentication", "Tencent Meeting authorization is required.");
        this.failures = 0;
        this.schedule(Math.max(1_000, Math.min(6 * 3_600_000, Date.parse(fresh.expiresAt!) - this.now() - 30_000)));
      } catch (error) {
        const err = failure(error);
        if (err.kind === "authentication") {
          this.auth = { status: "expired", message: err.message };
          this.enabled = false; this.snapshot = undefined; this.persist();
        } else this.schedule(Math.min(30 * 60_000, 30_000 * 2 ** Math.min(this.failures++, 6)));
      }
    });
  }
  connect(): Promise<AuthState> {
    if (this.login) return Promise.resolve({ ...this.auth });
    if (this.connectTask) return this.connectTask;
    this.connectTask = this.serial(async () => {
      try {
        if (this.login || this.stopped) return { ...this.auth };
        const current = await this.inspect();
        if (current.status === "connected") {
          this.enabled = true; this.schedule(1); return current;
        }
        this.login = new AbortController();
        this.auth = { status: "pending", requestId: crypto.randomUUID(), expiresAt: new Date(this.now() + 300_000).toISOString() };
        let output = "";
        let resolveChallenge!: (state: AuthState) => void;
        const challenge = new Promise<AuthState>((resolve) => resolveChallenge = resolve);
        const wait = setTimeout(() => resolveChallenge({ ...this.auth }), 2_000);
        const login = this.cli.run(["auth", "login", "--no-browser"], this.login.signal, (chunk) => {
          output += chunk;
          const raw = /authorize url:[ \t]*(https?:\/\/[^\r\n]*)\r?\n/i.exec(output)?.[1]?.trim();
          if (raw) {
            const valid = authorizationUrl(raw);
            if (!valid) { this.auth = { status: "error", message: "The CLI returned an untrusted authorization address." }; this.login?.abort(); }
            else this.auth = { ...this.auth, authorizationUrl: valid };
            resolveChallenge({ ...this.auth });
          }
        });
        // Keep login and all CLI queries serialized until polling has finished.
        this.queue = login.then(async (result) => {
          if (result.code !== 0) throw classifyFailure(result.stdout + result.stderr);
          const state = await this.inspect();
          if (state.status !== "connected") throw new MeetingError("authentication", "Authorization did not complete.");
          this.enabled = true; this.schedule(1);
        }).catch((error) => {
          this.auth = { status: "error", message: failure(error).message };
        }).finally(() => { this.login = undefined; clearTimeout(wait); resolveChallenge({ ...this.auth }); });
        return challenge;
      } catch (error) { return this.auth = { status: "error", message: failure(error).message }; }
    }).finally(() => this.connectTask = undefined);
    return this.connectTask;
  }
  private async pages(args: string[], key: string): Promise<{ rows: Record<string, any>[]; partial: boolean }> {
    const rows: Record<string, any>[] = [];
    const seen = new Set<string>();
    let token = "";
    for (let page = 0; page < 10; page++) {
      const data = parseCliJson(await this.cli.run([...args, ...(token ? ["--page-token", token] : [])], this.operationSignal));
      if (key === "meeting_info_list" && data.meeting_info_list === undefined && data.meeting_number === 0) data.meeting_info_list = [];
      if (!Array.isArray(data[key])) throw new MeetingError("parse", "The meeting CLI returned an invalid list.");
      if (!data[key].every((row: unknown) => row && typeof row === "object" && !Array.isArray(row)))
        throw new MeetingError("parse", "The meeting CLI returned an invalid meeting.");
      rows.push(...data[key]);
      token = typeof data.next_page_token === "string" ? data.next_page_token : "";
      if (!token) return { rows, partial: data.has_more === true || Number(data.remaining) > 0 };
      if (seen.has(token) || rows.length >= 300) return { rows, partial: true };
      seen.add(token);
    }
    return { rows, partial: true };
  }
  refresh(): Promise<MeetingSnapshot> {
    return this.refreshWithAccount().then((result) => result.snapshot);
  }
  refreshWithAccount(): Promise<MeetingRefreshResult> {
    const pending = (): MeetingRefreshResult => ({ snapshot: {
      schemaVersion: 1, revision: ++this.revision, fetchedAt: new Date(this.now()).toISOString(),
      timezone: "Asia/Shanghai", window: meetingWindow(this.now()), status: "auth_required",
      meetings: [], summaries: [], error: { kind: "authentication", message: "Complete Tencent Meeting authorization to refresh." },
    } });
    if (this.login) return Promise.resolve(pending());
    if (this.refreshTask) return this.refreshTask;
    this.refreshTask = this.serial(async () => {
      if (this.login) return pending();
      this.operationSignal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(25_000)]);
      try { return await this.fetchSnapshot(); }
      finally { this.operationSignal = this.abort.signal; }
    }).finally(() => this.refreshTask = undefined);
    return this.refreshTask;
  }
  private item(row: Record<string, any>, now: number, ended = false): MeetingItem {
    if (typeof row.meeting_id !== "string" || typeof row.subject !== "string")
      throw new MeetingError("parse", "The meeting CLI returned an invalid meeting.");
    const startTime = time(row.actual_start_time ?? row.start_time);
    const endTime = time(row.actual_end_time ?? row.end_time);
    if (Date.parse(endTime) < Date.parse(startTime)) throw new MeetingError("parse", "A meeting has invalid timestamps.");
    return {
      id: createHash("sha256").update(`${this.account}|${row.meeting_id}|${row.sub_meeting_id ?? ""}|${startTime}`).digest("hex").slice(0, 32),
      ...(typeof row.meeting_code === "string" ? { meetingCode: row.meeting_code } : {}),
      subject: row.subject, startTime, endTime,
      status: ended || Date.parse(endTime) <= now ? "ended" : Date.parse(startTime) <= now ? "ongoing" : "scheduled",
      ...(isSafeMeetingLink(row.join_url) ? { joinUrl: row.join_url } : {}),
    };
  }
  private async fetchSnapshot(): Promise<MeetingRefreshResult> {
    const now = this.now(), window = meetingWindow(now);
    let previous = this.snapshot;
    const snapshot: MeetingSnapshot = { schemaVersion: 1, revision: ++this.revision, fetchedAt: previous?.fetchedAt ?? new Date(now).toISOString(), timezone: "Asia/Shanghai", window, status: "ready", meetings: previous?.meetings ?? [], summaries: previous?.summaries ?? [] };
    const errors: MeetingError[] = [];
    let success = false;
    let queryAccount: string | undefined;
    let accountRevision: string | undefined;
    let accountChanged = false;
    try {
      const state = await this.inspect();
      if (state.status !== "connected") throw new MeetingError("authentication", "Tencent Meeting authorization is required.");
      queryAccount = this.account;
      if (previous && !this.snapshot) { previous = undefined; snapshot.meetings = []; snapshot.summaries = []; }
      const upcoming = await this.pages(["meeting", "list", "--show-all-sub", "1", "--page-size", "20"], "meeting_info_list")
        .catch((error) => { errors.push(failure(error)); return null; });
      // Query history without a start bound: filtering by actual end includes long meetings crossing the window.
      const ended = await this.pages(["meeting", "list-ended", "--end", window.now, "--page-size", "30"], "meeting_info_list")
        .catch((error) => { errors.push(failure(error)); return null; });
      if (upcoming || ended) {
        const rows = [...(upcoming?.rows ?? []), ...(ended?.rows ?? [])];
        const items: MeetingItem[] = [];
        for (const row of rows) {
          try { items.push(this.item(row, now, ended?.rows.includes(row))); }
          catch (error) { errors.push(failure(error)); }
        }
        const isToday = (item: MeetingItem) => Date.parse(item.startTime) < Date.parse(window.todayEnd) && Date.parse(item.endTime) > Date.parse(window.todayStart);
        const today = items.filter(isToday);
        if (upcoming && ended) snapshot.meetings = [...new Map(today.map((item) => [item.id, item])).values()];
        else snapshot.meetings = [...new Map([...snapshot.meetings.filter(isToday), ...today].map((item) => [item.id, item])).values()];
        if (upcoming?.partial || ended?.partial) errors.push(new MeetingError("unavailable", "The meeting result limit was reached; some meetings may be missing."));
        success = true;
      }
      if (ended) {
        const summaries: MeetingSummary[] = [];
        for (const row of ended.rows) {
          let normalized: MeetingItem;
          try { normalized = this.item(row, now, true); }
          catch (error) { errors.push(failure(error)); continue; }
          const { status: _, joinUrl: __, ...item } = normalized;
          const end = Date.parse(item.endTime);
          if (end < Date.parse(window.weekStart) || end > now) continue;
          let summary = "", summaryStatus: MeetingSummary["summaryStatus"] = "missing";
          try {
            const records = Array.isArray(row.records) ? row.records : [];
            const accessible = records.filter((record: any) => record?.permission_status === "can_view" && typeof record.record_file_id === "string" && !/录制中|转码中/.test(String(record.state)));
            const parts: string[] = [];
            let recordError: MeetingError | undefined;
            for (const record of accessible.slice(0, 10)) {
              try {
                const data = parseCliJson(await this.cli.run(["record", "smart-minutes", "--record-file-id", record.record_file_id], this.operationSignal));
                if (!data.meeting_minute || typeof data.meeting_minute !== "object") throw new MeetingError("parse", "The CLI returned an invalid recording summary.");
                for (const text of [data.meeting_minute.minute, data.meeting_minute.todo]) if (typeof text === "string" && text) parts.push(text);
              } catch (error) { recordError = failure(error); }
            }
            if (!parts.length) {
              const args = ["minutes", "get", "--meeting-id", row.meeting_id, ...(row.sub_meeting_id ? ["--sub-meeting-id", String(row.sub_meeting_id)] : []), "--page-size", "30"];
              const minutes = await this.pages(args, "minutes");
              for (const minute of minutes.rows) {
                parts.push(...originalText(minute.overview), ...originalText(minute.summary_points), ...originalText(minute.todos));
              }
              if (minutes.partial) errors.push(new MeetingError("unavailable", "Some meeting summary pages could not be included."));
            }
            summary = parts.join("\n\n");
            summaryStatus = summary ? "available" : "missing";
            if (!summary && recordError) throw recordError;
            if (summary && recordError) errors.push(recordError);
            if (!summary && records.some((record: any) => ["can_apply", "closed", "password_required"].includes(record?.permission_status))) {
              summaryStatus = "forbidden";
              errors.push(new MeetingError("permission", "Some recording summaries require additional permissions."));
            }
            if (accessible.length > 10) errors.push(new MeetingError("unavailable", "The recording summary result limit was reached."));
          } catch (error) {
            const err = failure(error); errors.push(err);
            summaryStatus = err.kind === "permission" ? "forbidden" : "error";
            const old = previous?.summaries.find((entry) => entry.id === item.id);
            if (old?.summaryStatus === "available") summary = old.summary;
          }
          summaries.push({ ...item, summary, summaryStatus });
        }
        snapshot.summaries = ended.partial
          ? [...new Map([...(previous?.summaries ?? []).filter((item) => Date.parse(item.endTime) >= Date.parse(window.weekStart) && Date.parse(item.endTime) <= now), ...summaries].map((item) => [item.id, item])).values()]
          : [...new Map(summaries.map((item) => [item.id, item])).values()];
      }
      this.enabled = true;
      if (!this.timer) this.schedule(1);
    } catch (error) { errors.push(failure(error)); }
    if (queryAccount) {
      try {
        const finalState = await this.inspect();
        accountRevision = finalState.status === "connected" ? this.account : undefined;
        if (finalState.status !== "connected" || this.account !== queryAccount) {
          accountChanged = true;
          previous = undefined;
          errors.push(new MeetingError("authentication", "The connected account changed during refresh. Refresh again to load its meetings."));
        }
      } catch (error) { errors.push(failure(error)); }
    }
    if (errors.length) {
      const error = errors.find((err) => err.kind === "authentication") ?? errors[0];
      snapshot.status = error.kind === "authentication" ? "auth_required" : success || previous ? "partial" : "unavailable";
      snapshot.error = { kind: error.kind, message: error.message };
      if (error.kind === "authentication") {
        snapshot.meetings = []; snapshot.summaries = [];
        if (!accountChanged) this.auth = { status: "expired", message: error.message };
        this.enabled = false; clearTimeout(this.timer); this.persist();
      }
    } else snapshot.fetchedAt = new Date(now).toISOString();
    if (!accountRevision) {
      snapshot.meetings = []; snapshot.summaries = [];
      if (snapshot.status === "partial") snapshot.status = "unavailable";
    }
    this.snapshot = snapshot;
    return { snapshot, ...(accountRevision ? { accountRevision } : {}) };
  }
}
