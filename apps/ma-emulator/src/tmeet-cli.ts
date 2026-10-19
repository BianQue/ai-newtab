import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isMeetingAuthorizationUrl } from "@homepage/agent-core";

export type FailureKind = "authentication" | "permission" | "network" | "parse" | "unavailable";
export class MeetingError extends Error {
  constructor(public kind: FailureKind, message: string) { super(message); }
}
export interface CliResult { stdout: string; stderr: string; code: number }
export interface MeetingCli {
  run(args: string[], signal?: AbortSignal, onOutput?: (chunk: string) => void): Promise<CliResult>;
}

export function authorizationUrl(value: string): string | undefined {
  return isMeetingAuthorizationUrl(value) ? new URL(value).href : undefined;
}

export function classifyFailure(text: string): MeetingError {
  if (/not logged|user config is empty|session has expired|identity.*expired|refresh token|200[45]|401|unauthorized/i.test(text))
    return new MeetingError("authentication", "Tencent Meeting authorization is required.");
  if (/500284|permission|forbidden|403|该功能暂不可使用/i.test(text))
    return new MeetingError("permission", "This account cannot access this meeting feature.");
  return new MeetingError("network", "Tencent Meeting could not be reached. Please retry.");
}

export function parseCliJson(result: CliResult): Record<string, any> {
  if (result.code !== 0) throw classifyFailure(result.stdout + result.stderr);
  let envelope: any;
  try { envelope = JSON.parse(result.stdout.trim()); }
  catch { throw new MeetingError("parse", "The meeting CLI returned an invalid response."); }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope))
    throw new MeetingError("parse", "The meeting CLI returned an invalid response.");
  if (envelope.code && envelope.code !== 0) throw classifyFailure(JSON.stringify(envelope));
  const data = envelope.data;
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new MeetingError("parse", "The meeting CLI returned an invalid response.");
  return data;
}

export function createMeetingCli(options: { executable?: string; proxy?: string; timeoutMs?: number } = {}): MeetingCli {
  // Invoke the native Windows binary directly so timeout/abort also terminates login polling.
  const installed = process.env.APPDATA && join(process.env.APPDATA, "npm", "node_modules", "@tencentcloud", "tmeet", "dist", "tmeet-Windows-x86_64.exe");
  const executable = options.executable ?? (process.platform === "win32" && installed && existsSync(installed) ? installed : "tmeet");
  const env = { ...process.env };
  if (options.proxy) {
    const u = new URL(options.proxy);
    if (!["http:", "https:"].includes(u.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) || u.port !== "7897")
      throw new Error("MA_TMEET_PROXY must use the local proxy on port 7897");
    env.HTTPS_PROXY = options.proxy;
    env.HTTP_PROXY = options.proxy;
  }
  return {
    run(args, signal, onOutput) {
      if (!["auth status", "auth login", "meeting list", "meeting list-ended", "minutes get", "record smart-minutes"].includes(args.slice(0, 2).join(" ")))
        return Promise.reject(new MeetingError("unavailable", "Unsupported meeting operation."));
      return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(new MeetingError("network", "Meeting request cancelled.")); return; }
        const child = spawn(executable, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: false });
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        let stdout = "", stderr = "", settled = false;
        const finish = (error?: Error, result?: CliResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          error ? reject(error) : resolve(result!);
        };
        const abort = () => { child.kill(); finish(new MeetingError("network", "Meeting request cancelled or timed out.")); };
        const timer = setTimeout(abort, args[0] === "auth" && args[1] === "login" ? 300_000 : options.timeoutMs ?? 25_000);
        signal?.addEventListener("abort", abort, { once: true });
        const output = (text: string, isError: boolean) => {
          if (isError) stderr += text; else stdout += text;
          if (stdout.length + stderr.length > 4_000_000) {
            child.kill(); finish(new MeetingError("parse", "Meeting response exceeded the size limit."));
          } else onOutput?.(text);
        };
        child.stdout.on("data", (chunk) => output(chunk, false));
        child.stderr.on("data", (chunk) => output(chunk, true));
        child.on("error", () => finish(new MeetingError("unavailable", "The tmeet CLI is unavailable.")));
        child.on("close", (code) => finish(undefined, { stdout, stderr, code: code ?? 1 }));
      });
    },
  };
}
