import type Anthropic from "@anthropic-ai/sdk";

/**
 * Where model calls go: an ordered list of Anthropic-compatible `/v1/messages`
 * endpoints. The first is the primary; the rest are fallbacks, tried when the
 * one before them fails or stalls. A failed upstream sits out a cooldown, so a
 * gateway that is down isn't retried on every request.
 */
export interface UpstreamSpec {
  /** "primary", or "fallback-2", "fallback-3", … — shown in logs and events. */
  name: string;
  baseUrl: string;
  /**
   * Fixed key for this upstream. Unset means "forward the client's key", which
   * only makes sense for the primary: the key the client sends is for it.
   */
  apiKey?: string;
  /** Requested model id → the id this upstream knows it by. `*` matches anything not listed. */
  modelMap: Record<string, string>;
}

/** Builds an SDK client for one upstream (tests inject a fake). */
export type UpstreamFactory = (spec: UpstreamSpec, apiKey: string) => Anthropic;

export interface UpstreamTarget {
  name: string;
  client: Anthropic;
  model: string;
}

export class UpstreamPool {
  private readonly downUntil = new Map<string, number>();

  constructor(
    readonly specs: UpstreamSpec[],
    private readonly factory: UpstreamFactory,
    private readonly cooldownMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (specs.length === 0) throw new Error("at least one upstream is required");
  }

  get primary(): UpstreamSpec {
    return this.specs[0];
  }

  /** Whether any upstream can be called without a key from the client. */
  get hasFixedKey(): boolean {
    return this.specs.some((s) => s.apiKey);
  }

  /**
   * The upstreams to try for `model`, best first: those not cooling down in
   * configured order, then the cooling ones (soonest back first) — a request is
   * never refused just because everything failed recently. Upstreams with no
   * usable key are left out.
   */
  candidates(model: string, clientKey: string | undefined): UpstreamTarget[] {
    const t = this.now();
    const usable = this.specs
      .map((spec, order) => ({ spec, order, key: spec.apiKey ?? clientKey, until: this.downUntil.get(spec.name) ?? 0 }))
      .filter((u) => u.key);
    const up = usable.filter((u) => u.until <= t);
    const down = usable.filter((u) => u.until > t).sort((a, b) => a.until - b.until);
    return [...up, ...down].map(({ spec, key }) => ({
      name: spec.name,
      client: this.factory(spec, key!),
      model: mapModel(spec.modelMap, model),
    }));
  }

  markFailed(name: string) {
    this.downUntil.set(name, this.now() + this.cooldownMs);
  }

  markOk(name: string) {
    this.downUntil.delete(name);
  }
}

export function mapModel(map: Record<string, string>, model: string): string {
  return map[model] ?? map["*"] ?? model;
}

/** `a=b,c=d` → `{a: "b", c: "d"}`. */
export function parseModelMap(raw: string | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const pair of (raw ?? "").split(",")) {
    const i = pair.indexOf("=");
    if (i <= 0) continue;
    const from = pair.slice(0, i).trim();
    const to = pair.slice(i + 1).trim();
    if (from && to) map[from] = to;
  }
  return map;
}
