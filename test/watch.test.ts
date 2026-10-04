import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server/app.js";
import { makeKif, sjis, SHIKEN_VS_FUNA, KAKUGAWARI } from "./fixtures.js";

let app: ReturnType<typeof createApp>;
let base = "";
const dir = mkdtempSync(path.join(tmpdir(), "kifu-watch-"));
const api = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(base + p, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};
const until = async (cond: () => Promise<boolean>, ms = 8000) => {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
};

beforeAll(async () => {
  writeFileSync(path.join(dir, "one.kif"), sjis(makeKif({ moves: SHIKEN_VS_FUNA, black: "me", white: "a", date: "2026/09/01" })));
  writeFileSync(path.join(dir, "notes.txt"), "not a kifu");
  app = createApp({ dbPath: path.join(mkdtempSync(path.join(tmpdir(), "kifu-watch-db-")), "t.db") });
  base = `http://127.0.0.1:${await app.listen()}`;
  await api("PUT", "/api/settings", { myNames: ["me"], autoAnalyze: false, watchFolders: [dir, path.join(dir, "missing")] });
});
afterAll(async () => app.close());

describe("watched folders", () => {
  it("imports what is already there when a folder is added", async () => {
    await until(async () => (await api("GET", "/api/games")).length === 1);
  });

  it("picks up new files in subfolders", async () => {
    mkdirSync(path.join(dir, "2026-09"));
    writeFileSync(path.join(dir, "2026-09", "two.kif"), makeKif({ moves: KAKUGAWARI, black: "b", white: "me", date: "2026/09/02" }));
    await until(async () => (await api("GET", "/api/games")).length === 2);
  });

  it("skips unchanged files and reports missing folders on a manual scan", async () => {
    const r = await api("POST", "/api/watch/scan");
    expect(r.scanned).toBe(0);
    expect(r.added).toEqual([]);
    expect(r.missing).toEqual([path.join(dir, "missing")]);
  });
});
