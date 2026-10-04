import { expect, it } from "vitest";
import { Db } from "../src/server/db.js";
import { Library } from "../src/server/library.js";
import { loadSettings, saveSettings } from "../src/server/settings.js";
import { weeklyNote } from "../src/server/weekly.js";
import { todayPlan } from "../src/server/today.js";
import { Cards } from "../src/server/cards.js";
import { Pages } from "../src/server/pages.js";
import { makeKif } from "./fixtures.js";

const MOVES = "7g7f 3c3d 2g2f 8c8d 2f2e 8d8e 6i7h 4a3b 2e2d 2c2d 2h2d 8e8f";
const END = Date.parse("2026-10-04T12:00:00Z");

it("reports the week's games, accuracy change, costliest moves and practice", () => {
  const db = new Db(":memory:");
  saveSettings(db, { ...loadSettings(db), myNames: ["me"] });
  const lib = new Library(db);
  const add = (date: string, moves: string, acc: number) => {
    const r = lib.importText(makeKif({ moves, black: "me", white: "rival", date }), "t.kif");
    if (r.status !== "added") throw new Error(r.status);
    db.run("UPDATE games SET accuracy_black = ?, analysis_status = 'done' WHERE id = ?", acc, r.id);
    return r.id;
  };
  const lost = add("2026/10/02", MOVES, 80); // 12 moves: I (black) resign
  add("2026/10/03", MOVES.split(" ").slice(0, 11).join(" "), 90);
  add("2026/09/25", MOVES, 70); // the week before
  add("2026/09/10", MOVES, 50); // older, ignored
  db.run("UPDATE plies SET loss = 0, level = 0 WHERE game_id = ?", lost);
  db.run("UPDATE plies SET loss = 35, level = 4 WHERE game_id = ? AND ply = 7", lost);
  db.run("UPDATE plies SET loss = 40, level = 4 WHERE game_id = ? AND ply = 8", lost); // the opponent's move: not mine

  const n = weeklyNote(lib, END);
  expect(n.title).toBe("週報 2026-09-28 – 2026-10-04");
  expect(n.body).toContain("2 games · 1勝 1敗 · win rate 50% · accuracy 85.0% (+15.0 on the week before)");
  expect(n.body).toContain(`[2026-10-02](#/game/${lost})`);
  expect(n.body).not.toContain("2026-09-25](#");
  expect(n.body).toContain(`7手目 ☗７八金（−35%）`);
  expect(n.body).toContain(`:::shogi-view{game=${lost} ply=6}`);
  expect(n.body).not.toContain("8手目");
  expect(n.body).toContain("No practice recorded this week.");

  // The report's boards don't make the loss count as reviewed in the daily plan.
  new Pages(db).create({ title: n.title, notebook: "Weekly", body: n.body });
  const plan = todayPlan(lib, new Cards(lib, null as never), null, END);
  expect(plan.losses.map((l) => l.id)).toContain(lost);
});

it("says so when there were no games", () => {
  const lib = new Library(new Db(":memory:"));
  expect(weeklyNote(lib, END).body).toContain("No games this week.");
});
