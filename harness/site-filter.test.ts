import { expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { isBlocked, normalizeBlockList, runHomepageBuild, type BrowserBridge, type KVStore } from "@homepage/agent-core";
import { fixtureHistory } from "./node-bridge";

test("normalizes pasted hosts and URLs", () => {
  expect(normalizeBlockList([" HTTPS://WWW.Google.COM/path ", "", " # comment", "*.Example.COM", "google.com"])).toEqual(["google.com", "*.example.com"]);
});

test("matches hosts and subdomains without matching lookalikes", () => {
  for (const host of ["google.com", "mail.google.com", "https://WWW.GOOGLE.COM./path"]) {
    expect(isBlocked(host, ["google.com"])).toBe(true);
  }
  expect(isBlocked("deep.sub.example.com", ["*.example.com"])).toBe(true);
  expect(isBlocked("example.com", ["*.example.com"])).toBe(true);
  for (const url of ["https:/mail.google.com", "https:\\mail.google.com", "HTTPS://user:pw@Mail.Google.com:443/x"]) {
    expect(isBlocked(url, ["google.com"])).toBe(true);
  }
  expect(isBlocked("localhost:3000", ["localhost"])).toBe(true);
  expect(isBlocked("notgoogle.com", ["google.com"])).toBe(false);
  expect(isBlocked("google.com.evil.test", ["google.com"])).toBe(false);
});

/** Exercise live and resumed tool dispatch without a network or browser. */
async function runTools(urls: string[], blockedSites?: string[] | (() => Promise<string[]>), resume = false, afterHistory?: () => void, scrape?: BrowserBridge["getPageHtml"]) {
  const results: Record<string, any> = {};
  const calls: string[][] = [];
  const logs: string[] = [];
  const checkpoints: any[] = [];
  const toolUse = (id: string, name: string, input: unknown) => ({ role: "assistant", content: [{ type: "tool_use", id, name, input }] });
  const historyCall = toolUse("history", "getHistory", { maxResults: 1 });
  const pagesCall = toolUse("pages", "getPageHtml", { urls });
  // Replies the fake model gives, in order. A resumed build starts with getPageHtml already called.
  const replies = [
    ...(resume ? [] : [historyCall, pagesCall]),
    toolUse("write", "write", { path: "/mnt/session/outputs/homepage.tsx", content: "export default function PersonalizedHomepage() {}" }),
    { role: "assistant", content: [{ type: "text", text: "Done." }] },
  ];
  const client = { messages: {
    stream: (params: any) => {
      for (const message of params.messages) {
        if (typeof message.content === "string") continue;
        for (const block of message.content) {
          if (block.type !== "tool_result" || results[block.tool_use_id]) continue;
          results[block.tool_use_id] = block;
          if (block.tool_use_id === "history") afterHistory?.();
        }
      }
      const reply = replies.shift()!;
      const stop_reason = reply.content.some((b: any) => b.type === "tool_use") ? "tool_use" : "end_turn";
      return { on() { return this; }, finalMessage: async () => ({ ...reply, stop_reason }) };
    },
  } } as unknown as Anthropic;
  const data = new Map<string, unknown>();
  if (resume) {
    data.set("buildCheckpoint", { runId: "session", model: "claude-sonnet-5-5", files: {}, messages: [
      { role: "user", content: "Build today's homepage." },
      historyCall,
      { role: "user", content: [{ type: "tool_result", tool_use_id: "history", content: [{ type: "text", text: "{}" }] }] },
      pagesCall,
    ] });
  }
  const store: KVStore = {
    get: async <T>(key: string) => data.get(key) as T,
    set: async (key, value) => { data.set(key, structuredClone(value)); if (key === "buildCheckpoint") checkpoints.push(structuredClone(value)); },
    remove: async (key) => { data.delete(key); },
  };
  const bridge: BrowserBridge = {
    getHistory: async () => ({ sites: fixtureHistory(), totalSitesSeen: fixtureHistory().length }),
    getPageHtml: scrape ?? (async ({ urls }) => { calls.push(urls); return { pages: [], failed: urls.map(url => ({ url, reason: "unavailable" })) }; }),
  };
  const result = await runHomepageBuild({ client, store, bridge, blockedSites, resumeSessionId: resume ? "session" : undefined, callbacks: { onLog: line => logs.push(line) } });
  const files: Record<string, string> = checkpoints.at(-1)?.files ?? {};
  const stored = Object.keys(files).filter(path => path.includes("/pages/"));
  return { results, calls, logs, stored, files, result, leftovers: [...data.keys()] };
}

test("finishes with the written component and leaves nothing behind", async () => {
  const { result, leftovers } = await runTools(["https://public.test"], []);
  expect(result.code).toContain("PersonalizedHomepage");
  expect(result.source).toBe("session-output");
  expect(leftovers).toEqual([]);
});

test("filters history before capping and excludes blocked sites from the count", async () => {
  const { results } = await runTools([], ["news.ycombinator.com"]);
  const digest = JSON.parse(results.history.content[0].text);
  expect(digest.totalSitesSeen).toBe(fixtureHistory().length - 1);
  expect(digest.sites).toHaveLength(1);
  expect(JSON.stringify(digest)).not.toContain("news.ycombinator.com");
});

test("uses newly saved blocked sites for the next tool call in an active build", async () => {
  let savedSites: string[] = [];
  const { results, calls } = await runTools(
    ["https://news.ycombinator.com"],
    async () => savedSites,
    false,
    () => { savedSites = ["news.ycombinator.com"]; },
  );
  expect(JSON.stringify(JSON.parse(results.history.content[0].text))).toContain("news.ycombinator.com");
  expect(calls).toEqual([]);
  expect(JSON.parse(results.pages.content[0].text)).toEqual({
    pages: [],
    failed: [{ url: "https://news.ycombinator.com", reason: "blocked by the user's settings" }],
  });
});

test("never forwards blocked or non-http URLs, including on resume", async () => {
  const urls = ["https://bank.test", "https://sub.bank.test", "https:/bank.test", "https:\\bank.test", "file:///secret", "chrome://settings", "javascript:alert(1)", "not a url"];
  for (const resume of [false, true]) {
    const { results, calls, logs } = await runTools(urls, ["bank.test"], resume);
    expect(calls).toEqual([]);
    expect(results.pages.is_error).toBeUndefined();
    expect(JSON.parse(results.pages.content[0].text)).toEqual({ pages: [], failed: urls.map(url => ({ url, reason: "blocked by the user's settings" })) });
    expect(logs).toContain("blocked: 8 url(s)");
  }
});

test("only forwards allowed URLs in mixed batches", async () => {
  const { results, calls } = await runTools(["https://bank.test", "https://public.test"], ["bank.test"]);
  expect(calls).toEqual([["https://public.test"]]);
  expect(JSON.parse(results.pages.content[0].text).failed).toEqual([
    { url: "https://bank.test", reason: "blocked by the user's settings" },
    { url: "https://public.test", reason: "unavailable" },
  ]);
});

test("uses defaults when unset and honors an explicitly empty list", async () => {
  expect((await runTools(["https://mail.google.com"])).calls).toEqual([]);
  expect((await runTools(["https://mail.google.com"], [])).calls).toEqual([["https://mail.google.com"]]);
});

test("always blocks loopback, private and local-network hosts", () => {
  for (const url of [
    "http://localhost:5173", "http://127.0.0.2/", "http://0.0.0.0:8080", "http://2130706433/",
    "http://[::1]:3000/", "http://[::ffff:127.0.0.1]/", "http://[fd12::1]/", "http://[fe80::1]/",
    "http://10.0.0.5/", "http://172.20.1.1/", "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data",
    "http://100.100.1.1/", "http://router/", "http://printer.local/", "https://wiki.corp.internal/",
    "http://nas.lan/", "http://box.home.arpa/",
  ]) {
    expect(isBlocked(url, [])).toBe(true);
  }
  for (const url of ["https://8.8.8.8/", "https://172.32.0.1/", "https://192.169.0.1/", "https://news.ycombinator.com/", "https://[2606:4700::1111]/"]) {
    expect(isBlocked(url, [])).toBe(false);
  }
});

test("drops pages that redirected to a blocked host before storing them", async () => {
  const redirector = "https://www.google.com/url?q=https://mail.google.com/";
  const { results, stored, files } = await runTools([redirector, "https://public.test/"], ["mail.google.com"], false, undefined, async ({ urls }) => ({
    pages: [
      { url: urls[0]!, finalUrl: "https://mail.google.com/mail/u/0/", title: "Inbox", html: "<p>secret</p>" },
      { url: urls[1]!, finalUrl: "https://public.test/", title: "Public", html: "<p>news</p>" },
    ],
    failed: [],
  }));
  const out = JSON.parse(results.pages.content[0].text);
  expect(stored).toHaveLength(1);
  expect(JSON.stringify(files)).not.toContain("secret");
  expect(out.pages.map((p: any) => p.url)).toEqual(["https://public.test/"]);
  expect(out.failed).toEqual([{ url: redirector, reason: "blocked by the user's settings" }]);
  expect(JSON.stringify(out)).not.toContain("Inbox");
});
