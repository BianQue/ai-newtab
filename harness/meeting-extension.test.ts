import { describe, expect, test, spyOn } from "bun:test";
import { isMeetingRefreshResult, isMeetingSnapshot, type MeetingSnapshot } from "../packages/agent-core";
import { MeetingManager, MEETING_REFRESH_INTERVAL_MS, type MeetingDependencies } from "../apps/extension/lib/meeting-manager";
import {
  INITIAL_MEETING_STATE, isMeetingCommand, isTrustedAuthorizationUrl,
  MEETING_MESSAGE, meetingFrameAction, meetingFrameState,
} from "../apps/extension/lib/meeting-protocol";

const snapshot = (revision = 1): MeetingSnapshot => ({
  schemaVersion: 1, revision, fetchedAt: "2026-10-19T08:00:00Z",
  timezone: "Asia/Shanghai", status: "ready",
  window: { todayStart: "2026-10-18T16:00:00Z", todayEnd: "2026-10-19T16:00:00Z",
    weekStart: "2026-10-12T08:00:00Z", now: "2026-10-19T08:00:00Z" },
  meetings: [], summaries: [],
});
const io = (request: MeetingDependencies["request"]): MeetingDependencies => ({
  request: async (route) => {
    const result = await request(route);
    return route === "refresh" && isMeetingSnapshot(result)
      ? { snapshot: result, accountRevision: "a".repeat(64) }
      : result;
  },
  load: async () => undefined, save: async () => {}, clear: async () => {},
});

