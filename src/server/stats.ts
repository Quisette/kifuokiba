import { Position, pieceTypeToStringForMove } from "tsshogi";
import { Library, GameFilter, GameListItem } from "./library.js";
import { clearPlies, winRate } from "../core/grading.js";
import { MOVE_KINDS, MoveKind, moveKinds } from "../core/movekind.js";

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

// A position counts as clearly won (or lost) at 85% (15%) winning chances, when that
// happens with at least 6 plies left, so the final mating sequence alone doesn't count.
// Regrade stores the first such ply per side (games.clear_black_ply / clear_white_ply).
const CLEAR = 85;
const MARGIN_PLIES = 6;

export type BlownGame = { id: number; date: string; opponent: string; result: string; peak: number; slipPly: number; slipText: string; slipLoss: number; sfen: string };

type EvalRow = { ply: number; score: number | null; mate: number | null; loss: number | null; text: string };
const evalOf = (r: EvalRow) => (r.score === null && r.mate === null ? null : { score: r.score ?? undefined, mate: r.mate ?? undefined });

/**
 * Converting won positions: of the analysed games where I was clearly winning, how many
 * I won; of those where I was clearly losing, how many I turned round; and the games I
 * let slip, with my costliest move after the first clearly won position.
 */
export function conversion(lib: Library, games: GameListItem[]) {
  const decided = games.filter((g) => g.mySide && (g.analysis_status === "done" || g.analysis_status === "imported") && (g.myResult === "win" || g.myResult === "loss" || g.myResult === "draw"));
  const out = { winning: 0, converted: 0, losing: 0, comebacks: 0 };
  const clear = new Map(
    lib.db
      .all<{ id: number; b: number | null; w: number | null; first_black: number }>(
        `SELECT id, clear_black_ply b, clear_white_ply w, substr(initial_sfen, instr(initial_sfen, ' ') + 1, 1) != 'w' first_black FROM games
         WHERE analysis_status IN ('done', 'imported')`,
      )
      .map((r) => [r.id, r]),
  );
  const pliesOf = (id: number) => lib.db.all<EvalRow>("SELECT ply, score, mate, loss, text FROM plies WHERE game_id = ? ORDER BY ply", id);
  const slipped: { g: GameListItem; from: number }[] = [];
  for (const g of decided) {
    const c = clear.get(g.id);
    if (!c) continue;
    // Libraries from before these columns: work them out once and keep them.
    if (c.b === null || c.w === null) {
      const r = clearPlies(pliesOf(g.id).map(evalOf), CLEAR, MARGIN_PLIES, lib.settings.grading);
      lib.db.run("UPDATE games SET clear_black_ply = ?, clear_white_ply = ? WHERE id = ?", r.black, r.white, g.id);
      c.b = r.black;
      c.w = r.white;
    }
    const mine = g.mySide === "black" ? c.b : c.w;
    const theirs = g.mySide === "black" ? c.w : c.b;
    if (mine >= 0) {
      out.winning++;
      if (g.myResult === "win") out.converted++;
      else slipped.push({ g, from: mine });
    }
    if (theirs >= 0) {
      out.losing++;
      if (g.myResult === "win") out.comebacks++;
    }
  }
  slipped.sort((a, b) => (a.g.date < b.g.date ? 1 : a.g.date > b.g.date ? -1 : b.g.id - a.g.id));
  const blown: BlownGame[] = slipped.slice(0, 12).map(({ g, from }) => {
    const meBlack = g.mySide === "black";
    const firstBlack = !!clear.get(g.id)!.first_black;
    let peak = 0;
    let slip: EvalRow | null = null;
    for (const r of pliesOf(g.id).filter((r) => r.ply >= from)) {
      const w = winRate(evalOf(r), lib.settings.grading);
      if (w !== undefined) peak = Math.max(peak, meBlack ? w : 100 - w);
      const moverBlack = (r.ply % 2 === 1) === firstBlack;
      if (r.ply > from && moverBlack === meBlack && r.loss !== null && (!slip || r.loss > slip.loss!)) slip = r;
    }
    return {
      id: g.id,
      date: g.date,
      opponent: g.opponent,
      result: g.myResult,
      peak: Math.round(peak),
      slipPly: slip?.ply ?? from,
      slipText: slip?.text ?? "",
      slipLoss: Math.round((slip?.loss ?? 0) * 10) / 10,
      // The position before the slip, to play it out again.
      sfen: lib.db.get<{ sfen: string }>("SELECT sfen FROM plies WHERE game_id = ? AND ply = ?", g.id, (slip?.ply ?? from + 1) - 1)?.sfen ?? "",
    };
  });
  return {
    ...out,
    blown,
    conversionRate: out.winning ? (out.converted / out.winning) * 100 : null,
    comebackRate: out.losing ? (out.comebacks / out.losing) * 100 : null,
  };
}

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

  // Where my 疑問手 and worse land, seen from my side of the board, and which pieces made them.
  const heat = new Array<number>(81).fill(0);
  const byPiece = new Map<string, number>();
  const badRows = lib.db.all<{ game_id: number; ply: number; usi: string; prev_sfen: string }>(
    `SELECT p.game_id, p.ply, p.usi, q.sfen prev_sfen FROM plies p
     JOIN plies q ON q.game_id = p.game_id AND q.ply = p.ply - 1
     WHERE p.ply > 0 AND p.level >= 2`,
  );
  for (const r of badRows) {
    const g = sideById.get(r.game_id);
    if (!g) continue;
    const moverBlack = (r.ply % 2 === 1) === (firstBlack.get(r.game_id) ?? true);
    if ((g.mySide === "black") !== moverBlack) continue;
    const pos = Position.newBySFEN(r.prev_sfen);
    const m = pos?.createMoveByUSI(r.usi);
    if (!pos || !m) continue;
    let file = m.to.file;
    let rank = m.to.rank;
    if (!moverBlack) {
      file = 10 - file;
      rank = 10 - rank;
    }
    heat[(rank - 1) * 9 + (9 - file)]++;
    const piece = pieceTypeToStringForMove(m.pieceType) + (r.usi.includes("*") ? "打" : "");
    byPiece.set(piece, (byPiece.get(piece) ?? 0) + 1);
  }

  const kindProfile = moveKindProfile(lib, sideById, firstBlack);

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
    conversion: conversion(lib, mine),
    meanMistakes: mean(mine.filter((g) => g.analysis_status !== "none").map((g) => g.mistakes)),
    /** Counts per square, row-major from my side's 9一 corner (index = (rank-1)*9 + (9-file)). */
    mistakeMap: {
      cells: heat,
      total: heat.reduce((a, b) => a + b, 0),
      byPiece: [...byPiece.entries()].map(([piece, n]) => ({ piece, n })).sort((a, b) => b.n - a.n),
    },
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
    /** My graded moves by kind (drops, captures, checks…): how much each costs and how often it is a 悪手 or worse. */
    moveKinds: kindProfile,
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

