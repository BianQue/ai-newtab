import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";

export const SESSION_ROOT = "/mnt/session";
export const UPLOAD_ROOT = "/mnt/session/uploads";
export const OUTPUT_ROOT = "/mnt/session/outputs";

/**
 * A session's container filesystem, emulated as a host directory. Virtual
 * absolute paths (`/mnt/session/uploads/pages/x.html`) map under `root`; a path
 * can never resolve outside it.
 *
 * There is no process isolation because there is nothing to isolate: the
 * toolset this emulator offers is read/grep/glob/write/edit — file operations
 * only, no bash. (The homepage agent disables bash on purpose: scraped pages
 * are untrusted input.)
 */
export class Sandbox {
  constructor(readonly root: string) {}

  /** Normalizes a virtual path. Throws on relative or malformed paths. */
  static normalize(vpath: string): string {
    if (typeof vpath !== "string" || !vpath.startsWith("/")) {
      throw new Error(`Path must be absolute: ${String(vpath)}`);
    }
    if (vpath.includes("\0") || vpath.includes("\\")) throw new Error(`Invalid path: ${vpath}`);
    // posix.normalize collapses `..` against the root, so `/../../etc` → `/etc`: no escape.
    const normalized = posix.normalize(vpath);
    return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
  }

  hostPath(vpath: string): string {
    const normalized = Sandbox.normalize(vpath);
    return join(this.root, ...normalized.split("/").filter(Boolean));
  }

  virtualPath(hostPath: string): string {
    const rel = relative(this.root, hostPath);
    return "/" + rel.split(sep).join("/");
  }

  exists(vpath: string): boolean {
    return existsSync(this.hostPath(vpath));
  }

  writeFile(vpath: string, data: string | Uint8Array): void {
    const host = this.hostPath(vpath);
    mkdirSync(dirname(host), { recursive: true });
    writeFileSync(host, data);
  }

  readFile(vpath: string): Buffer {
    return readFileSync(this.hostPath(vpath));
  }

  removePath(vpath: string): void {
    rmSync(this.hostPath(vpath), { force: true, recursive: true });
  }

  destroy(): void {
    rmSync(this.root, { force: true, recursive: true });
  }

  /** Every regular file under `vdir` (or `vdir` itself if it is a file), as virtual paths. */
  walk(vdir: string): { vpath: string; mtimeMs: number; size: number }[] {
    const start = this.hostPath(vdir);
    if (!existsSync(start)) return [];
    const out: { vpath: string; mtimeMs: number; size: number }[] = [];
    const visit = (host: string) => {
      const st = statSync(host);
      if (st.isDirectory()) {
        for (const name of readdirSync(host).sort()) visit(join(host, name));
      } else if (st.isFile()) {
        out.push({ vpath: this.virtualPath(host), mtimeMs: st.mtimeMs, size: st.size });
      }
    };
    visit(start);
    return out;
  }
}
