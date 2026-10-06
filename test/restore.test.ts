import { afterAll, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server/app.js";
import { makeKif } from "./fixtures.js";

const MOCK = path.resolve(process.platform === "win32" ? "tools/mock-usi-engine.cmd" : "tools/mock-usi-engine.mjs");
const apps: ReturnType<typeof createApp>[] = [];
afterAll(async () => {
  for (const a of apps) await a.close();
});
async function start() {
  const dir = mkdtempSync(path.join(tmpdir(), "kifu-restore-test-"));
  const app = createApp({ dbPath: path.join(dir, "lib.db"), autoBackup: false });
  apps.push(app);
  const base = `http://127.0.0.1:${await app.listen()}`;
  const api = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(base + p, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    if (!r.ok) throw new Error(`${method} ${p}: ${JSON.stringify(j)}`);
    return j;
  };
  await api("PUT", "/api/settings", { myNames: ["me"], autoAnalyze: false, engine: { path: MOCK, options: {}, movetimeMs: 30, nodes: 0, multipv: 1, verifyFactor: 1 } });
  return { app, base, api };
}
const waitIdle = async (api: (m: string, p: string) => Promise<{ running: boolean; queued: unknown[] }>) => {
  for (let i = 0; i < 300; i++) {
    const s = await api("GET", "/api/analysis");
    if (!s.running && !s.queued.length) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("analysis did not finish");
};

it("merges a backup into another library, keeping analysis, cards, history and notes", async () => {
  const a = await start();
  const g = (await a.api("POST", "/api/import", { text: makeKif({ moves: "7g7f 3c3d 8h3c+ 2a3c 2g2f", black: "me", white: "x", date: "2026/09/02" }) })).results[0].id;
  await a.api("POST", "/api/analysis", { ids: [g] });
  await waitIdle(a.api);
  await a.api("PATCH", `/api/games/${g}`, { notes: "hung the bishop", tags: ["blunder"] });
  await a.api("PUT", `/api/games/${g}/marks/3`, { mark: "??" });
  const card = (await a.api("GET", "/api/cards"))[0];
  await a.api("POST", `/api/cards/${card.id}/rate`, { rating: "good" });
  await a.api("POST", "/api/pages", { title: "Bishop trap", body: `:::shogi-view{game=${g} ply=3}\n:::` });
  const backup = Buffer.from(await (await fetch(`${a.base}/api/backup`)).arrayBuffer());

  // Another library that already has a different game, so ids shift.
  const b = await start();
  await b.api("POST", "/api/import", { text: makeKif({ moves: "2g2f 8c8d 2f2e", black: "me", white: "z", date: "2026/09/03" }) });
  const restore = async () => {
    const r = await fetch(`${b.base}/api/restore`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: backup });
    expect(r.ok).toBe(true);
    return r.json();
  };
  const r1 = await restore();
  expect(r1).toMatchObject({ games: 1, added: 1, cards: 1, reviews: 1, pages: 1 });
  const games = await b.api("GET", "/api/games");
  const restored = games.find((x: { white: string }) => x.white === "x");
  expect(restored.id).not.toBe(g);
  const detail = await b.api("GET", `/api/games/${restored.id}`);
  expect(detail.analysis_status).toBe("done");
  expect(detail.notes).toBe("hung the bishop");
  expect(detail.tags).toEqual(["blunder"]);
  expect(detail.plies[3].level).toBeGreaterThanOrEqual(3);
  expect(detail.plies[3].user_mark).toBe("??");
  const cards = await b.api("GET", "/api/cards");
  expect(cards).toHaveLength(1);
  expect(cards[0].repetitions).toBe(1);
  const pages = await b.api("GET", "/api/pages");
  const page = await b.api("GET", `/api/pages/${pages[0].id}`);
  expect(page.body).toContain(`game=${restored.id} `);
  // Restoring the same backup again changes nothing.
  expect(await restore()).toMatchObject({ added: 0, cards: 0, reviews: 0, pages: 0 });
  // Garbage is refused.
  const bad = await fetch(`${b.base}/api/restore`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: Buffer.alloc(500, 1) });
  expect(bad.status).toBe(400);
}, 30000);

it("merges variations from the backup's copy of a game into the one here", async () => {
  const kif = makeKif({ moves: "7g7f 3c3d 2g2f 8c8d", black: "me", white: "v", date: "2026/09/08" });
  const a = await start();
  const ga = (await a.api("POST", "/api/import", { text: kif })).results[0].id;
  await a.api("POST", `/api/games/${ga}/variations`, { tree: "7g7f 3c3d (8c8d)" });
  const backup = Buffer.from(await (await fetch(`${a.base}/api/backup`)).arrayBuffer());

  const b = await start();
  const gb = (await b.api("POST", "/api/import", { text: kif })).results[0].id;
  await b.api("POST", `/api/games/${gb}/variations`, { tree: "7g7f 3c3d 2g2f (5g5f)" });
  const r = await fetch(`${b.base}/api/restore`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: backup });
  expect(r.ok).toBe(true);
  const branches = await b.api("GET", `/api/games/${gb}/branches`);
  expect(branches.map((x: { usis: string[] }) => x.usis[0]).sort()).toEqual(["5g5f", "8c8d"]);
}, 30000);

it("restores studies and re-points notebook pages that embed them", async () => {
  const START = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1";
  const a = await start();
  const st = await a.api("POST", "/api/studies", { title: "研究", start_sfen: START, tree: { usi: "", children: [{ usi: "7g7f", comment: "note", children: [] }] } });
  await a.api("POST", "/api/pages", { title: "With study", body: `:::shogi-study{id=${st.id}}\n:::` });
  const backup = Buffer.from(await (await fetch(`${a.base}/api/backup`)).arrayBuffer());

  const b = await start();
  // An unrelated study here first, so the restored one gets another id.
  await b.api("POST", "/api/studies", { title: "other", start_sfen: START });
  const restore = async () => (await fetch(`${b.base}/api/restore`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: backup })).json();
  expect(await restore()).toMatchObject({ studies: 1, pages: 1 });
  const restored = (await b.api("GET", "/api/studies")).find((x: { title: string }) => x.title === "研究");
  expect(restored.id).not.toBe(st.id);
  expect((await b.api("GET", `/api/studies/${restored.id}`)).tree.children[0].comment).toBe("note");
  const pages = await b.api("GET", "/api/pages");
  expect((await b.api("GET", `/api/pages/${pages[0].id}`)).body).toContain(`shogi-study{id=${restored.id}}`);
  expect(await restore()).toMatchObject({ studies: 0, pages: 0 });
}, 30000);
