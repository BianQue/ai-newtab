import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { nowIso } from "./util";

/**
 * Durable state. Every API object is a JSON document in a small table; the
 * session event log is an append-only table ordered by `seq`.
 *
 * The event log is the source of truth for a session's conversation: the runner
 * never keeps a separate transcript, it re-derives the model messages from the
 * log. That is what makes an emulator restart (or a client reattach) lossless.
 */

export type DocTable = "environments" | "agents" | "agent_versions" | "sessions" | "files" | "resources";

export interface StoredEvent {
  seq: number;
  id: string;
  sessionId: string;
  type: string;
  /** The public event, exactly as the API returns it. */
  body: Record<string, any>;
  /** Private bookkeeping the API never exposes (raw model content, model tool_use ids). */
  internal: Record<string, any> | null;
}

export interface NewEvent {
  body: Record<string, any> & { id: string; type: string };
  internal?: Record<string, any>;
}

const DOC_TABLES: DocTable[] = ["environments", "agents", "agent_versions", "sessions", "files", "resources"];

export class Store {
  readonly db: Database;

  constructor(readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(join(dataDir, "emulator.db"), { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    for (const table of DOC_TABLES) {
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS ${table} (
           id TEXT PRIMARY KEY,
           parent TEXT,
           created_at TEXT NOT NULL,
           doc TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS ${table}_parent ON ${table}(parent);`,
      );
    }
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS events (
         seq INTEGER PRIMARY KEY AUTOINCREMENT,
         id TEXT NOT NULL UNIQUE,
         session_id TEXT NOT NULL,
         type TEXT NOT NULL,
         body TEXT NOT NULL,
         internal TEXT
       );
       CREATE INDEX IF NOT EXISTS events_session ON events(session_id, seq);`,
    );
  }

  // ---- documents -------------------------------------------------------------

  get<T>(table: DocTable, id: string): T | undefined {
    const row = this.db.query(`SELECT doc FROM ${table} WHERE id = ?`).get(id) as { doc: string } | null;
    return row ? (JSON.parse(row.doc) as T) : undefined;
  }

  put<T extends { id: string; created_at?: string }>(table: DocTable, doc: T, parent?: string | null): T {
    this.db
      .query(
        `INSERT INTO ${table} (id, parent, created_at, doc) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET parent = excluded.parent, doc = excluded.doc`,
      )
      .run(doc.id, parent ?? null, doc.created_at ?? nowIso(), JSON.stringify(doc));
    return doc;
  }

  /** Oldest first. */
  list<T>(table: DocTable, parent?: string): T[] {
    const rows = (
      parent === undefined
        ? this.db.query(`SELECT doc FROM ${table} ORDER BY created_at, rowid`).all()
        : this.db.query(`SELECT doc FROM ${table} WHERE parent = ? ORDER BY created_at, rowid`).all(parent)
    ) as { doc: string }[];
    return rows.map((r) => JSON.parse(r.doc) as T);
  }

  delete(table: DocTable, id: string): boolean {
    return this.db.query(`DELETE FROM ${table} WHERE id = ?`).run(id).changes > 0;
  }

  deleteByParent(table: DocTable, parent: string): number {
    return this.db.query(`DELETE FROM ${table} WHERE parent = ?`).run(parent).changes;
  }

  // ---- event log ---------------------------------------------------------------

  /** Appends atomically: a model turn and the events it produced commit together or not at all. */
  appendEvents(sessionId: string, events: NewEvent[]): StoredEvent[] {
    const insert = this.db.query(
      "INSERT INTO events (id, session_id, type, body, internal) VALUES (?, ?, ?, ?, ?)",
    );
    const tx = this.db.transaction((batch: NewEvent[]) =>
      batch.map((e) => {
        const res = insert.run(
          e.body.id,
          sessionId,
          e.body.type,
          JSON.stringify(e.body),
          e.internal ? JSON.stringify(e.internal) : null,
        );
        return {
          seq: Number(res.lastInsertRowid),
          id: e.body.id,
          sessionId,
          type: e.body.type,
          body: e.body,
          internal: e.internal ?? null,
        } satisfies StoredEvent;
      }),
    );
    return tx(events);
  }

  listEvents(sessionId: string, opts: { afterSeq?: number; limit?: number; order?: "asc" | "desc" } = {}): StoredEvent[] {
    const order = opts.order === "desc" ? "DESC" : "ASC";
    const cmp = opts.order === "desc" ? "<" : ">";
    const after = opts.afterSeq ?? (opts.order === "desc" ? Number.MAX_SAFE_INTEGER : 0);
    const rows = this.db
      .query(
        `SELECT seq, id, session_id, type, body, internal FROM events
         WHERE session_id = ? AND seq ${cmp} ? ORDER BY seq ${order} LIMIT ?`,
      )
      .all(sessionId, after, opts.limit ?? -1) as {
      seq: number;
      id: string;
      session_id: string;
      type: string;
      body: string;
      internal: string | null;
    }[];
    return rows.map((r) => ({
      seq: r.seq,
      id: r.id,
      sessionId: r.session_id,
      type: r.type,
      body: JSON.parse(r.body),
      internal: r.internal ? JSON.parse(r.internal) : null,
    }));
  }

  deleteEvents(sessionId: string): void {
    this.db.query("DELETE FROM events WHERE session_id = ?").run(sessionId);
  }

  close() {
    this.db.close();
  }
}
