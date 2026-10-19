import { useCallback, useEffect, useRef, useState } from "react";
import { INITIAL_MEETING_STATE, MEETING_PORT, type MeetingCommand, type MeetingState } from "@/lib/meeting-protocol";

export function useMeetings() {
  const [state, setState] = useState<MeetingState>(INITIAL_MEETING_STATE);
  const port = useRef<ReturnType<typeof browser.runtime.connect> | null>(null);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (disposed) return;
      const next = browser.runtime.connect({ name: MEETING_PORT });
      port.current = next;
      next.onMessage.addListener((message) => {
        if (message?.kind === "meetings") setState(message.state);
      });
      next.onDisconnect.addListener(() => {
        port.current = null;
        if (!disposed) timer = setTimeout(connect, 500);
      });
      next.postMessage({ kind: "subscribe" });
    };
    connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      port.current?.disconnect();
    };
  }, []);
  const send = useCallback((kind: MeetingCommand) => port.current?.postMessage({ kind }), []);
  const refresh = useCallback(() => send("refresh"), [send]);
  const connect = useCallback(() => send("connect"), [send]);
  return { state, refresh, connect };
}
