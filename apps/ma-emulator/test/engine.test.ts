/**
 * Session semantics the orchestrator relies on, exercised through the real SDK:
 * server-side durability across an emulator restart, interrupt/delete rules,
 * retries, truncated tool calls, stream-vs-list, agent versioning.
 */
import { afterEach, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { fakeModel, lastResults, reply, startHarness, text, toolUse, waitFor, type Harness } from "./helpers";

let h: Harness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
});

const NOTES = "line one\nthe secret word is pineapple\nline three\n";

async function setup(h: Harness, tools: any[] = [{ type: "agent_toolset_20260401", default_config: { enabled: false }, configs: [{ name: "read", enabled: true }, { name: "grep", enabled: true }] }]) {
  const env = await h.client.beta.environments.create({ name: `env-${Math.random()}`, config: { type: "cloud", networking: { type: "unrestricted" } } });
  const agent = await h.client.beta.agents.create({ name: "t", model: "claude-test", system: "be brief", tools } as any);
  const session = await h.client.beta.sessions.create({ agent: agent.id, environment_id: env.id });
  const file = await h.client.beta.files.upload({ file: new File([NOTES], "notes.txt", { type: "text/plain" }) });
  const res = await h.client.beta.sessions.resources.add(session.id, { type: "file", file_id: file.id, mount_path: "/notes/notes.txt" });
  return { env, agent, session, file, mountPath: res.mount_path };
}

const say = (h: Harness, id: string, t: string) =>
  h.client.beta.sessions.events.send(id, { events: [{ type: "user.message", content: [{ type: "text", text: t }] }] });

async function events(h: Harness, id: string) {
  const out: Anthropic.Beta.Sessions.BetaManagedAgentsSessionEvent[] = [];
  for await (const e of h.client.beta.sessions.events.list(id)) out.push(e);
  return out;
}

const idleWith = (h: Harness, id: string, reason: string) =>
  waitFor(async () => {
    const evs = await events(h, id);
    const last = [...evs].reverse().find((e) => e.type.startsWith("session.status_"));
    return last?.type === "session.status_idle" && (last as any).stop_reason.type === reason ? evs : null;
  }, `idle:${reason}`);

/** A model turn that hangs until the request is aborted. */
const hang = () => (_p: unknown, signal?: AbortSignal) =>
  new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));

test("mounts are re-rooted under /mnt/session/uploads and built-in tools run server-side", async () => {
  const model = fakeModel([
    () => reply([toolUse("grep", { pattern: "secret" })]),
    (p) => {
      expect(lastResults(p)[0].text).toContain("/mnt/session/uploads/notes/notes.txt:2:the secret word is pineapple");
      return reply([text("pineapple")]);
    },
  ]);
  h = startHarness(model);
  const { session, mountPath } = await setup(h);
  expect(mountPath).toBe("/mnt/session/uploads/notes/notes.txt");
  await say(h, session.id, "what is the secret?");
  const evs = await idleWith(h, session.id, "end_turn");
  expect(evs.map((e) => e.type)).toEqual([
    "user.message",
    "session.status_running",
    "span.model_request_start",
    "span.model_request_end",
    "agent.tool_use",
    "agent.tool_result",
    "span.model_request_start",
    "span.model_request_end",
    "agent.message",
    "session.status_idle",
  ]);
  const toolUseEv = evs.find((e) => e.type === "agent.tool_use")!;
  expect((evs.find((e) => e.type === "agent.tool_result") as any).tool_use_id).toBe(toolUseEv.id);
  const s = await h.client.beta.sessions.retrieve(session.id);
  expect(s.status).toBe("idle");
  expect(s.usage.input_tokens).toBe(200);
});

