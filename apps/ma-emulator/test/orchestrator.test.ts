/**
 * Acceptance: the ORIGINAL, unmodified `@homepage/agent-core` orchestrator —
 * written against the real Managed Agents API — runs end to end against the
 * emulator. Only the model is faked; everything between the SDK and the model
 * (HTTP, SSE, event log, sandbox, files, resources, cleanup) is the real thing.
 */
import { afterEach, expect, test } from "bun:test";
import {
  HOMEPAGE_SYSTEM_PROMPT,
  OUTPUT_PATH,
  STORAGE_KEYS,
  buildHistoryDigest,
  buildKickoffMessage,
  ensureAgent,
  ensureEnvironment,
  runHomepageBuild,
  type RunPhase,
} from "@homepage/agent-core";
import {
  fakeBridge,
  fakeModel,
  lastResults,
  memoryStore,
  reply,
  startHarness,
  text,
  toolUse,
  type Harness,
  type Turn,
} from "./helpers";

const HOMEPAGE = "export default function PersonalizedHomepage() { return <div>Story number 3</div>; }";
const MEETING_HOMEPAGE = `import React from 'react';
import { useMeetingData } from '@homepage/meetings';
export default function PersonalizedHomepage() {
  const { snapshot, refresh, connect } = useMeetingData();
  return <section style={{ color: 'black' }}><button onClick={refresh}>Refresh</button><button onClick={connect}>Connect</button>{snapshot?.meetings.map(m => <p key={m.id}>{m.subject}</p>)}</section>;
}`;

let h: Harness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
});

/** A plausible build: history → scrape → glob+grep → read → write → done. Asserts what the model sees at each step. */
function buildScript(seen: { mountPath?: string; grepLine?: number }): Turn[] {
  return [
    () => reply([text("Checking your history."), toolUse("getHistory", { daysToAnalyze: 7, maxResults: 10 })]),
    (p) => {
      const [r] = lastResults(p);
      expect(r.name).toBe("getHistory");
      expect(r.text).toContain("news.ycombinator.com");
      return reply([toolUse("getPageHtml", { urls: ["https://news.ycombinator.com/"] })]);
    },
    (p) => {
      const [r] = lastResults(p);
      expect(r.isError).toBe(false);
      const result = JSON.parse(r.text);
      seen.mountPath = result.pages[0].mountPath as string;
      expect(seen.mountPath).toStartWith("/mnt/session/uploads/pages/");
      // Two built-in tools in one turn: both run server-side before the next model call.
      return reply([
        toolUse("glob", { pattern: "**/*.html" }),
        toolUse("grep", { pattern: "Story number 3\\b", path: seen.mountPath }),
      ]);
    },
    (p) => {
      const [glob, grep] = lastResults(p);
      expect(glob.text).toContain(seen.mountPath!);
      const m = grep.text.match(/:(\d+):.*Story number 3</);
      expect(m).not.toBeNull();
      seen.grepLine = Number(m![1]);
      return reply([toolUse("read", { file_path: seen.mountPath, offset: seen.grepLine, limit: 1 })]);
    },
    (p) => {
      const [read] = lastResults(p);
      expect(read.text).toContain("Story number 3<");
      return reply([toolUse("write", { file_path: OUTPUT_PATH, content: HOMEPAGE })]);
    },
    (p) => {
      expect(lastResults(p)[0].isError).toBe(false);
      return reply([text("Done — your homepage is written.")]);
    },
  ];
}

test("the original orchestrator completes a build against the emulator and leaves nothing behind", async () => {
  const seen: { mountPath?: string } = {};
  const model = fakeModel(buildScript(seen));
  h = startHarness(model);
  const store = memoryStore();
  const bridge = fakeBridge();
  const phases: RunPhase[] = [];
  let narration = "";

  const result = await runHomepageBuild({
    client: h.client,
    bridge,
    store,
    callbacks: { onPhase: (p) => phases.push(p), onText: (t) => (narration += t) },
  });

  expect(result.code).toBe(HOMEPAGE);
  expect(result.source).toBe("session-output");
  expect(model.remaining()).toBe(0);
  expect(bridge.scraped).toEqual([["https://news.ycombinator.com/"]]);
  expect(narration).toContain("Done — your homepage is written.");
  for (const p of ["setup", "session-create", "history", "scraping", "analyzing", "writing", "done", "cleanup"]) {
    expect(phases).toContain(p as RunPhase);
  }

  // What reached the model: the agent's system prompt, the enabled toolset (no bash), custom tools, cache breakpoints.
  const first = model.requests[0] as any;
  expect(first.system[0].text).toBe(HOMEPAGE_SYSTEM_PROMPT);
  expect(first.system[0].cache_control).toEqual({ type: "ephemeral" });
  expect(first.tools.map((t: any) => t.name).sort()).toEqual(["getHistory", "getPageHtml", "glob", "grep", "read", "requestMeetingAuthorization", "write"]);
  const lastMsg = model.requests.at(-1)!.messages.at(-1)! as any;
  expect(lastMsg.content.at(-1).cache_control).toEqual({ type: "ephemeral" });

  // Privacy cleanup, as agent:retention checks it: session gone, no page bodies left in the Files API.
  const err = await h.client.beta.sessions.retrieve(result.sessionId).catch((e) => e);
  expect(err.status).toBe(404);
  const files = [];
  for await (const f of h.client.beta.files.list()) files.push(f);
  expect(files).toEqual([]);
  expect(await store.get(STORAGE_KEYS.activeSessionId)).toBeUndefined();
  expect(await store.get(STORAGE_KEYS.uploadedFileIds)).toBeUndefined();
});

