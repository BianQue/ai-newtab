import { SandpackLayout, SandpackPreview, SandpackProvider } from "@codesandbox/sandpack-react";
import { useEffect, useMemo, useRef } from "react";
import { MEETING_MESSAGE, meetingFrameAction, meetingFrameState, type MeetingState } from "@/lib/meeting-protocol";
import { meetingRuntimeSource } from "@/lib/meeting-runtime";

const INDEX_JS = `import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);`;

const INDEX_HTML = `<!DOCTYPE html>
<html><head><title>My Personalized Homepage</title></head>
<body><div id="root"></div></body></html>`;

/**
 * Renders the agent's component in a Sandpack iframe. The code is
 * model-generated, so it runs sandboxed rather than in the extension's own page.
 */
export function HomepagePreview({
  code, meetingState, onRefreshMeetings, onConnectMeetings, meetingRuntimeVersion,
}: {
  code: string;
  meetingState: MeetingState;
  onRefreshMeetings(): void;
  onConnectMeetings(): void;
  meetingRuntimeVersion?: 1;
}) {
  const container = useRef<HTMLDivElement>(null);
  const channel = useMemo(() => crypto.randomUUID(), [code]);
  const latest = useRef({ meetingState, onRefreshMeetings, onConnectMeetings });
  latest.current = { meetingState, onRefreshMeetings, onConnectMeetings };
  const ready = useRef<Window | null>(null);
  const sequence = useRef(0);
  const files = useMemo(() => ({
    "/App.js": { code },
    "/index.js": { code: INDEX_JS },
    "/index.html": { code: INDEX_HTML },
    ...(meetingRuntimeVersion === 1 ? {
      "/node_modules/@homepage/meetings/package.json": { code: JSON.stringify({ name: "@homepage/meetings", main: "./index.js" }) },
      "/node_modules/@homepage/meetings/index.js": { code: meetingRuntimeSource(channel) },
    } : {}),
  }), [code, channel, meetingRuntimeVersion]);

  useEffect(() => {
    ready.current = null;
    sequence.current = 0;
    if (meetingRuntimeVersion !== 1) return;
    const send = () => {
      const frame = container.current?.querySelector("iframe")?.contentWindow;
      if (!frame || ready.current !== frame) return;
      frame.postMessage({
        type: MEETING_MESSAGE, channel, sequence: sequence.current++,
        state: meetingFrameState(latest.current.meetingState),
      }, "*");
    };
    const receive = (event: MessageEvent) => {
      const frame = container.current?.querySelector("iframe")?.contentWindow ?? null;
      const action = meetingFrameAction(event, frame, channel);
      if (!action) return;
      if (action === "ready") {
        ready.current = frame;
        send();
      } else if (ready.current === frame) {
        if (action === "refresh") latest.current.onRefreshMeetings();
        else latest.current.onConnectMeetings();
      }
    };
    window.addEventListener("message", receive);
    return () => { window.removeEventListener("message", receive); ready.current = null; };
  }, [channel, meetingRuntimeVersion]);

  useEffect(() => {
    const frame = container.current?.querySelector("iframe")?.contentWindow;
    if (!frame || ready.current !== frame) return;
    frame.postMessage({
      type: MEETING_MESSAGE, channel, sequence: sequence.current++,
      state: meetingFrameState(meetingState),
    }, "*");
  }, [meetingState, channel]);

  return (
    <div ref={container} style={{ flex: 1, minHeight: 0 }}>
    <SandpackProvider key={channel} files={files} template="react" options={{ autorun: true }} style={{ height: "100%" }}>
      <SandpackLayout style={{ height: "100%", width: "100%", boxSizing: "border-box" }}>
        <SandpackPreview style={{ height: "100%" }} />
      </SandpackLayout>
    </SandpackProvider>
    </div>
  );
}
