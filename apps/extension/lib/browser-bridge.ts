import type { BrowserBridge } from "@homepage/agent-core";
import { getHistorySites } from "./history";
import { scrapeUrls } from "./scraper";
import { meetingManager } from "./meeting-service";

/**
 * The two capabilities only a real browser has, implemented over chrome.history
 * and chrome.tabs. Runs in the service worker, in-process with the agent loop.
 */
export const browserBridge: BrowserBridge = {
  getHistory: ({ daysToAnalyze, maxResults }) => getHistorySites(daysToAnalyze, maxResults),
  getPageHtml: ({ urls, loadDelayMs }) => scrapeUrls(urls, { loadDelay: loadDelayMs }),
  requestMeetingAuthorization: async () => {
    const auth = await meetingManager.connect();
    if (auth.status === "pending") {
      void browser.notifications.create({
        type: "basic",
        iconUrl: browser.runtime.getURL("/icon/128.png"),
        title: "Tencent Meeting authorization",
        message: "Open your homepage's Tencent Meeting controls to authorize the connection.",
      }).catch(() => {});
    }
    return { status: auth.status };
  },
};
