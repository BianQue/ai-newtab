import {
  DEFAULT_MODEL,
  DEFAULT_BLOCKED_SITES,
  MODEL_CHOICES,
  STORAGE_KEYS as AGENT_KEYS,
  type HomepageModel,
  type KVStore,
} from "@homepage/agent-core";

/**
 * Everything the extension persists, in one place. All of it lives in
 * chrome.storage.local — including the API key, which anyone with access to the
 * browser profile can read. Fine for a tool you run yourself; not for one you
 * distribute (see ARCHITECTURE.md → Privacy).
 */
export const KEYS = {
  ...AGENT_KEYS,
  /** Optional Anthropic-compatible gateway; unset means api.anthropic.com. */
  baseUrl: "baseUrl",
  /**
   * Which of the local emulator's upstream gateways to use first ("auto" or an
   * upstream name from its /health). Sent as `x-ma-upstream`; null = never set.
   */
  upstream: "upstream",
  /**
   * Keys for the emulator's fallback gateways, by upstream name. Sent as
   * `x-ma-key-<name>`; an empty string tells the emulator to forget that key.
   */
  upstreamKeys: "upstreamKeys",
  homepage: "homepageData",
  systemPrompt: "systemPrompt",
  blockedSites: "blockedSites",
  model: "model",
  autoRebuild: "autoRebuild",
  /** ISO timestamp of the last auto-build *attempted* (success or not). */
  lastAutoBuildAttempt: "lastAutoBuildAttempt",
  rebuildIntervalHours: "autoRebuildIntervalHours",
  /** Throttled mirror of the live build state, for tabs that open while the worker sleeps. */
  buildSnapshot: "buildSnapshot",
} as const;

export interface Homepage {
  /** The agent's raw TSX source. */
  code: string;
  /** ISO timestamp of when it was built. */
  timestamp: string;
}

export interface Settings {
  apiKey: string | null;
  /** Gateway origin, already normalized; null means the build-time default or api.anthropic.com. */
  baseUrl: string | null;
  upstream: string | null;
  upstreamKeys: Record<string, string>;
  systemPrompt: string;
  blockedSites: string[];
  model: HomepageModel;
  /** Unset means on — auto-rebuild is opt-out. */
  autoRebuild: boolean;
  rebuildIntervalHours: number | null;
}

/** The `KVStore` agent-core persists its agent/environment/session IDs through. */
export const extensionStore: KVStore = {
  async get<T>(key: string): Promise<T | undefined> {
    const result = await browser.storage.local.get(key);
    return result[key] as T | undefined;
  },
  async set(key: string, value: unknown): Promise<void> {
    await browser.storage.local.set({ [key]: value });
  },
  async remove(key: string): Promise<void> {
    await browser.storage.local.remove(key);
  },
};

export async function loadSettings(): Promise<Settings> {
  const s = await browser.storage.local.get([
    KEYS.apiKey,
    KEYS.baseUrl,
    KEYS.upstream,
    KEYS.upstreamKeys,
    KEYS.systemPrompt,
    KEYS.blockedSites,
    KEYS.model,
    KEYS.autoRebuild,
    KEYS.rebuildIntervalHours,
  ]);
  const model = s[KEYS.model] as string | undefined;
  return {
    apiKey: (s[KEYS.apiKey] as string | undefined) ?? null,
    baseUrl: (s[KEYS.baseUrl] as string | undefined) || null,
    upstream: (s[KEYS.upstream] as string | undefined) || null,
    upstreamKeys: (s[KEYS.upstreamKeys] as Record<string, string> | undefined) ?? {},
    systemPrompt: (s[KEYS.systemPrompt] as string | undefined) ?? "",
    blockedSites: (s[KEYS.blockedSites] as string[] | undefined) ?? [...DEFAULT_BLOCKED_SITES],
    // Fall back if a stored model is no longer offered.
    model: MODEL_CHOICES.find((m) => m.id === model)?.id ?? DEFAULT_MODEL,
    autoRebuild: s[KEYS.autoRebuild] !== false,
    rebuildIntervalHours: (s[KEYS.rebuildIntervalHours] as number | undefined) ?? null,
  };
}

export async function saveSetting<K extends "apiKey" | "baseUrl" | "upstream" | "upstreamKeys" | "systemPrompt" | "blockedSites" | "model" | "autoRebuild" | "rebuildIntervalHours">(
  key: K,
  value: Settings[K],
): Promise<void> {
  await browser.storage.local.set({ [KEYS[key]]: value });
}

/** The gateway baked in at build time (WXT_ANTHROPIC_BASE_URL), used as the form default. */
export const DEFAULT_BASE_URL: string = import.meta.env.WXT_ANTHROPIC_BASE_URL ?? "";

/** The endpoint builds actually talk to: the saved gateway, else the build-time default, else api.anthropic.com (undefined). */
export function effectiveBaseUrl(baseUrl: string | null): string | undefined {
  return baseUrl || DEFAULT_BASE_URL || undefined;
}

export interface UpstreamInfo {
  name: string;
  baseUrl: string;
  /** The emulator holds this upstream's key itself; otherwise the extension sends it. */
  fixedKey: boolean;
  modelMap: Record<string, string>;
}

/**
 * The upstream gateways behind the endpoint, if it is the local Managed Agents
 * emulator (its /health lists them). Anything else — api.anthropic.com, a plain
 * gateway, an emulator that's down — yields an empty list.
 */
export async function fetchUpstreams(baseUrl: string | undefined): Promise<UpstreamInfo[]> {
  if (!baseUrl) return [];
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const body = (await res.json()) as { upstreams?: UpstreamInfo[] };
    return Array.isArray(body.upstreams) ? body.upstreams : [];
  } catch {
    return [];
  }
}

/**
 * fetch for the build's Anthropic client: adds the emulator's headers from
 * storage on every request — `x-ma-upstream` (once the user has chosen) and an
 * `x-ma-key-<name>` per fallback key — so changing either in Settings applies to
 * the running build's next model call. The emulator only ever forwards a key to
 * the gateway it was given for.
 */
export const fetchWithUpstreamChoice: typeof fetch = async (input, init) => {
  const s = await browser.storage.local.get([KEYS.upstream, KEYS.upstreamKeys]);
  const upstream = s[KEYS.upstream] as string | undefined;
  const keys = (s[KEYS.upstreamKeys] as Record<string, string> | undefined) ?? {};
  if (!upstream && Object.keys(keys).length === 0) return fetch(input, init);
  const headers = new Headers(init?.headers);
  if (upstream) headers.set("x-ma-upstream", upstream);
  for (const [name, key] of Object.entries(keys)) headers.set(`x-ma-key-${name}`, key);
  return fetch(input, { ...init, headers });
};

/**
 * Reduce what the user typed to the origin the SDK expects: "" → null, and a
 * trailing "/" or "/v1" is dropped since the SDK appends "/v1/messages" itself.
 * Returns undefined when the text isn't an http(s) URL.
 */
export function normalizeBaseUrl(raw: string): string | null | undefined {
  const text = raw.trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "").replace(/\/v1$/, "");
  } catch {
    return undefined;
  }
}

export async function loadHomepage(): Promise<Homepage | undefined> {
  return extensionStore.get<Homepage>(KEYS.homepage);
}

export async function saveHomepage(code: string): Promise<void> {
  const homepage: Homepage = { code, timestamp: new Date().toISOString() };
  await extensionStore.set(KEYS.homepage, homepage);
}
