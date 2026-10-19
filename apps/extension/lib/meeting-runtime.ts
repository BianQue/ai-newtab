import { MEETING_MESSAGE } from "./meeting-protocol";

/** Data/actions only: each generated page owns its meeting layout and styles. */
export function meetingRuntimeSource(channel: string): string {
  return `import { useEffect, useSyncExternalStore } from "react";
const channel = ${JSON.stringify(channel)};
const type = ${JSON.stringify(MEETING_MESSAGE)};
let current = { snapshot: null, loading: true, error: null, stale: false, connectionStatus: "disconnected" };
const listeners = new Set();
let sequence = -1;
const send = (action) => parent.postMessage({ type, channel, action }, "*");
window.addEventListener("message", (event) => {
  const data = event.data;
  if (event.source !== parent || !data || data.type !== type || data.channel !== channel ||
      !Number.isSafeInteger(data.sequence) || data.sequence <= sequence || !data.state ||
      typeof data.state.loading !== "boolean" || typeof data.state.stale !== "boolean") return;
  sequence = data.sequence;
  current = data.state;
  listeners.forEach((listener) => listener());
});
const subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
const getSnapshot = () => current;
const refresh = () => send("refresh");
const connect = () => send("connect");
export function useMeetingData() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    send("ready");
    const timer = setInterval(() => { if (sequence < 0) send("ready"); }, 500);
    return () => clearInterval(timer);
  }, []);
  return { ...state, refresh, connect };
}`;
}
