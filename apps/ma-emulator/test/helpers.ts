import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { BrowserBridge, KVStore } from "@homepage/agent-core";
import type { EmulatorConfig } from "../src/config";
import type { UpstreamFactory } from "../src/engine";
import { startEmulator, type Emulator } from "../src/server";

export const TEST_KEY = "sk-test-key";

/** One scripted model turn: given the request, return the reply (or throw an APIError-like). */
export type Turn = (params: Anthropic.MessageStreamParams, signal?: AbortSignal) => Anthropic.Message | Promise<Anthropic.Message>;

export interface FakeModel {
  upstream: UpstreamFactory;
  requests: Anthropic.MessageStreamParams[];
  keysSeen: string[];
  remaining(): number;
}

/** A stand-in for `/v1/messages` that plays a fixed script, one turn per request. */
export function fakeModel(turns: Turn[]): FakeModel {
  const queue = [...turns];
  const requests: Anthropic.MessageStreamParams[] = [];
  const keysSeen: string[] = [];
  const upstream: UpstreamFactory = (apiKey) =>
    ({
      messages: {
        stream: (params: Anthropic.MessageStreamParams, opts?: { signal?: AbortSignal }) => {
          keysSeen.push(apiKey);
          requests.push(structuredClone(params));
          const turn = queue.shift();
          return {
            finalMessage: async () => {
              if (!turn) throw new Error("fake model: script exhausted");
              return turn(params, opts?.signal);
            },
          };
        },
      },
    }) as unknown as Anthropic;
  return { upstream, requests, keysSeen, remaining: () => queue.length };
}

let toolSeq = 0;

export function reply(content: Array<Record<string, any>>, stop_reason?: Anthropic.StopReason): Anthropic.Message {
  const blocks = content.map((b) =>
    b.type === "tool_use" ? { id: `toolu_${++toolSeq}`, ...b } : b.type === "text" ? { citations: null, ...b } : b,
  ) as Anthropic.ContentBlock[];
  return {
    id: `msg_${++toolSeq}`,
    type: "message",
    role: "assistant",
    model: "fake",
    content: blocks,
    stop_reason: stop_reason ?? (blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn"),
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } as Anthropic.Usage,
  } as Anthropic.Message;
}

export const toolUse = (name: string, input: Record<string, unknown>) => ({ type: "tool_use", name, input });
export const text = (t: string) => ({ type: "text", text: t });

/** The tool_result blocks in the newest user message of a request, keyed by tool name. */
export function lastResults(params: Anthropic.MessageStreamParams): { name: string; text: string; isError: boolean }[] {
  const msgs = params.messages;
  const user = msgs[msgs.length - 1];
  const assistant = msgs[msgs.length - 2];
  const names = new Map<string, string>();
  for (const b of (assistant?.content ?? []) as any[]) if (b.type === "tool_use") names.set(b.id, b.name);
  return ((user.content as any[]) ?? [])
    .filter((b) => b.type === "tool_result")
    .map((b) => ({
      name: names.get(b.tool_use_id) ?? "?",
      text: (b.content ?? []).map((c: any) => c.text ?? "").join(""),
      isError: Boolean(b.is_error),
    }));
}

export function testConfig(dataDir: string, overrides: Partial<EmulatorConfig> = {}): EmulatorConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    dataDir,
    upstreamBaseUrl: "http://upstream.invalid",
    maxTokens: 1000,
    maxTurns: 20,
    maxRetries: 2,
    retryBaseDelayMs: 5,
    ...overrides,
  };
}

export interface Harness {
  emu: Emulator;
  client: Anthropic;
  dataDir: string;
  logs: string[];
  restart(model: FakeModel, overrides?: Partial<EmulatorConfig>): Promise<void>;
  dispose(): Promise<void>;
}

export function startHarness(model: FakeModel, overrides: Partial<EmulatorConfig> = {}): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), "ma-emu-"));
  const logs: string[] = [];
  const log = (l: string) => logs.push(l);
  const h: Harness = {
    emu: startEmulator(testConfig(dataDir, overrides), { upstream: model.upstream, log }),
    client: undefined as unknown as Anthropic,
    dataDir,
    logs,
    async restart(next, nextOverrides = {}) {
      await h.emu.stop();
      h.emu = startEmulator(testConfig(dataDir, { ...overrides, ...nextOverrides }), { upstream: next.upstream, log });
      h.client = new Anthropic({ apiKey: TEST_KEY, baseURL: h.emu.url, maxRetries: 0 });
    },
    async dispose() {
      await h.emu.stop();
      // Windows releases sqlite file handles lazily; a leftover temp dir is harmless.
      for (let i = 0; i < 10; i++) {
        try {
          rmSync(dataDir, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
    },
  };
  h.client = new Anthropic({ apiKey: TEST_KEY, baseURL: h.emu.url, maxRetries: 0 });
  return h;
}

export function memoryStore(): KVStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async <T>(k: string) => data.get(k) as T | undefined,
    set: async (k: string, v: unknown) => void data.set(k, v),
    remove: async (k: string) => void data.delete(k),
  };
}

export const PAGE_HTML =
  "<html><body><h1>Hacker News</h1>" +
  Array.from({ length: 40 }, (_, i) => `<div class="story"><a href="https://example.com/${i}">Story number ${i}</a></div>`).join("") +
  "</body></html>";

export function fakeBridge(): BrowserBridge & { scraped: string[][] } {
  const scraped: string[][] = [];
  return {
    scraped,
    getHistory: async () => ({
      sites: [
        {
          domain: "news.ycombinator.com",
          totalVisits: 50,
          uniquePages: 10,
          lastVisitTime: Date.now(),
          averageVisitsPerDay: 7,
          titles: ["Hacker News"],
          urls: ["https://news.ycombinator.com/"],
          relevanceScore: 1,
        },
      ],
      totalSitesSeen: 1,
    }),
    getPageHtml: async ({ urls }) => {
      scraped.push(urls);
      return { pages: urls.map((url) => ({ url, title: "Hacker News", html: PAGE_HTML })), failed: [] };
    },
  };
}

export async function waitFor<T>(fn: () => T | Promise<T>, label: string, timeoutMs = 5_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
