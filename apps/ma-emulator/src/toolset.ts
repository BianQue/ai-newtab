import { statSync } from "node:fs";
import { posix } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { SESSION_ROOT, Sandbox } from "./sandbox";

/**
 * The built-in `agent_toolset_20260401`, emulated. Tools run server-side against
 * the session's sandbox — the client never sees these calls except as
 * `agent.tool_use` / `agent.tool_result` events in the log.
 *
 * Only file tools are implemented. `bash`, `web_fetch` and `web_search` are
 * reported as unsupported if an agent enables them.
 */

export type BuiltinToolName = "read" | "write" | "edit" | "glob" | "grep";
export const SUPPORTED_BUILTINS: BuiltinToolName[] = ["read", "write", "edit", "glob", "grep"];
export const ALL_TOOLSET_NAMES = ["bash", "edit", "read", "write", "glob", "grep", "web_fetch", "web_search"] as const;

/** Physical lines longer than this are wrapped into several numbered display lines. */
const WRAP_AT = 1000;
const READ_DEFAULT_LIMIT = 2000;
const READ_MAX_CHARS = 60_000;
const GREP_DEFAULT_HEAD = 100;
const GLOB_MAX = 200;

const LONG_LINES_NOTE =
  `Lines longer than ${WRAP_AT} characters are wrapped into several numbered lines; ` +
  "grep and read share the same numbering.";

export const BUILTIN_TOOL_DEFS: Record<BuiltinToolName, Anthropic.Tool> = {
  read: {
    name: "read",
    description:
      "Read a file from the sandbox. Returns numbered lines (cat -n format). " +
      "Use offset/limit to read a range of a large file. " +
      LONG_LINES_NOTE,
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path of the file to read." },
        offset: { type: "integer", minimum: 1, description: "1-based line number to start at." },
        limit: { type: "integer", minimum: 1, description: `Number of lines to read (default ${READ_DEFAULT_LIMIT}).` },
      },
      required: ["file_path"],
    },
  },
  write: {
    name: "write",
    description:
      "Write a file to the sandbox, creating parent directories and overwriting any existing file. " +
      `Files written under /mnt/session/outputs/ are the session's deliverables.`,
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path of the file to write." },
        content: { type: "string", description: "Full file contents." },
      },
      required: ["file_path", "content"],
    },
  },
  edit: {
    name: "edit",
    description:
      "Replace an exact string in a file. old_string must be unique in the file unless replace_all is true.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },
  glob: {
    name: "glob",
    description:
      "Find files by glob pattern (supports *, **, ?, {a,b}), matched against the path relative to `path`. " +
      "Returns absolute paths, most recently modified first.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: 'e.g. "**/*.html"' },
        path: { type: "string", description: `Directory to search (default ${SESSION_ROOT}).` },
      },
      required: ["pattern"],
    },
  },
  grep: {
    name: "grep",
    description:
      "Search file contents with a JavaScript regular expression. output_mode 'content' (default) prints " +
      "matching lines as path:line:text with optional context; 'files_with_matches' lists files; 'count' " +
      "counts matches per file. " +
      LONG_LINES_NOTE,
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression." },
        path: { type: "string", description: `File or directory to search (default ${SESSION_ROOT}).` },
        glob: { type: "string", description: 'Only search files matching this glob, e.g. "*.html".' },
        output_mode: { type: "string", enum: ["content", "files_with_matches", "count"] },
        ignore_case: { type: "boolean" },
        context: { type: "integer", minimum: 0, description: "Lines of context around each match." },
        head_limit: { type: "integer", minimum: 1, description: `Max output lines (default ${GREP_DEFAULT_HEAD}).` },
      },
      required: ["pattern"],
    },
  },
};

export interface ToolOutcome {
  text: string;
  isError: boolean;
  /** Virtual paths this call created or modified. */
  written?: string[];
}

export function runBuiltinTool(sandbox: Sandbox, name: string, input: Record<string, any>): ToolOutcome {
  try {
    switch (name as BuiltinToolName) {
      case "read":
        return ok(read(sandbox, input));
      case "write":
        return write(sandbox, input);
      case "edit":
        return edit(sandbox, input);
      case "glob":
        return ok(glob(sandbox, input));
      case "grep":
        return ok(grep(sandbox, input));
      default:
        return { text: `Unknown tool: ${name}`, isError: true };
    }
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), isError: true };
  }
}

