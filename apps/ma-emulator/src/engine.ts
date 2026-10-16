import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { EmulatorConfig } from "./config";
import type { FileService } from "./files";
import type { AgentDoc, Registry } from "./registry";
import { OUTPUT_ROOT, Sandbox, UPLOAD_ROOT } from "./sandbox";
import type { NewEvent, StoredEvent, Store } from "./store";
import { ALL_TOOLSET_NAMES, BUILTIN_TOOL_DEFS, SUPPORTED_BUILTINS, runBuiltinTool, type BuiltinToolName } from "./toolset";
import { ApiError, badRequest, conflict, newId, notFound, nowIso, sleep } from "./util";

/**
 * Sessions: the durable, server-side agent loop.
 *
 * The design rule is that the event log is the only state. `derive()` replays a
 * session's log into (a) the exact message list to send the model next and (b)
 * what the session is waiting on. `drive()` just asks "what's next?" in a loop
 * and appends events. So nothing is lost if:
 *   - the client disconnects — the loop doesn't need it, except to answer
 *     custom tool calls, which wait in the log until someone does;
 *   - the emulator itself is killed — on restart, sessions that were running are
 *     re-derived from the log and pick up where they stopped.
 *
 * The model is called through any `/v1/messages` upstream (Anthropic or a
 * compatible gateway); the built-in file tools run here, against the session's
 * sandbox; custom tools are handed to the client via `requires_action`.
 */

type SessionStatus = "idle" | "running" | "rescheduling" | "terminated";

export interface SessionDoc {
  id: string;
  type: "session";
  agent: Omit<AgentDoc, "created_at" | "updated_at" | "archived_at" | "metadata">;
  environment_id: string;
  title: string | null;
  metadata: Record<string, string>;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  vault_ids: string[];
  outcome_evaluations: unknown[];
  stats: { active_seconds: number; duration_seconds?: number };
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number };
  };
  /** When the current running stretch began (private). */
  _running_since?: string | null;
}

export interface ResourceDoc {
  id: string;
  type: "file";
  file_id: string;
  mount_path: string;
  created_at: string;
  updated_at: string;
}

interface ToolUseRef {
  eventId: string;
  modelId: string;
  name: string;
  input: Record<string, any>;
  custom: boolean;
}

/** Everything `drive()` needs to know, re-derived from the event log. */
export interface Derived {
  messages: Anthropic.MessageParam[];
  outstandingBuiltin: ToolUseRef[];
  outstandingCustom: ToolUseRef[];
  /** New user input or a complete set of tool results the model hasn't seen yet. */
  needsModel: boolean;
  turnsSinceUserMessage: number;
  /** A user.interrupt that hasn't been acknowledged with an idle yet. */
  interruptPending: boolean;
  lastStatus: Record<string, any> | null;
}

export interface StreamListener {
  onEvent(event: Record<string, any>): void;
  onClose(): void;
}

export type UpstreamFactory = (apiKey: string) => Anthropic;

interface Runner {
  driving: boolean;
  again: boolean;
  abort: AbortController | null;
}

const STATUS_EVENTS: Record<string, SessionStatus> = {
  "session.status_running": "running",
  "session.status_idle": "idle",
  "session.status_rescheduled": "rescheduling",
  "session.status_terminated": "terminated",
};

const event = (type: string, fields: Record<string, unknown> = {}) => ({
  id: newId("sevt"),
  type,
  processed_at: nowIso(),
  ...fields,
});

export class SessionEngine {
  private readonly listeners = new Map<string, Set<StreamListener>>();
  /** Upstream keys, in memory only. Never written to disk. */
  private readonly keys = new Map<string, string>();
  private readonly runners = new Map<string, Runner>();
  private stopping = false;

  constructor(
    private readonly store: Store,
    private readonly registry: Registry,
    private readonly files: FileService,
    private readonly config: EmulatorConfig,
    private readonly upstream: UpstreamFactory,
    private readonly log: (line: string) => void = (l) => console.log(l),
  ) {}

