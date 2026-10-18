/**
 * Stalled upstreams and failover: a gateway that accepts the request and then
 * goes quiet is abandoned by the watchdog, and the call moves to the next
 * upstream — with that upstream's own key and model names.
 */
import { afterEach, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { UpstreamPool, mapModel, parseModelMap, type UpstreamSpec } from "../src/upstreams";
import { fakeModel, reply, startHarness, text, waitFor, type Harness, type Turn } from "./helpers";

let h: Harness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
});

const TWO: UpstreamSpec[] = [
  { name: "primary", baseUrl: "http://primary.invalid", modelMap: {} },
  {
    name: "fallback-2",
    baseUrl: "http://backup.invalid",
    apiKey: "sk-backup",
    modelMap: { "claude-test": "glm-test", "*": "default-test" },
  },
];

/** A model call that never sends anything until it's aborted. */
const silent: Turn = (_p, signal) =>
  new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));

async function run(h: Harness, model = "claude-test") {
  const env = await h.client.beta.environments.create({ name: `env-${Math.random()}`, config: { type: "cloud", networking: { type: "unrestricted" } } });
  const agent = await h.client.beta.agents.create({ name: "t", model, system: "s", tools: [] } as any);
  const session = await h.client.beta.sessions.create({ agent: agent.id, environment_id: env.id });
  await h.client.beta.sessions.events.send(session.id, { events: [{ type: "user.message", content: [{ type: "text", text: "hi" }] }] });
  return session.id;
}

async function idle(h: Harness, id: string) {
  return waitFor(async () => {
    const evs: any[] = [];
    for await (const e of h.client.beta.sessions.events.list(id)) evs.push(e);
    return evs.at(-1)?.type === "session.status_idle" ? evs : null;
  }, "idle");
}

test("a stalled call is abandoned and retried; a flowing one is not", async () => {
  // Flowing: events keep arriving, so a reply slower than the stall timeout still lands.
  const flowing: Turn = async (_p, _s, emit) => {
    for (let i = 0; i < 6; i++) {
      emit!();
      await new Promise((r) => setTimeout(r, 40));
    }
    return reply([text("slow but fine")]);
  };
  const model = fakeModel([silent, flowing]);
  h = startHarness(model, { stallTimeoutMs: 100 });
  const evs = await idle(h, await run(h));

  const errors = evs.filter((e) => e.type === "session.error");
  expect(errors).toHaveLength(1);
  expect(errors[0].error.message).toContain("no data from the upstream");
  expect(errors[0].error.retry_status.type).toBe("retrying");
  expect(evs.some((e) => e.type === "agent.message" && e.content[0].text === "slow but fine")).toBe(true);
});

test("failover: the next upstream gets its own key and mapped model, without a backoff", async () => {
  const model = fakeModel([silent, () => reply([text("from backup")])]);
  h = startHarness(model, { upstreams: TWO, stallTimeoutMs: 100, retryBaseDelayMs: 60_000 });
  const evs = await idle(h, await run(h));

  expect(model.upstreamsSeen).toEqual(["primary", "fallback-2"]);
  expect(model.keysSeen).toEqual(["sk-test-key", "sk-backup"]);
  expect(model.requests.map((r) => r.model)).toEqual(["claude-test", "glm-test"]);
  expect(evs.find((e) => e.type === "session.error").error.message).toStartWith("[primary]");
  expect(evs.at(-1).stop_reason.type).toBe("end_turn");
});

test("a failed upstream cools down: the next session goes straight to the fallback", async () => {
  const overloaded: Turn = () => {
    throw Object.assign(new Error("overloaded"), { status: 503 });
  };
  const model = fakeModel([overloaded, () => reply([text("one")]), () => reply([text("two")])]);
  h = startHarness(model, { upstreams: TWO });
  await idle(h, await run(h));
  await idle(h, await run(h, "claude-other"));
  expect(model.upstreamsSeen).toEqual(["primary", "fallback-2", "fallback-2"]);
  expect(model.requests[2].model).toBe("default-test"); // `*` catches models not listed
});

test("a non-retryable error on one gateway still moves on to an untried one", async () => {
  const notFound: Turn = () => {
    throw Object.assign(new Error("model_not_found"), { status: 404 });
  };
  const model = fakeModel([notFound, () => reply([text("ok")])]);
  h = startHarness(model, { upstreams: TWO });
  const evs = await idle(h, await run(h));
  expect(model.upstreamsSeen).toEqual(["primary", "fallback-2"]);
  expect(evs.at(-1).stop_reason.type).toBe("end_turn");
});

