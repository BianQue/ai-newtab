import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { Store } from "./store";
import { ApiError, newId, notFound, nowIso } from "./util";

/** Public shape — matches the SDK's `FileMetadata`. Keys starting with `_` are private. */
export interface FileDoc {
  id: string;
  created_at: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  type: "file";
  downloadable: boolean;
  scope: { type: "session"; id: string } | null;
  /** For session outputs: the sandbox path this file was captured from. */
  _vpath?: string;
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".js": "text/javascript",
  ".jsx": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".css": "text/css",
  ".csv": "text/csv",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

export const mimeFor = (filename: string, fallback = "application/octet-stream") =>
  MIME[posix.extname(filename).toLowerCase()] ?? fallback;

export const publicFile = ({ _vpath, ...doc }: FileDoc) => doc;

/**
 * The Files API. Uploads persist independently of any session (that is why the
 * orchestrator deletes them itself); session outputs are files scoped to the
 * session that wrote them, and go away with it.
 */
export class FileService {
  private readonly blobDir: string;

  constructor(private readonly store: Store) {
    this.blobDir = join(store.dataDir, "files");
    mkdirSync(this.blobDir, { recursive: true });
  }

  upload(bytes: Uint8Array, filename: string, mimeType?: string): FileDoc {
    const doc: FileDoc = {
      id: newId("file"),
      created_at: nowIso(),
      filename,
      mime_type: mimeType && mimeType !== "application/octet-stream" ? mimeType : mimeFor(filename),
      size_bytes: bytes.byteLength,
      type: "file",
      // Like the real API: what you upload can be used, not downloaded back.
      downloadable: false,
      scope: null,
    };
    writeFileSync(this.blobPath(doc.id), bytes);
    return this.store.put("files", doc, null);
  }

  /** Capture (or refresh) a session output file written to the sandbox. */
  captureOutput(sessionId: string, vpath: string, bytes: Uint8Array): FileDoc {
    const existing = this.store.list<FileDoc>("files", sessionId).find((f) => f._vpath === vpath);
    const filename = posix.basename(vpath);
    const doc: FileDoc = {
      id: existing?.id ?? newId("file"),
      created_at: existing?.created_at ?? nowIso(),
      filename,
      mime_type: mimeFor(filename, "text/plain"),
      size_bytes: bytes.byteLength,
      type: "file",
      downloadable: true,
      scope: { type: "session", id: sessionId },
      _vpath: vpath,
    };
    writeFileSync(this.blobPath(doc.id), bytes);
    return this.store.put("files", doc, sessionId);
  }

  get(id: string): FileDoc {
    const doc = this.store.get<FileDoc>("files", id);
    if (!doc) throw notFound("File", id);
    return doc;
  }

  bytes(id: string): Uint8Array {
    return readFileSync(this.blobPath(this.get(id).id));
  }

  download(id: string): { doc: FileDoc; bytes: Uint8Array } {
    const doc = this.get(id);
    if (!doc.downloadable) {
      throw new ApiError(400, "invalid_request_error", `File ${id} is not downloadable`);
    }
    return { doc, bytes: this.bytes(id) };
  }

  /** Newest first, like the real API. */
  list(scopeId?: string): FileDoc[] {
    const all = scopeId ? this.store.list<FileDoc>("files", scopeId) : this.store.list<FileDoc>("files");
    return all.reverse();
  }

  delete(id: string): void {
    this.get(id);
    this.store.delete("files", id);
    rmSync(this.blobPath(id), { force: true });
  }

  deleteScope(sessionId: string): void {
    for (const f of this.store.list<FileDoc>("files", sessionId)) this.delete(f.id);
  }

  private blobPath(id: string): string {
    if (!/^file_[A-Za-z0-9]+$/.test(id)) throw notFound("File", id);
    return join(this.blobDir, id);
  }
}
