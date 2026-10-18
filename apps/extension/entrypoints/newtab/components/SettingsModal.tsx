import { useEffect, useState } from "react";
import { MODEL_CHOICES, normalizeBlockList, type HomepageModel } from "@homepage/agent-core";
import { REBUILD_INTERVAL_CHOICES } from "@/lib/auto-rebuild";
import { fetchUpstreams, type UpstreamInfo } from "@/lib/storage";
import { btn } from "./ui";

export function SettingsModal({
  initialPrompt,
  blockedSites,
  model,
  onChangeModel,
  gatewayUrl,
  upstream,
  onChangeUpstream,
  upstreamKeys,
  onChangeUpstreamKey,
  autoRebuild,
  onToggleAutoRebuild,
  intervalHours,
  onChangeInterval,
  onClose,
  onSave,
  onChangeKey,
}: {
  initialPrompt: string;
  blockedSites: string[];
  model: HomepageModel;
  onChangeModel: (next: HomepageModel) => void;
  /** The endpoint builds talk to; asked for its upstream list if it's the local emulator. */
  gatewayUrl: string | undefined;
  upstream: string | null;
  onChangeUpstream: (next: string) => void;
  /** Keys for fallback gateways the emulator doesn't hold one for, by upstream name. */
  upstreamKeys: Record<string, string>;
  onChangeUpstreamKey: (name: string, key: string) => void;
  autoRebuild: boolean;
  onToggleAutoRebuild: (next: boolean) => void;
  intervalHours: number;
  onChangeInterval: (next: number) => void;
  onClose: () => void;
  onSave: (prompt: string, blockedSites: string[]) => void;
  onChangeKey: () => void;
}) {
  const [draft, setDraft] = useState(initialPrompt);
  const [blockedDraft, setBlockedDraft] = useState(blockedSites.join("\n"));
  const [upstreams, setUpstreams] = useState<UpstreamInfo[]>([]);
  useEffect(() => {
    let live = true;
    fetchUpstreams(gatewayUrl).then((list) => live && setUpstreams(list));
    return () => {
      live = false;
    };
  }, [gatewayUrl]);
  const mappedModel = (u: UpstreamInfo) => u.modelMap[model] ?? u.modelMap["*"];
  // The primary uses the API key from the key screen; fallbacks the emulator has no key for need one here.
  const needsKey = upstreams.filter((u) => u.name !== "primary" && !u.fixedKey);
  const missingKey = (u: UpstreamInfo) => needsKey.includes(u) && !upstreamKeys[u.name];

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div style={{ backgroundColor: "white", borderRadius: 8, padding: 24, width: "90%", maxWidth: 600, maxHeight: "90vh", overflowY: "auto" }}>
        <h2 style={{ marginTop: 0, color: "#333" }}>Customize your homepage</h2>
        <p style={{ color: "#666" }}>Standing instructions applied to every build.</p>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="e.g. 'Focus on tech news and Rust releases', 'Always surface unread GitHub PRs first'"
          style={{
            width: "100%",
            minHeight: 200,
            padding: 12,
            fontSize: 14,
            borderRadius: 4,
            border: "1px solid #ddd",
            fontFamily: "inherit",
          }}
        />
        <label style={{ display: "block", marginTop: 16, color: "#333", fontSize: 14 }}>
          Sites the agent never reads
          <textarea
            value={blockedDraft}
            onChange={(e) => setBlockedDraft(e.target.value)}
            aria-describedby="blocked-sites-help"
            style={{ width: "100%", boxSizing: "border-box", minHeight: 120, marginTop: 8, padding: 12, fontSize: 14, borderRadius: 4, border: "1px solid #ddd", fontFamily: "inherit" }}
          />
        </label>
        <p id="blocked-sites-help" style={{ color: "#888", fontSize: 12, margin: "6px 0 0" }}>
          One per line. Subdomains are included. Use *.example.com for wildcards.
        </p>
        <label
          style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 16, color: "#333", fontSize: 14 }}
        >
          Model
          <select
            value={model}
            onChange={(e) => onChangeModel(e.target.value as HomepageModel)}
            style={{ padding: "4px 8px", fontSize: 14, borderRadius: 4, border: "1px solid #ddd" }}
          >
            {MODEL_CHOICES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        {upstreams.length > 1 && (
          <>
            <label
              style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 16, color: "#333", fontSize: 14 }}
            >
              Upstream gateway
              <select
                value={upstream && upstreams.some((u) => u.name === upstream) ? upstream : "auto"}
                onChange={(e) => onChangeUpstream(e.target.value)}
                style={{ padding: "4px 8px", fontSize: 14, borderRadius: 4, border: "1px solid #ddd", maxWidth: 420 }}
              >
                <option value="auto">Auto (primary first, switch on failure)</option>
                {upstreams.map((u) => (
                  <option key={u.name} value={u.name}>
                    {u.name} · {hostOf(u.baseUrl)}
                    {mappedModel(u) ? ` · ${mappedModel(u)}` : ""}
                    {missingKey(u) ? " (no key)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <p style={{ color: "#888", fontSize: 12, margin: "6px 0 0" }}>
              Chosen by the local emulator. The one you pick is tried first; if it fails or stalls the
              build still switches to another. Applies from the next model call, including a build in
              progress.
            </p>
            {needsKey.map((u) => (
              <UpstreamKeyField
                key={u.name}
                name={u.name}
                host={hostOf(u.baseUrl)}
                value={upstreamKeys[u.name] ?? ""}
                onSave={(key) => onChangeUpstreamKey(u.name, key)}
              />
            ))}
            {needsKey.length > 0 && (
              <p style={{ color: "#888", fontSize: 12, margin: "6px 0 0" }}>
                Stored in this browser like your main API key and sent only to the local emulator,
                which passes it on only to that gateway. Without one the gateway is skipped.
              </p>
            )}
          </>
        )}
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 16,
            color: "#333",
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={autoRebuild}
            onChange={(e) => onToggleAutoRebuild(e.target.checked)}
          />
          Rebuild automatically
        </label>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 10,
            marginLeft: 24,
            color: autoRebuild ? "#333" : "#aaa",
            fontSize: 14,
          }}
        >
          Every
          <select
            value={intervalHours}
            disabled={!autoRebuild}
            onChange={(e) => onChangeInterval(Number(e.target.value))}
            style={{ padding: "4px 8px", fontSize: 14, borderRadius: 4, border: "1px solid #ddd" }}
          >
            {REBUILD_INTERVAL_CHOICES.map((h) => (
              <option key={h} value={h}>
                {h === 24 ? "24 hours (daily)" : `${h} hours`}
              </option>
            ))}
          </select>
        </label>
        <p style={{ color: "#888", fontSize: 12, margin: "6px 0 0" }}>
          When on, the extension rebuilds in the background once your homepage is this old, so
          your next tab shows a fresh one (uses your API key).
        </p>
        <div style={{ display: "flex", gap: 12, marginTop: 20, justifyContent: "flex-end" }}>
          <button
            onClick={onChangeKey}
            style={{ ...btn, backgroundColor: "white", color: "#333", border: "1px solid #ddd", marginRight: "auto" }}
          >
            Change API key / gateway
          </button>
          <button
            onClick={onClose}
            style={{ ...btn, backgroundColor: "white", color: "#333", border: "1px solid #ddd" }}
          >
            Cancel
          </button>
          <button onClick={() => onSave(draft, normalizeBlockList(blockedDraft.split("\n")))} style={btn}>
            Save &amp; rebuild
          </button>
        </div>
      </div>
    </div>
  );
}

/** A fallback gateway's key: saved when the field loses focus or Enter is pressed. */
function UpstreamKeyField({
  name,
  host,
  value,
  onSave,
}: {
  name: string;
  host: string;
  value: string;
  onSave: (key: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft.trim() !== value && onSave(draft);
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, color: "#333", fontSize: 14 }}>
      <span style={{ whiteSpace: "nowrap" }}>
        {name} key <span style={{ color: "#888" }}>({host})</span>
      </span>
      <input
        type="password"
        autoComplete="off"
        value={draft}
        placeholder="API key for this gateway"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
        style={{ flex: 1, padding: "4px 8px", fontSize: 14, borderRadius: 4, border: "1px solid #ddd" }}
      />
    </label>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
