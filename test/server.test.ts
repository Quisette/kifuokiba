import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server/app.js";
import { makeKif, sjis, SHIKEN_VS_FUNA } from "./fixtures.js";

// Windows cannot run a .mjs directly; the .cmd wrapper starts it with node.
const MOCK = path.resolve(process.platform === "win32" ? "tools/mock-usi-engine.cmd" : "tools/mock-usi-engine.mjs");

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

  it("keeps my own move marks", async () => {
    const id = (await api("GET", "/api/games"))[0].id;
    await api("PUT", `/api/games/${id}/marks/2`, { mark: "!?" });
    expect((await api("GET", `/api/games/${id}`)).plies[2].user_mark).toBe("!?");
    await api("PUT", `/api/games/${id}/marks/2`, { mark: "" });
    expect((await api("GET", `/api/games/${id}`)).plies[2].user_mark).toBe("");
    await expect(api("PUT", `/api/games/${id}/marks/2`, { mark: "!!!" })).rejects.toThrow(/400|mark/);
    // A move I marked as a blunder goes into the review note even before analysis.
    await api("PUT", `/api/games/${id}/marks/1`, { mark: "??" });
    expect((await api("GET", `/api/games/${id}/note`)).body).toMatch(/### 1手目 \S+\?\?（my mark）/);
    await api("PUT", `/api/games/${id}/marks/1`, { mark: "" });
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

  it("writes a review note with each big mistake as a board", async () => {
    const list = await api("GET", "/api/games?q=x");
    const id = list.find((g: { white: string; analysis_status: string }) => g.white === "x" && g.analysis_status === "done").id;
    const n = await api("GET", `/api/games/${id}/note`);
    expect(n.title).toBe("2026-09-02 me vs x");
    expect(n.body).toContain(`:::shogi-view{game=${id} ply=2}`);
    expect(n.body).toMatch(/### 3手目 ☗３三角成（悪手/);
    // The portable .mdx carries the moves so it renders without the library.
    const res = await fetch(`${base}/api/games/${id}/note?portable=1&download=1`);
    const mdx = await res.text();
    expect(mdx.startsWith("---\ntitle:")).toBe(true);
    expect(mdx).toContain(":::shogi-view{move=2}\nposition startpos moves 7g7f 3c3d 8h3c+ 2a3c 2g2f\n:::");
    expect(mdx).not.toContain("game=");
    const page = await api("POST", `/api/games/${id}/note`);
    expect(page.notebook).toBe("Game reviews");
    expect(page.body).toBe(n.body);
  });

  it("exports the filtered games as a zip of KIF files", async () => {
    const { inflateRawSync } = await import("node:zlib");
    const all = await api("GET", "/api/games");
    const res = await fetch(`${base}/api/export/games?utf8=1`);
    expect(res.headers.get("content-type")).toBe("application/zip");
    const buf = Buffer.from(await res.arrayBuffer());
    const end = buf.length - 22;
    expect(buf.readUInt32LE(end)).toBe(0x06054b50);
    expect(buf.readUInt16LE(end + 10)).toBe(all.length);
    // First entry: inflate it and check it is a KIF with its UTF-8 name.
    const nameLen = buf.readUInt16LE(26);
    const name = buf.subarray(30, 30 + nameLen).toString("utf8");
    expect(name).toMatch(/_vs_.*\.kif$/);
    const packed = buf.subarray(30 + nameLen, 30 + nameLen + buf.readUInt32LE(18));
    expect(inflateRawSync(packed).toString("utf8")).toContain("手合割");
    // The filter applies: one opponent only.
    const one = Buffer.from(await (await fetch(`${base}/api/export/games?opponent=rival`)).arrayBuffer());
    expect(one.readUInt16LE(one.length - 12)).toBe(all.filter((g: { white: string; black: string }) => g.white === "rival" || g.black === "rival").length);
  });

  it("serves a position diagram as SVG", async () => {
    const sfen = "lnsgkgsnl/1r5b1/ppppppppp/9/9/2P6/PP1PPPPPP/1B5R1/LNSGKGSNL w - 2";
    const r = await fetch(`${base}/api/diagram.svg?sfen=${encodeURIComponent(sfen)}&last=7g7f`);
    expect(r.headers.get("content-type")).toBe("image/svg+xml");
    expect(r.headers.get("content-disposition")).toBeNull();
    expect(await r.text()).toMatch(/^<svg/);
    expect((await fetch(`${base}/api/diagram.svg?sfen=junk`)).status).toBe(400);
  });

  it("lists the variations stored in a KIF", async () => {
    const kif = [
      "手合割：平手", "先手：me", "後手：branchy", "手数----指手---------消費時間--",
      "   1 ７六歩(77)   ( 0:00/00:00:00)", "   2 ３四歩(33)   ( 0:00/00:00:00)+", "   3 ２六歩(27)   ( 0:00/00:00:00)", "   4 投了", "",
      "変化：2手", "   2 ８四歩(83)   ( 0:00/00:00:00)", "*居飛車にする手", "   3 ６八銀(79)   ( 0:00/00:00:00)", "",
    ].join("\n");
    const id = (await api("POST", "/api/import", { text: kif })).results[0].id;
    const b = await api("GET", `/api/games/${id}/branches`);
    expect(b).toEqual([{ ply: 2, usis: ["8c8d", "7i6h"], texts: ["☖８四歩", "☗６八銀"], comment: "居飛車にする手" }]);
    // The main line is unchanged.
    expect((await api("GET", `/api/games/${id}`)).plies.map((p: { usi: string }) => p.usi).slice(1)).toEqual(["7g7f", "3c3d", "2g2f"]);
    await api("DELETE", `/api/games/${id}`);
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
    // The blunder ▲3三角成 promotes on an empty square (△同桂 then takes it).
    const kind = (k: string) => s.moveKinds.rows.find((r: { kind: string }) => r.kind === k);
    expect(s.moveKinds.total).toBeGreaterThan(0);
    expect(kind("promotion").mistakes).toBeGreaterThanOrEqual(1);
    expect(kind("promotion").mistakeRate).toBeGreaterThan(kind("quiet").mistakeRate);
    expect(kind("quiet").moves).toBeGreaterThan(0);
  });

  it("works out move kinds for plies imported before they were stored", async () => {
    const before = (await api("GET", "/api/stats")).moveKinds;
    app.db.run("UPDATE plies SET move_kind = NULL");
    const after = (await api("GET", "/api/stats")).moveKinds;
    expect(after).toEqual(before);
    expect(app.db.get<{ n: number }>("SELECT count(*) n FROM plies WHERE ply > 0 AND move_kind IS NULL")!.n).toBe(0);
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
    expect(mine).toContain("<svg ");
    expect(mine).toContain("☖");
    expect(mine.split("\t")[2]).toContain("kifu-study");
  });

  it("counts reviews per day for the streak calendar", async () => {
    const a = await api("GET", "/api/cards/activity?days=30");
    expect(a.days).toHaveLength(30);
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    expect(a.days.at(-1).date).toBe(today);
    expect(a.days.at(-1).n).toBe(a.total);
    expect(a.streak).toBe(1);
    expect(a.best).toBe(1);
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

  it("downloads a consistent backup of the library", async () => {
    const res = await fetch(base + "/api/backup");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/kifu-study-\d{4}-\d{2}-\d{2}\.db/);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 15).toString()).toBe("SQLite format 3");
    const file = path.join(mkdtempSync(path.join(tmpdir(), "kifu-restore-")), "copy.db");
    writeFileSync(file, buf);
    const { Db } = await import("../src/server/db.js");
    const copy = new Db(file);
    const live = await api("GET", "/api/games");
    expect(copy.all("SELECT id FROM games")).toHaveLength(live.length);
    copy.close();
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

    // Against one opponent only (the player profile's "Openings against them").
    const vs = await api("GET", "/api/explorer?opponent=rival");
    expect(vs.games).toBe(1);
    expect((await api("GET", "/api/explorer?opponent=nobody")).games).toBe(0);
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

describe("review streaks", () => {
  it("counts consecutive days and keeps a streak alive until today ends", async () => {
    const { Db } = await import("../src/server/db.js");
    const { Library } = await import("../src/server/library.js");
    const { Cards } = await import("../src/server/cards.js");
    const db = new Db(":memory:");
    const lib = new Library(db);
    const cards = new Cards(lib, null as never);
    const at = (daysAgo: number) => {
      const d = new Date();
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysAgo, 12).getTime();
    };
    // Rows reference a card; foreign keys are on, so make one.
    const kif = makeKif({ moves: "7g7f 3c3d", black: "me", white: "x", date: "2026/09/03" });
    const gid = (lib.importText(kif) as { id: number }).id;
    db.run("INSERT INTO cards (game_id, ply, sfen, side, played_usi, best_usi, due_at, created_at) VALUES (?,1,'s','black','7g7f','2g2f',0,0)", gid);
    // Days 10-8 ago (3 in a row), then yesterday and the day before.
    for (const n of [10, 9, 8, 2, 1, 1]) db.run("INSERT INTO reviews (card_id, at, rating) VALUES (1, ?, 'good')", at(n));
    const a = cards.activity(14);
    expect(a.best).toBe(3);
    expect(a.streak).toBe(2); // today has none yet, so the streak counts from yesterday
    expect(a.days.at(-2)!.n).toBe(2);
    db.run("INSERT INTO reviews (card_id, at, rating) VALUES (1, ?, 'again')", at(0));
    expect(cards.activity(14).streak).toBe(3);
    expect(cards.activity(14).days.at(-1)).toMatchObject({ n: 1, again: 1 });
    db.close();
  });
});

describe("mate puzzles", () => {
  it("takes one puzzle per mating sequence and marks the ones missed", async () => {
    const { Db } = await import("../src/server/db.js");
    const { Library } = await import("../src/server/library.js");
    const { findPuzzles } = await import("../src/server/puzzles.js");
    const { saveSettings } = await import("../src/server/settings.js");
    const db = new Db(":memory:");
    const lib = new Library(db);
    saveSettings(db, { ...lib.settings, myNames: ["me"] });
    const kif = makeKif({ moves: "7g7f 3c3d 2g2f 4c4d 2f2e 2b3c", black: "me", white: "x", date: "2026/09/04" });
    const gid = (lib.importText(kif) as { id: number }).id;
    const set = (ply: number, mate: number | null, best = "", missed = "") =>
      db.run("UPDATE plies SET mate = ?, best_usi = ?, missed = ? WHERE game_id = ? AND ply = ?", mate, best, missed, gid, ply);
    // After ply 2 black (to move) mates in 5 and keeps it after ply 4; black lets it go at ply 5.
    set(2, 5, "2g2f");
    set(3, 4, "4c4d");
    set(4, 3, "2f2e");
    // Black's 5th move lets it go; now white mates in 3: the opponent's, so only with mineOnly off.
    set(5, -3, "2b3c", "mate");
    const mine = findPuzzles(lib, { mineOnly: true });
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ ply: 2, mateIn: 5, side: "black", mine: true, missed: true });
    const all = findPuzzles(lib);
    expect(all.map((p) => [p.ply, p.side])).toEqual(expect.arrayContaining([[2, "black"], [5, "white"]]));
    db.close();
  });
});

describe("opening drill", () => {
  it("collects my opening positions and judges moves by engine, book and my own good moves", async () => {
    const { Db } = await import("../src/server/db.js");
    const { Library } = await import("../src/server/library.js");
    const { repertoire } = await import("../src/server/repertoire.js");
    const { saveSettings } = await import("../src/server/settings.js");
    const db = new Db(":memory:");
    const lib = new Library(db);
    saveSettings(db, { ...lib.settings, myNames: ["me"] });
    const ids = ["7g7f 3c3d 2g2f", "7g7f 3c3d 6g6f", "7g7f 3c3d 6g6f 8c8d"].map(
      (moves, i) => (lib.importText(makeKif({ moves, black: "me", white: "x" + i, date: `2026/09/0${i + 1}` })) as { id: number }).id,
    );
    // Engine prefers 2g2f after 7g7f 3c3d; 6g6f lost 5 points each time, 2g2f lost nothing.
    for (const id of ids) {
      db.run("UPDATE plies SET best_usi = '2g2f' WHERE game_id = ? AND ply = 2", id);
      db.run("UPDATE plies SET loss = CASE usi WHEN '6g6f' THEN 5 ELSE 0 END WHERE game_id = ? AND ply = 3", id);
    }
    const r = repertoire(lib, { side: "black" });
    const p = r.find((x) => x.ply === 2)!;
    expect(p.count).toBe(3);
    expect(p.played.map((m) => [m.usi, m.count, m.good])).toEqual([["6g6f", 2, false], ["2g2f", 1, true]]);
    expect(p.accepted.map((a) => [a.usi, a.why])).toEqual([["2g2f", "engine"]]);
    expect(p.problem).toBe(true);
    // The first move has no analysis at all, so it is left out rather than accepting anything.
    expect(r.find((x) => x.ply === 0)).toBeUndefined();
    expect(repertoire(lib, { side: "white" })).toEqual([]);
    db.close();
  });
});

describe("automatic backups", () => {
  it("makes one backup per day and keeps the newest few", async () => {
    const { Db } = await import("../src/server/db.js");
    const { AutoBackup } = await import("../src/server/backup.js");
    const { readdirSync } = await import("node:fs");
    const dir = mkdtempSync(path.join(tmpdir(), "kifu-study-bk-"));
    const db = new Db(path.join(dir, "lib.db"));
    let keep = 2;
    const b = new AutoBackup(db, path.join(dir, "lib.db"), () => keep);
    expect(b.runIfDue(new Date(2026, 8, 1, 10))).toMatch(/kifu-study-2026-09-01\.db$/);
    expect(b.runIfDue(new Date(2026, 8, 1, 22))).toBeNull(); // same day
    b.runIfDue(new Date(2026, 8, 2, 10));
    b.runIfDue(new Date(2026, 8, 3, 10));
    expect(b.list().map((f) => f.date)).toEqual(["2026-09-03", "2026-09-02"]);
    expect(readdirSync(path.join(dir, "backups"))).toHaveLength(2);
    // The copy is a working library.
    const copy = new Db(path.join(dir, "backups", "kifu-study-2026-09-03.db"));
    expect(copy.get<{ n: number }>("SELECT COUNT(*) n FROM games")!.n).toBe(0);
    copy.close();
    keep = 0;
    expect(b.runIfDue(new Date(2026, 8, 4, 10))).toBeNull();
    db.close();
  });
});

describe("today's study plan", () => {
  it("lists due cards and recent losses without a review note", async () => {
    const { Db } = await import("../src/server/db.js");
    const { Library } = await import("../src/server/library.js");
    const { Cards } = await import("../src/server/cards.js");
    const { Pages } = await import("../src/server/pages.js");
    const { todayPlan } = await import("../src/server/today.js");
    const { saveSettings } = await import("../src/server/settings.js");
    const db = new Db(":memory:");
    const lib = new Library(db);
    saveSettings(db, { ...lib.settings, myNames: ["me"] });
    const cards = new Cards(lib, null as never);
    // Two moves, then black resigns: losses for "me" as black.
    const imp = (white: string, date: string) => (lib.importText(makeKif({ moves: "7g7f 3c3d", black: "me", white, date })) as { id: number }).id;
    const old = imp("a", "2026/08/01");
    const recent = imp("b", "2026/09/08");
    const noted = imp("c", "2026/09/09");
    new Pages(db).create({ title: "review", body: `:::shogi-view{game=${noted} ply=1}\n:::` });
    const plan = todayPlan(lib, cards, null, new Date(2026, 8, 10).getTime());
    expect(plan.losses.map((g) => g.id)).toEqual([recent]);
    expect(plan.losses[0].opponent).toBe("b");
    // Same short move list, different opponents: three games, not duplicates.
    expect(new Set([old, recent, noted]).size).toBe(3);
    expect(plan).toMatchObject({ due: 0, missedMates: 0, weakOpenings: 0 });
    db.close();
  });
});

describe("derived-result cache", () => {
  it("recomputes after a game or the settings change", async () => {
    const { Db } = await import("../src/server/db.js");
    const { Library } = await import("../src/server/library.js");
    const { saveSettings } = await import("../src/server/settings.js");
    const db = new Db(":memory:");
    const lib = new Library(db);
    let runs = 0;
    const count = () => lib.cached("n", () => (runs++, db.get<{ n: number }>("SELECT COUNT(*) n FROM games")!.n));
    expect(count()).toBe(0);
    expect(count()).toBe(0);
    expect(runs).toBe(1);
    lib.importText(makeKif({ moves: "7g7f 3c3d", black: "a", white: "b" }));
    expect(count()).toBe(1);
    saveSettings(db, { ...lib.settings, myNames: ["a"] });
    count();
    expect(runs).toBe(3);
    db.close();
  });
});

describe("streamed analysis", () => {
  // Reads SSE events from /api/live until `until` says stop (then aborts) or the stream ends.
  const stream = async (q: string, until?: (event: string, data: any) => boolean) => {
    const ctl = new AbortController();
    const r = await fetch(`${base}/api/live?${q}`, { signal: ctl.signal });
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const events: { event: string; data: any }[] = [];
    const reader = r.body!.getReader();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value);
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = /^event: (.*)$/m.exec(chunk)?.[1] ?? "";
          const data = JSON.parse(/^data: (.*)$/m.exec(chunk)?.[1] ?? "null");
          events.push({ event, data });
          if (until?.(event, data)) {
            ctl.abort();
            return events;
          }
        }
      }
    } catch (e) {
      if (!ctl.signal.aborted) throw e;
    }
    return events;
  };
  const START = encodeURIComponent("lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1");

  it("streams deepening lines and finishes at the time limit", async () => {
    const ev = await stream(`sfen=${START}&moves=7g7f&multipv=2&maxMs=600`);
    const lines = ev.filter((e) => e.event === "lines");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const depths = lines.map((e) => e.data.lines[0].depth);
    expect(depths.at(-1)).toBeGreaterThan(depths[0]);
    expect(lines[0].data.lines).toHaveLength(2);
    expect(lines[0].data.lines[0].text).toMatch(/^△/);
    const done = ev.at(-1)!;
    expect(done.event).toBe("done");
    expect(done.data.best).toMatch(/^[1-9][a-i]/);
    expect(done.data.elapsedMs).toBeGreaterThanOrEqual(500);
  });

  it("stops the engine when the stream is closed", async () => {
    const t0 = Date.now();
    await stream(`sfen=${START}&maxMs=60000`, (event, data) => event === "lines" && data.lines[0].depth >= 3);
    // The engine is free again: a normal search answers long before the 60 s limit.
    const r = await api("POST", "/api/analyze-position", { sfen: decodeURIComponent(START), movetimeMs: 50 });
    expect(r.best).toBeTruthy();
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it("rejects a bad position", async () => {
    const r = await fetch(`${base}/api/live?sfen=nonsense`);
    expect(r.status).toBe(400);
  });
});

