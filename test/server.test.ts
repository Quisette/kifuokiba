import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server/app.js";
import { makeKif, sjis, SHIKEN_VS_FUNA } from "./fixtures.js";

const MOCK = path.resolve("tools/mock-usi-engine.mjs");

let app: ReturnType<typeof createApp>;
let base = "";
const api = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(base + p, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${p}: ${JSON.stringify(j)}`);
  return j;
};
const waitIdle = async () => {
  for (let i = 0; i < 600; i++) {
    const s = await api("GET", "/api/analysis");
    if (!s.running && !s.queued.length) return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("analysis did not finish");
};

beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "kifu-study-"));
  app = createApp({ dbPath: path.join(dir, "t.db") });
  base = `http://127.0.0.1:${await app.listen()}`;
  await api("PUT", "/api/settings", { myNames: ["me"], engine: { path: MOCK, options: {}, movetimeMs: 50, nodes: 0, multipv: 1 }, autoAnalyze: false });
});
afterAll(async () => app.close());

describe("library API", () => {
  it("imports, dedups and classifies", async () => {
    const kif = makeKif({ moves: SHIKEN_VS_FUNA, black: "me 三段", white: "rival", date: "2026/09/01 21:05", event: "将棋ウォーズ(10分切れ負け)" });
    const r1 = await api("POST", "/api/import", { files: [{ name: "a.kif", data: Buffer.from(sjis(kif)).toString("base64") }] });
    expect(r1.results[0].status).toBe("added");
    const r2 = await api("POST", "/api/import", { text: kif.replace(/\r\n/g, "\n") });
    expect(r2.results[0].status).toBe("duplicate");
    const games = await api("GET", "/api/games");
    expect(games).toHaveLength(1);
    expect(games[0].mySide).toBe("black");
    expect(games[0].myResult).toBe("loss");
    expect(games[0].opponent).toBe("rival");
    expect(games[0].white_opening).toBe("四間飛車");
    expect(games[0].black_castle).toBe("舟囲い");
    const filtered = await api("GET", "/api/games?castle=" + encodeURIComponent("本美濃"));
    expect(filtered).toHaveLength(1);
    const none = await api("GET", "/api/games?result=win");
    expect(none).toHaveLength(0);
  });

  it("rejects garbage", async () => {
    const r = await api("POST", "/api/import", { text: "hello world" });
    expect(r.results[0].status).toBe("error");
  });

  it("analyses with a USI engine, grades moves and makes cards", async () => {
    // ▲3三角成?? drops the bishop to △同桂.
    const kif = makeKif({ moves: "7g7f 3c3d 8h3c+ 2a3c 2g2f", black: "me", white: "x", date: "2026/09/02", elapsed: [3000, 4000, 2000, 30000, 70000] });
    const r = await api("POST", "/api/import", { text: kif });
    const id = r.results[0].id;
    await api("POST", "/api/analysis", { ids: [id] });
    await waitIdle();
    const g = await api("GET", `/api/games/${id}`);
    expect(g.analysis_status).toBe("done");
    expect(g.plies.every((p: { score: number | null; mate: number | null }) => p.score !== null || p.mate !== null)).toBe(true);
    expect(g.plies[3].level).toBeGreaterThanOrEqual(3);
    expect(g.plies[3].label).toMatch(/悪手/);
    const cards = await api("GET", "/api/cards");
    expect(cards.length).toBeGreaterThanOrEqual(1);
    const card = cards.find((c: { ply: number }) => c.ply === 3);
    expect(card.side).toBe("black");
    // Answering with the game move is wrong; answering with the best move is right.
    const wrong = await api("POST", `/api/cards/${card.id}/answer`, { usi: card.played_usi });
    expect(wrong.correct).toBe(false);
    const right = await api("POST", `/api/cards/${card.id}/answer`, { usi: card.best_usi });
    expect(right.correct).toBe(true);
    const next = await api("POST", `/api/cards/${card.id}/rate`, { rating: "good" });
    expect(next.intervalDays).toBe(1);
    const counts = await api("GET", "/api/cards/counts");
    expect(counts.reviewedToday).toBe(1);

    // Re-analysing uses the eval cache: same results.
    await api("POST", "/api/analysis", { ids: [id], force: true });
    await waitIdle();
    const g2 = await api("GET", `/api/games/${id}`);
    expect(g2.plies.map((p: { score: number }) => p.score)).toEqual(g.plies.map((p: { score: number }) => p.score));

    // Export carries evals in ShogiHome's comment format and re-imports with them.
    const res = await fetch(`${base}/api/games/${id}/export?format=kif&utf8=1`);
    const text = await res.text();
    expect(text).toContain("#評価値=");
    expect(text).toContain("【");
  });

  it("computes stats", async () => {
    const s = await api("GET", "/api/stats");
    expect(s.totals.games).toBe(2);
    expect(s.totals.losses).toBe(1);
    expect(s.totals.wins).toBe(1);
    expect(s.bySide.find((x: { name: string }) => x.name === "先手").games).toBe(2);
    // My moves in the timed game: 3s, 2s (the blunder) and 70s.
    const fast = s.thinkTime.find((b: { label: string }) => b.label === "< 5s");
    expect(fast.moves).toBe(2);
    expect(fast.mistakes).toBeGreaterThanOrEqual(1);
    expect(s.thinkTime.find((b: { label: string }) => b.label === "60s+").moves).toBe(1);
    expect(s.phaseProfile[0].avgSeconds).toBeCloseTo(25, 0);
    // ▲3三角成 lands on 3三: row 3, column for file 3.
    expect(s.mistakeMap.cells[(3 - 1) * 9 + (9 - 3)]).toBeGreaterThanOrEqual(1);
    expect(s.mistakeMap.byPiece.find((p: { piece: string }) => p.piece === "角")?.n).toBeGreaterThanOrEqual(1);
  });

  it("stores notebook pages and position search", async () => {
    const p = await api("POST", "/api/pages", { title: "四間飛車 notes", body: "intro" });
    await api("POST", `/api/pages/${p.id}/append`, { text: ":::shogi-view{game=1 ply=8}\n:::" });
    const got = await api("GET", `/api/pages/${p.id}`);
    expect(got.body).toContain("shogi-view");
    const hits = await api("GET", "/api/position-search?sfen=" + encodeURIComponent("lnsgkgsnl/1r5b1/pppppp1pp/6p2/9/2P6/PP1PPPPPP/1B5R1/LNSGKGSNL b - 3"));
    expect(hits.length).toBe(2);
  });

  it("flags leeches and exports cards for Anki", async () => {
    const games = await api("GET", "/api/games");
    const card = await api("POST", "/api/cards", { gameId: games[0].id, ply: 5, note: "watch the bishop" });
    let r;
    for (let i = 0; i < 4; i++) r = await api("POST", `/api/cards/${card.id}/rate`, { rating: "again" });
    expect(r.lapses).toBe(4);
    expect(r.becameLeech).toBe(true);
    const leeches = await api("GET", "/api/cards?leech=1");
    expect(leeches.map((c: { id: number }) => c.id)).toContain(card.id);
    expect(leeches.every((c: { leech: boolean }) => c.leech)).toBe(true);

    const res = await fetch(base + "/api/cards/export/anki");
    expect(res.headers.get("content-type")).toContain("tab-separated");
    const tsv = await res.text();
    const lines = tsv.trim().split("\n");
    expect(lines.slice(0, 2)).toEqual(["#separator:tab", "#html:true"]);
    const rows = lines.filter((l) => !l.startsWith("#"));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) expect(row.split("\t")).toHaveLength(3);
    const mine = rows.find((l) => l.includes("watch the bishop"))!;
    expect(mine).toContain("<pre");
    expect(mine).toContain("後手の持駒");
    expect(mine.split("\t")[2]).toContain("kifu-study");
  });

  it("checks positions for a forced mate", async () => {
    // 頭金: ☗5二金打 mates the king on 5一, with the pawn on 5三 guarding the gold.
    const mate = await api("POST", "/api/mate", { sfen: "4k4/9/4P4/9/9/9/9/9/4K4 b G 1", timeMs: 1000 });
    expect(mate.status).toBe("mate");
    expect(mate.moves).toEqual(["G*5b"]);
    expect(mate.text).toContain("５二金");
    const none = await api("POST", "/api/mate", { sfen: "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1", timeMs: 1000 });
    expect(none.status).toBe("nomate");
  });

  it("searches move comments and game notes", async () => {
    const games = await api("GET", "/api/games");
    const id = games[0].id;
    await api("PUT", `/api/games/${id}/comments/2`, { comment: "ここで角交換を考えた" });
    await api("PATCH", `/api/games/${games[1].id}`, { notes: "Time trouble at the end" });
    const byComment = await api("GET", "/api/games?q=" + encodeURIComponent("角交換"));
    expect(byComment.map((g: { id: number }) => g.id)).toEqual([id]);
    const byNote = await api("GET", "/api/games?q=TIME%20TROUBLE");
    expect(byNote.map((g: { id: number }) => g.id)).toEqual([games[1].id]);
  });

  it("schedules with FSRS when chosen", async () => {
    await api("PUT", "/api/settings", { scheduler: "fsrs", desiredRetention: 0.9 });
    const games = await api("GET", "/api/games");
    const card = await api("POST", "/api/cards", { gameId: games[1].id, ply: 3 });
    const r = await api("POST", `/api/cards/${card.id}/rate`, { rating: "good" });
    expect(r.stability).toBeCloseTo(3.7145, 3);
    expect(r.intervalDays).toBe(4);
    const stored = await api("GET", `/api/cards/${card.id}`);
    expect(stored.stability).toBeCloseTo(3.7145, 3);
    expect(stored.last_review_at).toBeGreaterThan(0);
    await api("PUT", "/api/settings", { scheduler: "sm2" });
  });

  it("marks book moves and where a game leaves the book", async () => {
    const { Position } = await import("tsshogi");
    const sfenAfter = (usi: string) => {
      const pos = Position.newBySFEN("lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1")!;
      for (const u of usi.split(" ").filter(Boolean)) pos.doMove(pos.createMoveByUSI(u)!);
      return pos.sfen;
    };
    const book = [
      "#YANEURAOU-DB2016 1.00",
      `sfen ${sfenAfter("")}`,
      "2g2f none 30 20 5",
      "7g7f 3c3d 40 20 10",
      `sfen ${sfenAfter("7g7f")}`,
      "8c8d none -10 20 2",
      "3c3d none -20 20 8",
      `sfen ${sfenAfter("7g7f 3c3d")}`,
      "2g2f none 50 20 4 // 居飛車",
    ].join("\n");
    const file = path.join(mkdtempSync(path.join(tmpdir(), "kifu-book-")), "book.db");
    writeFileSync(file, book);
    expect((await api("GET", "/api/book")).configured).toBe(false);
    await api("PUT", "/api/settings", { bookPath: file });

    const root = await api("GET", "/api/book");
    expect(root.moves.map((m: { usi: string }) => m.usi)).toEqual(["7g7f", "2g2f"]);
    expect(root.moves[0]).toMatchObject({ count: 10, score: 40, text: "☗７六歩" });

    const games = await api("GET", "/api/games");
    const blunder = games.find((g: { move_count: number }) => g.move_count === 5);
    const b = await api("GET", `/api/games/${blunder.id}/book`);
    expect(b.inBook).toEqual([1, 2]);
    expect(b.leftBookAt).toBe(3);
    expect(b.alternatives.map((m: { usi: string }) => m.usi)).toEqual(["2g2f"]);
    await api("PUT", "/api/settings", { bookPath: "" });
  });

  it("explores my games move by move", async () => {
    const root = await api("GET", "/api/explorer");
    expect(root.games).toBe(2);
    expect(root.moves).toHaveLength(1);
    expect(root.moves[0]).toMatchObject({ usi: "7g7f", text: "☗７六歩", games: 2, mine: 2, wins: 1, losses: 1 });
    expect(root.engine?.bestUsi).toBeTruthy();

    const after = "lnsgkgsnl/1r5b1/pppppp1pp/6p2/9/2P6/PP1PPPPPP/1B5R1/LNSGKGSNL b - 3";
    const x = await api("GET", "/api/explorer?sfen=" + encodeURIComponent(after));
    expect(x.games).toBe(2);
    expect(x.moves.map((m: { usi: string }) => m.usi).sort()).toEqual(["2g2f", "8h3c+"]);
    expect(x.moves.every((m: { games: number; mine: number }) => m.games === 1 && m.mine === 1)).toBe(true);

    const white = await api("GET", "/api/explorer?side=white");
    expect(white.games).toBe(0);
    expect(white.moves).toEqual([]);
  });
});

describe("database upgrades", () => {
  it("adds columns that older library files lack", async () => {
    const { Db } = await import("../src/server/db.js");
    const file = path.join(mkdtempSync(path.join(tmpdir(), "kifu-old-")), "old.db");
    const old = new Db(file);
    old.run("ALTER TABLE plies DROP COLUMN missed");
    old.close();
    const db = new Db(file);
    const cols = db.all<{ name: string }>("PRAGMA table_info(plies)").map((c) => c.name);
    expect(cols).toContain("missed");
    db.close();
  });
});
