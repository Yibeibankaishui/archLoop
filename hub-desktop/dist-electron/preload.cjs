"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { contextBridge, ipcRenderer } = require("electron");
const HUB_RUNTIME_BRIDGE_INVOKE_CHANNEL = "hub-runtime:invoke";
const hubRuntime = {
    invoke: (request) => ipcRenderer.invoke(HUB_RUNTIME_BRIDGE_INVOKE_CHANNEL, request),
};
contextBridge.exposeInMainWorld("hubRuntime", hubRuntime);
