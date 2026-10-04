import { Library, GameFilter, GameListItem } from "./library.js";

type Score = { games: number; wins: number; losses: number; draws: number; winRate: number | null };

function score(games: GameListItem[]): Score {
  let wins = 0, losses = 0, draws = 0;
  for (const g of games) {
    if (g.myResult === "win") wins++;
    else if (g.myResult === "loss") losses++;
    else if (g.myResult === "draw") draws++;
  }
  const decided = wins + losses;
  return { games: games.length, wins, losses, draws, winRate: decided ? (wins / decided) * 100 : null };
}

function groupBy(games: GameListItem[], key: (g: GameListItem) => string, minGames = 1) {
  const m = new Map<string, GameListItem[]>();
  for (const g of games) {
    const k = key(g);
    if (!k) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(g);
  }
  return [...m.entries()]
    .map(([name, gs]) => ({ name, ...score(gs) }))
    .filter((r) => r.games >= minGames)
    .sort((a, b) => b.games - a.games);
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function computeStats(lib: Library, filter: GameFilter = {}) {
  const all = lib.listGames(filter);
  const mine = all.filter((g) => g.mySide);
  const byMonth = groupBy(mine, (g) => g.date.slice(0, 7)).sort((a, b) => a.name.localeCompare(b.name));

  // Rolling win rate over the last 20 decided games, in date order.
  const ordered = mine.filter((g) => g.myResult === "win" || g.myResult === "loss").sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
  const rolling: { date: string; winRate: number }[] = [];
  const W = 20;
  ordered.forEach((g, i) => {
    const window = ordered.slice(Math.max(0, i - W + 1), i + 1);
    rolling.push({ date: g.date || `#${g.id}`, winRate: (window.filter((x) => x.myResult === "win").length / window.length) * 100 });
  });

  // Phase-of-game error profile from per-ply levels of my moves.
  const plyRows = lib.db.all<{ game_id: number; ply: number; loss: number | null; level: number; elapsed_ms: number }>(
    "SELECT game_id, ply, loss, level, elapsed_ms FROM plies WHERE ply > 0 AND loss IS NOT NULL",
  );
  const sideById = new Map(mine.map((g) => [g.id, g]));
  const firstBlack = new Map(
    lib.db.all<{ id: number; initial_sfen: string }>("SELECT id, initial_sfen FROM games").map((r) => [r.id, r.initial_sfen.split(" ")[1] !== "w"]),
  );
  const phases = { opening: [] as number[], middlegame: [] as number[], endgame: [] as number[] };
  const phaseMistakes = { opening: 0, middlegame: 0, endgame: 0 };
  const phaseSeconds = { opening: [] as number[], middlegame: [] as number[], endgame: [] as number[] };
  // Think-time buckets: do fast moves go wrong more often? Only moves with a recorded time count.
  const timeBuckets = [
    { label: "< 5s", max: 5 },
    { label: "5–15s", max: 15 },
    { label: "15–60s", max: 60 },
    { label: "60s+", max: Infinity },
  ].map((b) => ({ ...b, losses: [] as number[], mistakes: 0 }));
  for (const r of plyRows) {
    const g = sideById.get(r.game_id);
    if (!g) continue;
    const moverBlack = (r.ply % 2 === 1) === (firstBlack.get(r.game_id) ?? true);
    if ((g.mySide === "black") !== moverBlack) continue;
    const phase = r.ply <= 30 ? "opening" : r.ply <= 80 ? "middlegame" : "endgame";
    phases[phase].push(r.loss!);
    if (r.level >= 3) phaseMistakes[phase]++;
    if (r.elapsed_ms > 0) {
      const sec = r.elapsed_ms / 1000;
      phaseSeconds[phase].push(sec);
      const b = timeBuckets.find((x) => sec < x.max)!;
      b.losses.push(r.loss!);
      if (r.level >= 3) b.mistakes++;
    }
  }

  const analysed = mine.filter((g) => g.myAccuracy !== null).sort((a, b) => (a.date < b.date ? -1 : 1));
  return {
    totals: score(mine),
    gamesInLibrary: all.length,
    gamesWithMySide: mine.length,
    bySide: groupBy(mine, (g) => (g.mySide === "black" ? "先手" : "後手")),
    byOpening: groupBy(mine, (g) => g.myOpening),
    byOpponentOpening: groupBy(mine, (g) =>
      g.opening || (g.mySide === "black" ? g.white_opening || g.white_style : g.black_opening || g.black_style),
    ),
    byCastle: groupBy(mine, (g) => g.myCastle),
    byMatchup: groupBy(mine, (g) => g.matchup),
    byTimeControl: groupBy(mine, (g) => g.time_control),
    bySource: groupBy(mine, (g) => g.source),
    byOpponent: groupBy(mine, (g) => g.opponent, 2),
    byMonth,
    rolling,
    accuracyTrend: analysed.map((g) => ({ id: g.id, date: g.date, accuracy: g.myAccuracy!, result: g.myResult })),
    meanAccuracy: mean(analysed.map((g) => g.myAccuracy!)),
    meanMistakes: mean(mine.filter((g) => g.analysis_status !== "none").map((g) => g.mistakes)),
    /** My rating per game, one series per site; empty when no names carry ratings. */
    ratingHistory: (() => {
      const bySource = new Map<string, { id: number; date: string; rating: number; result: string }[]>();
      for (const g of [...mine].sort((a, b) => (a.date < b.date ? -1 : 1))) {
        if (g.myRating === null) continue;
        const k = g.source || "other";
        if (!bySource.has(k)) bySource.set(k, []);
        bySource.get(k)!.push({ id: g.id, date: g.date, rating: g.myRating, result: g.myResult });
      }
      return [...bySource.entries()].map(([source, points]) => ({ source, points }));
    })(),
    /** Each time my written rank changed (Shogi Wars, 24 etc.), per site. */
    rankChanges: (() => {
      const last = new Map<string, string>();
      const out: { source: string; date: string; rank: string; id: number }[] = [];
      for (const g of [...mine].sort((a, b) => (a.date < b.date ? -1 : 1))) {
        if (!g.myRank) continue;
        const k = g.source || "other";
        if (last.get(k) !== g.myRank) out.push({ source: k, date: g.date, rank: g.myRank, id: g.id });
        last.set(k, g.myRank);
      }
      return out;
    })(),
    phaseProfile: (["opening", "middlegame", "endgame"] as const).map((p) => ({
      phase: p,
      avgLoss: mean(phases[p]),
      moves: phases[p].length,
      mistakes: phaseMistakes[p],
      avgSeconds: mean(phaseSeconds[p]),
    })),
    /** Mistake rate by how long I thought; empty when no game has move times. */
    thinkTime: timeBuckets.some((b) => b.losses.length)
      ? timeBuckets.map((b) => ({
          label: b.label,
          moves: b.losses.length,
          avgLoss: mean(b.losses),
          mistakes: b.mistakes,
          mistakeRate: b.losses.length ? (b.mistakes / b.losses.length) * 100 : null,
        }))
      : [],
    /** My openings (rows) × opponent openings (columns). */
    matchupGrid: (() => {
      const rows = new Map<string, Map<string, GameListItem[]>>();
      for (const g of mine) {
        const r = g.myOpening || "?";
        const c = g.opening || (g.mySide === "black" ? g.white_opening || g.white_style : g.black_opening || g.black_style) || "?";
        if (!rows.has(r)) rows.set(r, new Map());
        const m = rows.get(r)!;
        if (!m.has(c)) m.set(c, []);
        m.get(c)!.push(g);
      }
      return [...rows.entries()].map(([mineName, cols]) => ({
        mine: mineName,
        cells: [...cols.entries()].map(([theirs, gs]) => ({ theirs, ...score(gs) })),
      }));
    })(),
  };
}
