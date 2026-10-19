import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { runHomepageBuild, OUTPUT_PATH } from "@homepage/agent-core";
import { startEmulator } from "../src/server";
import type { MeetingCli } from "../src/tmeet-cli";
import { fakeBridge, fakeModel, memoryStore, reply, testConfig, text, toolUse, TEST_KEY } from "./helpers";

test("meeting refresh and recovered keepalive outlive deleted generation sessions without model calls", async () => {
  const path = mkdtempSync(join(tmpdir(), "meeting-lifecycle-"));
  const code = "import React from 'react'; import {useMeetingData} from '@homepage/meetings'; export default function PersonalizedHomepage(){const {snapshot}=useMeetingData(); return <section>{snapshot?.meetings.map(m=><p key={m.id}>{m.subject}</p>)}</section>}";
  const model = fakeModel([
    () => reply([toolUse("write", { file_path: OUTPUT_PATH, content: code })]),
    () => reply([text("Done")]),
  ]);
  const calls: string[][] = [];
  const now = Date.now();
  const expiry = new Date(now + 6 * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const localExpiry = `${expiry.getFullYear()}-${pad(expiry.getMonth() + 1)}-${pad(expiry.getDate())} ${pad(expiry.getHours())}:${pad(expiry.getMinutes())}:${pad(expiry.getSeconds())}`;
  const cli: MeetingCli = { async run(args) {
    calls.push(args);
    if (args[0] === "auth") return { code: 0, stderr: "", stdout: `Logged in\n OpenId: fixture-user\n AccessToken: valid (expires at ${localExpiry}, remaining 6h)\n RefreshToken: valid (expires at 2099-01-01 00:00:00)` };
    const data = args[1] === "list" ? { meeting_info_list: [] } : args[1] === "list-ended" ? {
      meeting_info_list: [{ meeting_id: "fixture-ended", meeting_code: "123456789", subject: "Recent meeting", start_time: new Date(now - 2 * 3_600_000).toISOString(), end_time: new Date(now - 3_600_000).toISOString() }],
    } : { minutes: [{ overview: "Original summary" }] };
    return { code: 0, stderr: "", stdout: JSON.stringify({ data }) };
  } };
  const config = testConfig(path, { tmeetApiKey: TEST_KEY });
  let emulator = startEmulator(config, { upstream: model.upstream, meetingCli: cli, log: () => {} });
  try {
    const client = new Anthropic({ apiKey: TEST_KEY, baseURL: emulator.url, maxRetries: 0 });
    const result = await runHomepageBuild({ client, bridge: fakeBridge(), store: memoryStore() });
    expect(result.code).toBe(code);
    expect(result.meetingRuntimeVersion).toBe(1);
    const removed = await client.beta.sessions.retrieve(result.sessionId).catch(error => error);
    expect(removed.status).toBe(404);
    const count = model.requests.length;
    const response = await fetch(`${emulator.url}/v1/integrations/tmeet/refresh`, { method: "POST", headers: { Authorization: `Bearer ${TEST_KEY}` } });
    expect(response.status).toBe(200);
    const { snapshot, accountRevision } = await response.json();
    expect(accountRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.status).toBe("ready");
    expect(snapshot.summaries[0].summary).toBe("Original summary");
    expect(model.requests.length).toBe(count);
    await emulator.stop();
    const beforeRecovery = calls.length;
    emulator = startEmulator(config, { upstream: model.upstream, meetingCli: cli, log: () => {} });
    // The status request queues after startup recovery, proving the recovered check completed.
    const status = await fetch(`${emulator.url}/v1/integrations/tmeet/status`, { headers: { Authorization: `Bearer ${TEST_KEY}` } });
    expect((await status.json()).status).toBe("connected");
    expect(calls.slice(beforeRecovery).some(args => args[0] === "meeting" && args[1] === "list")).toBe(true);
    expect(model.requests.length).toBe(count);
  } finally {
    await emulator.stop();
    rmSync(path, { recursive: true, force: true });
  }
});
