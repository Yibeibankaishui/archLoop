import { contextBridge, ipcRenderer } from "electron";

import type {
  HubRuntimeBridgeResult,
  HubRuntimeRequest,
  HubRuntimeResponseMap,
} from "@yibeibankaishui/archloop/hub-runtime-contract";
import { HUB_RUNTIME_BRIDGE_CHANNELS } from "@yibeibankaishui/archloop/hub-runtime-contract";

const hubRuntime = {
  invoke: <A extends HubRuntimeRequest["action"]>(
    request: HubRuntimeRequest<A>,
  ): Promise<HubRuntimeBridgeResult<HubRuntimeResponseMap[A]>> =>
    ipcRenderer.invoke(HUB_RUNTIME_BRIDGE_CHANNELS.invoke, request),
};

contextBridge.exposeInMainWorld("hubRuntime", hubRuntime);

export type HubDesktopPreloadApi = typeof hubRuntime;
