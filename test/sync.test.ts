import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/server/app.js";
import { lishogiGameToKif, LishogiGame } from "../src/server/fetchers/lishogi.js";
import { importRecordFromText } from "../src/core/recordFile.js";
import { summarizeRecord } from "../src/core/summarize.js";

// Payloads shaped like Lishogi's /api/games/user ndjson export. The live API was not
// reachable from the test sandbox, so these follow its documented Lichess-style shape.
const GAMES: LishogiGame[] = [
  {
    id: "aaaa1111",
    rated: true,
    variant: "standard",
    speed: "blitz",
    createdAt: Date.UTC(2026, 8, 20, 12, 0),
    lastMoveAt: Date.UTC(2026, 8, 20, 12, 10),
    status: "resign",
    players: { sente: { user: { name: "me", id: "me" }, rating: 1650 }, gote: { user: { name: "foe", id: "foe" }, rating: 1700 } },
    winner: "sente",
    moves: "7g7f 3c3d 2g2f 4c4d 2f2e 2b3c 3i4h",
    clock: { initial: 600, increment: 0, byoyomi: 10 },
  },
  {
    // Gote resigned while it was sente's turn: KIF can't say that, the result must still be right.
    id: "bbbb2222",
    rated: false,
    variant: "standard",
    speed: "rapid",
    createdAt: Date.UTC(2026, 8, 21, 12, 0),
    lastMoveAt: Date.UTC(2026, 8, 21, 12, 30),
    status: "resign",
    players: { sente: { user: { name: "me" } }, gote: { user: { name: "foe" } } },
    winner: "sente",
    moves: "7g7f 3c3d 2g2f 8c8d",
  },
  { id: "cccc3333", variant: "minishogi", status: "resign", winner: "gote", moves: "1e1d", players: {} },
  { id: "dddd4444", variant: "standard", status: "aborted", moves: "", players: {} },
];

describe("lishogi conversion", () => {
  it("turns a game into KIF with names, date, time control and result", () => {
    const kif = lishogiGameToKif(GAMES[0])!;
    const rec = importRecordFromText(kif);
    if (rec instanceof Error) throw rec;
    const s = summarizeRecord(rec, kif);
    expect(s.moveCount).toBe(7);
    expect(s.result).toBe("black");
    expect(s.source).toBe("lishogi");
    expect(kif).toContain("me (1650)");
    expect(kif).toContain("https://lishogi.org/aaaa1111");
    expect(kif).toContain("10分");
  });

  it("keeps the winner right when the loser resigned out of turn", () => {
    const kif = lishogiGameToKif(GAMES[1])!;
    const rec = importRecordFromText(kif);
    if (rec instanceof Error) throw rec;
    expect(summarizeRecord(rec, kif).result).toBe("black");
  });

  it("skips variants and aborted games", () => {
    expect(lishogiGameToKif(GAMES[2])).toBeNull();
    expect(lishogiGameToKif(GAMES[3])).toBeNull();
  });
});

describe("lishogi sync API", () => {
  const calls: string[] = [];
  let app: ReturnType<typeof createApp>;
  let base = "";
  const api = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(base + p, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };

  beforeAll(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kifu-sync-"));
    app = createApp({
      dbPath: path.join(dir, "t.db"),
      lishogiBase: "https://lishogi.test",
      fetchImpl: async (url, init) => {
        calls.push(url);
        expect(init?.headers?.Accept).toBe("application/x-ndjson");
        if (url.includes("/user/nobody")) return { ok: false, status: 404, text: async () => "" };
        return { ok: true, status: 200, text: async () => GAMES.map((g) => JSON.stringify(g)).join("\n") + "\n" };
      },
    });
    base = `http://127.0.0.1:${await app.listen()}`;
    await api("PUT", "/api/settings", { myNames: ["me"], autoAnalyze: false, accounts: { lishogi: "me" } });
  });
  afterAll(async () => app.close());

  it("imports new games, then only overlaps on the next sync", async () => {
    const first = await api("POST", "/api/sync/lishogi");
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ fetched: 4, duplicates: 0, skipped: 2, errors: [] });
    expect(first.body.added).toHaveLength(2);
    expect(calls[0]).toMatch(/^https:\/\/lishogi\.test\/api\/games\/user\/me\?/);
    expect(calls[0]).not.toContain("since=");

    const games = (await api("GET", "/api/games")).body;
    expect(games.map((g: { myResult: string }) => g.myResult).sort()).toEqual(["win", "win"]);
    expect(games.every((g: { source: string }) => g.source === "lishogi")).toBe(true);

    expect(games.every((g: { opponent: string }) => g.opponent === "foe")).toBe(true);
    const stats = (await api("GET", "/api/stats")).body;
    expect(stats.ratingHistory).toEqual([{ source: "lishogi", points: [expect.objectContaining({ rating: 1650, result: "win" })] }]);

    const prof = (await api("GET", "/api/players/foe")).body;
    expect(prof.totals).toMatchObject({ games: 2, wins: 2, losses: 0 });
    expect(prof.form).toBe("WW");
    expect(prof.theirRating).toBe(1700);
    expect((await api("GET", "/api/players/" + encodeURIComponent("誰か"))).status).toBe(404);
    // Both games open the same way with me as sente, so each is the other's similar game.
    const sim = (await api("GET", `/api/games/${games[0].id}/similar`)).body;
    expect(sim.map((g: { id: number }) => g.id)).toEqual([games[1].id]);

    const second = await api("POST", "/api/sync/lishogi");
    expect(second.body.added).toHaveLength(0);
    expect(second.body.duplicates).toBe(2);
    // Next sync asks only for games since the last one, less a day of overlap.
    const since = Number(new URL(calls[1]).searchParams.get("since"));
    expect(since).toBe(Date.UTC(2026, 8, 21, 12, 30) - 24 * 3600 * 1000);
  });

  it("reports unknown users and a missing username", async () => {
    const r = await api("POST", "/api/sync/lishogi", { username: "nobody" });
    expect(r.status).toBe(502);
    expect(r.body.error).toContain("nobody");
    await api("PUT", "/api/settings", { accounts: { lishogi: "" } });
    const none = await api("POST", "/api/sync/lishogi");
    expect(none.status).toBe(400);
  });
});