  // ---------------------------------------------------------------------------
  // sessions
  // ---------------------------------------------------------------------------

  createSession(body: any, apiKey?: string): SessionDoc {
    const agentRef = body?.agent;
    let agent: AgentDoc;
    if (typeof agentRef === "string") agent = this.registry.getAgent(agentRef);
    else if (agentRef && typeof agentRef === "object" && typeof agentRef.id === "string") {
      agent = this.registry.getAgent(agentRef.id, agentRef.version);
    } else {
      throw badRequest("agent must be an agent ID or {type: 'agent', id, version}");
    }
    if (agent.archived_at) throw badRequest(`Agent ${agent.id} is archived`);

    if (!body?.environment_id) throw badRequest("environment_id is required");
    const env = this.registry.getEnvironment(body.environment_id);
    if (env.archived_at) throw badRequest(`Environment ${env.id} is archived`);

    const now = nowIso();
    const { created_at: _c, updated_at: _u, archived_at: _a, metadata: _m, ...pinned } = agent;
    const doc: SessionDoc = {
      id: newId("sesn"),
      type: "session",
      agent: pinned,
      environment_id: env.id,
      title: body.title ?? null,
      metadata: body.metadata ?? {},
      status: "idle",
      created_at: now,
      updated_at: now,
      archived_at: null,
      vault_ids: body.vault_ids ?? [],
      outcome_evaluations: [],
      stats: { active_seconds: 0 },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      },
      _running_since: null,
    };
    this.store.put("sessions", doc);
    mkdirSync(this.sandbox(doc.id).root, { recursive: true });
    if (apiKey) this.keys.set(doc.id, apiKey);

