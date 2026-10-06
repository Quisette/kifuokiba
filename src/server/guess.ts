// Guess the move: replay a game and guess each move for one side. A guess is
// scored like a played move: the win-rate it gives away compared with the
// position before, with the same thresholds as mistake grading.
import { gradeMoves, winRate, type Eval } from "../core/grading.js";
import type { AnalysisQueue } from "./analysis.js";
import { Library } from "./library.js";

export type GuessMove = { usi: string; text: string; loss: number | null; level: number };
export type GuessResult = {
  ply: number;
  match: boolean;
  guess: GuessMove & { score: number | null; mate: number | null };
  played: GuessMove;
  best: { usi: string; text: string; pv: string } | null;
};

export class GuessError extends Error {}

type PlyRow = { ply: number; usi: string; sfen: string; score: number | null; mate: number | null; best_usi: string; pv: string };
const toEval = (r: { score?: number | null; mate?: number | null }): Eval => ({ score: r.score ?? undefined, mate: r.mate ?? undefined });
const hasEval = (r: { score: number | null; mate: number | null }) => r.score !== null || r.mate !== null;

export async function checkGuess(lib: Library, analysis: AnalysisQueue, gameId: number, ply: number, usi: string): Promise<GuessResult> {
  const game = lib.db.get<{ initial_sfen: string }>("SELECT initial_sfen FROM games WHERE id = ?", gameId);
  if (!game) throw new GuessError("no such game");
  const plies = lib.db.all<PlyRow>("SELECT ply, usi, sfen, score, mate, best_usi, pv FROM plies WHERE game_id = ? AND ply <= ? ORDER BY ply", gameId, ply);
  const before = plies[ply - 1];
  const after = plies[ply];
  if (ply < 1 || !before || !after?.usi) throw new GuessError("no move at that ply");
  const line = plies.slice(1, ply).map((p) => p.usi);

  const searchedBefore = hasEval(before) && before.best_usi ? null : await analysis.evalLine(game.initial_sfen, line);
  const evalBefore = searchedBefore ? toEval(searchedBefore) : toEval(before);
  const evalPlayed = hasEval(after) ? toEval(after) : toEval(await analysis.evalLine(game.initial_sfen, [...line, after.usi]));
  const match = usi === after.usi;
  const evalGuess = match ? evalPlayed : toEval(await analysis.evalLine(game.initial_sfen, [...line, usi]));

  // gradeMoves works on a sequence; give it [before, after] with the right mover.
  const mover = before.sfen.split(" ")[1] === "w" ? "white" : "black";
  const grade = (e: Eval) => {
    if (winRate(evalBefore) === undefined || winRate(e) === undefined) return { loss: null, level: 0 };
    const g = gradeMoves([evalBefore, e], mover, lib.settings.grading)[0];
    return { loss: Math.round(g.loss * 10) / 10, level: g.level };
  };
  const bestUsi = before.best_usi || searchedBefore?.best || "";
  const bestPv = before.best_usi ? before.pv : searchedBefore?.pv || bestUsi;
  return {
    ply,
    match,
    guess: { usi, text: Library.moveText(before.sfen, usi), ...grade(evalGuess), score: evalGuess.score ?? null, mate: evalGuess.mate ?? null },
    played: { usi: after.usi, text: Library.moveText(before.sfen, after.usi), ...grade(evalPlayed) },
    best: bestUsi ? { usi: bestUsi, text: Library.moveText(before.sfen, bestUsi), pv: bestPv } : null,
  };
}
