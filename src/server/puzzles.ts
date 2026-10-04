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
  // Only positions with a mate score, plus whether the move played from there let it go.
  const rows = lib.db.all<{ game_id: number; ply: number; sfen: string; mate: number; best_usi: string; next_missed: string | null }>(
    `SELECT p.game_id, p.ply, p.sfen, p.mate, p.best_usi,
            (SELECT n.missed FROM plies n WHERE n.game_id = p.game_id AND n.ply = p.ply + 1) AS next_missed
     FROM plies p WHERE p.mate IS NOT NULL AND p.mate != 0
     ORDER BY p.game_id, p.ply`,
  );
  const names = lib.myNames();
  const games = new Map(
    lib.db.all<{ id: number; black: string; white: string; date: string }>("SELECT id, black, white, date FROM games").map((g) => [g.id, { ...g, mySide: lib.mySide(g, names) }]),
  );
  // mate is from black's view: > 0 means black mates.
  const toMove = (sfen: string) => (sfen.split(" ")[1] === "w" ? "white" : "black");
  const mates = (r: { sfen: string; mate: number } | undefined) =>
    !!r && Math.abs(r.mate) <= maxMate && (r.mate > 0) === (toMove(r.sfen) === "black");
  const at = new Map(rows.map((r) => [`${r.game_id}:${r.ply}`, r]));

  const out: Puzzle[] = [];
  for (const r of rows) {
    if (!mates(r) || !r.best_usi) continue;
    // Same side to move two plies earlier already had the mate: not a new puzzle.
    if (mates(at.get(`${r.game_id}:${r.ply - 2}`))) continue;
    const g = games.get(r.game_id);
    if (!g) continue;
    const side = toMove(r.sfen);
    const mine = g.mySide === side;
    if (opts.mineOnly && !mine) continue;
    // Missed if any of the mover's moves along the sequence let the mate go.
    let missed = false;
    for (let k = r.ply, cur = at.get(`${r.game_id}:${k}`); mates(cur); k += 2, cur = at.get(`${r.game_id}:${k}`)) {
      if (cur!.next_missed === "mate") {
        missed = true;
        break;
      }
    }
    out.push({
      gameId: r.game_id,
      ply: r.ply,
      sfen: r.sfen,
      mateIn: Math.abs(r.mate),
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
