// Opening repertoire drill: the positions you reach most often in the opening
// with you to move, what you usually play there, and which moves count as good
// (book moves, the engine's best, and your own moves that lost little).
import { Library } from "./library.js";
import { sfenKey } from "./db.js";
import type { OpeningBook } from "./book.js";

export type RepertoireMove = { usi: string; text: string; count: number; avgLoss: number | null; good: boolean; book: boolean; engine: boolean };
export type RepertoirePosition = {
  sfen: string;
  /** Games of yours that reached this position with you to move. */
  count: number;
  ply: number;
  /** Your moves here, most played first. */
  played: RepertoireMove[];
  /** Every move that counts as correct in the drill. */
  accepted: { usi: string; text: string; why: string }[];
  /** Your most played move is not among the accepted ones. */
  problem: boolean;
};

export function repertoire(
  lib: Library,
  opts: { side: "black" | "white"; maxPly?: number; minCount?: number; goodLoss?: number; book?: OpeningBook | null; withText?: boolean },
): RepertoirePosition[] {
  const maxPly = opts.maxPly ?? 24;
  const minCount = opts.minCount ?? 2;
  const goodLoss = opts.goodLoss ?? 2;
  const names = lib.myNames();
  const mine = new Set(
    lib.db
      .all<{ id: number; black: string; white: string }>("SELECT id, black, white FROM games")
      .filter((g) => lib.mySide(g, names) === opts.side)
      .map((g) => g.id),
  );
  // Move names cost a position parse each; counts-only callers skip them.
  const text = opts.withText === false ? () => "" : (sfen: string, usi: string) => Library.moveText(sfen, usi);
  if (!mine.size) return [];

  // My moves in the opening: the position before (prev) and the move played (cur).
  const rows = lib.db.all<{ game_id: number; ply: number; sfen: string; best_usi: string; usi: string; loss: number | null }>(
    `SELECT prev.game_id, prev.ply, prev.sfen, prev.best_usi, cur.usi, cur.loss
     FROM plies prev JOIN plies cur ON cur.game_id = prev.game_id AND cur.ply = prev.ply + 1
     WHERE cur.ply <= ? AND cur.usi != ''`,
    maxPly,
  );
  const toMove = (sfen: string) => (sfen.split(" ")[1] === "w" ? "white" : "black");
  type Acc = { sfen: string; ply: number; games: Set<number>; moves: Map<string, { count: number; lossSum: number; lossN: number }>; best: Map<string, number> };
  const byPos = new Map<string, Acc>();
  for (const r of rows) {
    if (!mine.has(r.game_id) || toMove(r.sfen) !== opts.side) continue;
    const key = sfenKey(r.sfen);
    let a = byPos.get(key);
    if (!a) {
      a = { sfen: r.sfen, ply: r.ply, games: new Set(), moves: new Map(), best: new Map() };
      byPos.set(key, a);
    }
    // First visit per game only (repetitions).
    if (a.games.has(r.game_id)) continue;
    a.games.add(r.game_id);
    const m = a.moves.get(r.usi) ?? { count: 0, lossSum: 0, lossN: 0 };
    m.count++;
    if (r.loss !== null) {
      m.lossSum += r.loss;
      m.lossN++;
    }
    a.moves.set(r.usi, m);
    if (r.best_usi) a.best.set(r.best_usi, (a.best.get(r.best_usi) ?? 0) + 1);
  }

  const out: RepertoirePosition[] = [];
  for (const a of byPos.values()) {
    if (a.games.size < minCount) continue;
    const engineBest = [...a.best.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? "";
    const bookMoves = new Set((opts.book?.moves(a.sfen) ?? []).map((m) => m.usi));
    const played: RepertoireMove[] = [...a.moves.entries()]
      .map(([usi, m]) => {
        const avgLoss = m.lossN ? m.lossSum / m.lossN : null;
        const book = bookMoves.has(usi);
        const engine = usi === engineBest;
        return { usi, text: text(a.sfen, usi), count: m.count, avgLoss, book, engine, good: book || engine || (avgLoss !== null && avgLoss < goodLoss) };
      })
      .sort((x, y) => y.count - x.count);
    const accepted = new Map<string, string>();
    for (const u of bookMoves) accepted.set(u, "book");
    if (engineBest && !accepted.has(engineBest)) accepted.set(engineBest, "engine");
    for (const p of played) if (p.good && !accepted.has(p.usi)) accepted.set(p.usi, "yours");
    // Nothing to judge against (no analysis, no book): skip rather than accept anything.
    if (!accepted.size) continue;
    out.push({
      sfen: a.sfen,
      count: a.games.size,
      ply: a.ply,
      played,
      accepted: [...accepted.entries()].map(([usi, why]) => ({ usi, text: text(a.sfen, usi), why })),
      problem: !played[0].good,
    });
  }
  // Most reached first; within that, earlier in the game first.
  return out.sort((x, y) => y.count - x.count || x.ply - y.ply);
}