describe("variations saved into a game", () => {
  it("adds board lines to a game as branches without touching its main line", async () => {
    const kif = makeKif({ moves: "7g7f 3c3d 2g2f 8c8d", black: "me", white: "branchy", date: "2026/09/07" });
    const id = (await api("POST", "/api/import", { text: kif })).results[0].id;
    const before = (await api("GET", `/api/games/${id}`)).plies.map((p: { usi: string }) => p.usi);
    const r = await api("POST", `/api/games/${id}/variations`, { tree: "7g7f 3c3d (8c8d 2g2f) 2g2f 8c8d (4a3b)" });
    expect(r.branches).toBe(2);
    const branches = await api("GET", `/api/games/${id}/branches`);
    expect(branches.map((b: { ply: number; usis: string[] }) => [b.ply, b.usis])).toEqual([
      [2, ["8c8d", "2g2f"]],
      [4, ["4a3b"]],
    ]);
    expect((await api("GET", `/api/games/${id}`)).plies.map((p: { usi: string }) => p.usi)).toEqual(before);
    // Merging the same lines again adds nothing; the KIF export carries them.
    expect((await api("POST", `/api/games/${id}/variations`, { tree: "7g7f 8c8d" })).branches).toBe(2);
    const exported = new TextDecoder("shift_jis").decode(await (await fetch(`${base}/api/games/${id}/export?format=kif`)).arrayBuffer());
    expect(exported).toContain("変化：2手");
    await expect(api("POST", `/api/games/${id}/variations`, { tree: "7g7f (" })).rejects.toThrow(/400|variation/);
    await api("DELETE", `/api/games/${id}`);
  });
});

