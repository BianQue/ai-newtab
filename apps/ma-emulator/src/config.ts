import { join, resolve } from "node:path";

export interface EmulatorConfig {
  port: number;
  hostname: string;
  /** sqlite db, uploaded file blobs and per-session sandboxes live here. */
  dataDir: string;
  /** Where model calls go: any Anthropic-compatible `/v1/messages` endpoint. */
  upstreamBaseUrl: string;
  /**
   * Optional fixed upstream key. When unset (the default), the emulator holds no
   * key of its own: it forwards whatever key the client sent, keeps it in memory
   * only, and a session orphaned by an emulator restart waits until a client
   * request supplies a key again. Set this to let sessions resume unattended.
   */
  upstreamApiKey?: string;
  maxTokens: number;
  /** Model turns per user message before the session gives up. */
  maxTurns: number;
  /** Retries per model request on transient upstream failures. */
  maxRetries: number;
  retryBaseDelayMs: number;
}

const DEFAULT_UPSTREAM = "https://api.anthropic.com";

export function loadConfig(env: Record<string, string | undefined> = process.env): EmulatorConfig {
  const port = Number(env.MA_PORT ?? 8787);
  const hostname = env.MA_HOST ?? "127.0.0.1";
  // MA_UPSTREAM_BASE_URL is the explicit knob. ANTHROPIC_BASE_URL is accepted as a
  // fallback because the repo's root .env already points it at the gateway — but
  // never when it points back at this emulator, which would loop forever.
  let upstream = env.MA_UPSTREAM_BASE_URL || env.ANTHROPIC_BASE_URL || DEFAULT_UPSTREAM;
  if (pointsAtSelf(upstream, port)) upstream = env.MA_UPSTREAM_BASE_URL || DEFAULT_UPSTREAM;
  if (pointsAtSelf(upstream, port)) {
    throw new Error(`MA_UPSTREAM_BASE_URL (${upstream}) points at the emulator itself`);
  }

  return {
    port,
    hostname,
    dataDir: resolve(env.MA_DATA_DIR ?? join(import.meta.dir, "..", ".data")),
    upstreamBaseUrl: upstream.replace(/\/+$/, "").replace(/\/v1$/, ""),
    upstreamApiKey: env.MA_UPSTREAM_API_KEY || undefined,
    maxTokens: Number(env.MA_MAX_TOKENS ?? 32_000),
    maxTurns: Number(env.MA_MAX_TURNS ?? 80),
    maxRetries: Number(env.MA_MAX_RETRIES ?? 4),
    retryBaseDelayMs: Number(env.MA_RETRY_BASE_DELAY_MS ?? 2_000),
  };
}

function pointsAtSelf(url: string, port: number): boolean {
  try {
    const u = new URL(url);
    const local = ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(u.hostname);
    return local && Number(u.port || (u.protocol === "https:" ? 443 : 80)) === port;
  } catch {
    return false;
  }
}
