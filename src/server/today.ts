// "Today": a short study plan built from what is waiting: due cards, recent
// losses without a review note, mates you missed, and weak opening moves.
import { Library } from "./library.js";
import { Cards } from "./cards.js";
import { findPuzzles } from "./puzzles.js";
import { repertoire } from "./repertoire.js";
import type { OpeningBook } from "./book.js";

export function todayPlan(lib: Library, cards: Cards, book: OpeningBook | null, now = Date.now()) {
  const counts = cards.counts(now);
  const since = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  // A game counts as reviewed once a notebook page points a board at it (weekly reports don't count).
  const noted = new Set<number>();
  for (const p of lib.db.all<{ body: string }>("SELECT body FROM pages WHERE notebook != 'Weekly'")) {
    for (const m of p.body.matchAll(/game[=:](\d+)/g)) noted.add(Number(m[1]));
  }
  const losses = lib
    .listGames({ result: "loss", sort: "date", desc: true })
    .filter((g) => g.date.slice(0, 10) >= since && !noted.has(g.id))
    .slice(0, 3)
    .map((g) => ({ id: g.id, opponent: g.opponent, date: g.date, strategy: g.strategy, mistakes: g.mistakes, analysed: g.analysis_status === "done" }));
  const missedMates = lib.cached("puzzles:mine", () => findPuzzles(lib, { mineOnly: true })).filter((p) => p.missed).length;
  const weakOpenings = (["black", "white"] as const).reduce(
    (n, side) => n + lib.cached(`repertoire:${side}:counts:${book?.mtimeMs ?? ""}`, () => repertoire(lib, { side, book, withText: false })).filter((p) => p.problem).length,
    0,
  );
  // Tsume problems failed last time, in the collection with the most of them.
  const retry = lib.db.get<{ collection: string; n: number }>(
    "SELECT collection, COUNT(*) n FROM tsume WHERE last_result = 'failed' GROUP BY collection ORDER BY n DESC LIMIT 1",
  );
  const tsumeRetry = retry ? { collection: retry.collection, count: retry.n } : null;
  // The saved deck with the most due cards, to suggest working through it.
  const top = cards.decks(now).sort((a, b) => b.due - a.due)[0];
  const deck = top?.due ? { id: top.id, name: top.name, due: top.due } : null;
  return { due: counts.due, reviewedToday: counts.reviewedToday, losses, missedMates, weakOpenings, tsumeRetry, deck };
}
