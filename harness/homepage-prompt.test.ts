import { expect, test } from "bun:test";
import { buildHomepageSystemPrompt } from "../packages/agent-core/homepage-prompt";
import { HOMEPAGE_BASE_PROMPT } from "../packages/agent-core/prompt";
import { MEETING_RUNTIME_RULES } from "../packages/agent-core/meeting-runtime-rules";
import { MEETING_PRESENTATION_RULES } from "../packages/agent-core/meeting-presentation-rules";

test("default generation combines core, required contract and meeting presentation once", () => {
  const prompt = buildHomepageSystemPrompt();
  expect(prompt).toBe([HOMEPAGE_BASE_PROMPT, MEETING_RUNTIME_RULES, MEETING_PRESENTATION_RULES].join("\n\n"));
  expect(HOMEPAGE_BASE_PROMPT).not.toContain("three lines");
});

test("presentation rules can be replaced and composed in order without removing the contract", () => {
  const rules = ["## Compact layout\nUse compact spacing.", "## Status\nUse a quiet status label."];
  expect(buildHomepageSystemPrompt(rules)).toBe([HOMEPAGE_BASE_PROMPT, MEETING_RUNTIME_RULES, ...rules].join("\n\n"));
  expect(buildHomepageSystemPrompt(rules)).not.toContain(MEETING_PRESENTATION_RULES);
  expect(buildHomepageSystemPrompt([])).toContain(MEETING_RUNTIME_RULES);
  expect(rules).toHaveLength(2);
});
