// Electron shell: start the local server in the main process and show it in a window.
import { app, BrowserWindow, shell, dialog } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../server/app.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let server: ReturnType<typeof createApp> | null = null;

async function start() {
  server = createApp({
    dbPath: path.join(app.getPath("userData"), "library.db"),
    staticDir: path.join(here, "../renderer"),
  });
  const port = await server.listen();
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    title: "棋譜帖 Kifu Study",
    backgroundColor: "#17120d",
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  // Links to outside sites open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`)) void shell.openExternal(url);
    return { action: "deny" };
  });
  await win.loadURL(`http://127.0.0.1:${port}/`);
  // Smoke test hook: KIFU_STUDY_SMOKE=out.png saves a capture of the first screen and quits.
  const smoke = process.env.KIFU_STUDY_SMOKE;
  if (smoke) {
    await new Promise((r) => setTimeout(r, 1500));
    const { writeFileSync } = await import("node:fs");
    writeFileSync(smoke, (await win.webContents.capturePage()).toPNG());
    app.quit();
  }
}

app.whenReady().then(start).catch((e) => {
  dialog.showErrorBox("Kifu Study failed to start", String(e?.stack ?? e));
  app.quit();
});

app.on("window-all-closed", async () => {
  await server?.close();
  app.quit();
});
