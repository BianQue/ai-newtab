import type Anthropic from "@anthropic-ai/sdk";
import { buildHistoryDigest, slugifyUrl } from "./history-digest";
import { HOMEPAGE_SYSTEM_PROMPT, OUTPUT_PATH, buildKickoffMessage } from "./prompt";
import { DEFAULT_BLOCKED_SITES, isAllowedUrl, isBlocked, normalizeBlockList } from "./site-filter";
import { DEFAULTS } from "./schemas";
import { DEFAULT_MODEL, HOMEPAGE_TOOLS, STORAGE_KEYS, type HomepageModel } from "./setup";
import { OUTPUT_ROOT, UPLOAD_ROOT, WORKSPACE_TOOL_NAMES, Workspace } from "./workspace";
import type {
  BrowserBridge,
  GetHistoryResult,
  GetPageHtmlResult,
  HomepageBuildResult,
  KVStore,
  PageRef,
  RunCallbacks,
  RunPhase,
} from "./types";

type MessageParam = Anthropic.MessageParam;
type ToolUse = Anthropic.ToolUseBlock;
type ToolResult = Anthropic.ToolResultBlockParam;

/** Callbacks with the optionality resolved, so call sites don't repeat `?.`. */
interface Emit {
  phase(phase: RunPhase, detail?: string): void;
  text(chunk: string): void;
  log(line: string): void;
}

/** Model calls per build. A normal build takes 10–25; past this something is looping. */
const MAX_TURNS = 60;
/** Room for the component itself, which arrives as one `write` tool input. */
const MAX_TOKENS = 32_000;

/** Everything needed to pick a build back up after the host was killed mid-run. */
interface Checkpoint {
  runId: string;
  model: HomepageModel;
  messages: MessageParam[];
  files: Record<string, string>;
}

export interface RunOptions {
  client: Anthropic;
  bridge: BrowserBridge;
  store: KVStore;
  userSystemPrompt?: string;
  /**
   * Hosts the tools must never read. A getter is re-read before every tool call,
   * so a list saved mid-build applies to the rest of that build.
   */
  blockedSites?: string[] | (() => Promise<string[]>);
  /** Ignored when resuming: the build keeps the model it started with. */
  model?: HomepageModel;
  callbacks?: RunCallbacks;
  signal?: AbortSignal;
  /** Continue a checkpointed build instead of starting one (e.g. after the host was killed mid-run). */
  resumeSessionId?: string;
  now?: Date;
}

