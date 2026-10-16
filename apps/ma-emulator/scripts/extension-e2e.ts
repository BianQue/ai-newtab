/**
 * End to end: the built extension, in a real (headless) Chrome, builds a
 * homepage through the emulator — and survives its service worker being killed
 * mid-build.
 *
 *   Chrome extension (service worker, original agent-core)
 *        │  Managed Agents API over HTTP + SSE
 *        ▼
 *   ma-emulator (this package) ──/v1/messages──▶ upstream gateway
 *
 * The run:
 *   1. load apps/extension/.output/chrome-mv3 into a fresh headless profile,
 *   2. store the API key and point the gateway setting at the emulator,
 *   3. seed some history, start a build,
 *   4. (unless --no-kill) once the agent is working in its sandbox, kill the
 *      service worker — the session keeps running server-side; the worker is
 *      revived by the open new tab, reattaches, and finishes the build,
 *   5. check a homepage was saved and the session was deleted.
 *
 * Needs: the emulator running (pnpm emulator), ANTHROPIC_API_KEY, a build (pnpm build).
 * Run:   bun apps/ma-emulator/scripts/extension-e2e.ts [--no-kill]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EMULATOR = process.env.MA_EMULATOR_URL ?? "http://127.0.0.1:8787";
const API_KEY = process.env.ANTHROPIC_API_KEY;
const KILL = !process.argv.includes("--no-kill");
const EXT = join(import.meta.dir, "../../extension/.output/chrome-mv3");
const PORT = 9334;
const BUILD_TIMEOUT_MS = 20 * 60_000;

const CHROME =
  process.env.CHROME_PATH ??
  [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
  ].find((p) => existsSync(p));

if (!API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
if (!CHROME) throw new Error("Chrome not found; set CHROME_PATH");
if (!existsSync(join(EXT, "manifest.json"))) throw new Error(`No build at ${EXT}. Run: pnpm build`);
const health = await fetch(`${EMULATOR}/health`).then((r) => r.json()).catch(() => null);
if (!health?.ok) throw new Error(`Emulator not reachable at ${EMULATOR}. Run: pnpm emulator`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label: string, pass: boolean, extra?: string) => {
  console.log(`${pass ? "✅" : "❌"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!pass) failures++;
};

const profile = mkdtempSync(join(tmpdir(), "hp-e2e-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--enable-unsafe-extension-debugging",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

const getJson = async (path: string) => (await fetch(`http://127.0.0.1:${PORT}${path}`)).json() as Promise<any>;

async function cdp(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const waiters = new Map<number, (v: any) => void>();
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data));
    if (msg.id && waiters.has(msg.id)) {
      waiters.get(msg.id)!(msg);
      waiters.delete(msg.id);
    }
  };
  const send = (method: string, params: unknown = {}) =>
    new Promise<any>((res) => {
      const n = ++id;
      waiters.set(n, res);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  return {
    send,
    close: () => ws.close(),
    async evaluate<T>(expression: string): Promise<T> {
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      const ex = r.result?.exceptionDetails;
      if (ex) throw new Error(ex.exception?.description ?? JSON.stringify(ex));
      return r.result?.result?.value as T;
    },
  };
}

async function findWorker(extId: string) {
  for (let i = 0; i < 80; i++) {
    const targets: any[] = await getJson("/json/list");
    const sw = targets.find((t) => t.type === "service_worker" && t.url.includes(extId));
    if (sw) return sw;
    await sleep(250);
  }
  return undefined;
}

try {
  let version: any;
  for (let i = 0; i < 80 && !version; i++) {
    version = await getJson("/json/version").catch(() => undefined);
    if (!version) await sleep(250);
  }
  if (!version) throw new Error("Chrome devtools endpoint never came up");
  console.log(`   ${version.Browser}, emulator ${EMULATOR} → ${health.upstream}\n`);

  const browser = await cdp(version.webSocketDebuggerUrl);
  const loaded = await browser.send("Extensions.loadUnpacked", { path: EXT });
  const extId: string | undefined = loaded.result?.id;
  if (!extId) throw new Error(`loadUnpacked failed: ${JSON.stringify(loaded)}`);
  const sw = await findWorker(extId);
  check("service worker registered", Boolean(sw));

  const blank = ((await getJson("/json/list")) as any[]).find((t) => t.type === "page");
  const page = await cdp(blank.webSocketDebuggerUrl);
  await page.send("Runtime.enable");
  await page.send("Page.navigate", { url: `chrome-extension://${extId}/newtab.html` });
  await sleep(2500);

  // Key + gateway, exactly what the key screen saves. Seed history to build from.
  await page.evaluate(`
    (async () => {
      await chrome.storage.local.set({ apiKey: ${JSON.stringify(API_KEY)}, baseUrl: ${JSON.stringify(EMULATOR)} });
      for (const url of ["https://news.ycombinator.com/", "https://news.ycombinator.com/newest",
                         "https://lobste.rs/", "https://lobste.rs/newest", "https://github.com/trending"]) {
        await chrome.history.addUrl({ url });
      }
    })()
  `);
  // Reload so the app sees the key and its own port (which auto-reconnects) is live.
  await page.send("Page.reload");
  await sleep(2500);

  const started = Date.now();
  await page.evaluate(`
    new Promise((resolve) => {
      const port = chrome.runtime.connect({ name: "homepage-agent" });
      port.postMessage({ kind: "startBuild" });
      setTimeout(() => { port.disconnect(); resolve(true); }, 500);
    })
  `);
  console.log("   build started");

  const read = () =>
    page.evaluate<{ snap: any; home: any; session: string | null }>(`
      chrome.storage.local.get(["buildSnapshot", "homepageData", "activeSessionId"])
        .then((r) => ({ snap: r.buildSnapshot ?? null, home: r.homepageData ?? null, session: r.activeSessionId ?? null }))
    `);

  let killed = false;
  let sessionId: string | null = null;
  let lastPhase = "";
  let outcome: "done" | "error" | "timeout" = "timeout";
  while (Date.now() - started < BUILD_TIMEOUT_MS) {
    await sleep(3000);
    const { snap, home, session } = await read().catch(() => ({ snap: null, home: null, session: null }));
    sessionId = session ?? sessionId;
    if (snap?.phase && snap.phase !== lastPhase) {
      lastPhase = snap.phase;
      console.log(`   [${Math.round((Date.now() - started) / 1000)}s] ${snap.phase}${snap.detail ? " " + snap.detail : ""}`);
    }
    if (KILL && !killed && snap?.phase === "analyzing") {
      const target = await findWorker(extId);
      const res = await browser.send("Target.closeTarget", { targetId: target.id });
      killed = Boolean(res.result?.success);
      console.log(`   ✂ killed the service worker mid-build (session ${sessionId}) — the session keeps running in the emulator`);
      check("service worker killed mid-build", killed);
    }
    if (home?.timestamp && Date.parse(home.timestamp) > started) {
      outcome = "done";
      break;
    }
    if (snap?.phase === "error" && !snap.running) {
      outcome = "error";
      console.log(`   error: ${snap.error}`);
      break;
    }
  }

  const { home, session } = await read();
  check(`build finished (${outcome})`, outcome === "done", `${Math.round((Date.now() - started) / 1000)}s`);
  check("homepage saved", typeof home?.code === "string" && home.code.includes("export default"), `${home?.code?.length ?? 0} chars`);
  check("activeSessionId cleared", session === null);
  if (sessionId) {
    const res = await fetch(`${EMULATOR}/v1/sessions/${sessionId}`, { headers: { "x-api-key": API_KEY } });
    check(`session ${sessionId} deleted on the emulator`, res.status === 404, `HTTP ${res.status}`);
  }

  page.close();
  browser.close();
} catch (err) {
  console.error(`\n❌ ${err instanceof Error ? err.message : err}`);
  failures++;
} finally {
  chrome.kill("SIGKILL");
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
