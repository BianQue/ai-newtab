import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { isMeetingSnapshot } from "@homepage/agent-core";
import { loadConfig } from "../src/config";
import { startEmulator, type Emulator } from "../src/server";
import { authorizationUrl, createMeetingCli, MeetingError, parseCliJson, type CliResult, type MeetingCli } from "../src/tmeet-cli";
import { MeetingService, meetingWindow } from "../src/tmeet";

const NOW = Date.parse("2026-10-19T04:00:00Z");
const json = (data: unknown): CliResult => ({ code: 0, stdout: JSON.stringify({ data, message: "success" }), stderr: "" });
const status = (account = "fixture-account", expired = false): CliResult => ({
  code: 0, stderr: "", stdout: `Logged in\n OpenId: ${account}\n AccessToken: valid (expires at 2026-10-20 12:00:00, remaining 1d)\n RefreshToken: ${expired ? "expired" : "valid"} (expires at 2026-11-01 00:00:00)`,
});
const row = (overrides: Record<string, unknown> = {}) => ({
  meeting_id: "private-internal-id", meeting_code: "123456789", subject: "Fixture meeting",
  start_time: "2026-10-19T01:00:00Z", end_time: "2026-10-19T02:00:00Z", ...overrides,
});
const dirs: string[] = [];
const services: MeetingService[] = [];
const emulators: Emulator[] = [];
const dir = () => { const path = mkdtempSync(join(tmpdir(), "tmeet-test-")); dirs.push(path); return path; };
const service = (run: MeetingCli["run"], path = dir()) => { const service = new MeetingService({ run }, path, () => NOW); services.push(service); return service; };
afterEach(async () => {
  for (const emulator of emulators.splice(0)) await emulator.stop();
  for (const service of services.splice(0)) await service.stop();
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("meeting service boundaries", () => {
  test("Beijing dates, midnight rollover and exact seven day window", () => {
    expect(meetingWindow(NOW)).toEqual({ todayStart: "2026-10-18T16:00:00.000Z", todayEnd: "2026-10-19T16:00:00.000Z", weekStart: "2026-10-12T04:00:00.000Z", now: "2026-10-19T04:00:00.000Z" });
    expect(meetingWindow(Date.parse("2026-10-19T16:00:00Z")).todayStart).toBe("2026-10-19T16:00:00.000Z");
  });

  test("real CLI empty list shape succeeds; malformed envelope and unsafe authorization URLs fail", async () => {
    const meetings = service(async (args) => args[0] === "auth" ? status() : args[1] === "list" ? json({ meeting_number: 0, remaining: 0 }) : json({ meeting_info_list: [] }));
    expect((await meetings.refresh()).status).toBe("ready");
    expect(() => parseCliJson({ code: 0, stdout: "garbage", stderr: "" })).toThrow();
    expect(() => parseCliJson(json({}))).not.toThrow();
    expect(authorizationUrl("https://meeting.tencent.com/marketplace/tencentmeeting-cli-auth.html?code=fixture")).toBeDefined();
    for (const url of ["http://meeting.tencent.com/marketplace/tencentmeeting-cli-auth.html?code=x", "https://meeting.tencent.com.evil.test/marketplace/tencentmeeting-cli-auth.html?code=x", "https://meeting.tencent.com/other?code=x", "https://user@meeting.tencent.com/marketplace/tencentmeeting-cli-auth.html?code=x", "https://meeting.tencent.com/marketplace/tencentmeeting-cli-auth.html?code=x#bad"]) expect(authorizationUrl(url)).toBeUndefined();
    await expect(createMeetingCli().run(["auth", "logout"])).rejects.toThrow("Unsupported");
  });

  test("paginates instances, cross-day overlap, exact actual-end history and unmodified summaries", async () => {
    const calls: string[][] = [];
    const records = [
      row({ sub_meeting_id: "first" }),
      row({ sub_meeting_id: "second", start_time: "2026-10-18T15:00:00Z", end_time: "2026-10-18T17:00:00Z" }),
      row({ sub_meeting_id: "outside", start_time: "2026-10-12T01:00:00Z", actual_end_time: "2026-10-12T03:59:59Z" }),
    ];
    const meetings = service(async (args) => {
      calls.push(args);
      if (args[0] === "auth") return status();
      if (args[1] === "list") return json({ meeting_info_list: [row({ meeting_id: "upcoming", start_time: "2026-10-19T05:00:00Z", end_time: "2026-10-19T06:00:00Z", join_url: "javascript:alert(1)" })] });
      if (args[1] === "list-ended") return args.includes("--page-token") ? json({ meeting_info_list: records.slice(1) }) : json({ meeting_info_list: records.slice(0, 1), next_page_token: "cursor" });
      return json({ minutes: [{ overview: "<script>untrusted text</script>", summary_points: ["Exact original summary"], todos: [{ content: "Exact todo" }] }] });
    });
    const snapshot = await meetings.refresh();
    expect(isMeetingSnapshot(snapshot)).toBe(true);
    expect(snapshot.status).toBe("ready");
    expect(snapshot.meetings).toHaveLength(3);
    expect(snapshot.summaries).toHaveLength(2);
    expect(new Set(snapshot.summaries.map((item) => item.id)).size).toBe(2);
    expect(snapshot.summaries[0].summary).toBe("<script>untrusted text</script>\n\nExact original summary\n\nExact todo");
    expect(JSON.stringify(snapshot)).not.toContain("private-internal-id");
    expect(JSON.stringify(snapshot)).not.toContain("javascript:");
    expect(calls.some((args) => args.includes("--sub-meeting-id"))).toBe(true);
  });

  test("uses authorized recording originals and falls back to Yuanbao on recording failure", async () => {
    let failRecording = false;
    const calls: string[][] = [];
    const meetings = service(async (args) => {
      calls.push(args);
      if (args[0] === "auth") return status();
      if (args[1] === "list") return json({ meeting_info_list: [] });
      if (args[1] === "list-ended") return json({ meeting_info_list: [row({ records: [{ permission_status: "can_view", record_file_id: "fixture-file", state: "转码完成" }] })] });
      if (args[0] === "record") {
        if (failRecording) throw new MeetingError("permission", "Permission unavailable");
        // Official response: cloud.tencent.cn/document/product/1095/109458.
        return json({ meeting_minute: { minute: "Original recording summary", todo: "Original todo" } });
      }
      return json({ minutes: [{ overview: "Yuanbao original" }] });
    });
    expect((await meetings.refresh()).summaries[0].summary).toBe("Original recording summary\n\nOriginal todo");
    expect(calls.some((args) => args[0] === "minutes")).toBe(false);
    failRecording = true;
    expect((await meetings.refresh()).summaries[0].summary).toBe("Yuanbao original");
  });

  test("distinguishes missing summaries from permission failures and preserves successful list", async () => {
    let denied = false;
    const meetings = service(async (args) => {
      if (args[0] === "auth") return status();
      if (args[1] === "list") return json({ meeting_info_list: [] });
      if (args[1] === "list-ended") return json({ meeting_info_list: [row()] });
      if (denied) return { code: 1, stdout: "", stderr: "500284 forbidden" };
      return json({ minutes: [] });
    });
    expect((await meetings.refresh()).summaries[0].summaryStatus).toBe("missing");
    denied = true;
    const snapshot = await meetings.refresh();
    expect(snapshot.meetings).toHaveLength(1);
    expect(snapshot.status).toBe("partial");
    expect(snapshot.summaries[0].summaryStatus).toBe("forbidden");
    expect(snapshot.error?.kind).toBe("permission");
  });

  test("malformed upcoming rows do not block historical summaries and recording failures remain partial", async () => {
    const meetings = service(async (args) => {
      if (args[0] === "auth") return status();
      if (args[1] === "list") return json({ meeting_info_list: [row({ start_time: "invalid" })] });
      if (args[1] === "list-ended") return json({ meeting_info_list: [row({ records: [
        { permission_status: "can_view", record_file_id: "good", state: "complete" },
        { permission_status: "can_view", record_file_id: "bad", state: "complete" },
      ] })] });
      if (args.at(-1) === "bad") throw new MeetingError("network", "Network unavailable");
      return json({ meeting_minute: { minute: "Available original" } });
    });
    const snapshot = await meetings.refresh();
    expect(snapshot.status).toBe("partial");
    expect(snapshot.summaries[0].summary).toBe("Available original");
    expect(snapshot.meetings).toHaveLength(1);
  });

  test("a repeated pagination cursor is explicitly partial", async () => {
    const meetings = service(async (args) => {
      if (args[0] === "auth") return status();
      if (args[1] === "list") return json({ meeting_info_list: [], next_page_token: "repeated" });
      return json({ meeting_info_list: [] });
    });
    expect((await meetings.refresh()).status).toBe("partial");
  });

  test("legacy continuation without a supported page token is explicitly partial", async () => {
    const meetings = service(async (args) => {
      if (args[0] === "auth") return status();
      if (args[1] === "list") return json({ meeting_info_list: [], remaining: 2, next_cursory: "opaque-legacy-cursor" });
      return json({ meeting_info_list: [] });
    });
    expect((await meetings.refresh()).status).toBe("partial");
  });

  test("coalesces refresh, preserves stale data on network errors and clears all old-account fallback", async () => {
    let account = "first", broken = false;
    let count = 0;
    const meetings = service(async (args) => {
      if (args[0] === "auth") return status(account);
      count++;
      if (broken) throw new MeetingError("network", "Network unavailable");
      if (args[1] === "list") return json({ meeting_info_list: [] });
      if (args[1] === "list-ended") return json({ meeting_info_list: [row()] });
      return json({ minutes: [{ overview: "Private old account summary" }] });
    });
    const [first, same] = await Promise.all([meetings.refresh(), meetings.refresh()]);
    expect(first).toBe(same);
    expect(count).toBe(3);
    broken = true;
    const stale = await meetings.refresh();
    expect(stale.summaries[0].summary).toBe("Private old account summary");
    account = "second";
    const switched = await meetings.refresh();
    expect(switched.meetings).toEqual([]);
    expect(switched.summaries).toEqual([]);
    expect((await meetings.status()).accountRevision).toMatch(/^[a-f0-9]{64}$/);
  });

  test("refresh binds account identity atomically instead of using an earlier status response", async () => {
    let account = "account-A";
    const meetings = service(async (args) => {
      if (args[0] === "auth") return status(account);
      if (args[1] === "list") return json({ meeting_info_list: [row({ subject: `${account} schedule` })] });
      return json({ meeting_info_list: [] });
    });
    const earlier = await meetings.status();
    account = "account-B";
    const result = await meetings.refreshWithAccount();
    expect(result.accountRevision).toBe(createHash("sha256").update("account-B").digest("hex"));
    expect(result.accountRevision).not.toBe(earlier.accountRevision);
    expect(result.snapshot.status).toBe("ready");
    expect(result.snapshot.meetings[0].subject).toBe("account-B schedule");
  });

  test("account change between CLI queries discards the mixed snapshot", async () => {
    let account = "account-A";
    let switchAccount = true;
    const meetings = service(async (args) => {
      if (args[0] === "auth") return status(account);
      if (args[1] === "list") return json({ meeting_info_list: [row({ subject: `${account} schedule` })] });
      if (args[1] === "list-ended") {
        if (switchAccount) account = "account-B";
        return json({ meeting_info_list: [row({ subject: `${account} history` })] });
      }
      return json({ minutes: [{ overview: `${account} private summary` }] });
    });
    const result = await meetings.refreshWithAccount();
    expect(result.snapshot.status).toBe("auth_required");
    expect(result.snapshot.meetings).toEqual([]);
    expect(result.snapshot.summaries).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("private summary");
    expect(result.accountRevision).toBe(createHash("sha256").update("account-B").digest("hex"));
    switchAccount = false;
    const fresh = await meetings.refreshWithAccount();
    expect(fresh.snapshot.status).toBe("ready");
    expect(fresh.snapshot.summaries[0].summary).toBe("account-B private summary");
  });

  test("failed final identity check returns no private data or unverified account binding", async () => {
    let statusCalls = 0;
    const meetings = service(async (args) => {
      if (args[0] === "auth") {
        if (++statusCalls > 1) throw new MeetingError("network", "Identity check timed out");
        return status();
      }
      if (args[1] === "list") return json({ meeting_info_list: [row()] });
      if (args[1] === "list-ended") return json({ meeting_info_list: [row()] });
      return json({ minutes: [{ overview: "Potentially mixed private data" }] });
    });
    const result = await meetings.refreshWithAccount();
    expect(result.snapshot.status).toBe("unavailable");
    expect(result.accountRevision).toBeUndefined();
    expect(result.snapshot.meetings).toEqual([]);
    expect(result.snapshot.summaries).toEqual([]);
  });

  test("reuses one login challenge, refresh is nonblocking during login, completion enables durable recovery", async () => {
    let loggedIn = false, loginCalls = 0;
    let finishLogin!: (result: CliResult) => void;
    const run: MeetingCli["run"] = async (args, signal, output) => {
      if (args[1] === "status") return loggedIn ? status() : { code: 0, stderr: "", stdout: "Not logged in." };
      if (args[1] === "login") {
        loginCalls++;
        output?.("authorize url: https://meeting.tencent.com/marketplace/tencentmeeting-cli-auth.html?code=fixture\n");
        return new Promise((resolve, reject) => {
          finishLogin = resolve;
          signal?.addEventListener("abort", () => reject(new MeetingError("network", "Cancelled")), { once: true });
        });
      }
      return json({ meeting_info_list: [] });
    };
    const path = dir(), meetings = service(run, path);
    const first = await meetings.connect();
    expect(first.status).toBe("pending");
    expect(first.authorizationUrl).toBeDefined();
    expect((await meetings.connect()).requestId).toBe(first.requestId);
    expect(loginCalls).toBe(1);
    expect((await meetings.refresh()).status).toBe("auth_required");
    loggedIn = true; finishLogin({ code: 0, stdout: "", stderr: "" });
    await Bun.sleep(20);
    expect((await meetings.status()).status).toBe("connected");
    expect(JSON.parse(readFileSync(join(path, "tmeet-schedule.json"), "utf8")).enabled).toBe(true);
    await meetings.stop();
    let renewed = 0;
    const restarted = service(async (args) => {
      if (args[0] === "auth") return status();
      renewed++; return json({ meeting_info_list: [] });
    }, path);
    restarted.recover();
    await Bun.sleep(20);
    expect(renewed).toBe(1);
  });

  test("authorization URL waits for a complete output line, including a split authorization code", async () => {
    let emit!: (chunk: string) => void;
    const meetings = service(async (args, signal, output) => {
      if (args[1] === "status") return { code: 0, stdout: "Not logged in.", stderr: "" };
      emit = output!;
      return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new MeetingError("network", "Cancelled"))));
    });
    const pending = meetings.connect();
    await Bun.sleep(1);
    emit("authorize url: https://mee");
    expect((await meetings.status()).authorizationUrl).toBeUndefined();
    emit("ting.tencent.com/marketplace/tencentmeeting-cli-auth.html?code=first");
    expect((await meetings.status()).authorizationUrl).toBeUndefined();
    emit("second\r\nwaiting for authorization...\n");
    expect((await pending).authorizationUrl).toBe("https://meeting.tencent.com/marketplace/tencentmeeting-cli-auth.html?code=firstsecond");
  });

  test("expiry recovery invokes authenticated read instead of trusting status and stops after refresh-token expiry", async () => {
    const path = dir();
    writeFileSync(join(path, "tmeet-schedule.json"), JSON.stringify({ enabled: true, nextCheckAt: 1 }));
    const calls: string[][] = [];
    const meetings = service(async (args) => {
      calls.push(args);
      if (args[0] === "auth") return status();
      throw new MeetingError("authentication", "Refresh token expired");
    }, path);
    meetings.recover();
    await Bun.sleep(20);
    expect(calls.some((args) => args[0] === "meeting")).toBe(true);
    expect(JSON.parse(readFileSync(join(path, "tmeet-schedule.json"), "utf8")).enabled).toBe(false);
  });

  test("network recovery persists a bounded retry and shutdown aborts authorization", async () => {
    const path = dir();
    writeFileSync(join(path, "tmeet-schedule.json"), JSON.stringify({ enabled: true, nextCheckAt: 1 }));
    const meetings = service(async (args) => {
      if (args[0] === "auth") return status();
      throw new MeetingError("network", "Offline");
    }, path);
    meetings.recover();
    await Bun.sleep(20);
    expect(JSON.parse(readFileSync(join(path, "tmeet-schedule.json"), "utf8")).nextCheckAt).toBe(NOW + 30_000);
    let cancelled = false;
    const login = service(async (args, signal, output) => {
      if (args[1] === "status") return { code: 0, stdout: "Not logged in.", stderr: "" };
      output?.("authorize url: https://meeting.tencent.com/marketplace/tencentmeeting-cli-auth.html?code=fixture\n");
      return new Promise((_, reject) => signal?.addEventListener("abort", () => {
        cancelled = true; reject(new MeetingError("network", "Cancelled"));
      }));
    });
    await login.connect();
    await login.stop();
    expect(cancelled).toBe(true);
    expect((await login.status()).status).toBe("error");
  });
});