describe("custom review decks", () => {
  it("filters cards by opponent, tag, kind of move and side, and saves decks", async () => {
    // ☗ "me" hangs the bishop with ▲3三角成 (a promotion) against "deckfoe".
    const kif = makeKif({ moves: "7g7f 3c3d 8h3c+ 2a3c 2g2f", black: "me", white: "deckfoe", date: "2026/09/09" });
    const gid = (await api("POST", "/api/import", { text: kif })).results[0].id;
    await api("PATCH", `/api/games/${gid}`, { tags: ["deckdemo"] });
    await api("POST", "/api/analysis", { ids: [gid] });
    await waitIdle();
    const mine = await api("GET", "/api/cards?opponent=deckfoe");
    expect(mine.length).toBeGreaterThanOrEqual(1);
    expect(mine.every((c: { game_id: number }) => c.game_id === gid)).toBe(true);
    expect(mine[0]).toMatchObject({ opponent: "deckfoe", tags: ["deckdemo"], side: "black" });
    expect(mine[0].moveKinds).toContain("promotion");
    expect(await api("GET", "/api/cards?tag=deckdemo")).toHaveLength(mine.length);
    expect((await api("GET", "/api/cards?opponent=deckfoe&moveKind=drop")).length).toBe(0);
    expect((await api("GET", "/api/cards?opponent=deckfoe&side=white")).length).toBe(0);

    const facets = await api("GET", "/api/cards/facets");
    expect(facets.opponent.find((f: { value: string }) => f.value === "deckfoe").total).toBe(mine.length);
    expect(facets.tag.map((f: { value: string }) => f.value)).toContain("deckdemo");

    const deck = await api("POST", "/api/decks", { name: "vs deckfoe", filter: { opponent: "deckfoe", due: true, bogus: 1 } });
    expect(deck.filter).toEqual({ opponent: "deckfoe" });
    const decks = await api("GET", "/api/decks");
    expect(decks.find((d: { id: number }) => d.id === deck.id)).toMatchObject({ name: "vs deckfoe", total: mine.length });
    expect(await api("GET", `/api/cards?deck=${deck.id}`)).toHaveLength(mine.length);
    const plan = await api("GET", "/api/today");
    expect(plan.deck).toMatchObject({ id: deck.id, name: "vs deckfoe" });
    await expect(api("POST", "/api/decks", { name: " " })).rejects.toThrow(/name/);
    await api("DELETE", `/api/decks/${deck.id}`);
    expect((await api("GET", "/api/decks")).some((d: { id: number }) => d.id === deck.id)).toBe(false);
    await api("DELETE", `/api/games/${gid}`);
  });
});

