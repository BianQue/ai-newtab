import { useState } from "react";
import { DEFAULT_BASE_URL, normalizeBaseUrl } from "@/lib/storage";
import { btn } from "./ui";

const input = {
  width: "100%",
  boxSizing: "border-box",
  padding: 12,
  fontSize: 14,
  borderRadius: 4,
  border: "1px solid #ddd",
  fontFamily: "ui-monospace, monospace",
} as const;

export function ApiKeySetup({
  initialBaseUrl,
  onSave,
}: {
  initialBaseUrl: string | null;
  onSave: (key: string, baseUrl: string | null) => void;
}) {
  const [value, setValue] = useState("");
  const [gateway, setGateway] = useState(initialBaseUrl ?? DEFAULT_BASE_URL);
  const baseUrl = normalizeBaseUrl(gateway);
  const key = value.trim();
  // Official keys look like sk-ant-…; a gateway issues its own format, so only require non-empty.
  const valid = baseUrl !== undefined && (baseUrl ? key.length > 0 : key.startsWith("sk-ant-"));

  return (
    <div style={{ maxWidth: 520, margin: "12vh auto", padding: 24, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 24 }}>Connect your Anthropic API key</h1>
      <p style={{ color: "#555", lineHeight: 1.6 }}>
        The agent runs inside this extension and talks to the Anthropic API (or the
        Anthropic-compatible gateway you enter) directly. Your key is stored in{" "}
        <code>chrome.storage.local</code> on this machine and is only sent to that endpoint.
      </p>
      <label style={{ display: "block", color: "#333", fontSize: 14, marginBottom: 6 }}>
        API gateway <span style={{ color: "#888" }}>(optional — leave blank for api.anthropic.com)</span>
      </label>
      <input
        type="url"
        value={gateway}
        onChange={(e) => setGateway(e.target.value)}
        placeholder="https://your-gateway.example.com"
        style={input}
      />
      {baseUrl === undefined && (
        <p style={{ color: "#a02620", fontSize: 12, margin: "6px 0 0" }}>Enter a full http(s) URL.</p>
      )}
      <label style={{ display: "block", color: "#333", fontSize: 14, margin: "16px 0 6px" }}>API key</label>
      <input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={baseUrl ? "Your gateway key" : "sk-ant-..."}
        style={input}
      />
      <button
        style={{ ...btn, marginTop: 16, opacity: valid ? 1 : 0.5 }}
        disabled={!valid}
        onClick={() => onSave(key, baseUrl ?? null)}
      >
        Save key
      </button>
    </div>
  );
}
