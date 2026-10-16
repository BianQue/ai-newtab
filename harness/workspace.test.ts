import { expect, test } from "bun:test";
import { Workspace } from "@homepage/agent-core";

const PAGE = "/mnt/session/uploads/pages/news_0.html";

function workspace() {
  const ws = new Workspace();
  ws.put(PAGE, ["<h1>News</h1>", "<a href=\"/story/1\">Rust 2.0 released</a>", "<p>footer</p>"].join("\n"));
  return ws;
}

test("grep reports path, line and a snippet around the match", () => {
  expect(workspace().run("grep", { pattern: "rust" })).toBe(`${PAGE}:2: <a href="/story/1">Rust 2.0 released</a>`);
  expect(workspace().run("grep", { pattern: "nothing-here" })).toBe("No matches.");
});

test("read pages through a file by line", () => {
  const ws = workspace();
  expect(ws.run("read", { path: PAGE, limit: 1 })).toBe(`1\t<h1>News</h1>\n[2 more lines; continue with offset=2]`);
  expect(ws.run("read", { path: PAGE, offset: 3 })).toBe("3\t<p>footer</p>");
  expect(() => ws.run("read", { path: "/missing.html" })).toThrow(/No such file/);
});

test("glob matches within and across segments", () => {
  const ws = workspace();
  expect(ws.run("glob", { pattern: "/mnt/session/uploads/**/*.html" })).toContain(PAGE);
  expect(ws.run("glob", { pattern: "/mnt/session/uploads/*.html" })).toBe("No files matched.");
});

test("write only lands in the outputs directory", () => {
  const ws = workspace();
  expect(() => ws.run("write", { path: PAGE, content: "x" })).toThrow(/limited to/);
  ws.run("write", { path: "/mnt/session/outputs/homepage.tsx", content: "export default 1" });
  expect(ws.get("/mnt/session/outputs/homepage.tsx")).toBe("export default 1");
});