/**
 * Loss and mistake rate for each kind of move I play. A move counts under every
 * kind it belongs to, so the rows don't add up to the total. Kinds are stored
 * per ply at import; plies from older libraries are worked out here once.
 */
function moveKindProfile(lib: Library, sideById: Map<number, GameListItem>, firstBlack: Map<number, boolean>) {
  const missing = lib.db.all<{ game_id: number; ply: number; usi: string; prev_sfen: string }>(
    `SELECT p.game_id, p.ply, p.usi, q.sfen prev_sfen FROM plies p
     JOIN plies q ON q.game_id = p.game_id AND q.ply = p.ply - 1
     WHERE p.ply > 0 AND p.move_kind IS NULL`,
  );
  if (missing.length) {
    lib.db.tx(() => {
      for (const r of missing) {
        lib.db.run("UPDATE plies SET move_kind = ? WHERE game_id = ? AND ply = ?", moveKinds(r.prev_sfen, r.usi)?.join(",") ?? "", r.game_id, r.ply);
      }
    });
  }
  const acc = new Map<MoveKind, { losses: number[]; mistakes: number }>(MOVE_KINDS.map((k) => [k, { losses: [], mistakes: 0 }]));
  const rows = lib.db.all<{ game_id: number; ply: number; loss: number; level: number; move_kind: string }>(
    "SELECT game_id, ply, loss, level, move_kind FROM plies WHERE ply > 0 AND loss IS NOT NULL AND move_kind != ''",
  );
  let total = 0;
  for (const r of rows) {
    const g = sideById.get(r.game_id);
    if (!g) continue;
    const moverBlack = (r.ply % 2 === 1) === (firstBlack.get(r.game_id) ?? true);
    if ((g.mySide === "black") !== moverBlack) continue;
    total++;
    for (const k of r.move_kind.split(",") as MoveKind[]) {
      const a = acc.get(k);
      if (!a) continue;
      a.losses.push(r.loss);
      if (r.level >= 3) a.mistakes++;
    }
  }
  return {
    total,
    rows: MOVE_KINDS.map((kind) => {
      const a = acc.get(kind)!;
      return {
        kind,
        moves: a.losses.length,
        share: total ? (a.losses.length / total) * 100 : 0,
        avgLoss: mean(a.losses),
        mistakes: a.mistakes,
        mistakeRate: a.losses.length ? (a.mistakes / a.losses.length) * 100 : null,
      };
    }),
  };
}