test("the session outlives the emulator: a restart mid-turn resumes from the event log", async () => {
  const first = fakeModel([() => reply([toolUse("read", { file_path: "/mnt/session/uploads/notes/notes.txt" })]), hang()]);
  h = startHarness(first);
  const { session } = await setup(h);
  await say(h, session.id, "read my notes");
  await waitFor(() => first.requests.length === 2, "second model request");

  // Kill the emulator while the second model call is in flight.
  const second = fakeModel([
    (p) => {
      // The whole conversation was rebuilt from the log: question, tool call, tool result.
      expect(p.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
      expect(lastResults(p)[0].text).toContain("pineapple");
      return reply([text("Your notes mention pineapple.")]);
    },
  ]);
  await h.restart(second);

  // No key on disk, so the recovered session waits for a client to show up
  // (checked in-process: any HTTP request would itself supply the key).
  expect(h.emu.engine.getSession(session.id).status).toBe("rescheduling");
  expect(second.requests).toHaveLength(0);
  const evs = await idleWith(h, session.id, "end_turn"); // listing events supplies the key → resumes
  expect(evs.some((e) => e.type === "session.status_rescheduled")).toBe(true);
  expect(second.remaining()).toBe(0);
  expect(evs.filter((e) => e.type === "agent.tool_result")).toHaveLength(1); // the read was not re-run
});

test("with a fixed upstream key, a recovered session resumes without any client", async () => {
  const first = fakeModel([hang()]);
  h = startHarness(first, { upstreamApiKey: "sk-fixed" });
  const { session } = await setup(h);
  await say(h, session.id, "hello");
  await waitFor(() => first.requests.length === 1, "first model request");
  const second = fakeModel([() => reply([text("hi")])]);
  await h.restart(second);
  await waitFor(() => second.remaining() === 0, "resumed model call");
  expect(second.keysSeen).toEqual(["sk-fixed"]);
});

test("a running session can't be deleted; interrupt it, then delete removes everything", async () => {
  const model = fakeModel([hang()]);
  h = startHarness(model);
  const { session, file } = await setup(h);
  await say(h, session.id, "hello");
  await waitFor(() => model.requests.length === 1, "model request");

  const refused = await h.client.beta.sessions.delete(session.id).catch((e) => e);
  expect(refused.status).toBe(409);

  await h.client.beta.sessions.events.send(session.id, { events: [{ type: "user.interrupt" }] });
  await idleWith(h, session.id, "end_turn");
  expect((await h.client.beta.sessions.delete(session.id)).type).toBe("session_deleted");
  expect((await h.client.beta.sessions.retrieve(session.id).catch((e) => e)).status).toBe(404);
  // Uploads belong to the Files API and survive the session (the orchestrator deletes its own).
  expect((await h.client.beta.files.retrieveMetadata(file.id)).id).toBe(file.id);
});

test("custom tools park the session in requires_action until every call is answered", async () => {
  const model = fakeModel([
    () => reply([toolUse("ask", { q: "a" }), toolUse("ask", { q: "b" })]),
    (p) => {
      expect(lastResults(p).map((r) => r.text)).toEqual(["A", "B"]);
      return reply([text("thanks")]);
    },
  ]);
  h = startHarness(model);
  const { session } = await setup(h, [{ type: "custom", name: "ask", description: "ask", input_schema: { type: "object", properties: {} } }]);
  await say(h, session.id, "go");
  const evs = await idleWith(h, session.id, "requires_action");
  const calls = evs.filter((e) => e.type === "agent.custom_tool_use");
  const idle = evs.at(-1) as any;
  expect(idle.stop_reason.event_ids).toEqual(calls.map((c) => c.id));

  const send = (id: string, t: string) =>
    h!.client.beta.sessions.events.send(session.id, {
      events: [{ type: "user.custom_tool_result", custom_tool_use_id: id, content: [{ type: "text", text: t }] }],
    });
  await send(calls[0].id, "A");
  expect((await h.client.beta.sessions.retrieve(session.id)).status).toBe("idle"); // still waiting on b
  expect((await send("sevt_bogus", "x").catch((e) => e)).status).toBe(400);
  await send(calls[1].id, "B");
  await idleWith(h, session.id, "end_turn");
});

test("transient upstream failures are retried as session.error + rescheduled; fatal ones end the turn", async () => {
  const overloaded = () => {
    throw Object.assign(new Error("overloaded"), { status: 529 });
  };
  const model = fakeModel([overloaded, overloaded, () => reply([text("ok")])]);
  h = startHarness(model);
  const { session } = await setup(h);
  await say(h, session.id, "hi");
  const evs = await idleWith(h, session.id, "end_turn");
  const errors = evs.filter((e) => e.type === "session.error") as any[];
  expect(errors.map((e) => [e.error.type, e.error.retry_status.type])).toEqual([
    ["model_overloaded_error", "retrying"],
    ["model_overloaded_error", "retrying"],
  ]);
  expect(evs.filter((e) => e.type === "session.status_rescheduled")).toHaveLength(2);

  const bad = fakeModel([
    () => {
      throw Object.assign(new Error("bad request"), { status: 400 });
    },
  ]);
  await h.restart(bad);
  await say(h, session.id, "again");
  const after = await idleWith(h, session.id, "retries_exhausted");
  expect((after.filter((e) => e.type === "session.error").at(-1) as any).error.retry_status.type).toBe("terminal");
});

test("a tool call truncated by max_tokens is discarded, never executed", async () => {
  const model = fakeModel([
    () => reply([text("writing"), toolUse("write", { file_path: "/mnt/session/outputs/x.tsx", content: "half" })], "max_tokens"),
    (p) => {
      const last = p.messages.at(-1)!.content as any[];
      expect(last.at(-1).text).toContain("output limit");
      return reply([text("ok, smaller")]);
    },
  ]);
  h = startHarness(model, {});
  const { session } = await setup(h, [{ type: "agent_toolset_20260401", default_config: { enabled: true }, configs: [] }]);
  await say(h, session.id, "write it");
  const evs = await idleWith(h, session.id, "end_turn");
  expect(evs.some((e) => e.type === "agent.tool_use")).toBe(false);
  const outputs = [];
  for await (const f of h.client.beta.files.list({ scope_id: session.id })) outputs.push(f);
  expect(outputs).toEqual([]);
});

test("the stream only carries live events; list pages through history", async () => {
  const model = fakeModel([() => reply([text("one")]), () => reply([text("two")])]);
  h = startHarness(model);
  const { session } = await setup(h);
  await say(h, session.id, "first");
  await idleWith(h, session.id, "end_turn");

  const stream = await h.client.beta.sessions.events.stream(session.id);
  await say(h, session.id, "second");
  const live: string[] = [];
  for await (const e of stream) {
    live.push(e.type);
    if (e.type === "session.status_idle") break;
  }
  expect(live[0]).toBe("user.message"); // nothing from the first turn
  expect(live).toContain("agent.message");

  const all = [];
  for await (const e of h.client.beta.sessions.events.list(session.id, { limit: 3 })) all.push(e.id);
  expect(new Set(all).size).toBe(all.length);
  expect(all.length).toBeGreaterThan(10);
});

test("agents are versioned: stale updates conflict, sessions pin the version they started with", async () => {
  h = startHarness(fakeModel([]));
  const { agent, env } = await setup(h);
  const v2 = await h.client.beta.agents.update(agent.id, { version: 1, system: "v2" });
  expect(v2.version).toBe(2);
  expect((await h.client.beta.agents.update(agent.id, { version: 1, system: "x" }).catch((e) => e)).status).toBe(409);
  const pinned = await h.client.beta.sessions.create({ agent: { type: "agent", id: agent.id, version: 1 }, environment_id: env.id });
  expect(pinned.agent.version).toBe(1);
  expect(pinned.agent.system).toBe("be brief");
  const latest = await h.client.beta.sessions.create({ agent: agent.id, environment_id: env.id });
  expect(latest.agent.system).toBe("v2");
});