const ok = (text: string): ToolOutcome => ({ text, isError: false });

// ---------------------------------------------------------------------------

/** Split into display lines, wrapping very long physical lines (preferably after a `>`). */
export function displayLines(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    let rest = line;
    while (rest.length > WRAP_AT) {
      const window = rest.slice(0, WRAP_AT);
      const tagEnd = window.lastIndexOf(">");
      const cut = tagEnd >= WRAP_AT * 0.5 ? tagEnd + 1 : WRAP_AT;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    out.push(rest);
  }
  if (out.length > 1 && out[out.length - 1] === "" && text.endsWith("\n")) out.pop();
  return out;
}

function readText(sandbox: Sandbox, vpath: string): string {
  const host = sandbox.hostPath(vpath);
  let st;
  try {
    st = statSync(host);
  } catch {
    throw new Error(`File does not exist: ${vpath}`);
  }
  if (st.isDirectory()) throw new Error(`${vpath} is a directory. Use glob to list it.`);
  return sandbox.readFile(vpath).toString("utf-8");
}

function read(sandbox: Sandbox, input: Record<string, any>): string {
  const vpath = Sandbox.normalize(String(input.file_path ?? ""));
  const lines = displayLines(readText(sandbox, vpath));
  const offset = Math.max(1, Number(input.offset) || 1);
  const limit = Math.max(1, Number(input.limit) || READ_DEFAULT_LIMIT);
  if (offset > lines.length) return `<file has ${lines.length} lines; offset ${offset} is past the end>`;

  let out = "";
  let n = offset;
  for (; n < Math.min(lines.length + 1, offset + limit); n++) {
    const row = `${String(n).padStart(6)}\t${lines[n - 1]}\n`;
    if (out.length + row.length > READ_MAX_CHARS) {
      out += `<output truncated at ${READ_MAX_CHARS} characters; continue with offset=${n}>\n`;
      return out;
    }
    out += row;
  }
  if (n <= lines.length) out += `<${lines.length - n + 1} more lines; continue with offset=${n}>\n`;
  return out || "<empty file>";
}

function write(sandbox: Sandbox, input: Record<string, any>): ToolOutcome {
  const vpath = Sandbox.normalize(String(input.file_path ?? ""));
  if (typeof input.content !== "string") throw new Error("content must be a string");
  if (!vpath.startsWith(SESSION_ROOT + "/")) throw new Error(`Can only write under ${SESSION_ROOT}/`);
  sandbox.writeFile(vpath, input.content);
  return { text: `File written: ${vpath} (${input.content.length} chars)`, isError: false, written: [vpath] };
}

function edit(sandbox: Sandbox, input: Record<string, any>): ToolOutcome {
  const vpath = Sandbox.normalize(String(input.file_path ?? ""));
  const text = readText(sandbox, vpath);
  const oldStr = String(input.old_string ?? "");
  const newStr = String(input.new_string ?? "");
  if (!oldStr) throw new Error("old_string must not be empty");
  const count = text.split(oldStr).length - 1;
  if (count === 0) throw new Error("old_string not found in file");
  if (count > 1 && !input.replace_all) {
    throw new Error(`old_string occurs ${count} times; make it unique or set replace_all`);
  }
  const next = input.replace_all ? text.split(oldStr).join(newStr) : text.replace(oldStr, () => newStr);
  sandbox.writeFile(vpath, next);
  return { text: `Edited ${vpath} (${input.replace_all ? count : 1} replacement(s))`, isError: false, written: [vpath] };
}

