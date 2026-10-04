import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server/app.js";
import { makeKif } from "./fixtures.js";

const dir = mkdtempSync(path.join(tmpdir(), "kifu-guess-"));
const ENGINE = path.resolve(process.platform === "win32" ? "tools/mock-usi-engine.cmd" : "tools/mock-usi-engine.mjs");
let app: ReturnType<typeof createApp>;
let base = "";
const call = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(base + p, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};

beforeAll(async () => {
  app = createApp({ dbPath: path.join(dir, "t.db"), autoBackup: false });
  base = `http://127.0.0.1:${await app.listen()}`;
  await call("PUT", "/api/settings", { autoAnalyze: false, engine: { path: ENGINE, options: {}, movetimeMs: 30, nodes: 0, multipv: 1 } });
});
afterAll(async () => app.close());

it("scores a guessed move against the move played, without analysing the game first", async () => {
  // ▲3三角成?? gives the bishop away to the knight; guessing ▲2六歩 instead costs much less.
  const r = await call("POST", "/api/import", { text: makeKif({ moves: "7g7f 3c3d 8h3c+ 2a3c 2g2f", black: "a", white: "b", date: "2026/09/30" }) });
  const id = r.body.results[0].id;

  const miss = await call("POST", `/api/games/${id}/guess`, { ply: 3, usi: "2g2f" });
  expect(miss.status).toBe(200);
  expect(miss.body.match).toBe(false);
  expect(miss.body.played.usi).toBe("8h3c+");
  expect(miss.body.played.text).toContain("角");
  expect(miss.body.guess.text).toContain("歩");
  expect(miss.body.played.loss).toBeGreaterThan(miss.body.guess.loss);
  expect(miss.body.played.level).toBeGreaterThanOrEqual(3);

  const hit = await call("POST", `/api/games/${id}/guess`, { ply: 3, usi: "8h3c+" });
  expect(hit.body.match).toBe(true);
  expect(hit.body.guess.loss).toBe(hit.body.played.loss);

  // The searches went into the position cache, so the same guess again needs no engine.
  const cached = app.db.all<{ n: number }>("SELECT COUNT(*) n FROM evals")[0].n;
  await call("POST", `/api/games/${id}/guess`, { ply: 3, usi: "2g2f" });
  expect(app.db.all<{ n: number }>("SELECT COUNT(*) n FROM evals")[0].n).toBe(cached);

  expect((await call("POST", `/api/games/${id}/guess`, { ply: 3, usi: "5a4b" })).status).toBe(400);
  expect((await call("POST", `/api/games/${id}/guess`, { ply: 9, usi: "2g2f" })).status).toBe(400);
}, 30000);
