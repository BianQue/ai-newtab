import { MeetingManager, type MeetingCache, type MeetingRoute } from "./meeting-manager";
import { effectiveBaseUrl, extensionStore, KEYS, loadSettings } from "./storage";

async function requestMeetingService(route: MeetingRoute): Promise<unknown> {
  const settings = await loadSettings();
  const baseUrl = effectiveBaseUrl(settings.baseUrl);
  const key = settings.tmeetKey || settings.apiKey;
  if (!baseUrl || !key) throw new Error("Configure the local meeting service key to connect.");
  const url = new URL(baseUrl);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Meetings require the local MA emulator.");
  }
  const response = await fetch(`${url.origin}/v1/integrations/tmeet/${route}`, {
    method: route === "status" ? "GET" : "POST",
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error("Meeting service access denied. Check the local key and allowed extension origin.");
    if (response.status === 404) throw new Error("This MA service does not support meetings.");
    throw new Error("The meeting service is unavailable. Try refreshing.");
  }
  return response.json();
}

export const meetingManager = new MeetingManager({
  request: requestMeetingService,
  load: () => extensionStore.get<MeetingCache>(KEYS.meetingSnapshot),
  save: (cache) => extensionStore.set(KEYS.meetingSnapshot, cache),
  clear: () => extensionStore.remove(KEYS.meetingSnapshot),
});
