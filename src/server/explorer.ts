// Opening explorer over the user's own games: for a position, which moves were
// played next, how often, and how those games ended for the user.
import { Library } from "./library.js";
import { sfenKey } from "./db.js";
import type { GameListItem } from "./library.js";

export type ExplorerFilter = { side?: "black" | "white" | ""; source?: string; opponent?: string };

export type ExplorerMove = {
  usi: string;
  text: string;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  /** Times the user played this move themselves (vs the opponent playing it). */
  mine: number;
  /** Mean win-rate loss of the user's own plays of this move, when analysed. */
  myAvgLoss: number | null;
  lastDate: string;
  gameIds: number[];
};

export type ExplorerResult = {
  sfen: string;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  /** Engine view of the position from any analysed game that reached it (black's view). */
  engine: { score: number | null; mate: number | null; bestUsi: string; bestText: string } | null;
  moves: ExplorerMove[];
};

export function explore(lib: Library, sfen: string, filter: ExplorerFilter = {}): ExplorerResult {
  const key = sfenKey(sfen);
  const games = new Map<number, GameListItem>();
  for (const g of lib.listGames()) {
    if (filter.side && g.mySide !== filter.side) continue;
    if (filter.source && g.source !== filter.source) continue;
    if (filter.opponent && g.opponent !== filter.opponent) continue;
    games.set(g.id, g);
  }
  const hits = lib.db.all<{ game_id: number; ply: number; sfen: string; score: number | null; mate: number | null; best_usi: string }>(
    "SELECT game_id, ply, sfen, score, mate, best_usi FROM plies WHERE sfen GLOB ? ORDER BY game_id, ply",
    key + " *",
  );
  // A game can reach the same position twice (repetition); count its first visit only.
  const firstVisit = new Map<number, (typeof hits)[number]>();
  for (const h of hits) if (games.has(h.game_id) && !firstVisit.has(h.game_id)) firstVisit.set(h.game_id, h);

  const result: ExplorerResult = { sfen: hits[0]?.sfen ?? sfen, games: 0, wins: 0, losses: 0, draws: 0, engine: null, moves: [] };
  const byMove = new Map<string, ExplorerMove & { lossSum: number; lossN: number }>();
  const toMove = key.split(" ")[1] === "w" ? "white" : "black";

  for (const [gameId, h] of firstVisit) {
    const g = games.get(gameId)!;
    result.games++;
    tally(result, g.myResult);
    if (!result.engine && (h.best_usi || h.score !== null || h.mate !== null)) {
      result.engine = { score: h.score, mate: h.mate, bestUsi: h.best_usi, bestText: h.best_usi ? Library.moveText(h.sfen, h.best_usi) : "" };
    }
    const n = lib.db.get<{ usi: string; loss: number | null }>("SELECT usi, loss FROM plies WHERE game_id = ? AND ply = ?", gameId, h.ply + 1);
    if (!n?.usi) continue;
    let m = byMove.get(n.usi);
    if (!m) {
      m = { usi: n.usi, text: Library.moveText(h.sfen, n.usi), games: 0, wins: 0, losses: 0, draws: 0, mine: 0, myAvgLoss: null, lastDate: "", gameIds: [], lossSum: 0, lossN: 0 };
      byMove.set(n.usi, m);
    }
    m.games++;
    tally(m, g.myResult);
    if (g.mySide === toMove) {
      m.mine++;
      if (n.loss !== null) {
        m.lossSum += n.loss;
        m.lossN++;
      }
    }
    if (g.date > m.lastDate) m.lastDate = g.date;
    m.gameIds.push(gameId);
  }
  result.moves = [...byMove.values()]
    .map(({ lossSum, lossN, ...m }) => ({ ...m, myAvgLoss: lossN ? lossSum / lossN : null }))
    .sort((a, b) => b.games - a.games || b.lastDate.localeCompare(a.lastDate));
  return result;
}

function tally(t: { wins: number; losses: number; draws: number }, r: GameListItem["myResult"]) {
  if (r === "win") t.wins++;
  else if (r === "loss") t.losses++;
  else if (r === "draw") t.draws++;
}