test("HTTP integration requires fixed capability, exact extension Origin and loopback Host; health discloses no capability", async () => {
  let calls = 0;
  const origin = `chrome-extension://${"a".repeat(32)}`;
  const config = loadConfig({ MA_PORT: "0", MA_DATA_DIR: dir(), MA_TMEET_API_KEY: "fixture-capability", MA_TMEET_ORIGINS: origin });
  const emulator = startEmulator(config, { log: () => {}, meetingCli: { run: async () => { calls++; return status(); } } });
  emulators.push(emulator);
  const request = (headers: Record<string, string>) => fetch(`${emulator.url}/v1/integrations/tmeet/status`, { headers });
  expect((await request({ authorization: "Bearer arbitrary-key", origin })).status).toBe(401);
  expect((await request({ authorization: "Bearer fixture-capability", origin: "https://evil.example" })).status).toBe(403);
  expect((await request({ authorization: "Bearer fixture-capability", host: "evil.example" })).status).toBe(403);
  expect(calls).toBe(0);
  const response = await request({ authorization: "Bearer fixture-capability", origin });
  expect(response.status).toBe(200);
  expect(response.headers.get("access-control-allow-origin")).toBe(origin);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const health = await (await fetch(`${emulator.url}/health`)).text();
  expect(health).not.toContain("fixture-capability");
  expect(health).not.toContain("authorizationUrl");
});
