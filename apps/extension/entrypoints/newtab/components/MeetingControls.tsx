import { useState } from "react";
import { isTrustedAuthorizationUrl, type MeetingState } from "@/lib/meeting-protocol";
import { saveSetting } from "@/lib/storage";
import { btn, errorBox } from "./ui";

export function MeetingControls({
  state, onRefresh, onConnect, hasRuntime, onRebuild,
}: {
  state: MeetingState;
  onRefresh(): void;
  onConnect(): void;
  hasRuntime: boolean;
  onRebuild(): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [key, setKey] = useState("");
  const authorizationUrl = state.auth.authorizationUrl;
  const pending = state.auth.status === "pending";
  return <div style={{ position: "relative" }}>
    <button style={btn} onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
      Tencent Meeting{pending ? " - Authorization required" : ""}
    </button>
    {expanded && <section aria-label="Tencent Meeting connection" style={{
      position: "fixed", right: 20, top: 66, width: 320, maxWidth: "calc(100vw - 40px)",
      boxSizing: "border-box", padding: 16, border: "1px solid #ddd", borderRadius: 4,
      background: "white", color: "#222", boxShadow: "0 4px 16px #0002",
      fontFamily: "system-ui", fontSize: 14, overflowWrap: "anywhere", zIndex: 1002,
      maxHeight: "calc(100vh - 86px)", overflow: "auto",
    }}>
      <strong>Tencent Meeting</strong>
      <p role="status">{state.loading ? "Updating meetings..." : state.auth.status}</p>
      {state.snapshot && <p style={{ color: "#555" }}>
        Updated {new Date(state.snapshot.fetchedAt).toLocaleString()}{state.stale ? " - Stale" : ""}
      </p>}
      {state.error && <p style={{ ...errorBox, padding: 8 }}>{state.error}</p>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button style={btn} onClick={onConnect} disabled={pending}>Connect</button>
        <button style={btn} onClick={onRefresh} disabled={state.loading}>Refresh</button>
      </div>
      {pending && isTrustedAuthorizationUrl(authorizationUrl) && <p>
        <a href={authorizationUrl} target="_blank" rel="noopener noreferrer">Authorize with Tencent Meeting</a>
      </p>}
      {pending && !isTrustedAuthorizationUrl(authorizationUrl) && <p>Waiting for a verified authorization link...</p>}
      {!hasRuntime && <p>
        Rebuild this page to add live meetings.
        {" "}<button style={btn} onClick={onRebuild}>Rebuild</button>
      </p>}
      <details style={{ marginTop: 12 }}>
        <summary>Local service key</summary>
        <form onSubmit={async (event) => {
          event.preventDefault();
          await saveSetting("tmeetKey", key.trim() || null);
          setKey("");
        }}>
          <label style={{ display: "block", margin: "8px 0" }}>
            Separate key (optional)
            <input type="password" value={key} onChange={(event) => setKey(event.target.value)}
              autoComplete="off" style={{ boxSizing: "border-box", width: "100%" }} />
          </label>
          <button style={btn} type="submit">Save key</button>
        </form>
      </details>
    </section>}
  </div>;
}
