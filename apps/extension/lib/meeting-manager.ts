import {
  isAuthState,
  isMeetingSnapshot,
  isMeetingRefreshResult,
  type AuthState,
  type MeetingSnapshot,
} from "@homepage/agent-core";
import { INITIAL_MEETING_STATE, isMeetingCommand, type MeetingState } from "./meeting-protocol";

interface MeetingPort {
  postMessage(message: unknown): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}
export type MeetingRoute = "status" | "connect" | "refresh";

export interface MeetingCache {
  snapshot: MeetingSnapshot;
  accountRevision?: string;
}

export interface MeetingDependencies {
  request(route: MeetingRoute): Promise<unknown>;
  load(): Promise<MeetingCache | undefined>;
  save(cache: MeetingCache): Promise<void>;
  clear(): Promise<void>;
}

/**
 * Independent of build sessions. One worker owns request coalescing, cached data,
 * and authorization polling for all new tabs.
 */
export class MeetingManager {
  private state: MeetingState = { ...INITIAL_MEETING_STATE };
  private readonly ports = new Set<MeetingPort>();
  private refreshTask: Promise<void> | null = null;
  private connectTask: Promise<AuthState> | null = null;
  private poll: ReturnType<typeof setTimeout> | null = null;
  private cacheTask: Promise<MeetingCache | undefined> | null = null;
  private accountRevision: string | undefined;
  private lastRefresh = 0;
  private generation = 0;

  constructor(private readonly io: MeetingDependencies) {}

  attach(port: MeetingPort) {
    this.ports.add(port);
    port.onMessage.addListener((raw: unknown) => {
      if (!isMeetingCommand(raw)) return;
      if (raw.kind === "subscribe") {
        this.send(port);
        void this.open();
      } else if (raw.kind === "connect") {
        void this.connect();
      } else {
        void this.refresh();
      }
    });
    port.onDisconnect.addListener(() => this.ports.delete(port));
  }

  getState(): MeetingState { return this.state; }

  private send(port: MeetingPort) {
    try { port.postMessage({ kind: "meetings", state: this.state }); }
    catch { this.ports.delete(port); }
  }

  private publish(update: Partial<MeetingState>) {
    this.state = { ...this.state, ...update };
    for (const port of this.ports) this.send(port);
  }

  async open() {
    // Tabs opened together share the same fetch and a short cooldown.
    if (Date.now() - this.lastRefresh > 5_000) await this.refresh();
  }

  async reset() {
    this.generation++;
    this.lastRefresh = 0;
    if (this.poll) clearTimeout(this.poll);
    this.poll = null;
    this.state = { ...INITIAL_MEETING_STATE };
    this.publish({});
    await this.refreshTask;
    await this.connectTask;
    await this.io.clear();
    this.cacheTask = null;
    this.accountRevision = undefined;
    await this.refresh();
  }

  refresh(): Promise<void> {
    if (this.refreshTask) return this.refreshTask;
    const generation = this.generation;
    this.publish({ loading: true, error: null });
    this.refreshTask = (async () => {
      try {
        const rawAuth = await this.io.request("status");
        if (generation !== this.generation) return;
        if (!isAuthState(rawAuth)) throw new Error("Invalid meeting authorization response.");
        this.publish({ auth: rawAuth });
        const cache = await (this.cacheTask ??= this.io.load());
        if (generation !== this.generation) return;
        if (rawAuth.accountRevision && rawAuth.accountRevision !== this.accountRevision) {
          this.accountRevision = rawAuth.accountRevision;
          // Verify the account before exposing persisted private meeting data.
          if (cache?.accountRevision === rawAuth.accountRevision && isMeetingSnapshot(cache.snapshot)) {
            this.publish({ snapshot: cache.snapshot, stale: true });
          } else {
            this.publish({ snapshot: null, stale: false });
            await this.io.clear();
            this.cacheTask = Promise.resolve(undefined);
          }
        }
        if (rawAuth.status === "disconnected") {
          this.publish({ snapshot: null, stale: false });
          this.accountRevision = undefined;
          this.cacheTask = Promise.resolve(undefined);
          await this.io.clear();
        }
        if (rawAuth.status === "pending") this.schedulePoll();
        const response = await this.io.request("refresh");
        if (generation !== this.generation) return;
        if (!isMeetingRefreshResult(response)) throw new Error("Invalid meeting data response.");
        const raw = response.snapshot;
        if ((response.accountRevision && response.accountRevision !== this.accountRevision) ||
          (raw.status === "auth_required" && !response.accountRevision)) {
          this.accountRevision = response.accountRevision;
          this.publish({ snapshot: null, stale: false });
          await this.io.clear();
          if (generation !== this.generation) return;
          this.cacheTask = Promise.resolve(undefined);
        }
        const good = raw.status === "ready" || raw.status === "partial";
        if (good) {
          this.accountRevision = response.accountRevision;
          const nextCache = { snapshot: raw, accountRevision: response.accountRevision };
          await this.io.save(nextCache);
          if (generation !== this.generation) return;
          this.cacheTask = Promise.resolve(nextCache);
          this.publish({ snapshot: raw, stale: raw.status !== "ready", error: null });
        } else {
          this.publish({
            snapshot: this.state.snapshot ?? raw,
            stale: Boolean(this.state.snapshot),
            error: raw.status === "auth_required" ? "Connect Tencent Meeting to update meetings." : "Meeting data is unavailable.",
          });
        }
        this.lastRefresh = Date.now();
      } catch (error) {
        if (generation === this.generation) this.publish({
          error: error instanceof Error ? error.message : "Meeting service unavailable.",
          stale: Boolean(this.state.snapshot),
        });
      } finally {
        if (generation === this.generation) this.publish({ loading: false });
        this.refreshTask = null;
      }
    })();
    return this.refreshTask;
  }

  connect(): Promise<AuthState> {
    if (this.connectTask) return this.connectTask;
    const generation = this.generation;
    this.connectTask = (async () => {
      try {
        const raw = await this.io.request("connect");
        if (!isAuthState(raw)) throw new Error("Invalid meeting authorization response.");
        if (generation !== this.generation) return { status: "disconnected" } as AuthState;
        this.publish({ auth: raw, error: null });
        if (raw.status === "pending") this.schedulePoll();
        if (raw.status === "connected") await this.refresh();
        return raw;
      } catch (error) {
        const auth: AuthState = { status: "error", message: "Meeting connection failed. Open Tencent Meeting controls to retry." };
        if (generation === this.generation) this.publish({ auth, error: error instanceof Error ? error.message : auth.message ?? null });
        return auth;
      } finally {
        this.connectTask = null;
      }
    })();
    return this.connectTask;
  }

  private schedulePoll() {
    if (this.poll) return;
    const generation = this.generation;
    this.poll = setTimeout(async () => {
      this.poll = null;
      try {
        const auth = await this.io.request("status");
        if (generation !== this.generation || !isAuthState(auth)) return;
        this.publish({ auth });
        if (auth.status === "pending") this.schedulePoll();
        else if (auth.status === "connected") await this.refresh();
      } catch {
        if (generation === this.generation) this.publish({ error: "Unable to check authorization. Refresh to retry." });
      }
    }, 2_000);
  }
}