/** Glob → RegExp over a `/`-separated relative path. */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        const slash = pattern[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) re += "\\{";
      else {
        re += "(?:" + pattern.slice(i + 1, end).split(",").map(escapeRe).join("|") + ")";
        i = end;
      }
    } else re += escapeRe(c);
  }
  return new RegExp(`^${re}$`);
}

const escapeRe = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");

function glob(sandbox: Sandbox, input: Record<string, any>): string {
  const base = Sandbox.normalize(String(input.path ?? SESSION_ROOT));
  const pattern = String(input.pattern ?? "").replace(/^\.\//, "");
  if (!pattern) throw new Error("pattern is required");
  // An absolute pattern is matched against the whole path.
  const matcher = globToRegExp(pattern.startsWith("/") ? pattern.slice(1) : pattern);
  const files = sandbox
    .walk(pattern.startsWith("/") ? "/" : base)
    .filter((f) => matcher.test(pattern.startsWith("/") ? f.vpath.slice(1) : posix.relative(base, f.vpath)))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (files.length === 0) return "No files found";
  const shown = files.slice(0, GLOB_MAX).map((f) => `${f.vpath} (${f.size} bytes)`);
  if (files.length > GLOB_MAX) shown.push(`<${files.length - GLOB_MAX} more not shown>`);
  return shown.join("\n");
}

function grep(sandbox: Sandbox, input: Record<string, any>): string {
  const base = Sandbox.normalize(String(input.path ?? SESSION_ROOT));
  let regex: RegExp;
  try {
    regex = new RegExp(String(input.pattern ?? ""), input.ignore_case ? "i" : "");
  } catch (err) {
    throw new Error(`Invalid regular expression: ${(err as Error).message}`);
  }
  const mode = input.output_mode ?? "content";
  const context = Math.max(0, Number(input.context) || 0);
  const headLimit = Math.max(1, Number(input.head_limit) || GREP_DEFAULT_HEAD);
  const globFilter = input.glob ? String(input.glob) : undefined;
  const globRe = globFilter ? globToRegExp(globFilter) : undefined;

  const out: string[] = [];
  let truncated = false;
  const push = (line: string) => {
    if (out.length >= headLimit) {
      truncated = true;
      return false;
    }
    out.push(line);
    return true;
  };

  for (const file of sandbox.walk(base)) {
    if (globRe) {
      // Like ripgrep: a slash-free glob matches the basename at any depth.
      const subject = globFilter!.includes("/") ? posix.relative(base, file.vpath) : posix.basename(file.vpath);
      if (!globRe.test(subject)) continue;
    }
    const buf = sandbox.readFile(file.vpath);
    if (buf.subarray(0, 8192).includes(0)) continue; // binary
    const lines = displayLines(buf.toString("utf-8"));
    const hits: number[] = [];
    lines.forEach((l, i) => regex.test(l) && hits.push(i));
    if (hits.length === 0) continue;

    if (mode === "files_with_matches") {
      if (!push(file.vpath)) break;
      continue;
    }
    if (mode === "count") {
      if (!push(`${file.vpath}:${hits.length}`)) break;
      continue;
    }
    // content
    let lastPrinted = -1;
    for (const hit of hits) {
      const from = Math.max(0, hit - context, lastPrinted + 1);
      const to = Math.min(lines.length - 1, hit + context);
      if (lastPrinted >= 0 && from > lastPrinted + 1 && context > 0) push("--");
      for (let i = from; i <= to; i++) {
        const marker = i === hit || hits.includes(i) ? ":" : "-";
        if (!push(`${file.vpath}${marker}${i + 1}${marker}${lines[i]}`)) break;
      }
      lastPrinted = to;
      if (truncated) break;
    }
    if (truncated) break;
  }

  if (out.length === 0) return "No matches found";
  if (truncated) out.push(`<output truncated at ${headLimit} lines; narrow the pattern or raise head_limit>`);
  return out.join("\n");
}