/** Everything about one opponent: my record, their openings and castles, recent form. */
export function playerProfile(lib: Library, name: string) {
  const games = lib
    .listGames()
    .filter((g) => g.mySide && g.opponent === name)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  const their = (g: GameListItem) => (g.mySide === "black" ? "white" : "black");
  const theirOpening = (g: GameListItem) => g.opening || (their(g) === "black" ? g.black_opening || g.black_style : g.white_opening || g.white_style);
  return {
    name,
    totals: score(games),
    firstPlayed: games.at(-1)?.date ?? "",
    lastPlayed: games[0]?.date ?? "",
    /** Their openings and how I scored against each. */
    theirOpenings: groupBy(games, theirOpening),
    theirCastles: groupBy(games, (g) => (their(g) === "black" ? g.black_castle : g.white_castle)),
    myOpenings: groupBy(games, (g) => g.myOpening),
    bySide: groupBy(games, (g) => (g.mySide === "black" ? "先手" : "後手")),
    /** Most recent first: W/L string like "WWLW". */
    form: games
      .slice(0, 10)
      .map((g) => (g.myResult === "win" ? "W" : g.myResult === "loss" ? "L" : g.myResult === "draw" ? "D" : "-"))
      .join(""),
    meanAccuracy: mean(games.filter((g) => g.myAccuracy !== null).map((g) => g.myAccuracy!)),
    theirRating: games.find((g) => g.opponentRating !== null)?.opponentRating ?? null,
    games,
  };
}

/**
 * Games like this one, for reviewing together: same side, same opening on both
 * sides, then the same castles. Losses come first since they're what you study.
 */
export function similarGames(lib: Library, id: number, limit = 8) {
  const all = lib.listGames();
  const me = all.find((g) => g.id === id);
  if (!me || !me.mySide) return [];
  const theirOpening = (g: GameListItem) => g.opening || (g.mySide === "black" ? g.white_opening || g.white_style : g.black_opening || g.black_style);
  const myCastle = (g: GameListItem) => g.myCastle;
  const theirCastle = (g: GameListItem) => (g.mySide === "black" ? g.white_castle : g.black_castle);
  return all
    .filter((g) => g.id !== id && g.mySide)
    .map((g) => {
      let score = 0;
      if (g.myOpening && g.myOpening === me.myOpening) score += 3;
      if (theirOpening(g) && theirOpening(g) === theirOpening(me)) score += 3;
      if (g.mySide === me.mySide) score += 1;
      if (myCastle(g) && myCastle(g) === myCastle(me)) score += 1;
      if (theirCastle(g) && theirCastle(g) === theirCastle(me)) score += 1;
      return { g, score };
    })
    .filter((x) => x.score >= 4)
    .sort((a, b) => b.score - a.score || Number(b.g.myResult === "loss") - Number(a.g.myResult === "loss") || (a.g.date < b.g.date ? 1 : -1))
    .slice(0, limit)
    .map(({ g, score }) => ({ id: g.id, date: g.date, opponent: g.opponent, myResult: g.myResult, strategy: g.strategy, mySide: g.mySide, score }));
}
