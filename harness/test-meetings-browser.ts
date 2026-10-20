/** Real extension/Sandpack acceptance with synthetic service data; no private account access. */
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import assert from "node:assert/strict";

const modulePath = process.env.PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error("Set PLAYWRIGHT_MODULE to an installed playwright index.mjs.");
const { chromium } = await import(pathToFileURL(modulePath).href);
const chrome = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const output = resolve("harness/out/meetings-browser");
mkdirSync(output, { recursive: true });
const key = crypto.randomUUID();
let revision = 0;
let pending = false;
let failRefresh = false;
let refreshRequests = 0;
const requestOrigins = new Set<string>();
const originalSummary = '<script>window.meetingInjected=true</script> Original summary.\n' + 'Next action remains unchanged. Long original meeting notes.\n'.repeat(80);
const authUrl = "https://meeting.tencent.com/marketplace/tencentmeeting-cli-auth.html?code=test-fixture";
const fixture = () => ({
  schemaVersion: 1, revision: ++revision, fetchedAt: new Date().toISOString(), timezone: "Asia/Shanghai",
  window: { todayStart: "2026-10-19T00:00:00+08:00", todayEnd: "2026-10-20T00:00:00+08:00", weekStart: "2026-10-12T12:00:00+08:00", now: "2026-10-19T12:00:00+08:00" },
  status: "ready",
  meetings: Array.from({ length: Math.min(revision, 5) }, (_, i) => ({
    id: `row-${i}`, subject: `Meeting ${i + 1}`, startTime: "2026-10-19T14:00:00+08:00", endTime: "2026-10-19T15:00:00+08:00", status: "scheduled",
  })),
  summaries: [{ id: "summary-1", subject: "Completed meeting", startTime: "2026-10-18T14:00:00+08:00", endTime: "2026-10-18T15:00:00+08:00", summary: originalSummary, summaryStatus: "available" }],
});
const service = createServer((req, res) => {
  requestOrigins.add(req.headers.origin ?? "none");
  const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,OPTIONS" };
  const reply = (body: unknown, status = 200) => { res.writeHead(status, { ...headers, "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.method === "OPTIONS") return reply(null);
  if (req.headers.authorization !== `Bearer ${key}`) return reply(null, 401);
  const route = new URL(req.url ?? "/", "http://localhost").pathname.split("/").at(-1);
  if (route === "connect") pending = true;
  if (route === "status" || route === "connect") return reply(pending
    ? { status: "pending", requestId: "fixture-request", authorizationUrl: authUrl, expiresAt: new Date(Date.now() + 300_000).toISOString() }
    : { status: "connected", accountRevision: "a".repeat(64) });
  if (route === "refresh") {
    refreshRequests++;
    if (failRefresh) return reply(null, 503);
    return reply({ snapshot: fixture(), accountRevision: "a".repeat(64) });
  }
  return reply(null, 404);
});
await new Promise<void>(resolve => service.listen(0, "127.0.0.1", resolve));
const servicePort = (service.address() as { port: number }).port;

const code = (variant: "green" | "red") => `import React from 'react';
import { useMeetingData } from '@homepage/meetings';
export default function PersonalizedHomepage() {
  const {snapshot,loading,error,stale,refresh,connect} = useMeetingData();
  const [expanded, setExpanded] = React.useState(null);
  const status = loading ? 'Updating' : stale ? 'Stale' : 'Ready';
  return <main style={{fontFamily:'system-ui',padding:24,maxWidth:900,margin:'auto',color:'${variant === "green" ? "#12583d" : "#8a2440"}',overflowWrap:'anywhere'}}>
    <h1>Meeting dashboard ${variant}</h1>
    <span role="img" aria-label={status} title={status + ' ' + (snapshot?.fetchedAt || '') + ' ' + (error || '')} style={{display:'inline-block',width:8,height:8,borderRadius:'50%',background:loading?'#888':stale?'#b07819':'#34865a'}} />
    <button onClick={connect}>Connect account</button>
    <section aria-label="Today"><h2>Today</h2>{snapshot?.meetings.map(m => <article key={m.id}><h3>{m.subject}</h3></article>)}</section>
    <section aria-label="Last seven days" style={{maxHeight:480,overflowY:'auto'}}><h2>Last seven days</h2>{snapshot?.summaries.map(m => <div key={m.id}>
      <h3>{m.subject}</h3>
      <p data-summary style={{whiteSpace:'pre-wrap',lineHeight:'24px',margin:0,...(expanded===m.id?{maxHeight:'min(360px, 50vh)',overflowY:'auto'}:{display:'-webkit-box',WebkitLineClamp:3,WebkitBoxOrient:'vertical',overflow:'hidden'})}}>{m.summary}</p>
      <button aria-expanded={expanded===m.id} onClick={()=>setExpanded(expanded===m.id?null:m.id)}>{expanded===m.id?'Collapse summary':'Expand summary'}</button>
    </div>)}</section>
  </main>;
}`;

const profile = mkdtempSync(join(tmpdir(), "tmeet-browser-"));
const args = ["--headless=new", "--no-first-run", "--no-default-browser-check", "--enable-unsafe-extension-debugging", "--remote-debugging-port=0", `--user-data-dir=${profile}`];
if (process.env.BROWSER_PROXY) args.push(`--proxy-server=${process.env.BROWSER_PROXY}`);
args.push("about:blank");
const child = spawn(chrome, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
let stderr = "";
child.stderr.on("data", data => { stderr += data.toString(); });
let browser: any;
const errors: string[] = [];
try {
  let ws: string | undefined;
  for (let i = 0; i < 100 && !ws; i++) {
    ws = stderr.match(/DevTools listening on (ws:\/\/\S+)/)?.[1];
    if (!ws) await sleep(100);
  }
  assert(ws, "Chrome exposes DevTools");
  browser = await chromium.connectOverCDP(ws);
  const cdp = await browser.newBrowserCDPSession();
  const { id } = await cdp.send("Extensions.loadUnpacked", { path: resolve("apps/extension/.output/chrome-mv3") });
  assert(id, "Unpacked extension loads");
  const context = browser.contexts()[0];
  const page = await context.newPage();
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.goto(`chrome-extension://${id}/newtab.html`);
  const seed = async (source: string) => {
    await page.evaluate(async (data: any) => {
      const extension = (globalThis as any).chrome;
      await extension.storage.local.set(data);
      await extension.storage.local.remove("activeSessionId");
    }, { apiKey: key, baseUrl: `http://127.0.0.1:${servicePort}`, autoRebuild: false,
      homepageData: { code: source, meetingRuntimeVersion: 1, timestamp: new Date().toISOString() } });
    await page.reload();
  };
  const getPreview = async () => {
    for (let i = 0; i < 180; i++) {
      // The preview's URL changes while Sandpack compiles; identify it by rendered content.
      for (const candidate of page.frames()) {
        if (candidate === page.mainFrame()) continue;
        if (await candidate.getByRole("heading", { name: /Meeting dashboard/ }).count().catch(() => 0)) return candidate;
      }
      await sleep(500);
    }
    await page.screenshot({ path: join(output, "failed-load.png"), fullPage: true });
    throw new Error(`Sandpack preview did not render. Frames: ${page.frames().map((f: any) => f.url()).join(", ")}`);
  };
  await seed(code("green"));
  const refreshAlarm = await page.evaluate(async () => (globalThis as any).chrome.alarms.get('meeting-refresh'));
  assert.equal(refreshAlarm?.periodInMinutes, 10, 'browser schedules meeting refresh every ten minutes');
  await page.setViewportSize({ width: 1365, height: 900 });
  let frame = await getPreview();
  await frame.getByRole("heading", { name: "Meeting 1", exact: true }).waitFor({ timeout: 30_000 });
  assert.equal(await frame.locator("[data-summary]").textContent(), originalSummary);
  assert.equal(await frame.evaluate(() => (window as any).meetingInjected), undefined);
  assert(await frame.locator('[data-summary]').evaluate((el: HTMLElement) => el.clientHeight <= 72), 'summary preview is at most three lines');
  await frame.getByRole('button', { name: 'Expand summary' }).click();
  assert(await frame.locator('[data-summary]').evaluate((el: HTMLElement) => el.clientHeight <= 360 && el.scrollHeight > el.clientHeight), 'expanded original scrolls within a bounded height');
  const refreshData = async () => {
    await page.getByRole('button', { name: /^Tencent Meeting/ }).click();
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('button', { name: /^Tencent Meeting/ }).click();
  };
  const before = await page.evaluate(async () => (await (globalThis as any).chrome.storage.local.get("homepageData")).homepageData.code);
  const beforeCount = await frame.locator("article").count();
  await refreshData();
  await frame.waitForFunction((count: number) => document.querySelectorAll("article").length > count, beforeCount);
  const after = await page.evaluate(async () => (await (globalThis as any).chrome.storage.local.get("homepageData")).homepageData.code);
  assert.equal(after, before, "refresh preserves generated code");
  assert.equal(await frame.getByRole('button', { name: 'Collapse summary' }).getAttribute('aria-expanded'), 'true', 'refresh preserves expanded state');
  assert.equal(await frame.locator('[role="alert"], [role="status"]').count(), 0, 'background updates do not announce or show banners');
  assert.equal(await page.evaluate(async () => (await (globalThis as any).chrome.storage.local.get("activeSessionId")).activeSessionId), undefined);
  await page.screenshot({ path: join(output, "desktop-green.png"), fullPage: true });
  failRefresh = true;
  await refreshData();
  await frame.getByRole("img", { name: "Stale", exact: true }).waitFor();
  assert(await frame.locator("article").count() > 0, "failure retains previous rows");
  failRefresh = false;
  const pagesBeforeConnect = context.pages().length;
  await frame.getByRole("button", { name: "Connect account" }).click();
  await page.getByRole("button", { name: /Tencent Meeting/ }).click();
  await page.getByRole("link", { name: "Authorize with Tencent Meeting" }).waitFor();
  assert.equal(await frame.locator(`a[href*="cli-auth"]`).count(), 0);
  assert.equal(context.pages().length, pagesBeforeConnect, "authorization was not opened automatically");
  await page.screenshot({ path: join(output, "trusted-authorization.png"), fullPage: true });
  await context.route("https://meeting.tencent.com/marketplace/tencentmeeting-cli-auth.html?code=test-fixture", (route: any) => route.fulfill({ status: 200, contentType: "text/html", body: "<h1>Authorization fixture</h1>" }));
  const opened = context.waitForEvent("page");
  await page.getByRole("link", { name: "Authorize with Tencent Meeting" }).click();
  const authPage = await opened;
  await authPage.waitForURL(authUrl);
  await authPage.close();
  pending = false;
  await frame.getByRole("img", { name: "Ready", exact: true }).waitFor({ timeout: 15_000 });
  await seed(code("red"));
  await page.setViewportSize({ width: 390, height: 844 });
  frame = await getPreview();
  await frame.getByRole("heading", { name: "Meeting 1", exact: true }).waitFor({ timeout: 30_000 });
  assert.equal(await frame.locator("h1").evaluate((el: HTMLElement) => getComputedStyle(el).color), "rgb(138, 36, 64)");
  assert(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "mobile preview does not overflow");
  assert(await frame.locator('[data-summary]').evaluate((el: HTMLElement) => el.clientHeight <= 72), 'mobile summary is collapsed');
  await frame.getByRole('button', { name: 'Expand summary' }).click();
  assert(await frame.locator('[data-summary]').evaluate((el: HTMLElement) => el.clientHeight <= Math.min(360, innerHeight / 2) + 1 && el.scrollHeight > el.clientHeight), 'mobile expanded summary is bounded');
  await frame.getByRole('button', { name: 'Collapse summary' }).click();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "mobile host does not overflow");
  const controls = await page.getByRole("button", { name: /^Tencent Meeting/ }).boundingBox();
  const preview = await page.locator("iframe").first().boundingBox();
  assert(controls && preview && preview.y >= controls.y + controls.height, "host controls do not cover generated content");
  await page.screenshot({ path: join(output, "mobile-red.png"), fullPage: true });
  assert.deepEqual(errors, [], "no uncaught page errors");
  console.log(JSON.stringify({ passed: true, extensionId: id, requestOrigins: [...requestOrigins], refreshRequests, screenshots: output, viewports: ["1365x900", "390x844"], errors }));
} finally {
  await browser?.close();
  child.kill();
  service.closeAllConnections();
  service.close();
}
