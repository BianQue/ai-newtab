import type Anthropic from "@anthropic-ai/sdk";
import { GET_HISTORY_SCHEMA, GET_PAGE_HTML_SCHEMA } from "./schemas";
import { GLOB_SCHEMA, GREP_SCHEMA, READ_SCHEMA, WRITE_SCHEMA } from "./workspace";

/** Models offered in Settings. The first is the default. */
export const MODEL_CHOICES = [
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
] as const;

export type HomepageModel = (typeof MODEL_CHOICES)[number]["id"];

export const DEFAULT_MODEL: HomepageModel = "claude-sonnet-5-5";

export const STORAGE_KEYS = {
  apiKey: "apiKey",
  /** ID of the build in flight; present means a killed host should resume it. */
  activeSessionId: "activeSessionId",
  /** Conversation + workspace of the build in flight, saved after every turn. */
  buildCheckpoint: "buildCheckpoint",
} as const;

/**
 * Everything the model can call. The agent loop runs on the plain Messages API,
 * so all six tools execute on the host: the two browser tools through the
 * BrowserBridge, the four file tools against the in-memory Workspace.
 */
export const HOMEPAGE_TOOLS: Anthropic.Tool[] = [
  {
    name: "getHistory",
    description:
      "Returns a ranked digest of the user's most-visited domains over a recent " +
      "window: visit counts, unique page counts, last-visit timestamps, relevance " +
      "scores, and a few sample page titles per domain. Call this first, once.",
    input_schema: GET_HISTORY_SCHEMA,
  },
  {
    name: "getPageHtml",
    description:
      "Loads URLs in the user's real, logged-in browser, sanitizes the HTML, and " +
      "mounts each page into your sandbox. Returns a mountPath and byte count per " +
      "page plus a list of failures. Use grep/read on the returned mountPath. " +
      "Prefer this over any web fetch: it sees authenticated, JavaScript-rendered " +
      "pages that an anonymous fetch cannot.",
    input_schema: GET_PAGE_HTML_SCHEMA,
  },
  {
    name: "read",
    description: "Read a file in your sandbox with line numbers. Page HTML is split one tag per line.",
    input_schema: READ_SCHEMA,
  },
  {
    name: "grep",
    description: "Search files in your sandbox with a regular expression. Returns path:line: snippet per match.",
    input_schema: GREP_SCHEMA,
  },
  {
    name: "glob",
    description: "List files in your sandbox matching a glob, with their sizes.",
    input_schema: GLOB_SCHEMA,
  },
  {
    name: "write",
    description: "Write a file to your sandbox's outputs directory. Your only way to deliver the homepage.",
    input_schema: WRITE_SCHEMA,
  },
];
