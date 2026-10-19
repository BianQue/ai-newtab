import { expect, test } from "bun:test";
import { hasMeetingRuntime, isAuthState, isMeetingSnapshot, isSafeMeetingLink, type MeetingSnapshot } from "@homepage/agent-core";

const snapshot: MeetingSnapshot = {
  schemaVersion: 1,
  revision: 1,
  fetchedAt: "2026-10-19T01:00:00.000Z",
  timezone: "Asia/Shanghai",
  window: {
    todayStart: "2026-10-18T16:00:00.000Z",
    todayEnd: "2026-10-19T16:00:00.000Z",
    weekStart: "2026-10-12T01:00:00.000Z",
    now: "2026-10-19T01:00:00.000Z",
  },
  status: "ready",
  meetings: [],
  summaries: [],
};

test("meeting snapshots accept empty success and untrusted text while rejecting malformed or secret fields", () => {
  expect(isMeetingSnapshot(snapshot)).toBe(true);
  const full = {
    ...snapshot,
    meetings: [{ id: "instance-a", subject: "<script>alert(1)</script>", startTime: snapshot.fetchedAt, endTime: snapshot.fetchedAt, status: "ended", joinUrl: "https://meeting.tencent.com/example" }],
    summaries: [{ id: "instance-a", subject: "Example", startTime: snapshot.fetchedAt, endTime: snapshot.fetchedAt, summary: "<b>Original summary</b>", summaryStatus: "available" }],
  };
  expect(isMeetingSnapshot(full)).toBe(true);
  expect(isMeetingSnapshot({ ...snapshot, token: "private" })).toBe(false);
  expect(isMeetingSnapshot({ ...snapshot, revision: -1 })).toBe(false);
  expect(isMeetingSnapshot({ ...snapshot, fetchedAt: "invalid" })).toBe(false);
  expect(isMeetingSnapshot({ ...snapshot, fetchedAt: "1" })).toBe(false);
  expect(isMeetingSnapshot({ ...snapshot, meetings: [{ ...full.meetings[0], joinUrl: "javascript:alert(1)" }] })).toBe(false);
  expect(isMeetingSnapshot({ ...snapshot, meetings: [{ ...full.meetings[0], accessToken: "private" }] })).toBe(false);
  expect(isMeetingSnapshot({ ...snapshot, summaries: [{ ...full.summaries[0], summaryStatus: "unknown" }] })).toBe(false);
  expect(isMeetingSnapshot({ ...snapshot, window: { ...snapshot.window, token: "private" } })).toBe(false);
});

test("runtime metadata requires a hook import and invocation", () => {
  expect(hasMeetingRuntime("import { useMeetingData } from '@homepage/meetings'; function Page() { return useMeetingData(); }")).toBe(true);
  expect(hasMeetingRuntime("import React from 'react'; import {useMeetingData} from '@homepage/meetings'; export default function Page() { return useMeetingData(); }")).toBe(true);
  expect(hasMeetingRuntime("import { useMeetingData } from '@homepage/meetings'; export default () => <div />;")).toBe(false);
  expect(hasMeetingRuntime("export default () => <div>@homepage/meetings</div>;")).toBe(false);
});

test("trusted auth envelopes reject credential fields and unsafe URL schemes", () => {
  expect(isAuthState({ status: "connected", accountRevision: "a".repeat(64) })).toBe(true);
  expect(isAuthState({ status: "connected", accountRevision: "raw-account-id" })).toBe(false);
  expect(isAuthState({ status: "pending", requestId: "request-a", authorizationUrl: "https://meeting.tencent.com/authorize" })).toBe(true);
  expect(isAuthState({ status: "connected", accessToken: "private" })).toBe(false);
  expect(isAuthState({ status: "pending", authorizationUrl: "javascript:alert(1)" })).toBe(false);
  expect(isSafeMeetingLink("https://user:password@meeting.tencent.com/")).toBe(false);
  expect(isSafeMeetingLink("https://meeting.tencent.com/")).toBe(true);
});
