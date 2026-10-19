import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function verify(imports = "", content = "") {
  const directory = mkdtempSync(join(tmpdir(), "homepage-verify-"));
  directories.push(directory);
  const path = join(directory, "homepage.tsx");
  writeFileSync(path, `import React from "react";
${imports}
export default function PersonalizedHomepage() {
  ${content}
  return <main><p>${"Reading material ".repeat(50)}</p>
    {[0, 1, 2, 3, 4].map(i => <a key={i} href={"https://source.test/story/" + i}>Story {i}</a>)}
  </main>;
}`);
  return Bun.spawnSync([process.execPath, fileURLToPath(new URL("./verify-homepage.ts", import.meta.url)), path], {
    cwd: process.cwd(),
  });
}

test("standalone verifier keeps supporting historical React-only homepages", () => {
  const result = verify();
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("VERIFIED");
});

test("standalone verifier renders the unavailable meeting state without a service or session", () => {
  const result = verify(
    `import { useMeetingData } from "@homepage/meetings";`,
    `const data = useMeetingData();
    if (data.snapshot !== null || data.loading || data.connectionStatus !== "unavailable" || !data.error)
      throw new Error("Incorrect standalone state");
    data.refresh(); data.connect();`,
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("VERIFIED");
});

test("standalone verifier still rejects arbitrary imports", () => {
  const result = verify(`import { readFileSync } from "node:fs";`, "readFileSync;");
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain('only "react" and "@homepage/meetings" are allowed');
});
