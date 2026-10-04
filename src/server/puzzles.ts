// Mate puzzles from your own games: every position where the side to move had a
// forced mate (per the stored analysis), taken at the start of each mating
// sequence so one mate gives one puzzle.
import { Library } from "./library.js";

export type Puzzle = {
  gameId: number;
  /** The puzzle is the position after this ply. */
  ply: number;
  sfen: string;
  mateIn: number;
  side: "black" | "white";
  mine: boolean;
  /** The player to move did not keep the mate in the game. */
  missed: boolean;
  bestUsi: string;
  black: string;
  white: string;
  date: string;
};

export function findPuzzles(lib: Library, opts: { mineOnly?: boolean; maxMate?: number } = {}): Puzzle[] {
  const maxMate = opts.maxMate ?? 15;
  const rows = lib.db.all<{ game_id: number; ply: number; sfen: string; mate: number | null; best_usi: string; missed: string }>(
    `SELECT p.game_id, p.ply, p.sfen, p.mate, p.best_usi, p.missed FROM plies p
     WHERE p.game_id IN (SELECT game_id FROM plies WHERE mate IS NOT NULL AND mate != 0)
     ORDER BY p.game_id, p.ply`,
  );
  const games = new Map(
    lib.db.all<{ id: number; black: string; white: string; date: string }>("SELECT id, black, white, date FROM games").map((g) => [g.id, g]),
  );
  // mate is from black's view: > 0 means black mates.
  const toMove = (sfen: string) => (sfen.split(" ")[1] === "w" ? "white" : "black");
  const mates = (r: { sfen: string; mate: number | null }) =>
    r.mate !== null && r.mate !== 0 && Math.abs(r.mate) <= maxMate && (r.mate > 0) === (toMove(r.sfen) === "black");

  const out: Puzzle[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!mates(r) || !r.best_usi) continue;
    // Same side to move two plies earlier, in the same game, already had the mate: not a new puzzle.
    const before = rows[i - 2];
    if (before && before.game_id === r.game_id && before.ply === r.ply - 2 && mates(before)) continue;
    const g = games.get(r.game_id);
    if (!g) continue;
    const side = toMove(r.sfen);
    const mine = lib.mySide(g) === side;
    if (opts.mineOnly && !mine) continue;
    // Missed if any of the mover's moves along the sequence let the mate go.
    let missed = false;
    for (let k = i; k < rows.length && rows[k].game_id === r.game_id && mates(rows[k]); k += 2) {
      const nx = rows[k + 1];
      if (nx && nx.game_id === r.game_id && nx.missed === "mate") {
        missed = true;
        break;
      }
    }
    out.push({
      gameId: r.game_id,
      ply: r.ply,
      sfen: r.sfen,
      mateIn: Math.abs(r.mate!),
      side,
      mine,
      missed,
      bestUsi: r.best_usi,
      black: g.black,
      white: g.white,
      date: g.date,
    });
  }
  // Missed ones first (that's the point), then shortest mates.
  return out.sort((a, b) => Number(b.missed) - Number(a.missed) || a.mateIn - b.mateIn || b.date.localeCompare(a.date));
}
