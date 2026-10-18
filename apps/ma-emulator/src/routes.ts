import type { EmulatorConfig } from "./config";
import type { SessionEngine } from "./engine";
import { publicFile, type FileService } from "./files";
import type { Registry } from "./registry";
import { ApiError, badRequest } from "./util";

/**
 * HTTP surface. Paths, envelopes and SSE framing follow what
 * `@anthropic-ai/sdk`'s `client.beta.*` sends and parses, so an unmodified SDK
 * client works by pointing `baseURL` here.
 */

interface Ctx {
  req: Request;
  url: URL;
  params: string[];
  apiKey?: string;
}

type Handler = (ctx: Ctx) => Response | Promise<Response>;

export interface Services {
  config: EmulatorConfig;
  registry: Registry;
  files: FileService;
  engine: SessionEngine;
  log: (line: string) => void;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-expose-headers": "*",
};

const json = (body: unknown, status = 200) => Response.json(body, { status });

async function readJson(req: Request): Promise<any> {
  const text = await req.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest("request body is not valid JSON");
  }
}

const cursorPage = <T>(data: T[]) => ({ data, next_page: null });

export function createRouter(s: Services) {
  const { registry, files, engine } = s;
  const routes: [string, RegExp, Handler][] = [];
  const on = (method: string, pattern: string, handler: Handler) =>
    routes.push([method, new RegExp("^" + pattern.replace(/:\w+/g, "([^/]+)") + "$"), handler]);

  // ---- health --------------------------------------------------------------------
  const primary = s.config.upstreams[0];
  const anyFixedKey = s.config.upstreams.some((u) => u.apiKey);
  on("GET", "/health", () =>
    json({
      ok: true,
      upstream: primary.baseUrl,
      upstreams: s.config.upstreams.map((u) => ({ name: u.name, baseUrl: u.baseUrl, fixedKey: Boolean(u.apiKey) })),
      fixedKey: anyFixedKey,
    }),
  );

  // ---- environments ----------------------------------------------------------------
  on("POST", "/v1/environments", async ({ req }) => json(registry.createEnvironment(await readJson(req))));
  on("GET", "/v1/environments", () => json(cursorPage(registry.listEnvironments())));
  on("GET", "/v1/environments/:id", ({ params }) => json(registry.getEnvironment(params[0])));
  on("POST", "/v1/environments/:id", async ({ req, params }) =>
    json(registry.updateEnvironment(params[0], await readJson(req))),
  );
  on("DELETE", "/v1/environments/:id", ({ params }) => json(registry.deleteEnvironment(params[0])));
  on("POST", "/v1/environments/:id/archive", ({ params }) => json(registry.archiveEnvironment(params[0])));

  // ---- agents ------------------------------------------------------------------------
  on("POST", "/v1/agents", async ({ req }) => json(registry.createAgent(await readJson(req))));
  on("GET", "/v1/agents", () => json(cursorPage(registry.listAgents())));
  on("GET", "/v1/agents/:id", ({ params, url }) => {
    const v = url.searchParams.get("version");
    return json(registry.getAgent(params[0], v ? Number(v) : undefined));
  });
  on("POST", "/v1/agents/:id", async ({ req, params }) => json(registry.updateAgent(params[0], await readJson(req))));
  on("POST", "/v1/agents/:id/archive", ({ params }) => json(registry.archiveAgent(params[0])));

  // ---- sessions ----------------------------------------------------------------------
  on("POST", "/v1/sessions", async ({ req, apiKey }) => {
    const doc = engine.createSession(await readJson(req), apiKey);
    return json(engine.view(doc));
  });
  on("GET", "/v1/sessions", () =>
    json({ data: engine.listSessions().map((d) => engine.view(d)), next_page: null, prev_page: null }),
  );
  on("GET", "/v1/sessions/:id", ({ params, apiKey }) => {
    engine.rememberKey(params[0], apiKey);
    return json(engine.view(engine.getSession(params[0])));
  });
  on("POST", "/v1/sessions/:id", async ({ req, params }) =>
    json(engine.view(engine.updateSession(params[0], await readJson(req)))),
  );
  on("DELETE", "/v1/sessions/:id", ({ params }) => json(engine.deleteSession(params[0])));
  on("POST", "/v1/sessions/:id/archive", ({ params }) => json(engine.view(engine.archiveSession(params[0]))));

  // ---- events ------------------------------------------------------------------------
  on("GET", "/v1/sessions/:id/events", ({ params, url, apiKey }) => {
    engine.rememberKey(params[0], apiKey);
    const limit = url.searchParams.get("limit");
    const order = url.searchParams.get("order");
    return json(
      engine.listEvents(params[0], {
        limit: limit ? Number(limit) : undefined,
        page: url.searchParams.get("page") ?? undefined,
        order: order === "desc" ? "desc" : "asc",
      }),
    );
  });
  on("POST", "/v1/sessions/:id/events", async ({ req, params, apiKey }) => {
    const body = await readJson(req);
    return json(engine.sendEvents(params[0], body.events, apiKey));
  });
  on("GET", "/v1/sessions/:id/events/stream", ({ req, params, apiKey }) => {
    const sessionId = params[0];
    engine.getSession(sessionId); // 404 before opening a stream
    const enc = new TextEncoder();
    let cleanup = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const write = (chunk: string) => {
          if (closed) return;
          try {
            controller.enqueue(enc.encode(chunk));
          } catch {
            cleanup();
          }
        };
        const unsubscribe = engine.subscribe(sessionId, {
          onEvent: (ev) => write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`),
          onClose: () => {
            cleanup();
            try {
              controller.close();
            } catch {}
          },
        });
        // Comments keep proxies and idle timers from closing a quiet stream.
        const ping = setInterval(() => write(": ping\n\n"), 15_000);
        cleanup = () => {
          if (closed) return;
          closed = true;
          clearInterval(ping);
          unsubscribe();
        };
        req.signal.addEventListener("abort", () => cleanup(), { once: true });
        write(": connected\n\n");
      },
      cancel() {
        cleanup();
      },
    });
    // Attaching a stream is also how a client says "I'm back" after an emulator restart.
    engine.rememberKey(sessionId, apiKey);
    return new Response(body, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    });
  });

  // ---- resources -----------------------------------------------------------------------
  on("POST", "/v1/sessions/:id/resources", async ({ req, params }) =>
    json(engine.addResource(params[0], await readJson(req))),
  );
  on("GET", "/v1/sessions/:id/resources", ({ params }) => json(cursorPage(engine.listResources(params[0]))));
  on("GET", "/v1/sessions/:id/resources/:rid", ({ params }) => json(engine.getResource(params[0], params[1])));
  on("DELETE", "/v1/sessions/:id/resources/:rid", ({ params }) => json(engine.deleteResource(params[0], params[1])));

  // ---- files -----------------------------------------------------------------------------
  on("POST", "/v1/files", async ({ req }) => {
    const form = await req.formData().catch(() => {
      throw badRequest("expected multipart/form-data with a `file` field");
    });
    const file = form.get("file");
    if (!(file instanceof File)) throw badRequest("missing `file` field");
    return json(publicFile(files.upload(new Uint8Array(await file.arrayBuffer()), file.name || "upload", file.type)));
  });
  on("GET", "/v1/files", ({ url }) => {
    const data = files.list(url.searchParams.get("scope_id") ?? undefined).map(publicFile);
    return json({ data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null });
  });
  on("GET", "/v1/files/:id", ({ params }) => json(publicFile(files.get(params[0]))));
  on("GET", "/v1/files/:id/content", ({ params }) => {
    const { doc, bytes } = files.download(params[0]);
    return new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]), {
      headers: {
        "content-type": doc.mime_type,
        "content-disposition": `attachment; filename="${encodeURIComponent(doc.filename)}"`,
      },
    });
  });
  on("DELETE", "/v1/files/:id", ({ params }) => {
    files.delete(params[0]);
    return json({ id: params[0], type: "file_deleted" });
  });

  // ---- plain Messages API: pass through, so one base URL serves both modes ---------------
  // (to the primary only: no failover or model mapping on this path)
  const passthrough: Handler = async ({ req, url, apiKey }) => {
    const headers = new Headers();
    for (const h of ["content-type", "anthropic-version", "anthropic-beta", "accept"]) {
      const v = req.headers.get(h);
      if (v) headers.set(h, v);
    }
    headers.set("x-api-key", primary.apiKey ?? apiKey ?? "");
    const upstream = await fetch(primary.baseUrl + url.pathname + url.search, {
      method: req.method,
      headers,
      body: req.method === "GET" ? undefined : await req.arrayBuffer(),
      signal: req.signal,
    });
    const out = new Headers(upstream.headers);
    out.delete("content-encoding");
    out.delete("content-length");
    return new Response(upstream.body, { status: upstream.status, headers: out });
  };
  on("POST", "/v1/messages", passthrough);
  on("POST", "/v1/messages/count_tokens", passthrough);
  on("GET", "/v1/models", passthrough);

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    let res: Response;
    try {
      const apiKey =
        req.headers.get("x-api-key") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? undefined;
      if (!apiKey && !anyFixedKey && url.pathname.startsWith("/v1/")) {
        throw new ApiError(401, "authentication_error", "x-api-key header is required");
      }
      const match = routes.find(([m, re]) => m === req.method && re.test(url.pathname));
      if (!match) {
        const pathKnown = routes.some(([, re]) => re.test(url.pathname));
        throw pathKnown
          ? new ApiError(405, "invalid_request_error", `${req.method} not allowed on ${url.pathname}`)
          : new ApiError(404, "not_found_error", `No route for ${req.method} ${url.pathname}`);
      }
      const params = url.pathname.match(match[1])!.slice(1).map(decodeURIComponent);
      res = await match[2]({ req, url, params, apiKey });
    } catch (err) {
      if (err instanceof ApiError) res = err.toResponse();
      else {
        s.log(`[http] ${req.method} ${url.pathname} crashed: ${err instanceof Error ? err.stack : String(err)}`);
        res = new ApiError(500, "api_error", err instanceof Error ? err.message : String(err)).toResponse();
      }
    }

    if (!(req.method === "GET" && /\/(events|events\/stream)$/.test(url.pathname) && res.ok)) {
      s.log(`[http] ${req.method} ${url.pathname} → ${res.status}`);
    }
    for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
    return res;
  };
}
