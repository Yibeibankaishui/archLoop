import type {
  HubRuntimeBridgeResult,
  HubRuntimeRequest,
  HubRuntimeResponseMap,
} from "@yibeibankaishui/archloop/hub-runtime-contract";

export interface HubDesktopRuntimeApi {
  invoke: <A extends HubRuntimeRequest["action"]>(
    request: HubRuntimeRequest<A>,
  ) => Promise<HubRuntimeBridgeResult<HubRuntimeResponseMap[A]>>;
}

declare global {
  interface Window {
    hubRuntime: HubDesktopRuntimeApi;
  }
}

export const hubRuntimeClient = (): HubDesktopRuntimeApi => {
  if (!window.hubRuntime) {
    throw new Error(
      "Hub runtime bridge is unavailable. Launch archLoop Hub through the desktop app shell.",
    );
  }
  return window.hubRuntime;
};