test("x-ma-upstream: a manual choice leads, switches mid-session, and 'auto' restores the order", async () => {
  const model = fakeModel([
    () => reply([text("one")]),
    () => reply([text("two")]),
    () => reply([text("three")]),
  ]);
  h = startHarness(model, { upstreams: TWO });
  const pinned = (name: string) => ({ headers: { "x-ma-upstream": name } });
  const env = await h.client.beta.environments.create({ name: "e", config: { type: "cloud", networking: { type: "unrestricted" } } });
  const agent = await h.client.beta.agents.create({ name: "t", model: "claude-test", system: "s", tools: [] } as any);
  const session = await h.client.beta.sessions.create({ agent: agent.id, environment_id: env.id }, pinned("fallback-2"));
  const say = async (t: string, opts?: object) => {
    await h!.client.beta.sessions.events.send(session.id, { events: [{ type: "user.message", content: [{ type: "text", text: t }] }] }, opts);
    await idle(h!, session.id);
  };
  await say("a"); // the choice made at creation sticks without the header
  await say("b", pinned("auto"));
  await say("c", pinned("no-such-upstream")); // unknown names are ignored (stays auto)
  expect(model.upstreamsSeen).toEqual(["fallback-2", "primary", "primary"]);
  expect(model.requests[0].model).toBe("glm-test");
});

test("switching upstream mid-call drops the hanging attempt at once, without an error", async () => {
  const model = fakeModel([silent, () => reply([text("from backup")])]);
  h = startHarness(model, { upstreams: TWO }); // stall timeout 60s: only the switch can rescue this
  const id = await run(h);
  await waitFor(() => model.upstreamsSeen.length === 1, "primary call in flight");
  await h.client.beta.sessions.retrieve(id, {}, { headers: { "x-ma-upstream": "fallback-2" } });
  const evs = await idle(h, id);
  expect(model.upstreamsSeen).toEqual(["primary", "fallback-2"]);
  expect(evs.filter((e) => e.type === "session.error")).toEqual([]);
  expect(evs.at(-1).stop_reason.type).toBe("end_turn");
});

test("a fallback without a fixed key uses the key the client sends for it, and only that one", async () => {
  const keyless = TWO.map(({ apiKey: _, ...u }) => u);
  const model = fakeModel([silent, () => reply([text("from backup")]), () => reply([text("primary only")])]);
  h = startHarness(model, { upstreams: keyless, stallTimeoutMs: 100 });
  const env = await h.client.beta.environments.create({ name: "e", config: { type: "cloud", networking: { type: "unrestricted" } } });
  const agent = await h.client.beta.agents.create({ name: "t", model: "claude-test", system: "s", tools: [] } as any);
  const withKey = { headers: { "x-ma-key-fallback-2": "sk-client-backup" } };
  const session = await h.client.beta.sessions.create({ agent: agent.id, environment_id: env.id }, withKey);
  const say = async (t: string, opts?: object) => {
    await h!.client.beta.sessions.events.send(session.id, { events: [{ type: "user.message", content: [{ type: "text", text: t }] }] }, opts);
    return idle(h!, session.id);
  };
  await say("a", withKey);
  expect(model.upstreamsSeen).toEqual(["primary", "fallback-2"]);
  expect(model.keysSeen).toEqual(["sk-test-key", "sk-client-backup"]);

  // An empty header forgets the key: the fallback drops out, even though the
  // primary is still cooling down from its stall.
  await say("b", { headers: { "x-ma-key-fallback-2": "" } });
  expect(model.upstreamsSeen.at(-1)).toBe("primary");
  expect(model.keysSeen.at(-1)).toBe("sk-test-key");
});

test("pool ordering, cooldown expiry and keyless upstreams", () => {
  let now = 0;
  const pool = new UpstreamPool(TWO, (spec) => spec.name as any, 1000, () => now);
  const names = (key?: string) => pool.candidates("claude-test", key ? { primary: key } : {}).map((t) => t.name);
  expect(names("k")).toEqual(["primary", "fallback-2"]);
  expect(names(undefined)).toEqual(["fallback-2"]); // primary forwards the client's key; none here
  pool.markFailed("primary");
  expect(names("k")).toEqual(["fallback-2", "primary"]); // cooling, but still last resort
  expect(pool.candidates("claude-test", { primary: "k" }, "primary").map((t) => t.name)).toEqual(["primary", "fallback-2"]); // pinned beats cooldown
  now = 1001;
  expect(names("k")).toEqual(["primary", "fallback-2"]);
});

test("config: numbered fallbacks with model maps", () => {
  const c = loadConfig({
    MA_UPSTREAM_BASE_URL: "https://a.example/v1/",
    MA_UPSTREAM_2_BASE_URL: "https://b.example",
    MA_UPSTREAM_2_API_KEY: "sk-b",
    MA_UPSTREAM_2_MODEL_MAP: "claude-sonnet-5-5=glm-5.3-flash, claude-opus-5-5=kimi-k3",
    MA_UPSTREAM_4_BASE_URL: "https://ignored.example", // after a gap
  });
  expect(c.upstreams.map((u) => [u.name, u.baseUrl, u.apiKey])).toEqual([
    ["primary", "https://a.example", undefined],
    ["fallback-2", "https://b.example", "sk-b"],
  ]);
  expect(c.upstreams[1].modelMap).toEqual({ "claude-sonnet-5-5": "glm-5.3-flash", "claude-opus-5-5": "kimi-k3" });
  // No key: the client supplies it per request (x-ma-key-fallback-2).
  expect(loadConfig({ MA_UPSTREAM_2_BASE_URL: "https://b.example" }).upstreams[1].apiKey).toBeUndefined();
  expect(mapModel(parseModelMap("a=b"), "z")).toBe("z");
});
