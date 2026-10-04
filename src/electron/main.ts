// Electron shell: start the local server in the main process and show it in a window.
import { app, BrowserWindow, Notification, shell, dialog } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../server/app.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let server: ReturnType<typeof createApp> | null = null;
let win: BrowserWindow | null = null;
let port = 0;

// Kifu files opened from the OS: double-click, "Open with", or dropped on the dock icon.
const KIFU_EXT = /\.(kif|kifu|ki2|ki2u|csa|jkf)$/i;
const pending: string[] = [];
const kifuArgs = (argv: string[]) => argv.slice(1).filter((a) => !a.startsWith("-") && KIFU_EXT.test(a));

async function openFiles(paths: string[]) {
  if (!paths.length) return;
  if (!server || !win) {
    pending.push(...paths);
    return;
  }
  const id = await server.importPaths(paths);
  if (win.isMinimized()) win.restore();
  win.focus();
  if (id) await win.loadURL(`http://127.0.0.1:${port}/#/game/${id}`);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => void openFiles(kifuArgs(argv)));
}
app.on("open-file", (e, file) => {
  e.preventDefault();
  void openFiles([file]);
});
pending.push(...kifuArgs(process.argv));

async function start() {
  server = createApp({
    dbPath: path.join(app.getPath("userData"), "library.db"),
    staticDir: path.join(here, "../renderer"),
  });
  port = await server.listen();
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    title: "棋譜帖 Kifu Study",
    backgroundColor: "#17120d",
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  // Links to outside sites open in the default browser.
  win.on("closed", () => (win = null));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`)) void shell.openExternal(url);
    return { action: "deny" };
  });
  await win.loadURL(`http://127.0.0.1:${port}/`);
  await openFiles(pending.splice(0));
  watchDue();
  // Smoke test hook: KIFU_STUDY_SMOKE=out.png saves a capture of the first screen and quits.
  const smoke = process.env.KIFU_STUDY_SMOKE;
  if (smoke) {
    await new Promise((r) => setTimeout(r, 1500));
    const { writeFileSync } = await import("node:fs");
    writeFileSync(smoke, (await win!.webContents.capturePage()).toPNG());
    app.quit();
  }
}

// Due cards on the dock/taskbar badge, and one notification a day while the window is in the background.
function watchDue() {
  let notifiedOn = "";
  const tick = () => {
    if (!server) return;
    const { due } = server.cards.counts();
    app.setBadgeCount(due);
    const today = new Date().toDateString();
    if (due > 0 && notifiedOn !== today && win && !win.isFocused() && Notification.isSupported()) {
      notifiedOn = today;
      const n = new Notification({ title: "棋譜帖", body: `${due} card${due === 1 ? " is" : "s are"} due for review.` });
      n.on("click", () => {
        if (!win) return;
        if (win.isMinimized()) win.restore();
        win.focus();
        void win.loadURL(`http://127.0.0.1:${port}/#/review`);
      });
      n.show();
    }
  };
  tick();
  setInterval(tick, 5 * 60 * 1000).unref();
}

app.whenReady().then(start).catch((e) => {
  dialog.showErrorBox("Kifu Study failed to start", String(e?.stack ?? e));
  app.quit();
});

app.on("window-all-closed", async () => {
  await server?.close();
  app.quit();
});
