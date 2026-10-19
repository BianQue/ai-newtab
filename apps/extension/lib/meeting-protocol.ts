import type { AuthState, MeetingSnapshot } from "@homepage/agent-core";
export { hasMeetingRuntime, isMeetingAuthorizationUrl as isTrustedAuthorizationUrl } from "@homepage/agent-core";

export const MEETING_PORT = "homepage-meetings";
export const MEETING_RUNTIME_VERSION = 1;
export const MEETING_MESSAGE = "homepage-meetings-v1";

export interface MeetingState {
  snapshot: MeetingSnapshot | null;
  auth: AuthState;
  loading: boolean;
  error: string | null;
  stale: boolean;
}

export const INITIAL_MEETING_STATE: MeetingState = {
  snapshot: null,
  auth: { status: "disconnected" },
  loading: false,
  error: null,
  stale: false,
};

export type MeetingCommand = "subscribe" | "refresh" | "connect";

export function isMeetingCommand(value: unknown): value is { kind: MeetingCommand } {
  if (!value || typeof value !== "object") return false;
  const keys = Object.keys(value);
  return keys.length === 1 && "kind" in value &&
    ["subscribe", "refresh", "connect"].includes(String(value.kind));
}

/** Opaque iframe origins need the actual window and a per-preview channel. */
export function meetingFrameAction(
  event: Pick<MessageEvent, "source" | "data">,
  frame: Window | null,
  channel: string,
): "ready" | "refresh" | "connect" | null {
  if (!frame || event.source !== frame) return null;
  const data = event.data;
  if (!data || typeof data !== "object" || Object.keys(data).length !== 3 ||
    data.type !== MEETING_MESSAGE || data.channel !== channel) return null;
  return ["ready", "refresh", "connect"].includes(data.action) ? data.action : null;
}

/** Only this projection crosses into generated code. Auth URLs stay in trusted UI. */
export function meetingFrameState(state: MeetingState) {
  return {
    snapshot: state.snapshot,
    loading: state.loading,
    error: state.error,
    stale: state.stale,
    connectionStatus: state.auth.status,
  };
}

