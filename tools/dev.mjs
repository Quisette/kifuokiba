// Dev loop: bundle the server once, run it on :3210, and serve the renderer with Vite (HMR, /api proxied).
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
execFileSync(process.execPath, [path.join(root, "tools/build-server.mjs")], { stdio: "inherit", cwd: root });
const server = spawn(process.execPath, ["--no-warnings", "dist/server/main.mjs"], { stdio: "inherit", cwd: root, env: { ...process.env, PORT: "3210" } });
const vite = spawn("npx", ["vite"], { stdio: "inherit", cwd: root });
const stop = () => {
  server.kill();
  vite.kill();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
server.on("exit", stop);
vite.on("exit", stop);
