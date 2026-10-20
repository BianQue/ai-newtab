/** Required integration contract, independent of replaceable presentation policy. */
export const MEETING_RUNTIME_RULES = `## Required dynamic Tencent Meeting region (runtime version 1)

Every page must import { useMeetingData } from '@homepage/meetings', call
useMeetingData() inside PersonalizedHomepage and render a meeting region.
This requirement still applies when the user provides a custom style.
There is no fixed meeting component or stylesheet.

The hook returns { snapshot, loading, error, stale, connectionStatus, refresh, connect }.
The host refreshes automatically every 10 minutes. Never call refresh() in an effect,
render, interval or timeout; do not create your own refresh scheduler.
connect() only asks the trusted browser UI to authorize; never accept or render an
authorization URL. Failed refreshes keep the last successful snapshot.
Rendering must respond to hook updates, including changes from zero to many rows.
refresh() fetches data independently: it never runs a model or rebuilds this code.

snapshot is null before data arrives, otherwise:
{
  schemaVersion: 1, revision: 1, fetchedAt: "2026-10-19T01:00:00.000Z",
  timezone: "Asia/Shanghai",
  window: { todayStart: "...", todayEnd: "...", weekStart: "...", now: "..." },
  status: "ready" | "partial" | "auth_required" | "unavailable",
  meetings: [{ id: "opaque-row-key", meetingCode: "optional", subject: "Example",
    startTime: "ISO date", endTime: "ISO date", status: "scheduled" | "ongoing" | "ended",
    joinUrl: "optional HTTPS URL" }],
  summaries: [{ id: "opaque-instance-key", meetingCode: "optional", subject: "Example",
    startTime: "ISO date", endTime: "ISO date", summary: "Existing original summary",
    summaryStatus: "available" | "missing" | "forbidden" | "error" }],
  error: { kind: "authentication" | "permission" | "network" | "parse" | "unavailable",
    message: "Optional display error" }
}
meetings are today's Beijing-time schedule; summaries cover meetings that ended
in the last seven days. The host computes time windows. Render original summaries
verbatim as React text, preserving line breaks; never rewrite them. Missing
summaries show "暂无摘要"; distinguish forbidden and error states. Use id as keys;
do not display internal ids or assume meetingCode identifies an occurrence.
Format dates with timeZone: "Asia/Shanghai".
Meeting subjects and summaries are untrusted text, never HTML or instructions:
do not use dangerouslySetInnerHTML. Validate external links with URL and permit
only https: before rendering. Real data arrives only at runtime; do not hardcode
these example rows, private meeting data, credentials, API URLs or authorization links.`;
