# Agent Skills

## Issue tracker

Use GitHub Issues in BianQue/ai-newtab. See docs/agents/issue-tracker.md. Leave issues open for user acceptance.

## Domain docs

Use a single repository-wide context. See docs/agents/domain.md. Feature specifications live in docs/specs/.

## Implementation

Follow existing TypeScript, Bun, React and WXT patterns. Keep credentials out of browser-generated code, logs and tracker content. Test observable behavior at existing integration boundaries. Do not weaken existing session cleanup or sandbox boundaries for integrations.
