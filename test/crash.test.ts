import { afterAll, beforeAll, expect, it } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server/app.js";
import { makeKif } from "./fixtures.js";

const dir = mkdtempSync(path.join(tmpdir(), "kifu-crash-"));
const MOCK = path.resolve("tools/mock-usi-engine.mjs");
let app: ReturnType<typeof createApp>;
let base = "";
const api = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(base + p, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};
const waitIdle = async () => {
  for (let i = 0; i < 200; i++) {
    const s = await api("GET", "/api/analysis");
    if (!s.running && !s.queued.length) return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("analysis did not finish");
};

beforeAll(async () => {
  app = createApp({ dbPath: path.join(dir, "t.db"), autoBackup: false });
  base = `http://127.0.0.1:${await app.listen()}`;
});
afterAll(async () => app.close());

it.skipIf(process.platform === "win32")("recovers when the engine dies mid-analysis", async () => {
  // A wrapper around the mock engine that exits on its 4th search.
  const crashy = path.join(dir, "crashy.mjs");
  writeFileSync(
    crashy,
    `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const child = spawn(process.execPath, [${JSON.stringify(MOCK)}], { stdio: ["pipe", "inherit", "inherit"] });
let gos = 0;
createInterface({ input: process.stdin }).on("line", (l) => {
  if (l.startsWith("go") && ++gos === 4) process.exit(3);
  child.stdin.write(l + "\\n");
});
`,
  );
  chmodSync(crashy, 0o755);
  await api("PUT", "/api/settings", { myNames: ["me"], autoAnalyze: false, engine: { path: crashy, options: {}, movetimeMs: 30, nodes: 0, multipv: 1 } });
  const ids = [];
  for (const [i, moves] of ["7g7f 3c3d 2g2f 8c8d 2f2e", "2g2f 8c8d 7g7f 3c3d 6i7h"].entries()) {
    const r = await api("POST", "/api/import", { text: makeKif({ moves, black: "me", white: "x" + i, date: "2026/09/1" + i }) });
    ids.push(r.results[0].id);
  }
  await api("POST", "/api/analysis", { ids });
  const s = await waitIdle();
  expect(s.error).toMatch(/stopped unexpectedly/);
  // Nothing is left marked as queued.
  for (const id of ids) expect((await api("GET", `/api/games/${id}`)).analysis_status).not.toBe("queued");
  // With a working engine, analysis runs again.
  await api("PUT", "/api/settings", { engine: { path: MOCK, options: {}, movetimeMs: 30, nodes: 0, multipv: 1 } });
  await api("POST", "/api/analysis", { ids });
  const s2 = await waitIdle();
  expect(s2.error).toBeFalsy();
  for (const id of ids) expect((await api("GET", `/api/games/${id}`)).analysis_status).toBe("done");
}, 30000);
