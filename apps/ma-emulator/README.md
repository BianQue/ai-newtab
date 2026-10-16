# ma-emulator — a local Managed Agents API

A local, durable stand-in for the Managed Agents endpoints the homepage builder
uses (`/v1/agents`, `/v1/environments`, `/v1/sessions`, session events and
resources, `/v1/files`). It runs the agent loop server-side and calls the model
through any Anthropic-compatible `/v1/messages` upstream — the official API or a
gateway that only offers the Messages API.

The point is to keep the original architecture intact: `packages/agent-core` and
the extension run **unmodified**, exactly as they would against the real
service; only the base URL changes.

```
Chrome extension (service worker)        harness (Bun)
        │   original agent-core: sessions, events (SSE), resources, files
        └──────────────┬──────────────────────┘
                       ▼
            ma-emulator  http://127.0.0.1:8787
            ├─ store.ts     sqlite: agents (+versions), environments, sessions,
            │               append-only event log, files, resources
            ├─ engine.ts    the session loop: derive() replays the event log into
            │               messages + "what are we waiting on"; drive() acts on it
            ├─ toolset.ts   read / grep / glob / write / edit, server-side
            ├─ sandbox.ts   one directory per session, /mnt/session/... jailed
            └─ routes.ts    HTTP + SSE, shaped like what @anthropic-ai/sdk expects
                       │
                       ▼  /v1/messages (streaming, tool use, prompt caching)
            upstream: MA_UPSTREAM_BASE_URL (falls back to ANTHROPIC_BASE_URL)
```

## Run

From the repo root (so Bun loads the root `.env`):

```bash
pnpm emulator          # listens on 127.0.0.1:8787, upstream = ANTHROPIC_BASE_URL from .env
```

Then point a client at it:

- **Extension**: on the key screen (or *Change API key / gateway*), set the
  gateway to `http://127.0.0.1:8787` and paste your upstream key.
- **Harness**: `ANTHROPIC_BASE_URL=http://127.0.0.1:8787 pnpm agent:run`
  (likewise `agent:resume-test`, `agent:retention`).

| Variable | Default | |
|---|---|---|
| `MA_UPSTREAM_BASE_URL` | `ANTHROPIC_BASE_URL`, else `https://api.anthropic.com` | where model calls go |
| `MA_UPSTREAM_API_KEY` | unset | fixed upstream key; see *Keys* |
| `MA_PORT` / `MA_HOST` | `8787` / `127.0.0.1` | |
| `MA_DATA_DIR` | `apps/ma-emulator/.data` | sqlite db, file blobs, sandboxes |
| `MA_MAX_TOKENS` / `MA_MAX_TURNS` / `MA_MAX_RETRIES` | `32000` / `80` / `4` | |

## Semantics it reproduces

- **The session runs without the client.** The loop lives here; a client that
  disconnects (closed tab, killed service worker) loses nothing. Built-in tools
  keep running; a custom tool call parks the session in
  `idle` + `requires_action` until someone answers it.
- **The event log is the only state.** Model messages are re-derived from the
  log every step (raw assistant content and model `tool_use` ids ride along as
  private columns). Hence:
  - a client reattach is lossless (`events.list` + `events.stream`);
  - an **emulator restart** is lossless too: sessions that were `running` are
    recovered from their logs and continue, without re-running finished tools.
- **Stream has no replay.** `events/stream` carries only events after it opens;
  history comes from `events.list` — the orchestrator's "open stream, then list"
  pattern depends on exactly this.
- **Status machine**: `idle` / `running` / `rescheduling` with
  `session.status_*` events and `stop_reason` `end_turn` | `requires_action`
  (with `event_ids`) | `retries_exhausted`. Transient upstream errors
  (429/5xx/529/network) become `session.error` (`retry_status: retrying`) +
  `status_rescheduled` and are retried with backoff.
- **Interrupt / delete**: deleting a running session is a 409; `user.interrupt`
  aborts the in-flight model call and closes open tool calls with error results.
  Deleting removes the log, sandbox and session-scoped output files; uploads
  belong to the Files API and must be deleted by the client.
- **Mounts** are re-rooted under `/mnt/session/uploads`; files written under
  `/mnt/session/outputs/` appear in `files.list({ scope_id: session })`.
- **Agents are versioned** (optimistic `version` on update; sessions pin the
  version they were created with). Environment names are unique.
- A tool call cut off by `max_tokens` is discarded, never executed, and the
  model is asked to retry it more compactly.

Long single-line HTML is wrapped at ~1000 characters (at tag boundaries) into
numbered display lines that `grep` and `read` share, so `grep -n` → `read
offset` works on minified pages.

## Keys

By default the emulator stores no key. It forwards the key each client request
carries and keeps it **in memory only**. A session recovered after a restart
waits in `rescheduling` until any request on it (stream, list, retrieve, send)
supplies a key again. Set `MA_UPSTREAM_API_KEY` to let sessions resume with no
client at all (clients may then send any key).

## Not emulated

`bash`, `web_fetch`, `web_search` (an agent that enables them gets a log line
and the tool is not offered), MCP toolsets, skills, vaults, multi-agent threads,
outcome evaluations, and live `event_delta` previews.

## Tests

```bash
pnpm test                                   # unit + contract tests (fake model)
bun apps/ma-emulator/scripts/extension-e2e.ts   # real Chrome + emulator + upstream;
                                            # kills the service worker mid-build
```

`test/orchestrator.test.ts` runs the original `@homepage/agent-core`
orchestrator against the emulator over real HTTP/SSE: full build, agent reuse,
and the client-crash reattach scenario. `test/engine.test.ts` covers restart
recovery, requires_action, interrupt/delete, retries, truncation, and agent
versioning.