describe("opponent prep sheet", () => {
  it("writes a notebook page about one opponent", async () => {
    const moves = SHIKEN_VS_FUNA.split(" ");
    const ids: number[] = [];
    for (const [usi, date] of [
      [SHIKEN_VS_FUNA, "2026/09/10"],
      [moves.slice(0, 12).join(" "), "2026/09/11"],
      ["7g7f 3c3d 8h3c+ 2a3c 2g2f", "2026/09/12"],
    ]) {
      ids.push((await api("POST", "/api/import", { text: makeKif({ moves: usi, black: "me", white: "prepfoe", date }) })).results[0].id);
    }
    await api("POST", "/api/analysis", { ids });
    await waitIdle();
    const page = await api("POST", "/api/notes/prep", { opponent: "prepfoe" });
    expect(page.notebook).toBe("Opponents");
    expect(page.title).toBe("対策 vs prepfoe");
    const body: string = page.body;
    expect(body).toMatch(/3 games · \d勝 \d敗/);
    expect(body).toContain("| ☗ | 四間飛車 |");
    expect(body).toContain("Positions I keep reaching");
    expect(body).toMatch(/reached in 2 games\n\n:::shogi-view\{game=\d+ ply=\d+\}/);
    expect(body).toContain("My costliest moves against them");
    expect(body).toContain("#/review?opponent=prepfoe");
    expect(body).toContain(`](#/game/${ids[2]})`);
    await expect(api("POST", "/api/notes/prep", { opponent: "nobody-at-all" })).rejects.toThrow(/404|no games/);
    for (const id of ids) await api("DELETE", `/api/games/${id}`);
    await api("DELETE", `/api/pages/${page.id}`);
  });
});
