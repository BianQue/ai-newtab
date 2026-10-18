import { join, resolve } from "node:path";
import { parseModelMap, type UpstreamSpec } from "./upstreams";

export interface EmulatorConfig {
  port: number;
  hostname: string;
  /** sqlite db, uploaded file blobs and per-session sandboxes live here. */
  dataDir: string;
  /**
   * Where model calls go: Anthropic-compatible `/v1/messages` endpoints, primary
   * first. The primary's `apiKey` is optional. When unset (the default), the
   * emulator holds no key of its own: it forwards whatever key the client sent,
   * keeps it in memory only, and a session orphaned by an emulator restart waits
   * until a client request supplies a key again (or a fallback with a fixed key
   * picks it up). Fallbacks need their own key.
   */
  upstreams: UpstreamSpec[];
  maxTokens: number;
  /** Model turns per user message before the session gives up. */
  maxTurns: number;
  /** Retries per model request on transient upstream failures (across all upstreams). */
  maxRetries: number;
  retryBaseDelayMs: number;
  /**
   * A model call that receives nothing from the upstream for this long — no
   * first byte, or no stream event mid-response — is abandoned as stalled and
   * retried, on the next upstream if there is one.
   */
  stallTimeoutMs: number;
  /** How long a failed upstream is skipped in favour of the next one. */
  upstreamCooldownMs: number;
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

  const upstreams: UpstreamSpec[] = [
    {
      name: "primary",
      baseUrl: normalizeBaseUrl(upstream),
      apiKey: env.MA_UPSTREAM_API_KEY || undefined,
      modelMap: parseModelMap(env.MA_UPSTREAM_MODEL_MAP),
    },
  ];
  // Fallbacks: MA_UPSTREAM_2_BASE_URL / _API_KEY / _MODEL_MAP, then _3_, … up to the first gap.
  for (let n = 2; env[`MA_UPSTREAM_${n}_BASE_URL`]; n++) {
    const baseUrl = env[`MA_UPSTREAM_${n}_BASE_URL`]!;
    const apiKey = env[`MA_UPSTREAM_${n}_API_KEY`];
    if (!apiKey) throw new Error(`MA_UPSTREAM_${n}_BASE_URL is set but MA_UPSTREAM_${n}_API_KEY is not`);
    if (pointsAtSelf(baseUrl, port)) throw new Error(`MA_UPSTREAM_${n}_BASE_URL (${baseUrl}) points at the emulator itself`);
    upstreams.push({
      name: `fallback-${n}`,
      baseUrl: normalizeBaseUrl(baseUrl),
      apiKey,
      modelMap: parseModelMap(env[`MA_UPSTREAM_${n}_MODEL_MAP`]),
    });
  }

  return {
    port,
    hostname,
    dataDir: resolve(env.MA_DATA_DIR ?? join(import.meta.dir, "..", ".data")),
    upstreams,
    maxTokens: Number(env.MA_MAX_TOKENS ?? 32_000),
    maxTurns: Number(env.MA_MAX_TURNS ?? 80),
    maxRetries: Number(env.MA_MAX_RETRIES ?? 4),
    retryBaseDelayMs: Number(env.MA_RETRY_BASE_DELAY_MS ?? 2_000),
    stallTimeoutMs: Number(env.MA_STALL_TIMEOUT_MS ?? 60_000),
    upstreamCooldownMs: Number(env.MA_UPSTREAM_COOLDOWN_MS ?? 5 * 60_000),
  };
}

const normalizeBaseUrl = (url: string) => url.replace(/\/+$/, "").replace(/\/v1$/, "");

function pointsAtSelf(url: string, port: number): boolean {
  try {
    const u = new URL(url);
    const local = ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(u.hostname);
    return local && Number(u.port || (u.protocol === "https:" ? 443 : 80)) === port;
  } catch {
    return false;
  }
}
