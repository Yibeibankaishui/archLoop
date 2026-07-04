import { app, BrowserWindow, ipcMain } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHubRuntimeBridgeService } from "@yibeibankaishui/archloop/hub-runtime-bridge";
import { HUB_RUNTIME_BRIDGE_CHANNELS } from "@yibeibankaishui/archloop/hub-runtime-contract";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const useFixtures = process.env.ARCHLOOP_HUB_DESKTOP_FIXTURES === "1";
const bridge = createHubRuntimeBridgeService({
  cwd: process.env.ARCHLOOP_HUB_REPO_ROOT ?? process.cwd(),
  useFixtures,
});
const createWindow = async () => {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 720,
    minHeight: 640,
    backgroundColor: "#f8fafc",
    title: "archLoop Hub",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    await window.loadURL(devServerUrl);
  } else {
    await window.loadFile(join(__dirname, "../dist/index.html"));
  }
  return window;
};
app.whenReady().then(async () => {
  ipcMain.handle(HUB_RUNTIME_BRIDGE_CHANNELS.invoke, async (_event, request) =>
    bridge.invoke(request),
  );
  await createWindow();
  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
