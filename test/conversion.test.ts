import { expect, it } from "vitest";
import { Db } from "../src/server/db.js";
import { Library } from "../src/server/library.js";
import { loadSettings, saveSettings } from "../src/server/settings.js";
import { conversion } from "../src/server/stats.js";
import { insightsFromStats } from "../src/server/insights.js";
import { computeStats } from "../src/server/stats.js";
import { makeKif } from "./fixtures.js";

const MOVES = "7g7f 3c3d 2g2f 8c8d 2f2e 8d8e 6i7h 4a3b 2e2d 2c2d 2h2d 8e8f";

function setup() {
  const db = new Db(":memory:");
  saveSettings(db, { ...loadSettings(db), myNames: ["me"] });
  const lib = new Library(db);
  const add = (moves: string, black: string, white: string, date: string, scores: Record<number, number>, losses: Record<number, number> = {}) => {
    const r = lib.importText(makeKif({ moves, black, white, date }), "t.kif");
    if (r.status !== "added") throw new Error(r.status);
    for (const [ply, score] of Object.entries(scores)) lib.db.run("UPDATE plies SET score = ? WHERE game_id = ? AND ply = ?", score, r.id, Number(ply));
    for (const [ply, loss] of Object.entries(losses)) lib.db.run("UPDATE plies SET loss = ? WHERE game_id = ? AND ply = ?", loss, r.id, Number(ply));
    lib.db.run("UPDATE plies SET score = COALESCE(score, 0), loss = COALESCE(loss, 0) WHERE game_id = ?", r.id);
    lib.db.run("UPDATE games SET analysis_status = 'done' WHERE id = ?", r.id);
    return r.id;
  };
  return { lib, add };
}

it("counts won positions converted, comebacks, and the games let slip", () => {
  const { lib, add } = setup();
  // 12 moves then resign: black (me) loses after being +1500 at move 3; move 7 (☗７八金) threw it away.
  const blown = add(MOVES, "me", "x", "2026/09/01", { 3: 1500, 4: 1500, 5: 1600, 6: 1500, 7: -300 }, { 5: 2, 7: 45 });
  // 11 moves: white resigns, I win from -1500 at move 2.
  add(MOVES.split(" ").slice(0, 11).join(" "), "me", "y", "2026/09/02", { 2: -1500, 3: 0, 4: 1500, 5: 1500 });
  // Only clearly winning in the last few plies: the final attack, not counted.
  add(MOVES.split(" ").slice(0, 11).join(" "), "me", "z", "2026/09/03", { 9: 2000, 10: 2000, 11: 3000 });
  // Me as white, never clear either way.
  add(MOVES.split(" ").slice(0, 11).join(" "), "w", "me", "2026/09/04", {});

  const c = conversion(lib, lib.listGames());
  expect(c.winning).toBe(2);
  expect(c.converted).toBe(1);
  expect(c.conversionRate).toBe(50);
  expect(c.losing).toBe(1);
  expect(c.comebacks).toBe(1);
  expect(c.blown).toHaveLength(1);
  expect(c.blown[0]).toMatchObject({ id: blown, opponent: "x", slipPly: 7, slipLoss: 45 });
  expect(c.blown[0].peak).toBeGreaterThanOrEqual(85);
  expect(c.blown[0].slipText).toContain("７八金");
  // Worked out once and stored; a regrade computes the same.
  expect(lib.db.get<{ b: number }>("SELECT clear_black_ply b FROM games WHERE id = ?", blown)?.b).toBe(3);
  lib.regrade(blown);
  expect(lib.db.get<{ b: number; w: number }>("SELECT clear_black_ply b, clear_white_ply w FROM games WHERE id = ?", blown)).toEqual({ b: 3, w: -1 });
});

it("suggests practising conversion when many won positions slip", () => {
  const { lib, add } = setup();
  for (let i = 0; i < 6; i++) add(MOVES, "me", "x" + i, `2026/08/1${i}`, { 3: 1500, 4: 1500, 5: 1500, 6: 1500 }, { 7: 30 });
  const s = computeStats(lib);
  expect(s.conversion.winning).toBe(6);
  expect(s.conversion.conversionRate).toBe(0);
  const tip = insightsFromStats(s, { leeches: 0 }).find((x) => x.kind === "conversion");
  expect(tip?.text).toMatch(/won 0 of the 6 games/);
  expect(tip?.link).toMatch(/#\/game\/\d+\?ply=6/);
});
