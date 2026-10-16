import Anthropic from "@anthropic-ai/sdk";
import { loadConfig, type EmulatorConfig } from "./config";
import { SessionEngine, type UpstreamFactory } from "./engine";
import { FileService } from "./files";
import { Registry } from "./registry";
import { createRouter } from "./routes";
import { Store } from "./store";

export interface Emulator {
  url: string;
  config: EmulatorConfig;
  engine: SessionEngine;
  store: Store;
  stop(): Promise<void>;
}

export interface EmulatorOptions {
  /** Override how model calls are made (tests inject a fake upstream). */
  upstream?: UpstreamFactory;
  log?: (line: string) => void;
}

export function startEmulator(config: EmulatorConfig, opts: EmulatorOptions = {}): Emulator {
  const log = opts.log ?? ((line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`));
  const store = new Store(config.dataDir);
  const registry = new Registry(store);
  const files = new FileService(store);

  const clients = new Map<string, Anthropic>();
  const upstream: UpstreamFactory =
    opts.upstream ??
    ((apiKey) => {
      let client = clients.get(apiKey);
      if (!client) {
        // Retries are the session's job (they show up as session.error /
        // status_rescheduled events), so the SDK's own are off.
        client = new Anthropic({ apiKey, baseURL: config.upstreamBaseUrl, maxRetries: 0, timeout: 10 * 60_000 });
        clients.set(apiKey, client);
      }
      return client;
    });

  const engine = new SessionEngine(store, registry, files, config, upstream, log);
  const handle = createRouter({ config, registry, files, engine, log });

  // idleTimeout 0: event streams stay open for as long as a build runs.
  const server = Bun.serve({ port: config.port, hostname: config.hostname, idleTimeout: 0, fetch: handle });
  const url = `http://${config.hostname}:${server.port}`;

  engine.recover();

  return {
    url,
    config,
    engine,
    store,
    async stop() {
      engine.abortAll();
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
  console.log(`  upstream /v1/messages: ${config.upstreamBaseUrl}`);
  console.log(`  data dir:              ${config.dataDir}`);
  console.log(
    config.upstreamApiKey
      ? "  upstream key:          fixed (MA_UPSTREAM_API_KEY)"
      : "  upstream key:          forwarded from each client request, held in memory only",
  );
  const shutdown = async () => {
    await emu.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