test("meeting connection returns pending without exposing trusted host secrets or retaining the build session", async () => {
  const page = MEETING_HOMEPAGE;
  const model = fakeModel([
    (request) => {
      expect(JSON.stringify(request.messages)).toContain("Use a compact monochrome layout");
      return reply([toolUse("requestMeetingAuthorization", {})]);
    },
    (request) => {
      expect(lastResults(request)).toEqual([{ name: "requestMeetingAuthorization", text: '{"status":"pending"}', isError: false }]);
      return reply([toolUse("write", { file_path: OUTPUT_PATH, content: page })]);
    },
    () => reply([text("Done.")]),
  ]);
  h = startHarness(model);
  const store = memoryStore();
  let calls = 0;
  const result = await runHomepageBuild({
    client: h.client,
    store,
    userSystemPrompt: "Use a compact monochrome layout",
    bridge: {
      ...fakeBridge(),
      requestMeetingAuthorization: async () => {
        calls++;
        return { status: "pending", authorizationUrl: "https://secret.example/authorize", token: "private-token" };
      },
    },
  });
  expect(calls).toBe(1);
  expect(result.code).toBe(page);
  expect(result.meetingRuntimeVersion).toBe(1);
  expect(JSON.stringify(model.requests)).not.toContain("secret.example");
  expect(JSON.stringify(model.requests)).not.toContain("private-token");
  expect((await h.client.beta.sessions.retrieve(result.sessionId).catch((error) => error)).status).toBe(404);
  expect(await store.get(STORAGE_KEYS.activeSessionId)).toBeUndefined();
  expect(await store.get(STORAGE_KEYS.uploadedFileIds)).toBeUndefined();
});

test("meeting tools reject arbitrary arguments and unsupported bridges still finish generation", async () => {
  const bridge = fakeBridge();
  const model = fakeModel([
    () => reply([toolUse("requestMeetingAuthorization", { url: "https://untrusted.example" })]),
    (request) => {
      expect(lastResults(request)[0].isError).toBe(true);
      expect(lastResults(request)[0].text).not.toContain("untrusted.example");
      return reply([toolUse("requestMeetingAuthorization", {})]);
    },
    (request) => {
      expect(lastResults(request)[0].text).toBe('{"status":"unavailable"}');
      return reply([toolUse("write", { file_path: OUTPUT_PATH, content: HOMEPAGE })]);
    },
    () => reply([text("Done.")]),
  ]);
  h = startHarness(model);
  const result = await runHomepageBuild({ client: h.client, store: memoryStore(), bridge });
  expect(result.code).toBe(HOMEPAGE);
  expect(result.meetingRuntimeVersion).toBeUndefined();
  expect(model.remaining()).toBe(0);
});

test("meeting connection failures cannot leak host exception text into model requests or logs", async () => {
  const model = fakeModel([
    () => reply([toolUse("requestMeetingAuthorization", {})]),
    (request) => {
      expect(lastResults(request)[0].text).toBe('{"status":"error"}');
      return reply([toolUse("write", { file_path: OUTPUT_PATH, content: MEETING_HOMEPAGE })]);
    },
    () => reply([text("Done.")]),
  ]);
  h = startHarness(model);
  const logs: string[] = [];
  await runHomepageBuild({
    client: h.client,
    store: memoryStore(),
    callbacks: { onLog: (line) => logs.push(line) },
    bridge: {
      ...fakeBridge(),
      requestMeetingAuthorization: async () => { throw new Error("private-token"); },
    },
  });
  expect(JSON.stringify(model.requests)).not.toContain("private-token");
  expect(JSON.stringify(logs)).not.toContain("private-token");
});

