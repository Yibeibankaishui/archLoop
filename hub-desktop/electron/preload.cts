import type {
  HubRuntimeBridgeResult,
  HubRuntimeRequest,
  HubRuntimeResponseMap,
} from "@yibeibankaishui/archloop/hub-runtime-contract";

const { contextBridge, ipcRenderer } =
  require("electron") as typeof import("electron");
const HUB_RUNTIME_BRIDGE_INVOKE_CHANNEL: typeof import("@yibeibankaishui/archloop/hub-runtime-contract").HUB_RUNTIME_BRIDGE_CHANNELS.invoke =
  "hub-runtime:invoke";

const hubRuntime = {
  invoke: <A extends HubRuntimeRequest["action"]>(
    request: HubRuntimeRequest<A>,
  ): Promise<HubRuntimeBridgeResult<HubRuntimeResponseMap[A]>> =>
    ipcRenderer.invoke(HUB_RUNTIME_BRIDGE_INVOKE_CHANNEL, request),
};

contextBridge.exposeInMainWorld("hubRuntime", hubRuntime);

export type HubDesktopPreloadApi = typeof hubRuntime;