    for (const resource of body.resources ?? []) this.addResource(doc.id, resource);
    this.log(`[session ${doc.id}] created (agent ${agent.id} v${agent.version})`);
    return doc;
  }

  getSession(id: string): SessionDoc {
    const doc = this.store.get<SessionDoc>("sessions", id);
    if (!doc) throw notFound("Session", id);
    return doc;
  }

  view(doc: SessionDoc) {
    const { _running_since, ...pub } = doc;
    const runningFor = _running_since ? (Date.now() - Date.parse(_running_since)) / 1000 : 0;
    return {
      ...pub,
      resources: this.listResources(doc.id),
      stats: {
        active_seconds: Math.round((doc.stats.active_seconds + runningFor) * 10) / 10,
        duration_seconds: Math.round((Date.now() - Date.parse(doc.created_at)) / 100) / 10,
      },
    };
  }

  listSessions(): SessionDoc[] {
    return this.store.list<SessionDoc>("sessions").reverse();
  }

  updateSession(id: string, body: any): SessionDoc {
    const doc = this.getSession(id);
    const next = {
      ...doc,
      title: body?.title !== undefined ? body.title : doc.title,
      metadata: body?.metadata ?? doc.metadata,
      updated_at: nowIso(),
    };
    return this.store.put("sessions", next);
  }

  archiveSession(id: string): SessionDoc {
    const doc = this.getSession(id);
    if (doc.status === "running") throw conflict("cannot archive a session while it is running");
    return this.store.put("sessions", { ...doc, archived_at: nowIso(), updated_at: nowIso() });
  }

  /**
   * Deletes the session, its event log, its sandbox and its output files.
   * Uploaded files it mounted are *not* deleted — they belong to the Files API,
   * which is why a well-behaved client deletes its own uploads.
   */
  deleteSession(id: string) {
    const doc = this.getSession(id);
    const runner = this.runners.get(id);
    if (doc.status === "running" || runner?.driving) {
      throw conflict(`cannot delete session ${id} while it is running; interrupt it first`);
    }
    for (const l of this.listeners.get(id) ?? []) {
      l.onEvent(event("session.deleted"));
      l.onClose();
    }
    this.listeners.delete(id);
    this.store.deleteEvents(id);
    this.store.deleteByParent("resources", id);
    this.files.deleteScope(id);
    this.sandbox(id).destroy();
    this.store.delete("sessions", id);
    this.keys.delete(id);
    this.runners.delete(id);
    this.log(`[session ${id}] deleted`);
    return { id, type: "session_deleted" };
  }

  // ---------------------------------------------------------------------------
  // resources (files mounted into the sandbox)
  // ---------------------------------------------------------------------------

  addResource(sessionId: string, body: any): ResourceDoc {
    this.getSession(sessionId);
    if (body?.type !== "file") throw badRequest("only file resources are supported");
    const file = this.files.get(String(body.file_id ?? ""));
    // Every mount is re-rooted under /mnt/session/uploads.
    let mountPath = Sandbox.normalize(body.mount_path ?? `${UPLOAD_ROOT}/${file.id}`);
    if (!mountPath.startsWith(UPLOAD_ROOT + "/")) mountPath = UPLOAD_ROOT + mountPath;
    this.sandbox(sessionId).writeFile(mountPath, this.files.bytes(file.id));

    const now = nowIso();
    const doc: ResourceDoc = {
      id: newId("sesrsc"),
      type: "file",
      file_id: file.id,
      mount_path: mountPath,
      created_at: now,
      updated_at: now,
    };
    return this.store.put("resources", doc, sessionId);
  }

  listResources(sessionId: string): ResourceDoc[] {
    return this.store.list<ResourceDoc>("resources", sessionId);
  }

  getResource(sessionId: string, id: string): ResourceDoc {
    const doc = this.store.get<ResourceDoc>("resources", id);
    if (!doc || !this.listResources(sessionId).some((r) => r.id === id)) throw notFound("Resource", id);
    return doc;
  }

  deleteResource(sessionId: string, id: string) {
    const doc = this.getResource(sessionId, id);
    this.sandbox(sessionId).removePath(doc.mount_path);
    this.store.delete("resources", id);
    return { id, type: "session_resource_deleted" };
  }

  // ---------------------------------------------------------------------------
  // events
  // ---------------------------------------------------------------------------

  listEvents(sessionId: string, opts: { limit?: number; page?: string; order?: "asc" | "desc" }) {
    this.getSession(sessionId);
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    const afterSeq = opts.page ? Number(opts.page) : undefined;
    const rows = this.store.listEvents(sessionId, { afterSeq, limit: limit + 1, order: opts.order });
    const page = rows.slice(0, limit);
    return {
      data: page.map((r) => r.body),
      next_page: rows.length > limit ? String(page[page.length - 1].seq) : null,
    };
  }

  /** Live events only — the stream has no replay. Pair it with `listEvents` for history. */
  subscribe(sessionId: string, listener: StreamListener): () => void {
    this.getSession(sessionId);
    let set = this.listeners.get(sessionId);
    if (!set) this.listeners.set(sessionId, (set = new Set()));
    set.add(listener);
    return () => set!.delete(listener);
  }

  sendEvents(sessionId: string, events: any[], apiKey?: string) {
    const session = this.getSession(sessionId);
    if (apiKey) this.keys.set(sessionId, apiKey);
    if (session.status === "terminated") throw badRequest(`Session ${sessionId} is terminated`);
    if (session.archived_at) throw badRequest(`Session ${sessionId} is archived`);
    if (!Array.isArray(events) || events.length === 0) throw badRequest("events must be a non-empty array");

    const derived = this.derive(sessionId);
    const awaiting = new Map(derived.outstandingCustom.map((t) => [t.eventId, t]));
    const batch: NewEvent[] = [];
    let interrupt = false;

    for (const e of events) {
      switch (e?.type) {
        case "user.message":
          if (!Array.isArray(e.content) || e.content.length === 0) {
            throw badRequest("user.message needs non-empty content");
          }
          batch.push({ body: event("user.message", { content: e.content }) });
          break;
        case "user.custom_tool_result": {
          const ref = awaiting.get(e.custom_tool_use_id);
          if (!ref) {
            throw badRequest(`${e.custom_tool_use_id} is not a custom tool call awaiting a result`);
          }
          awaiting.delete(e.custom_tool_use_id);
          batch.push({
            body: event("user.custom_tool_result", {
              custom_tool_use_id: e.custom_tool_use_id,
              content: e.content ?? [],
              is_error: e.is_error ?? false,
            }),
          });
          break;
        }
        case "user.interrupt":
          interrupt = true;
          batch.push({ body: event("user.interrupt") });
          break;
        default:
          throw badRequest(`unsupported event type: ${String(e?.type)}`);
      }
    }

    const stored = this.append(sessionId, batch);
    if (interrupt) this.runners.get(sessionId)?.abort?.abort(new Error("interrupted"));
    this.kick(sessionId);
    return { data: stored.map((s) => s.body) };
  }

  /** Any authenticated request on a session refreshes its key; a session stalled for want of one resumes. */
  rememberKey(sessionId: string, apiKey: string | undefined) {
    if (!apiKey || !this.store.get<SessionDoc>("sessions", sessionId)) return;
    this.keys.set(sessionId, apiKey);
    if (this.getSession(sessionId).status === "rescheduling" && !this.runners.get(sessionId)?.driving) {
      this.log(`[session ${sessionId}] key supplied, resuming`);
      this.kick(sessionId);
    }
  }

  /** On startup: sessions that were mid-run when the emulator died carry on from their logs. */
  recover() {
    for (const s of this.store.list<SessionDoc>("sessions")) {
      if (s.status !== "running" && s.status !== "rescheduling") continue;
      this.log(`[session ${s.id}] was ${s.status} at shutdown — recovering from the event log`);
      // The running stretch ended when the process died; don't count the downtime.
      this.store.put("sessions", { ...s, _running_since: null });
      this.append(s.id, [{ body: event("session.status_rescheduled") }]);
      this.kick(s.id);
    }
  }

  /** Wait until no session is being driven (tests and graceful shutdown). */
  async quiesce(timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while ([...this.runners.values()].some((r) => r.driving) && Date.now() < deadline) await sleep(20);
  }

  /** Stop driving (shutdown). Sessions keep their `running` status, so the next start recovers them. */
  abortAll() {
    this.stopping = true;
    for (const r of this.runners.values()) r.abort?.abort(new Error("shutting down"));
  }

  // ---------------------------------------------------------------------------
  // the loop
  // ---------------------------------------------------------------------------

  private append(sessionId: string, events: NewEvent[]): StoredEvent[] {
    if (events.length === 0) return [];
    const stored = this.store.appendEvents(sessionId, events);

    // Keep the session document's status in step with its status events.
    const status = [...stored].reverse().find((e) => STATUS_EVENTS[e.type]);
    if (status) {
      const doc = this.getSession(sessionId);
      const next = STATUS_EVENTS[status.type];
      let active = doc.stats.active_seconds;
      let since = doc._running_since ?? null;
      if (next === "running" && !since) since = nowIso();
      if (next !== "running" && since) {
        active += (Date.now() - Date.parse(since)) / 1000;
        since = null;
      }
      this.store.put("sessions", {
        ...doc,
        status: next,
        updated_at: nowIso(),
        stats: { ...doc.stats, active_seconds: active },
        _running_since: since,
      });
    }

    for (const e of stored) for (const l of this.listeners.get(sessionId) ?? []) l.onEvent(e.body);
    return stored;
  }

  private kick(sessionId: string) {
    if (this.stopping) return;
    let runner = this.runners.get(sessionId);
    if (!runner) this.runners.set(sessionId, (runner = { driving: false, again: false, abort: null }));
    if (runner.driving) {
      runner.again = true;
      return;
    }
    runner.driving = true;
    const r = runner;
    void (async () => {
      try {
        do {
          r.again = false;
          await this.drive(sessionId, r);
        } while (r.again);
      } catch (err) {
        this.log(`[session ${sessionId}] runner crashed: ${err instanceof Error ? err.stack : String(err)}`);
        if (this.store.get("sessions", sessionId)) {
          this.append(sessionId, [
            { body: event("session.error", { error: { type: "unknown_error", message: String(err), retry_status: { type: "terminal" } } }) },
            { body: event("session.status_idle", { stop_reason: { type: "retries_exhausted" } }) },
          ]);
        }
      } finally {
        r.driving = false;
      }
    })();
  }

  private setIdle(sessionId: string, stopReason: Record<string, unknown>) {
    this.append(sessionId, [{ body: event("session.status_idle", { stop_reason: stopReason }) }]);
    this.log(`[session ${sessionId}] idle: ${stopReason.type}`);
  }

  private async drive(sessionId: string, runner: Runner): Promise<void> {
    for (;;) {
      if (this.stopping) return;
      const session = this.store.get<SessionDoc>("sessions", sessionId);
      if (!session) return; // deleted underneath us

      const d = this.derive(sessionId);

      if (d.interruptPending) {
        this.setIdle(sessionId, { type: "end_turn" });
        return;
      }

      const hasWork = d.outstandingBuiltin.length > 0 || d.needsModel;
      if (!hasWork) {
        if (d.outstandingCustom.length > 0) {
          const ids = d.outstandingCustom.map((t) => t.eventId);
          const last = d.lastStatus;
          const alreadyAnnounced =
            session.status === "idle" &&
            last?.type === "session.status_idle" &&
            last.stop_reason?.type === "requires_action" &&
            JSON.stringify(last.stop_reason.event_ids) === JSON.stringify(ids);
          if (!alreadyAnnounced) this.setIdle(sessionId, { type: "requires_action", event_ids: ids });
        } else if (session.status !== "idle") {
          this.setIdle(sessionId, { type: "end_turn" });
        }
        return;
      }

      const apiKey = this.config.upstreamApiKey ?? this.keys.get(sessionId);
      if (!apiKey) {
        if (session.status !== "rescheduling") {
          this.append(sessionId, [{ body: event("session.status_rescheduled") }]);
        }
        this.log(`[session ${sessionId}] has work but no upstream key; waiting for a client request`);
        return;
      }
      if (session.status !== "running") this.append(sessionId, [{ body: event("session.status_running") }]);

      if (d.outstandingBuiltin.length > 0) {
        for (const ref of d.outstandingBuiltin) this.runBuiltin(sessionId, ref);
        continue;
      }

      if (d.turnsSinceUserMessage >= this.config.maxTurns) {
        this.append(sessionId, [
          {
            body: event("session.error", {
              error: {
                type: "unknown_error",
                message: `stopped after ${this.config.maxTurns} model turns without finishing`,
                retry_status: { type: "terminal" },
              },
            }),
          },
        ]);
        this.setIdle(sessionId, { type: "retries_exhausted" });
        return;
      }

      const outcome = await this.callModel(sessionId, session, d, apiKey, runner);
      if (outcome === "stop") return;
    }
  }

  private runBuiltin(sessionId: string, ref: ToolUseRef) {
    const sandbox = this.sandbox(sessionId);
    const out = runBuiltinTool(sandbox, ref.name, ref.input);
    for (const vpath of out.written ?? []) {
      if (vpath.startsWith(OUTPUT_ROOT + "/")) this.files.captureOutput(sessionId, vpath, sandbox.readFile(vpath));
    }
    this.append(sessionId, [
      {
        body: event("agent.tool_result", {
          tool_use_id: ref.eventId,
          content: [{ type: "text", text: out.text }],
          is_error: out.isError,
        }),
        internal: { tool_use_id: ref.modelId },
      },
    ]);
    this.log(`[session ${sessionId}] ${ref.name} ${out.isError ? "failed" : "ok"}: ${summarize(ref.input)}`);
  }

  private async callModel(
    sessionId: string,
    session: SessionDoc,
    d: Derived,
    apiKey: string,
    runner: Runner,
  ): Promise<"continue" | "stop"> {
    const agent = session.agent;
    const tools = this.toolsFor(agent, sessionId);
    const customNames = new Set(agent.tools.filter((t) => t.type === "custom").map((t) => t.name as string));
    const params: Anthropic.MessageStreamParams = {
      model: agent.model.id,
      max_tokens: this.config.maxTokens,
      messages: withCacheBreakpoint(d.messages),
      ...(agent.system
        ? { system: [{ type: "text", text: agent.system, cache_control: { type: "ephemeral" } }] }
        : {}),
      ...(tools.length ? { tools } : {}),
    };

    const controller = new AbortController();
    runner.abort = controller;
    const client = this.upstream(apiKey);
    try {
      for (let attempt = 0; ; attempt++) {
        const start = event("span.model_request_start");
        this.append(sessionId, [{ body: start }]);
        try {
          const msg = await client.messages.stream(params, { signal: controller.signal }).finalMessage();
          this.recordResponse(sessionId, start.id, msg, customNames);
          return "continue";
        } catch (err) {
          if (this.stopping) return "stop";
          const endError = event("span.model_request_end", {
            is_error: true,
            model_request_start_id: start.id,
            model_usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          });
          this.append(sessionId, [{ body: endError }]);
          if (controller.signal.aborted) return "continue"; // interrupt: drive() re-derives and goes idle

          const status = (err as any)?.status as number | undefined;
          const retryable = status === undefined || status === 408 || status === 409 || status === 429 || status >= 500;
          const message = err instanceof Error ? err.message : String(err);
          const errorType =
            status === 429 ? "model_rate_limited_error" : status === 529 ? "model_overloaded_error" : "model_request_failed_error";
          this.log(`[session ${sessionId}] model request failed (${status ?? "network"}): ${message.slice(0, 300)}`);

          if (retryable && attempt < this.config.maxRetries) {
            this.append(sessionId, [
              { body: event("session.error", { error: { type: errorType, message, retry_status: { type: "retrying" } } }) },
              { body: event("session.status_rescheduled") },
            ]);
            try {
              await sleep(this.config.retryBaseDelayMs * 2 ** attempt, controller.signal);
            } catch {
              return this.stopping ? "stop" : "continue";
            }
            this.append(sessionId, [{ body: event("session.status_running") }]);
            continue;
          }

          this.append(sessionId, [
            {
              body: event("session.error", {
                error: { type: errorType, message, retry_status: { type: retryable ? "exhausted" : "terminal" } },
              }),
            },
          ]);
          this.setIdle(sessionId, { type: "retries_exhausted" });
          return "stop";
        }
      }
    } finally {
      runner.abort = null;
    }
  }

  /** One model response → one atomic batch: the span end (carrying the raw content) plus its public events. */
  private recordResponse(sessionId: string, startId: string, msg: Anthropic.Message, customNames: Set<string>) {
    let content = msg.content as Anthropic.ContentBlock[];
    let continuation: string | undefined;

    // A response cut off at max_tokens mid tool call has a truncated input. Never
    // execute it (a half-written homepage would be "delivered"); drop it and ask
    // the model to retry smaller.
    const last = content[content.length - 1];
    if (msg.stop_reason === "max_tokens" && last?.type === "tool_use") {
      content = content.slice(0, -1);
      continuation =
        `Your previous response hit the ${this.config.maxTokens}-token output limit while writing a ` +
        `${last.name} call, so that call was discarded. Retry it more compactly.`;
      if (content.length === 0) content = [{ type: "text", text: "(response truncated)", citations: null }];
    }

    const usage = msg.usage;
    const batch: NewEvent[] = [
      {
        body: event("span.model_request_end", {
          is_error: false,
          model_request_start_id: startId,
          model_usage: {
            input_tokens: usage.input_tokens ?? 0,
            output_tokens: usage.output_tokens ?? 0,
            cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
            cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
          },
        }),
        internal: { content, stop_reason: msg.stop_reason, continuation },
      },
    ];

    for (const block of content) {
      if (block.type === "thinking" || block.type === "redacted_thinking") {
        batch.push({ body: event("agent.thinking") });
      } else if (block.type === "text") {
        if (block.text) batch.push({ body: event("agent.message", { content: [{ type: "text", text: block.text }] }) });
      } else if (block.type === "tool_use") {
        const custom = customNames.has(block.name);
        batch.push({
          body: custom
            ? event("agent.custom_tool_use", { name: block.name, input: block.input })
            : event("agent.tool_use", { name: block.name, input: block.input, evaluated_permission: "allow" }),
          internal: { tool_use_id: block.id },
        });
      }
    }
    this.append(sessionId, batch);

    const doc = this.getSession(sessionId);
    this.store.put("sessions", {
      ...doc,
      usage: {
        input_tokens: doc.usage.input_tokens + (usage.input_tokens ?? 0),
        output_tokens: doc.usage.output_tokens + (usage.output_tokens ?? 0),
        cache_read_input_tokens: doc.usage.cache_read_input_tokens + (usage.cache_read_input_tokens ?? 0),
        cache_creation: {
          ...doc.usage.cache_creation,
          ephemeral_5m_input_tokens:
            doc.usage.cache_creation.ephemeral_5m_input_tokens + (usage.cache_creation_input_tokens ?? 0),
        },
      },
    });
    this.log(
      `[session ${sessionId}] model: stop=${msg.stop_reason} in=${usage.input_tokens} ` +
        `cache_read=${usage.cache_read_input_tokens ?? 0} out=${usage.output_tokens} ` +
        `blocks=${content.map((b) => (b.type === "tool_use" ? `tool_use(${b.name})` : b.type)).join(",")}`,
    );
  }

  private readonly warned = new Set<string>();

  private toolsFor(agent: SessionDoc["agent"], sessionId: string): Anthropic.Tool[] {
    const tools: Anthropic.Tool[] = [];
    for (const t of agent.tools) {
      if (t.type === "agent_toolset_20260401") {
        for (const name of ALL_TOOLSET_NAMES) {
          const cfg = t.configs.find((c: any) => c.name === name);
          if (!(cfg?.enabled ?? t.default_config.enabled)) continue;
          if (SUPPORTED_BUILTINS.includes(name as BuiltinToolName)) {
            tools.push(BUILTIN_TOOL_DEFS[name as BuiltinToolName]);
          } else if (!this.warned.has(`${sessionId}:${name}`)) {
            this.warned.add(`${sessionId}:${name}`);
            this.log(`[session ${sessionId}] built-in tool "${name}" is enabled but not emulated; not offered`);
          }
        }
      } else if (t.type === "custom") {
        tools.push({ name: t.name, description: t.description, input_schema: t.input_schema });
      }
    }
    return tools;
  }

  // ---------------------------------------------------------------------------
  // derivation: event log → conversation + what we're waiting on
  // ---------------------------------------------------------------------------

  derive(sessionId: string): Derived {
    const messages: Anthropic.MessageParam[] = [];
    let pending: Anthropic.ContentBlockParam[] = [];
    const byEventId = new Map<string, ToolUseRef>();
    let outstanding = new Map<string, ToolUseRef>();
    let needsModel = false;
    let turns = 0;
    let interruptPending = false;
    let lastStatus: Record<string, any> | null = null;

    const flush = () => {
      if (pending.length === 0) return;
      // tool_result blocks must lead the user turn.
      const results = pending.filter((b) => b.type === "tool_result");
      const rest = pending.filter((b) => b.type !== "tool_result");
      messages.push({ role: "user", content: [...results, ...rest] });
      pending = [];
    };
    const answer = (ref: ToolUseRef | undefined, content: any[], isError: boolean) => {
      if (!ref || !outstanding.has(ref.modelId)) return;
      pending.push({ type: "tool_result", tool_use_id: ref.modelId, content, is_error: isError });
      outstanding.delete(ref.modelId);
      if (outstanding.size === 0) needsModel = true;
    };

    for (const { type, body, internal } of this.store.listEvents(sessionId)) {
      switch (type) {
        case "user.message":
          pending.push(...(body.content as Anthropic.ContentBlockParam[]));
          needsModel = true;
          turns = 0;
          break;
        case "span.model_request_end":
          if (body.is_error || !internal?.content) break;
          flush();
          messages.push({ role: "assistant", content: internal.content });
          outstanding = new Map();
          needsModel = false;
          turns++;
          if (internal.continuation) {
            pending.push({ type: "text", text: internal.continuation });
            needsModel = true;
          }
          break;
        case "agent.tool_use":
        case "agent.custom_tool_use": {
          const ref: ToolUseRef = {
            eventId: body.id,
            modelId: internal?.tool_use_id,
            name: body.name,
            input: body.input,
            custom: type === "agent.custom_tool_use",
          };
          byEventId.set(ref.eventId, ref);
          outstanding.set(ref.modelId, ref);
          // A turn that ends in tool calls is complete only once they're all answered.
          needsModel = false;
          break;
        }
        case "agent.tool_result":
          answer(byEventId.get(body.tool_use_id), body.content ?? [], Boolean(body.is_error));
          break;
        case "user.custom_tool_result":
          answer(byEventId.get(body.custom_tool_use_id), body.content ?? [], Boolean(body.is_error));
          break;
        case "user.interrupt":
          // Every tool call still open gets a synthetic error result, so the
          // conversation stays valid for whatever the user says next.
          for (const ref of outstanding.values()) {
            pending.push({
              type: "tool_result",
              tool_use_id: ref.modelId,
              content: [{ type: "text", text: "Interrupted by the user before this tool call completed." }],
              is_error: true,
            });
          }
          outstanding = new Map();
          needsModel = false;
          interruptPending = true;
          break;
        default:
          if (STATUS_EVENTS[type]) {
            lastStatus = body;
            if (type === "session.status_idle") interruptPending = false;
          }
      }
    }
    flush();

    const open = [...outstanding.values()];
    return {
      messages,
      outstandingBuiltin: open.filter((t) => !t.custom),
      outstandingCustom: open.filter((t) => t.custom),
      needsModel: needsModel && open.length === 0,
      turnsSinceUserMessage: turns,
      interruptPending,
      lastStatus,
    };
  }

  sandbox(sessionId: string): Sandbox {
    return new Sandbox(join(this.store.dataDir, "sandboxes", sessionId));
  }
}

/** Mark the newest message as a prompt-cache breakpoint so each turn re-reads the prefix from cache. */
function withCacheBreakpoint(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;
  const out = messages.slice();
  const last = out[out.length - 1];
  const blocks: any[] = typeof last.content === "string" ? [{ type: "text", text: last.content }] : [...last.content];
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].type !== "thinking" && blocks[i].type !== "redacted_thinking") {
      blocks[i] = { ...blocks[i], cache_control: { type: "ephemeral" } };
      break;
    }
  }
  out[out.length - 1] = { ...last, content: blocks };
  return out;
}

function summarize(input: Record<string, any>): string {
  const s = JSON.stringify(input, (k, v) => (k === "content" && typeof v === "string" ? `<${v.length} chars>` : v));
  return s.length > 160 ? s.slice(0, 160) + "…" : s;
}

export { ApiError };
