import Anthropic from "@anthropic-ai/sdk";
import { loadConfig, type EmulatorConfig } from "./config";
import { SessionEngine } from "./engine";
import { FileService } from "./files";
import { Registry } from "./registry";
import { createRouter } from "./routes";
import { Store } from "./store";
import { UpstreamPool, type UpstreamFactory } from "./upstreams";
import { createMeetingCli, type MeetingCli } from "./tmeet-cli";
import { MeetingService } from "./tmeet";

export interface Emulator {
  url: string;
  config: EmulatorConfig;
  engine: SessionEngine;
  store: Store;
  meetings: MeetingService;
  stop(): Promise<void>;
}

export interface EmulatorOptions {
  /** Override how model calls are made (tests inject a fake upstream). */
  upstream?: UpstreamFactory;
  log?: (line: string) => void;
  meetingCli?: MeetingCli;
}

export function startEmulator(config: EmulatorConfig, opts: EmulatorOptions = {}): Emulator {
  const log = opts.log ?? ((line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`));
  const store = new Store(config.dataDir);
  const registry = new Registry(store);
  const files = new FileService(store);

  const clients = new Map<string, Anthropic>();
  const factory: UpstreamFactory =
    opts.upstream ??
    ((spec, apiKey) => {
      const cacheKey = `${spec.name}\0${apiKey}`;
      let client = clients.get(cacheKey);
      if (!client) {
        // Retries and failover are the session's job (they show up as
        // session.error / status_rescheduled events), so the SDK's own are off.
        // Stalls are caught by the session's watchdog; this is only a backstop.
        client = new Anthropic({ apiKey, baseURL: spec.baseUrl, maxRetries: 0, timeout: 10 * 60_000 });
        clients.set(cacheKey, client);
      }
      return client;
    });
  const upstreams = new UpstreamPool(config.upstreams, factory, config.upstreamCooldownMs);

  const engine = new SessionEngine(store, registry, files, config, upstreams, log);
  const meetings = new MeetingService(opts.meetingCli ?? createMeetingCli({ executable: config.tmeetExecutable, proxy: config.tmeetProxy }), config.dataDir);
  const handle = createRouter({ config, registry, files, engine, meetings, log });

  // idleTimeout 0: event streams stay open for as long as a build runs.
  const server = Bun.serve({ port: config.port, hostname: config.hostname, idleTimeout: 0, fetch: handle });
  const url = `http://${config.hostname}:${server.port}`;

  engine.recover();
  meetings.recover();

  return {
    url,
    config,
    engine,
    store,
    meetings,
    async stop() {
      engine.abortAll();
      await meetings.stop();
      await engine.quiesce(5_000);
      server.stop(true);
      store.close();
    },
  };
}

if (import.meta.main) {
  const config = loadConfig();
  const emu = startEmulator(config);
  console.log(`Managed Agents emulator listening on ${emu.url}`);
  for (const u of config.upstreams) {
    const key = u.apiKey
      ? "fixed key"
      : u.name === "primary"
        ? "client's key (in memory only)"
        : `client's key via x-ma-key-${u.name} (in memory only)`;
    const map = Object.entries(u.modelMap).map(([from, to]) => `${from}→${to}`).join(", ");
    console.log(`  upstream ${u.name.padEnd(11)} ${u.baseUrl}  [${key}]${map ? `  models: ${map}` : ""}`);
  }
  console.log(`  stall timeout:       ${config.stallTimeoutMs / 1000}s`);
  console.log(`  data dir:            ${config.dataDir}`);
  const shutdown = async () => {
    await emu.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
