import { HOMEPAGE_BASE_PROMPT } from "./prompt";
import { MEETING_RUNTIME_RULES } from "./meeting-runtime-rules";
import { MEETING_PRESENTATION_RULES } from "./meeting-presentation-rules";

export const DEFAULT_FRONTEND_RULES: readonly string[] = [MEETING_PRESENTATION_RULES];

export function buildHomepageSystemPrompt(frontendRules: readonly string[] = DEFAULT_FRONTEND_RULES): string {
  return [HOMEPAGE_BASE_PROMPT, MEETING_RUNTIME_RULES, ...frontendRules].join("\n\n");
}