export async function runHomepageBuild(opts: RunOptions): Promise<HomepageBuildResult> {
  const { client, bridge, store, callbacks, signal } = opts;
  const emit: Emit = {
    phase: (p, d) => callbacks?.onPhase?.(p, d),
    text: (t) => callbacks?.onText?.(t),
    log: (l) => callbacks?.onLog?.(l),
  };

  emit.phase("setup");
  let checkpoint: Checkpoint | undefined;
  if (opts.resumeSessionId) {
    const saved = await store.get<Checkpoint>(STORAGE_KEYS.buildCheckpoint);
    if (saved?.runId === opts.resumeSessionId) checkpoint = saved;
    else emit.log(`no checkpoint for ${opts.resumeSessionId}; starting a fresh build`);
  }
  if (!checkpoint) emit.phase("session-create");

  const runId = checkpoint?.runId ?? `build_${Date.now().toString(36)}`;
  const model = checkpoint?.model ?? opts.model ?? DEFAULT_MODEL;
  const workspace = new Workspace(checkpoint?.files);
  const messages: MessageParam[] = checkpoint?.messages ?? [
    {
      role: "user",
      content: buildKickoffMessage({ now: opts.now ?? new Date(), userSystemPrompt: opts.userSystemPrompt }),
    },
  ];
  await store.set(STORAGE_KEYS.activeSessionId, runId);
  emit.log(`build=${runId} model=${model}${checkpoint ? ` resumed at ${messages.length} messages` : ""}`);
  const tail = messages[messages.length - 1]!;
  if (checkpoint && tail.role === "assistant" && typeof tail.content !== "string") {
    const pending = tail.content.filter((b) => b.type === "tool_use").length;
    if (pending) emit.log(`re-answering ${pending} orphaned tool call(s)`);
  }

  const saveCheckpoint = async () => {
    const next: Checkpoint = { runId, model, messages, files: workspace.snapshot() };
    try {
      await store.set(STORAGE_KEYS.buildCheckpoint, next);
    } catch (err) {
      // Most likely the storage quota. The build carries on; it just can't be resumed.
      emit.log(`checkpoint not saved: ${String(err)}`);
    }
  };

  /** Every tool_use must get a tool_result, or the next request is rejected. Errors are results too. */
  const dispatch = async (use: ToolUse): Promise<ToolResult> => {
    try {
      const blockedSites = normalizeBlockList(
        (typeof opts.blockedSites === "function" ? await opts.blockedSites() : opts.blockedSites) ?? DEFAULT_BLOCKED_SITES,
      );
      let text: string;
      if (use.name === "getHistory") {
        text = JSON.stringify(await runGetHistory(use, bridge, emit, blockedSites));
      } else if (use.name === "getPageHtml") {
        text = JSON.stringify(await runGetPageHtml(use, { bridge, workspace, emit, blockedSites }));
      } else if ((WORKSPACE_TOOL_NAMES as readonly string[]).includes(use.name)) {
        emit.phase("analyzing", use.name);
        emit.log(`workspace:${use.name} ${describeInput(use.input)}`);
        text = workspace.run(use.name, use.input as Record<string, unknown>);
      } else {
        throw new Error(`Unknown tool: ${use.name}`);
      }
      return { type: "tool_result", tool_use_id: use.id, content: [{ type: "text", text }] };
    } catch (err) {
      emit.log(`tool ${use.name} failed: ${String(err)}`);
      return { type: "tool_result", tool_use_id: use.id, is_error: true, content: [{ type: "text", text: String(err) }] };
    }
  };

  let finalMessage = "";
  // Replay narration from a checkpoint, so a reattached view isn't blank.
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.type === "text") {
        finalMessage += block.text;
        emit.text(block.text);
      }
    }
  }

  try {
    for (let turn = 0; ; ) {
      if (signal?.aborted) throw new Error("aborted");

      // Answer the last assistant turn's tool calls. After a resume this also
      // covers calls that were made but never answered before the host died.
      const last = messages[messages.length - 1]!;
      if (last.role === "assistant") {
        const uses = typeof last.content === "string" ? [] : last.content.filter((b): b is ToolUse => b.type === "tool_use");
        if (uses.length === 0) break; // end of turn: the model is done.
        const results: ToolResult[] = [];
        for (const use of uses) results.push(await dispatch(use));
        messages.push({ role: "user", content: results });
        await saveCheckpoint();
        continue;
      }

      if (++turn > MAX_TURNS) throw new Error(`Gave up after ${MAX_TURNS} model turns without a finished homepage.`);
      emit.phase("thinking");
      const stream = client.messages.stream(
        {
          model,
          max_tokens: MAX_TOKENS,
          system: [{ type: "text", text: HOMEPAGE_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          tools: HOMEPAGE_TOOLS,
          messages: withCacheBreakpoint(messages),
        },
        { signal },
      );
      stream.on("text", (chunk) => {
        finalMessage += chunk;
        emit.text(chunk);
      });
      const reply = await stream.finalMessage();
      messages.push({ role: "assistant", content: reply.content });
      await saveCheckpoint();

      if (reply.stop_reason === "max_tokens" && reply.content.some((b) => b.type === "tool_use")) {
        throw new Error(`The model ran out of output tokens (${MAX_TOKENS}) in the middle of a tool call.`);
      }
    }

    emit.phase("writing");
    const code = collectDeliverable(workspace, finalMessage, emit);
    emit.phase("done");
    return { code: code.code, sessionId: runId, source: code.source };
  } finally {
    // Privacy: the checkpoint holds every domain, title and page body the model
    // saw. It exists only to survive a host kill; any other exit drops it.
    emit.phase("cleanup");
    await store.remove(STORAGE_KEYS.buildCheckpoint);
    await store.remove(STORAGE_KEYS.activeSessionId);
  }
}

/**
 * Cache the conversation up to its newest message. The system prompt + tools
 * carry a breakpoint of their own; old message breakpoints are dropped so the
 * request never exceeds the four-breakpoint limit.
 */
function withCacheBreakpoint(messages: MessageParam[]): MessageParam[] {
  const last = messages[messages.length - 1]!;
  const blocks: Anthropic.ContentBlockParam[] =
    typeof last.content === "string" ? [{ type: "text", text: last.content }] : [...last.content];
  const tail = blocks[blocks.length - 1];
  if (tail && tail.type !== "thinking" && tail.type !== "redacted_thinking") {
    blocks[blocks.length - 1] = { ...tail, cache_control: { type: "ephemeral" } };
  }
  return [...messages.slice(0, -1), { ...last, content: blocks }];
}

function describeInput(input: unknown): string {
  const { content, ...rest } = (input ?? {}) as Record<string, unknown>;
  const shown = JSON.stringify(rest);
  return typeof content === "string" ? `${shown} (+${content.length} chars)` : shown;
}

// ---------------------------------------------------------------------------
// tool implementations
// ---------------------------------------------------------------------------

async function runGetHistory(
  use: ToolUse,
  bridge: BrowserBridge,
  emit: Emit,
  blockedSites: string[],
): Promise<GetHistoryResult> {
  const input = use.input as { daysToAnalyze?: number; maxResults?: number };
  const daysToAnalyze = input.daysToAnalyze ?? DEFAULTS.daysToAnalyze;
  const maxResults = input.maxResults ?? DEFAULTS.maxResults;

  emit.phase("history", `${daysToAnalyze}d`);
  const { sites, totalSitesSeen } = await bridge.getHistory({ daysToAnalyze, maxResults });
  const allowed = sites.filter((site) => !isBlocked(site.domain, blockedSites));
  // Blocked domains are dropped from the count too: the model is never told they exist.
  const digest = buildHistoryDigest(allowed, {
    daysToAnalyze,
    maxResults,
    totalSitesSeen: totalSitesSeen - (sites.length - allowed.length),
  });
  emit.log(`history: ${digest.sites.length} of ${digest.totalSitesSeen} domains`);
  return digest;
}

async function runGetPageHtml(
  use: ToolUse,
  ctx: {
    bridge: BrowserBridge;
    workspace: Workspace;
    emit: Emit;
    blockedSites: string[];
  },
): Promise<GetPageHtmlResult> {
  const input = use.input as { urls: string[]; loadDelayMs?: number };
  ctx.emit.phase("scraping", `${input.urls.length} pages`);

  const allowed: string[] = [];
  const blocked: GetPageHtmlResult["failed"] = [];
  for (const url of input.urls) {
    // Match on the URL the browser will load; malformed URLs never reach the signed-in browser.
    if (isAllowedUrl(url, ctx.blockedSites)) allowed.push(url);
    else blocked.push({ url, reason: "blocked by the user's settings" });
  }

  // Skip the bridge entirely when nothing is left, so no scraper window opens.
  const { pages: loaded, failed } = allowed.length
    ? await ctx.bridge.getPageHtml({
        urls: allowed,
        loadDelayMs: input.loadDelayMs ?? DEFAULTS.loadDelayMs,
      })
    : { pages: [], failed: [] };

  // A redirect can land on a blocked host; drop what it read before anything is stored.
  const pages = loaded.filter((page) => {
    if (!page.finalUrl || isAllowedUrl(page.finalUrl, ctx.blockedSites)) return true;
    blocked.push({ url: page.url, reason: "blocked by the user's settings" });
    return false;
  });
  if (blocked.length) ctx.emit.log(`blocked: ${blocked.length} url(s)`);

  const refs: PageRef[] = [];
  for (const page of pages) {
    // Sanitized HTML is often minified onto a handful of lines; one tag per line
    // makes grep hits and read ranges meaningful.
    const html = page.html.replace(/>\s*</g, ">\n<");
    const filename = `${slugifyUrl(page.url)}_${refs.length}.html`;
    const mountPath = ctx.workspace.put(`${UPLOAD_ROOT}/pages/${filename}`, html);
    refs.push({ url: page.url, title: page.title, mountPath, bytes: html.length });
    ctx.emit.log(`stored ${page.url} -> ${mountPath} (${html.length}b)`);
  }

  const failures = [...blocked, ...failed];
  if (refs.length === 0 && failures.length > 0 && blocked.length === 0) {
    throw new Error(
      `No pages could be loaded. Failures: ${failures.map((f) => `${f.url} (${f.reason})`).join("; ")}`,
    );
  }

  return { pages: refs, failed: failures };
}

// ---------------------------------------------------------------------------
// deliverable retrieval
// ---------------------------------------------------------------------------

const CODE_FENCE = /```(?:tsx|jsx|ts|js|typescript|javascript)?\s*\n([\s\S]*?)```/;

/** Strip a ```tsx fence, if the model wrapped the file contents in one. */
function stripFence(text: string): string {
  const fenced = text.match(CODE_FENCE);
  return (fenced ? fenced[1]! : text).trim();
}

function collectDeliverable(
  workspace: Workspace,
  finalMessage: string,
  emit: Emit,
): { code: string; source: HomepageBuildResult["source"] } {
  const candidates = [
    OUTPUT_PATH,
    ...workspace.paths().filter((p) => p.startsWith(OUTPUT_ROOT + "/") && /\.(tsx|jsx|ts|js)$/.test(p)),
  ];
  for (const path of candidates) {
    const text = workspace.get(path);
    if (text?.trim()) {
      emit.log(`deliverable from workspace output: ${path} (${text.length}b)`);
      return { code: stripFence(text), source: "session-output" };
    }
  }

  // Fallback: the model sometimes answers with the component inline instead of
  // (or as well as) writing it. Better than failing the run outright.
  const fenced = finalMessage.match(CODE_FENCE);
  if (fenced && fenced[1]!.includes("PersonalizedHomepage")) {
    emit.log("deliverable recovered from message fence");
    return { code: fenced[1]!.trim(), source: "message-fence" };
  }

  throw new Error(
    `Agent produced no homepage. Expected a file at ${OUTPUT_PATH}. ` +
      `Final message: ${finalMessage.slice(0, 400)}`,
  );
}
