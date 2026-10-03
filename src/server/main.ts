// `npm run serve`: run the app as a local server and open it in a browser tab.
import path from "node:path";
import os from "node:os";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.KIFU_STUDY_DATA ?? path.join(os.homedir(), ".kifu-study");
mkdirSync(dataDir, { recursive: true });

const app = createApp({
  dbPath: process.env.KIFU_STUDY_DB ?? path.join(dataDir, "library.db"),
  staticDir: process.env.KIFU_STUDY_STATIC ?? path.join(here, "../renderer"),
  port: Number(process.env.PORT ?? 3210),
});
const port = await app.listen();
console.log(`kifu-study running at http://127.0.0.1:${port}`);

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