test("a capable host rejects a static meeting replacement and still cleans up the session", async () => {
  const model = fakeModel([
    () => reply([toolUse("write", { file_path: OUTPUT_PATH, content: HOMEPAGE })]),
    () => reply([text("Done.")]),
  ]);
  h = startHarness(model);
  const store = memoryStore();
  await expect(runHomepageBuild({
    client: h.client,
    store,
    bridge: { ...fakeBridge(), requestMeetingAuthorization: async () => ({ status: "pending" }) },
  })).rejects.toThrow("missing the required @homepage/meetings");
  expect(await store.get(STORAGE_KEYS.activeSessionId)).toBeUndefined();
  expect((await h.client.beta.sessions.list()).data).toEqual([]);
});

test("agents and environments are created once and reused", async () => {
  h = startHarness(fakeModel([]));
  const store = memoryStore();
  const [a1, e1] = await Promise.all([ensureAgent(h.client, store), ensureEnvironment(h.client, store)]);
  const [a2, e2] = await Promise.all([ensureAgent(h.client, store), ensureEnvironment(h.client, store)]);
  expect(a2).toBe(a1);
  expect(e2).toBe(e1);
  expect((await h.client.beta.agents.retrieve(a1)).version).toBe(1);

  // A fresh store (e.g. another profile) adopts the environment by name instead of creating a duplicate.
  expect(await ensureEnvironment(h.client, memoryStore())).toBe(e1);

  // A stale fingerprint updates the agent in place (new version, same id).
  const key = [...store.data.keys()].find((k) => k.startsWith("agentId-"))!;
  const agent = await h.client.beta.agents.retrieve(a1);
  await h.client.beta.agents.update(a1, { version: agent.version, metadata: { config: "stale" } });
  expect(await ensureAgent(h.client, store)).toBe(a1);
  expect((await h.client.beta.agents.retrieve(a1)).version).toBe(3);
  expect(store.data.get(key)).toBe(a1);
});

test("a client that dies mid tool call reattaches losslessly (the agent:resume-test scenario)", async () => {
  const seen: { mountPath?: string } = {};
  const model = fakeModel(buildScript(seen));
  h = startHarness(model);
  const store = memoryStore();
  const bridge = fakeBridge();

  // ---- crash phase: drive the session by hand, answer getHistory, then vanish on getPageHtml.
  const [agentId, environmentId] = await Promise.all([ensureAgent(h.client, store), ensureEnvironment(h.client, store)]);
  const session = await h.client.beta.sessions.create({ agent: agentId, environment_id: environmentId, title: "resume-test" });
  await store.set(STORAGE_KEYS.activeSessionId, session.id);
  const controller = new AbortController();
  const stream = await h.client.beta.sessions.events.stream(session.id, undefined, { signal: controller.signal });
  await h.client.beta.sessions.events.send(session.id, {
    events: [{ type: "user.message", content: [{ type: "text", text: buildKickoffMessage({ now: new Date() }) }] }],
  });
  let orphan: string | undefined;
  for await (const event of stream) {
    if (event.type !== "agent.custom_tool_use") continue;
    if (event.name === "getHistory") {
      const { sites, totalSitesSeen } = await bridge.getHistory({ daysToAnalyze: 7, maxResults: 10 });
      const digest = buildHistoryDigest(sites, { daysToAnalyze: 7, maxResults: 10, totalSitesSeen });
      await h.client.beta.sessions.events.send(session.id, {
        events: [{ type: "user.custom_tool_result", custom_tool_use_id: event.id, content: [{ type: "text", text: JSON.stringify(digest) }] }],
      });
    } else if (event.name === "getPageHtml") {
      orphan = event.id;
      controller.abort(); // the tab closed
      break;
    }
  }
  expect(orphan).toBeDefined();

  // The session survives the client: idle, waiting on exactly that call.
  const before = await h.client.beta.sessions.retrieve(session.id);
  expect(before.status).toBe("idle");

  // ---- resume phase
  const logs: string[] = [];
  const result = await runHomepageBuild({
    client: h.client,
    bridge,
    store,
    resumeSessionId: session.id,
    callbacks: { onLog: (l) => logs.push(l) },
  });
  expect(logs.some((l) => l.includes(`re-answering orphaned tool call ${orphan}`))).toBe(true);
  expect(result.sessionId).toBe(session.id);
  expect(result.code).toBe(HOMEPAGE);
  expect(model.remaining()).toBe(0);
  expect((await h.client.beta.sessions.retrieve(session.id).catch((e) => e)).status).toBe(404);
});
