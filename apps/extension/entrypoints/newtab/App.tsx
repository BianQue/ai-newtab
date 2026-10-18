import { useCallback, useEffect, useState } from "react";
import { DEFAULT_MODEL, DEFAULT_BLOCKED_SITES, type HomepageModel } from "@homepage/agent-core";
import { DEFAULT_REBUILD_INTERVAL_HOURS } from "@/lib/auto-rebuild";
import { BUILD_STEPS } from "@/lib/protocol";
import { KEYS, effectiveBaseUrl, extensionStore, loadHomepage, loadSettings, saveSetting } from "@/lib/storage";
import { toRenderable } from "@/lib/transpile";
import { ApiKeySetup } from "./components/ApiKeySetup";
import { BuildProgress } from "./components/BuildProgress";
import { HomepagePreview } from "./components/HomepagePreview";
import { SettingsModal } from "./components/SettingsModal";
import { btn, errorBox } from "./components/ui";
import { useHomepageBuild } from "./useHomepageBuild";

export default function App() {
  const [loading, setLoading] = useState(true);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [upstream, setUpstream] = useState<string | null>(null);
  const [upstreamKeys, setUpstreamKeys] = useState<Record<string, string>>({});
  const [systemPrompt, setSystemPrompt] = useState("");
  const [blockedSites, setBlockedSites] = useState<string[]>(DEFAULT_BLOCKED_SITES);
  const [model, setModel] = useState<HomepageModel>(DEFAULT_MODEL);
  const [autoRebuild, setAutoRebuild] = useState(true);
  const [intervalHours, setIntervalHours] = useState(DEFAULT_REBUILD_INTERVAL_HOURS);
  /** Transpiled homepage, ready for Sandpack. */
  const [renderedCode, setRenderedCode] = useState<string | null>(null);
  /** A session left mid-flight, offered as "Resume interrupted build". */
  const [resumable, setResumable] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  /** Expand the full progress view over an existing homepage. */
  const [viewProgress, setViewProgress] = useState(false);
  /** The error the user dismissed, so a stale banner doesn't linger. */
  const [dismissedError, setDismissedError] = useState<string | null>(null);

  const { state, build, cancel } = useHomepageBuild((code) => setRenderedCode(toRenderable(code)));

  // Once a build finishes, drop back to the homepage view.
  useEffect(() => {
    if (!state.running) setViewProgress(false);
  }, [state.running]);

  // Scheduled rebuilds are driven by the worker's alarm, not by opening a tab;
  // useHomepageBuild surfaces any build already in flight.
  useEffect(() => {
    (async () => {
      try {
        const [settings, homepage, activeSession] = await Promise.all([
          loadSettings(),
          loadHomepage(),
          extensionStore.get<string>(KEYS.activeSessionId),
        ]);
        setApiKey(settings.apiKey);
        setBaseUrl(settings.baseUrl);
        setUpstream(settings.upstream);
        setUpstreamKeys(settings.upstreamKeys);
        setSystemPrompt(settings.systemPrompt);
        setBlockedSites(settings.blockedSites);
        setModel(settings.model);
        setAutoRebuild(settings.autoRebuild);
        setIntervalHours(settings.rebuildIntervalHours ?? DEFAULT_REBUILD_INTERVAL_HOURS);
        setResumable(activeSession ?? null);
        if (homepage?.code) setRenderedCode(toRenderable(homepage.code));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const saveKey = useCallback(
    async (key: string, nextBaseUrl: string | null) => {
      // An upstream choice (and a fallback key) names one of the old endpoint's
      // gateways; it means nothing elsewhere, and a key mustn't follow it there.
      const gatewayChanged = nextBaseUrl !== baseUrl;
      await Promise.all([
        saveSetting("apiKey", key),
        saveSetting("baseUrl", nextBaseUrl),
        ...(gatewayChanged ? [saveSetting("upstream", null), saveSetting("upstreamKeys", {})] : []),
      ]);
      if (gatewayChanged) {
        setUpstream(null);
        setUpstreamKeys({});
      }
      setBaseUrl(nextBaseUrl);
      setApiKey(key);
    },
    [baseUrl],
  );

  /** Back to the key screen, prefilled with the current gateway. */
  const changeKey = useCallback(async () => {
    await saveSetting("apiKey", null);
    setShowSettings(false);
    setApiKey(null);
  }, []);

  const savePrompt = useCallback(
    async (prompt: string, sites: string[]) => {
      await Promise.all([saveSetting("systemPrompt", prompt), saveSetting("blockedSites", sites)]);
      setBlockedSites(sites);
      setSystemPrompt(prompt);
      setShowSettings(false);
      setRenderedCode(null);
      build();
    },
    [build],
  );

  // These persist immediately; the worker reads them on its next heartbeat or build.
  const changeModel = useCallback(async (next: HomepageModel) => {
    setModel(next);
    await saveSetting("model", next);
  }, []);
  // Read by every request the worker's client makes, so a running build picks it up too.
  const changeUpstream = useCallback(async (next: string) => {
    setUpstream(next);
    await saveSetting("upstream", next);
  }, []);
  // A cleared key is stored as "" (not dropped) so the emulator is told to forget it.
  const changeUpstreamKey = useCallback(
    async (name: string, key: string) => {
      const next = { ...upstreamKeys, [name]: key.trim() };
      setUpstreamKeys(next);
      await saveSetting("upstreamKeys", next);
    },
    [upstreamKeys],
  );
  const toggleAutoRebuild = useCallback(async (next: boolean) => {
    setAutoRebuild(next);
    await saveSetting("autoRebuild", next);
  }, []);
  const changeInterval = useCallback(async (next: number) => {
    setIntervalHours(next);
    await saveSetting("rebuildIntervalHours", next);
  }, []);

  if (loading) return <div style={{ padding: 20, textAlign: "center" }}>Loading…</div>;
  if (!apiKey) return <ApiKeySetup initialBaseUrl={baseUrl} onSave={saveKey} />;

  // With no homepage to fall back to, a running build takes over the tab.
  if (state.running && (!renderedCode || viewProgress)) {
    return (
      <BuildProgress
        state={state}
        onCancel={cancel}
        onBack={renderedCode ? () => setViewProgress(false) : undefined}
      />
    );
  }

  if (!renderedCode) {
    return (
      <div style={{ maxWidth: 560, margin: "14vh auto", padding: 24, fontFamily: "system-ui" }}>
        <h1 style={{ fontSize: 26 }}>Build your homepage</h1>
        <p style={{ color: "#555", lineHeight: 1.6 }}>
          The agent reads your browsing history, opens the pages you actually follow, and writes a
          homepage from what it finds today.
        </p>
        {state.error && (
          <div style={{ ...errorBox, margin: "16px 0", padding: 12, borderRadius: 4 }}>{state.error}</div>
        )}
        <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
          <button style={btn} onClick={() => build()}>
            Build today&apos;s homepage
          </button>
          {resumable && (
            <button style={{ ...btn, backgroundColor: "#555" }} onClick={() => build({ resume: true })}>
              Resume interrupted build
            </button>
          )}
          <button
            style={{ ...btn, backgroundColor: "white", color: "#333", border: "1px solid #ddd" }}
            onClick={changeKey}
          >
            Change API key / gateway
          </button>
        </div>
      </div>
    );
  }

  const showError = state.error && dismissedError !== state.error;

  return (
    <div style={{ height: "100vh", width: "100vw" }}>
      <div style={{ position: "fixed", top: 20, right: 20, zIndex: 999, display: "flex", gap: 8 }}>
        {state.running ? (
          // A build is running in the background (from here, another tab, or the
          // scheduled rebuild). Let the user watch it without losing this page.
          <button
            style={{ ...btn, backgroundColor: "#0a7", display: "flex", alignItems: "center", gap: 8 }}
            onClick={() => setViewProgress(true)}
            title="View build progress"
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "white",
                animation: "hb-pulse 1.2s ease-in-out infinite",
              }}
            />
            Building… {Math.min(state.stepIndex + 1, BUILD_STEPS.length)}/{BUILD_STEPS.length}
          </button>
        ) : (
          <button style={btn} onClick={() => build()} title="Rebuild now">
            ↻ Rebuild
          </button>
        )}
        <button style={btn} onClick={() => setShowSettings(true)} title="Customize homepage">
          ⚙️ Settings
        </button>
      </div>

      {showError && (
        <div
          style={{
            ...errorBox,
            position: "fixed",
            top: 20,
            left: 20,
            right: 260,
            zIndex: 999,
            padding: "10px 14px",
            borderRadius: 6,
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
          }}
        >
          <span style={{ flex: 1 }}>
            <b>Build failed.</b> {state.error}
          </span>
          <button style={{ ...btn, padding: "4px 10px", backgroundColor: "#a02620" }} onClick={() => build()}>
            Retry
          </button>
          <button
            onClick={() => setDismissedError(state.error)}
            style={{
              background: "transparent",
              border: "none",
              color: "#a02620",
              cursor: "pointer",
              fontSize: 16,
              lineHeight: 1,
            }}
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      <HomepagePreview code={renderedCode} />

      {showSettings && (
        <SettingsModal
          initialPrompt={systemPrompt}
          blockedSites={blockedSites}
          model={model}
          onChangeModel={changeModel}
          gatewayUrl={effectiveBaseUrl(baseUrl)}
          upstream={upstream}
          onChangeUpstream={changeUpstream}
          upstreamKeys={upstreamKeys}
          onChangeUpstreamKey={changeUpstreamKey}
          autoRebuild={autoRebuild}
          onToggleAutoRebuild={toggleAutoRebuild}
          intervalHours={intervalHours}
          onChangeInterval={changeInterval}
          onClose={() => setShowSettings(false)}
          onSave={savePrompt}
          onChangeKey={changeKey}
        />
      )}
    </div>
  );
}
