import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sandbox } from "../src/sandbox";
import { displayLines, globToRegExp, runBuiltinTool } from "../src/toolset";

const root = mkdtempSync(join(tmpdir(), "ma-sbx-"));
const sb = new Sandbox(root);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const longLine = Array.from({ length: 300 }, (_, i) => `<li>item ${i}</li>`).join("");
sb.writeFile("/mnt/session/uploads/pages/a.html", `<h1>Title</h1>\n${longLine}\n<p>footer</p>\n`);
sb.writeFile("/mnt/session/uploads/pages/b.html", "<p>other</p>\n");

test("long lines wrap at tag boundaries, and grep and read agree on numbering", () => {
  const lines = displayLines(longLine);
  expect(lines.length).toBeGreaterThan(4);
  expect(lines.every((l) => l.length <= 1000)).toBe(true);
  expect(lines.join("")).toBe(longLine);
  expect(lines.slice(0, -1).every((l) => l.endsWith(">"))).toBe(true);

  const grep = runBuiltinTool(sb, "grep", { pattern: "item 250<" });
  const m = grep.text.match(/a\.html:(\d+):/);
  expect(m).not.toBeNull();
  const read = runBuiltinTool(sb, "read", { file_path: "/mnt/session/uploads/pages/a.html", offset: Number(m![1]), limit: 1 });
  expect(read.text).toContain("item 250<");
});

test("grep modes, context, glob filter and head_limit", () => {
  expect(runBuiltinTool(sb, "grep", { pattern: "<p>", output_mode: "files_with_matches" }).text.split("\n").sort()).toEqual([
    "/mnt/session/uploads/pages/a.html",
    "/mnt/session/uploads/pages/b.html",
  ]);
  expect(runBuiltinTool(sb, "grep", { pattern: "<p>", glob: "b.*" }).text).toBe("/mnt/session/uploads/pages/b.html:1:<p>other</p>");
  expect(runBuiltinTool(sb, "grep", { pattern: "TITLE", ignore_case: true, context: 1 }).text).toContain("a.html-2-");
  expect(runBuiltinTool(sb, "grep", { pattern: "item", head_limit: 2 }).text).toContain("truncated at 2 lines");
  expect(runBuiltinTool(sb, "grep", { pattern: "(" }).isError).toBe(true);
});

test("glob matches relative to the search path, newest first", () => {
  expect(globToRegExp("**/*.html").test("pages/a.html")).toBe(true);
  expect(globToRegExp("**/*.html").test("a.html")).toBe(true);
  expect(globToRegExp("*.{ts,tsx}").test("x.tsx")).toBe(true);
  const out = runBuiltinTool(sb, "glob", { pattern: "**/*.html" }).text;
  expect(out).toContain("/mnt/session/uploads/pages/a.html");
  expect(runBuiltinTool(sb, "glob", { pattern: "*.html", path: "/mnt/session/uploads/pages" }).text).toContain("b.html");
  expect(runBuiltinTool(sb, "glob", { pattern: "*.none" }).text).toBe("No files found");
});

test("paths can't escape the sandbox, and writes stay under /mnt/session", () => {
  expect(sb.hostPath("/mnt/../../../etc/passwd")).toBe(join(root, "etc", "passwd"));
  expect(runBuiltinTool(sb, "read", { file_path: "relative.txt" }).isError).toBe(true);
  expect(runBuiltinTool(sb, "write", { file_path: "/etc/x", content: "no" }).isError).toBe(true);
  const w = runBuiltinTool(sb, "write", { file_path: "/mnt/session/outputs/home.tsx", content: "export default 1" });
  expect(w.written).toEqual(["/mnt/session/outputs/home.tsx"]);
  const e = runBuiltinTool(sb, "edit", { file_path: "/mnt/session/outputs/home.tsx", old_string: "1", new_string: "2" });
  expect(e.isError).toBe(false);
  expect(sb.readFile("/mnt/session/outputs/home.tsx").toString()).toBe("export default 2");
  expect(runBuiltinTool(sb, "read", { file_path: "/mnt/session/outputs/missing" }).text).toContain("does not exist");
});
