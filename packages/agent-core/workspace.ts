import type { ToolInputSchema } from "./schemas";

/**
 * An in-memory stand-in for the session sandbox: scraped pages are written here
 * and the model works on them through read / grep / glob / write, all executed
 * locally. Nothing in it ever leaves the host except what a tool returns.
 */

/** Scraped pages land under this root. Kept from the sandbox layout so the prompt reads the same. */
export const UPLOAD_ROOT = "/mnt/session/uploads";
/** The only directory `write` may touch, so the model can't overwrite a page it is reading. */
export const OUTPUT_ROOT = "/mnt/session/outputs";

/** Every tool result is capped so a single call can't flood the context window. */
const MAX_RESULT_CHARS = 40_000;
const MAX_READ_LINE_CHARS = 2_000;
const GREP_SNIPPET_RADIUS = 150;
const DEFAULT_READ_LIMIT = 400;
const DEFAULT_GREP_RESULTS = 50;

export const READ_SCHEMA: ToolInputSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "Absolute path of the file to read." },
    offset: { type: "integer", minimum: 1, description: "1-based line to start at. Default 1." },
    limit: { type: "integer", minimum: 1, maximum: 2000, description: `Lines to return. Default ${DEFAULT_READ_LIMIT}.` },
  },
  required: ["path"],
};

export const GREP_SCHEMA: ToolInputSchema = {
  type: "object",
  properties: {
    pattern: { type: "string", description: "JavaScript regular expression." },
    path: { type: "string", description: "A file, or a directory to search recursively. Default: every file." },
    ignoreCase: { type: "boolean", description: "Default true." },
    context: { type: "integer", minimum: 0, maximum: 5, description: "Lines of context around each match. Default 0." },
    maxResults: { type: "integer", minimum: 1, maximum: 200, description: `Default ${DEFAULT_GREP_RESULTS}.` },
  },
  required: ["pattern"],
};

export const GLOB_SCHEMA: ToolInputSchema = {
  type: "object",
  properties: {
    pattern: { type: "string", description: "Glob such as /mnt/session/uploads/**/*.html. `*` stays within a segment, `**` crosses them." },
  },
  required: ["pattern"],
};

export const WRITE_SCHEMA: ToolInputSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: `Absolute path under ${OUTPUT_ROOT}/.` },
    content: { type: "string", description: "The full file contents." },
  },
  required: ["path", "content"],
};

export const WORKSPACE_TOOL_NAMES = ["read", "grep", "glob", "write"] as const;

function normalizePath(path: string): string {
  return ("/" + path.trim()).replace(/\/+/g, "/").replace(/\/$/, "");
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more chars]`;
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*" && pattern[i + 1] === "*") {
      source += ".*";
      i++;
      if (pattern[i + 1] === "/") i++; // `**/` also matches zero directories
    } else if (c === "*") source += "[^/]*";
    else if (c === "?") source += "[^/]";
    else source += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

export class Workspace {
  private readonly files = new Map<string, string>();

  constructor(initial?: Record<string, string>) {
    for (const [path, content] of Object.entries(initial ?? {})) this.files.set(path, content);
  }

  /** Plain-object copy, for checkpointing. */
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.files);
  }

  get(path: string): string | undefined {
    return this.files.get(normalizePath(path));
  }

  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  /** Host-side write: no output-dir restriction. Returns the stored path. */
  put(path: string, content: string): string {
    const normalized = normalizePath(path);
    this.files.set(normalized, content);
    return normalized;
  }

  /** Run one of the model-facing tools. Throws on bad input; the caller reports it as a tool error. */
  run(name: string, input: Record<string, unknown>): string {
    switch (name) {
      case "read":
        return this.read(input as { path: string; offset?: number; limit?: number });
      case "grep":
        return this.grep(input as { pattern: string; path?: string; ignoreCase?: boolean; context?: number; maxResults?: number });
      case "glob":
        return this.glob(input as { pattern: string });
      case "write":
        return this.write(input as { path: string; content: string });
      default:
        throw new Error(`Unknown workspace tool: ${name}`);
    }
  }

  private require(path: string): string {
    const content = this.get(path);
    if (content === undefined) {
      throw new Error(`No such file: ${path}. Existing files:\n${this.paths().join("\n") || "(none)"}`);
    }
    return content;
  }

  private read({ path, offset = 1, limit = DEFAULT_READ_LIMIT }: { path: string; offset?: number; limit?: number }): string {
    const lines = this.require(path).split("\n");
    const start = Math.max(1, offset);
    const out: string[] = [];
    let size = 0;
    let line = start;
    for (; line < start + limit && line <= lines.length; line++) {
      const row = `${line}\t${clip(lines[line - 1]!, MAX_READ_LINE_CHARS)}`;
      if (size + row.length > MAX_RESULT_CHARS) break;
      out.push(row);
      size += row.length + 1;
    }
    if (line <= lines.length) out.push(`[${lines.length - line + 1} more lines; continue with offset=${line}]`);
    return out.join("\n") || `[empty range; the file has ${lines.length} lines]`;
  }

  private grep({
    pattern,
    path,
    ignoreCase = true,
    context = 0,
    maxResults = DEFAULT_GREP_RESULTS,
  }: { pattern: string; path?: string; ignoreCase?: boolean; context?: number; maxResults?: number }): string {
    const regex = new RegExp(pattern, ignoreCase ? "i" : "");
    const scope = path ? normalizePath(path) : "";
    const targets = this.paths().filter((p) => !scope || p === scope || p.startsWith(scope + "/"));
    if (scope && targets.length === 0) this.require(scope);

    const out: string[] = [];
    let matches = 0;
    let size = 0;
    for (const file of targets) {
      const lines = this.files.get(file)!.split("\n");
      for (let i = 0; i < lines.length && matches < maxResults; i++) {
        const hit = regex.exec(lines[i]!);
        if (!hit) continue;
        matches++;
        const from = Math.max(0, i - context);
        const to = Math.min(lines.length - 1, i + context);
        for (let j = from; j <= to; j++) {
          const text = lines[j]!;
          // Trim long lines to a window around the match so one minified line can't eat the budget.
          const center = j === i ? hit.index : 0;
          const begin = Math.max(0, center - GREP_SNIPPET_RADIUS);
          const snippet = text.slice(begin, begin + GREP_SNIPPET_RADIUS * 2);
          const row = `${file}:${j + 1}${j === i ? ":" : "-"} ${begin > 0 ? "…" : ""}${snippet}${begin + snippet.length < text.length ? "…" : ""}`;
          if (size + row.length > MAX_RESULT_CHARS) return out.join("\n") + "\n[output truncated]";
          out.push(row);
          size += row.length + 1;
        }
      }
      if (matches >= maxResults) {
        out.push(`[stopped at maxResults=${maxResults}]`);
        break;
      }
    }
    return out.join("\n") || "No matches.";
  }

  private glob({ pattern }: { pattern: string }): string {
    const regex = globToRegExp(normalizePath(pattern));
    const hits = this.paths().filter((p) => regex.test(p));
    return hits.map((p) => `${p} (${this.files.get(p)!.length}b)`).join("\n") || "No files matched.";
  }

  private write({ path, content }: { path: string; content: string }): string {
    const normalized = normalizePath(path);
    if (!normalized.startsWith(OUTPUT_ROOT + "/")) {
      throw new Error(`write is limited to ${OUTPUT_ROOT}/; got ${normalized}`);
    }
    this.files.set(normalized, content);
    return `Wrote ${content.length} chars to ${normalized}.`;
  }
}