describe("meeting worker boundary", () => {
  test("new tabs share a ten-minute cadence, including after failed requests", async () => {
    let now = 1_000_000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    let calls = 0;
    const manager = new MeetingManager(io(async (route) => {
      if (route === "status") return { status: "connected" };
      calls++;
      throw new Error("Offline");
    }));
    try {
      await manager.open();
      now += MEETING_REFRESH_INTERVAL_MS - 1;
      await manager.open();
      expect(calls).toBe(1);
      now++;
      await manager.open();
      expect(calls).toBe(2);
    } finally { clock.mockRestore(); }
  });

  test("worker restart reuses fresh same-account data but manual refresh still works", async () => {
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now);
    let calls = 0;
    const deps = io(async (route) => {
      if (route === "status") return { status: "connected", accountRevision: "a".repeat(64) };
      calls++;
      return snapshot(2);
    });
    deps.load = async () => ({ accountRevision: "a".repeat(64),
      snapshot: { ...snapshot(), fetchedAt: new Date(now - 60_000).toISOString() } });
    const manager = new MeetingManager(deps);
    try {
      await manager.open();
      expect(calls).toBe(0);
      expect(manager.getState().stale).toBe(false);
      expect(manager.getState().snapshot?.revision).toBe(1);
      await manager.refresh();
      expect(calls).toBe(1);
      expect(manager.getState().snapshot?.revision).toBe(2);
    } finally { clock.mockRestore(); }
  });

  test("coalesces cross-tab refresh and preserves the last successful snapshot on failure", async () => {
    let calls = 0;
    let fail = false;
    const manager = new MeetingManager(io(async (route) => {
      calls++;
      if (fail) throw new Error("Network unavailable");
      return route === "status" ? { status: "connected" } : snapshot();
    }));
    await Promise.all([manager.refresh(), manager.refresh(), manager.refresh()]);
    expect(calls).toBe(2);
    expect(manager.getState().snapshot?.revision).toBe(1);
    fail = true;
    await manager.refresh();
    expect(manager.getState().snapshot?.revision).toBe(1);
    expect(manager.getState().stale).toBe(true);
    expect(manager.getState().loading).toBe(false);
  });

  test("setting changes reject old responses and refresh the new service", async () => {
    let resolve!: (value: unknown) => void;
    let calls = 0;
    const manager = new MeetingManager(io(async (route) => {
      calls++;
      if (calls === 1) return new Promise((done) => { resolve = done; });
      return route === "status" ? { status: "connected" } : snapshot(2);
    }));
    const first = manager.refresh();
    const reset = manager.reset();
    resolve({ status: "connected" });
    await Promise.all([first, reset]);
    expect(manager.getState().snapshot?.revision).toBe(2);
    expect(calls).toBe(3);
  });

  test("rejects unexpected fields instead of caching credentials", async () => {
    let saved = false;
    const deps = io(async (route) => route === "status" ? { status: "connected" } :
      { ...snapshot(), accessToken: "must-not-persist" });
    deps.save = async () => { saved = true; };
    const manager = new MeetingManager(deps);
    await manager.refresh();
    expect(saved).toBe(false);
    expect(manager.getState().snapshot).toBeNull();
    expect(manager.getState().error).toContain("Invalid");
  });

  test("verifies account identity before restoring cache and clears data on account switches", async () => {
    let accountRevision = "a".repeat(64);
    let fail = true;
    let clears = 0;
    const deps = io(async (route) => {
      if (route === "status") return { status: "connected", accountRevision };
      if (fail) throw new Error("Network unavailable");
      return { snapshot: snapshot(2), accountRevision };
    });
    deps.load = async () => ({ accountRevision: "a".repeat(64), snapshot: snapshot() });
    deps.clear = async () => { clears++; };
    const manager = new MeetingManager(deps);
    expect(manager.getState().snapshot).toBeNull();
    await manager.open();
    expect(manager.getState().snapshot?.revision).toBe(1);
    expect(manager.getState().stale).toBe(true);
    accountRevision = "b".repeat(64);
    await manager.refresh();
    expect(manager.getState().snapshot).toBeNull();
    expect(clears).toBe(1);
    fail = false;
    await manager.refresh();
    expect(manager.getState().snapshot?.revision).toBe(2);
  });

  test("does not expose another account's persisted cache after worker restart", async () => {
    const deps = io(async (route) => {
      if (route === "status") return { status: "connected", accountRevision: "b".repeat(64) };
      throw new Error("Network unavailable");
    });
    deps.load = async () => ({ accountRevision: "a".repeat(64), snapshot: snapshot() });
    const manager = new MeetingManager(deps);
    await manager.open();
    expect(manager.getState().snapshot).toBeNull();
  });

  test("binds cache to the refresh response when the account changes after status", async () => {
    const accountA = "a".repeat(64), accountB = "b".repeat(64);
    const privateB = { ...snapshot(), summaries: [{
      id: "b-summary", subject: "Synthetic account B meeting",
      startTime: "2026-10-19T06:00:00Z", endTime: "2026-10-19T07:00:00Z",
      summary: "Synthetic private B summary", summaryStatus: "available" as const,
    }] };
    let cache: Awaited<ReturnType<MeetingDependencies["load"]>>;
    const deps = io(async (route) => route === "status"
      ? { status: "connected", accountRevision: accountA }
      : { snapshot: privateB, accountRevision: accountB });
    deps.save = async (value) => { cache = value; };
    const manager = new MeetingManager(deps);
    await manager.refresh();
    expect(cache?.accountRevision).toBe(accountB);
    expect(manager.getState().snapshot?.summaries[0].summary).toBe("Synthetic private B summary");
    const restarted = new MeetingManager({
      ...deps, load: async () => cache,
      request: async (route) => {
        if (route === "status") return { status: "connected", accountRevision: accountA };
        throw new Error("Network unavailable");
      },
    });
    await restarted.open();
    expect(restarted.getState().snapshot).toBeNull();
  });

  test("trusted refresh envelopes require identity for successful data and reject secret fields", () => {
    expect(isMeetingRefreshResult({ snapshot: snapshot() })).toBe(false);
    expect(isMeetingRefreshResult({ snapshot: snapshot(), accountRevision: "a".repeat(64) })).toBe(true);
    expect(isMeetingRefreshResult({ snapshot: snapshot(), accountRevision: "a".repeat(64), accessToken: "secret" })).toBe(false);
    expect(isMeetingRefreshResult({ snapshot: { ...snapshot(), status: "auth_required" } })).toBe(true);
    expect(isMeetingRefreshResult({ snapshot: { ...snapshot(), status: "unavailable", summaries: [{
      id: "private", subject: "Private fixture", startTime: "2026-10-19T06:00:00Z",
      endTime: "2026-10-19T07:00:00Z", summary: "Must be scoped", summaryStatus: "available",
    }] } })).toBe(false);
    const projected = meetingFrameState({ ...INITIAL_MEETING_STATE, snapshot: snapshot(),
      auth: { status: "connected", accountRevision: "a".repeat(64) } });
    expect(JSON.stringify(projected)).not.toContain("accountRevision");
  });

  test("discards cached data when a refresh cannot retain its account identity", async () => {
    let changed = false;
    let cleared = 0;
    const deps = io(async (route) => {
      if (route === "status") return { status: "connected", accountRevision: "a".repeat(64) };
      return changed
        ? { snapshot: { ...snapshot(2), status: "auth_required" } }
        : { snapshot: snapshot(), accountRevision: "a".repeat(64) };
    });
    deps.clear = async () => { cleared++; };
    const manager = new MeetingManager(deps);
    await manager.refresh();
    expect(manager.getState().snapshot?.status).toBe("ready");
    changed = true;
    await manager.refresh();
    expect(manager.getState().snapshot?.meetings).toEqual([]);
    expect(manager.getState().snapshot?.status).toBe("auth_required");
    expect(cleared).toBe(2);
  });

  test("rejects unscoped commands and never projects the authorization challenge", () => {
    expect(isMeetingCommand({ kind: "connect", url: "https://evil.test" })).toBe(false);
    expect(isMeetingCommand({ kind: "connect" })).toBe(true);
    const projected = meetingFrameState({
      ...INITIAL_MEETING_STATE,
      auth: { status: "pending", authorizationUrl: "https://private.test", requestId: "private-request" },
    });
    expect(JSON.stringify(projected)).not.toContain("private");
    expect(projected.connectionStatus).toBe("pending");
  });
});

describe("meeting preview trust boundary", () => {
  test("binds commands to the actual iframe and current channel, including opaque origins", () => {
    const frame = {} as Window;
    const message = { type: MEETING_MESSAGE, channel: "current", action: "refresh" };
    expect(meetingFrameAction({ source: frame, data: message }, frame, "current")).toBe("refresh");
    expect(meetingFrameAction({ source: {} as Window, data: message }, frame, "current")).toBeNull();
    expect(meetingFrameAction({ source: frame, data: message }, frame, "old")).toBeNull();
    expect(meetingFrameAction({ source: frame, data: { ...message, url: "https://evil.test" } }, frame, "current")).toBeNull();
  });

  test("only permits the exact CLI authorization endpoint", () => {
    const trusted = "https://meeting.tencent.com/marketplace/tencentmeeting-cli-auth.html?code=test";
    expect(isTrustedAuthorizationUrl(trusted)).toBe(true);
    for (const invalid of [
      trusted.replace("https:", "http:"), trusted.replace("meeting.tencent.com", "meeting.tencent.com.evil.test"),
      trusted.replace("/marketplace/", "/"), trusted + "#redirect", trusted.replace("code=test", "code="),
      trusted + "&redirect=https://evil.test", trusted + "&code=duplicate",
      trusted.replace("meeting.tencent.com", "user:pass@meeting.tencent.com"),
    ]) expect(isTrustedAuthorizationUrl(invalid)).toBe(false);
  });
});
