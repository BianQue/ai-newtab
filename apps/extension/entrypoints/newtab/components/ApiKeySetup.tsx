import { useEffect, useState } from "react";
import { DEFAULT_BASE_URL, effectiveBaseUrl, fetchUpstreams, hostOf, normalizeBaseUrl, type UpstreamInfo } from "@/lib/storage";
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

const label = { display: "block", color: "#333", fontSize: 14, margin: "16px 0 6px" } as const;

export function ApiKeySetup({
  initialBaseUrl,
  initialUpstreamKeys,
  onSave,
}: {
  initialBaseUrl: string | null;
  /** Fallback keys already saved for initialBaseUrl's emulator. */
  initialUpstreamKeys: Record<string, string>;
  onSave: (key: string, baseUrl: string | null, upstreamKeys: Record<string, string>) => void;
}) {
  const [value, setValue] = useState("");
  const [gateway, setGateway] = useState(initialBaseUrl ?? DEFAULT_BASE_URL);
  const baseUrl = normalizeBaseUrl(gateway);
  const key = value.trim();
  // Official keys look like sk-ant-…; a gateway issues its own format, so only require non-empty.
  const valid = baseUrl !== undefined && (baseUrl ? key.length > 0 : key.startsWith("sk-ant-"));

  // If the endpoint is the local emulator, it lists its gateways; ask once typing settles.
  const [upstreams, setUpstreams] = useState<UpstreamInfo[]>([]);
  useEffect(() => {
    if (baseUrl === undefined) return setUpstreams([]);
    let live = true;
    const timer = setTimeout(
      () => fetchUpstreams(effectiveBaseUrl(baseUrl)).then((list) => live && setUpstreams(list)),
      400,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [baseUrl]);
  // The primary takes the API key above; a fallback the emulator holds no key for takes one here.
  const primary = upstreams.find((u) => u.name === "primary");
  const needsKey = upstreams.filter((u) => u.name !== "primary" && !u.fixedKey);

  // Saved fallback keys belong to the saved gateway; never carry them to another one.
  const [upstreamKeys, setUpstreamKeys] = useState(initialUpstreamKeys);
  useEffect(() => setUpstreamKeys(baseUrl === initialBaseUrl ? initialUpstreamKeys : {}), [baseUrl]);

  const save = () => {
    const keys: Record<string, string> = {};
    for (const u of needsKey) keys[u.name] = (upstreamKeys[u.name] ?? "").trim();
    onSave(key, baseUrl ?? null, keys);
  };

  return (
    <div style={{ maxWidth: 520, margin: "12vh auto", padding: 24, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 24 }}>Connect your Anthropic API key</h1>
      <p style={{ color: "#555", lineHeight: 1.6 }}>
        The agent runs inside this extension and talks to the Anthropic API (or the
        Anthropic-compatible gateway you enter) directly. Your key is stored in{" "}
        <code>chrome.storage.local</code> on this machine and is only sent to that endpoint.
      </p>
      <label style={{ ...label, marginTop: 0 }}>
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
      <label style={label}>
        API key
        {primary && needsKey.length > 0 && (
          <span style={{ color: "#888" }}> — primary ({hostOf(primary.baseUrl)})</span>
        )}
      </label>
      <input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={baseUrl ? "Your gateway key" : "sk-ant-..."}
        style={input}
      />
      {needsKey.map((u) => (
        <div key={u.name}>
          <label style={label}>
            Backup key — {u.name} <span style={{ color: "#888" }}>({hostOf(u.baseUrl)}, optional)</span>
          </label>
          <input
            type="password"
            autoComplete="off"
            value={upstreamKeys[u.name] ?? ""}
            onChange={(e) => setUpstreamKeys({ ...upstreamKeys, [u.name]: e.target.value })}
            placeholder="Used when the primary fails or stalls"
            style={input}
          />
        </div>
      ))}
      {needsKey.length > 0 && (
        <p style={{ color: "#888", fontSize: 12, margin: "6px 0 0" }}>
          The local emulator passes each key only to its own gateway. Without a backup key that
          gateway is skipped. You can change these later in Settings.
        </p>
      )}
      <button style={{ ...btn, marginTop: 16, opacity: valid ? 1 : 0.5 }} disabled={!valid} onClick={save}>
        Save key
      </button>
    </div>
  );
}
