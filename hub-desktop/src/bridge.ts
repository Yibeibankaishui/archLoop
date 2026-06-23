import type {
  HubRuntimeBridgeResult,
  HubRuntimeRequest,
  HubRuntimeResponseMap,
} from "@yibeibankaishui/archloop/hub-runtime-contract";

import { createHubDesktopBrowserFixtureRuntime } from "./fixtureRuntime";

export interface HubDesktopRuntimeApi {
  invoke: <A extends HubRuntimeRequest["action"]>(
    request: HubRuntimeRequest<A>,
  ) => Promise<HubRuntimeBridgeResult<HubRuntimeResponseMap[A]>>;
}

declare global {
  interface Window {
    hubRuntime?: HubDesktopRuntimeApi;
  }
}

let browserFixtureRuntime: HubDesktopRuntimeApi | undefined;

export const hubRuntimeClient = (): HubDesktopRuntimeApi => {
  if (window.hubRuntime) {
    return window.hubRuntime;
  }

  if (import.meta.env.VITE_HUB_DESKTOP_FIXTURES === "1") {
    browserFixtureRuntime ??= createHubDesktopBrowserFixtureRuntime();
    return browserFixtureRuntime;
  }

  throw new Error(
    "Hub runtime bridge is unavailable. Launch archLoop Hub through the desktop app shell.",
  );
};
