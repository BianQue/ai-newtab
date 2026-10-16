/**
 * The worst-timed host kill, and the proof that resume handles it.
 *
 * The orchestrator checkpoints the conversation and workspace after every
 * turn. If the host dies while a tool call is pending, the checkpoint ends on
 * an assistant tool_use with no result, and the next request would be rejected
 * unless resume answers it first.
 *
 * Phase "crash": run a real build and hard-exit the instant getPageHtml is
 * requested — without answering. This is a worker kill at the worst moment.
 *
 * Phase "resume": runHomepageBuild({ resumeSessionId }). It must load the
 * checkpoint, answer the orphaned tool call, and finish the build.
 *
 * Run: pnpm agent:resume-test   (runs "crash" then "resume")
 */
import Anthropic from "@anthropic-ai/sdk";
import { STORAGE_KEYS, runHomepageBuild, type BrowserBridge } from "@homepage/agent-core";
import { FileKVStore, STATE_PATH, nodeBridge } from "./node-bridge";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
const store = new FileKVStore(STATE_PATH);

async function crash(): Promise<never> {
  const dyingBridge: BrowserBridge = {
    getHistory: (args) => nodeBridge.getHistory(args),
    getPageHtml: async ({ urls }) => {
      console.log(`[crash] getPageHtml requested — DYING WITHOUT ANSWERING`);
      console.log(`[crash] urls: ${JSON.stringify(urls)}`);
      process.exit(0);
    },
  };
  await runHomepageBuild({
    client,
    bridge: dyingBridge,
    store,
    callbacks: { onPhase: (p, d) => console.log(`[crash] [${p}]${d ? " " + d : ""}`) },
  });
  throw new Error("[crash] build finished before getPageHtml was requested");
}

async function resume() {
  const sessionId = await store.get<string>(STORAGE_KEYS.activeSessionId);
  if (!sessionId) throw new Error("no activeSessionId — crash phase did not run");
  console.log(`[resume] resuming ${sessionId}`);

  let reAnswered = false;
  const result = await runHomepageBuild({
    client,
    bridge: nodeBridge,
    store,
    resumeSessionId: sessionId,
    callbacks: {
      onLog: (line) => {
        if (line.includes("re-answering")) reAnswered = true;
        console.log(`  · ${line}`);
      },
      onPhase: (p, d) => console.log(`[${p}]${d ? " " + d : ""}`),
    },
  });

  console.log("\n========== RESUME RESULT ==========");
  console.log(`✅ build resumed and completed: ${result.sessionId}`);
  console.log(`${reAnswered ? "✅" : "❌"} orphaned tool call was re-answered`);
  console.log(`✅ deliverable recovered (${result.code.length}b, via ${result.source})`);

  const sameBuild = result.sessionId === sessionId;
  console.log(`${sameBuild ? "✅" : "❌"} resumed the same build (no restart)`);

  const leftover = await store.get(STORAGE_KEYS.buildCheckpoint);
  console.log(`${leftover ? "❌" : "✅"} checkpoint removed after the build`);

  if (!reAnswered || !sameBuild || leftover) process.exit(1);
}

const phase = process.argv[2];
if (phase === "crash") await crash();
else if (phase === "resume") await resume();
else throw new Error("usage: test-resume.ts crash|resume");
