import { createHash } from "node:crypto";
import { Color, Move, Position, Record, formatMove, formatPV } from "tsshogi";
import { Db, sfenKey } from "./db.js";
import { AppSettings, loadSettings } from "./settings.js";
import { importRecordFromBuffer, importRecordFromText, exportRecordAsBuffer, RecordFileFormat } from "../core/recordFile.js";
import { summarizeRecord, normalizePlayerName, parseStrength, GameSummary } from "../core/summarize.js";
import { classify, strategyLabel, styleMatchup, Classification } from "../core/classifier/index.js";
import { gradeMoves, accuracy, turningPoint, Eval, mistakeLabels } from "../core/grading.js";
import { newSm2State } from "../core/sm2.js";
import { getSituationText } from "../core/score.js";
import { SCORE_MATE_INFINITE } from "../core/usi.js";

export type ImportResult =
  | { status: "added"; id: number; name: string }
  | { status: "duplicate"; id: number; name: string }
  | { status: "error"; name: string; error: string };

export type GameRow = {
  id: number;
  black: string;
  white: string;
  date: string;
  event: string;
  time_control: string;
  source: string;
  result: string;
  end_reason: string;
  move_count: number;
  strategy: string;
  opening: string;
  black_opening: string;
  white_opening: string;
  black_style: string;
  white_style: string;
  black_castle: string;
  white_castle: string;
  matchup: string;
  analysis_status: string;
  accuracy_black: number | null;
  accuracy_white: number | null;
  turning_ply: number | null;
  imported_at: number;
  file_name: string;
};

export type GameListItem = GameRow & {
  tags: string[];
  mySide: "black" | "white" | "";
  myResult: "win" | "loss" | "draw" | "";
  opponent: string;
  myOpening: string;
  myCastle: string;
  myAccuracy: number | null;
  mistakes: number; // my 悪手+大悪手 (or both sides' when side unknown)
  /** Rating / rank written after the names, e.g. "(1650)" from Lishogi, "三段" from Shogi Wars. */
  myRating: number | null;
  myRank: string;
  opponentRating: number | null;
};

export type GameFilter = {
  q?: string;
  side?: "black" | "white" | "";
  result?: "win" | "loss" | "draw" | "";
  opening?: string;
  castle?: string;
  opponent?: string;
  tag?: string;
  source?: string;
  matchup?: string;
  dateFrom?: string;
  dateTo?: string;
  analysed?: "yes" | "no" | "";
  sort?: string;
  desc?: boolean;
};

const LIST_COLUMNS = `id, black, white, date, event, time_control, source, result, end_reason, move_count,
  strategy, opening, black_opening, white_opening, black_style, white_style, black_castle, white_castle,
  matchup, analysis_status, accuracy_black, accuracy_white, turning_ply, imported_at, file_name`;

/** Games shorter than this are deduplicated by players and date as well as moves. */
const SHORT_GAME = 30;

export function hashCanonical(canonical: string): string {
  return createHash("sha1").update(canonical).digest("hex");
}

function sideOfMove(initialSfen: string, ply: number): "black" | "white" {
  const firstBlack = initialSfen.split(" ")[1] !== "w";
  return (ply % 2 === 1) === firstBlack ? "black" : "white";
}

export class Library {
  constructor(readonly db: Db) {}

  get settings(): AppSettings {
    return loadSettings(this.db);
  }

  // ---------------------------------------------------------------- import

  importBuffer(data: Uint8Array, fileName: string): ImportResult {
    const record = importRecordFromBuffer(data, fileName);
    if (record instanceof Error) return { status: "error", name: fileName, error: record.message };
    const text = new TextDecoder().decode(data);
    return this.importRecord(record, fileName, text);
  }

  importText(text: string, name = "pasted"): ImportResult {
    const record = importRecordFromText(text);
    if (record instanceof Error) return { status: "error", name, error: record.message };
    return this.importRecord(record, name, text);
  }

  private importRecord(record: Record, fileName: string, rawText: string): ImportResult {
    const summary = summarizeRecord(record, rawText);
    if (summary.moveCount === 0) {
      return { status: "error", name: fileName, error: "no moves in record" };
    }
    // Moves alone identify a real game across sources, but short games (early
    // resignations, disconnects) collide; tell those apart by players and day.
    const key =
      summary.moveCount < SHORT_GAME
        ? `${summary.canonical}|${normalizePlayerName(summary.blackName)}|${normalizePlayerName(summary.whiteName)}|${summary.date.slice(0, 10)}`
        : summary.canonical;
    const hash = hashCanonical(key);
    const existing = this.db.get<{ id: number }>("SELECT id FROM games WHERE hash = ?", hash);
    if (existing) {
      this.mergeImportedEvals(existing.id, summary);
      return { status: "duplicate", id: existing.id, name: fileName };
    }
    const sfens = [summary.initialSfen, ...summary.plies.map((p) => p.sfen)];
    const cls = classify(sfens);
    // Store a KIF rendering as the canonical text so later exports round-trip
    // through one format whatever the source was.
    const kif = exportRecordAsBuffer(record, RecordFileFormat.KIF, { utf8: true, returnCode: "\n" }).text;
    const now = Date.now();
    const id = this.db.tx(() => {
      const r = this.db.run(
        `INSERT INTO games (hash, original_text, file_name, black, white, date, event, time_control, source,
           result, end_reason, move_count, initial_sfen, strategy, strategy_header, opening, black_opening,
           white_opening, black_style, white_style, black_castle, white_castle, matchup, classification,
           imported_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        hash,
        kif,
        fileName,
        summary.blackName,
        summary.whiteName,
        summary.date,
        summary.event,
        summary.timeControl,
        summary.source,
        summary.result,
        summary.endReason,
        summary.moveCount,
        summary.initialSfen,
        strategyLabel(cls),
        summary.strategyHeader,
        cls.opening?.name ?? "",
        cls.sideOpening.black?.name ?? "",
        cls.sideOpening.white?.name ?? "",
        cls.style.black,
        cls.style.white,
        cls.mainCastle.black,
        cls.mainCastle.white,
        styleMatchup(cls),
        JSON.stringify(cls),
        now,
        now,
      );
      const gameId = Number(r.lastInsertRowid);
      this.db.run("INSERT INTO plies (game_id, ply, sfen) VALUES (?, 0, ?)", gameId, summary.initialSfen);
      for (const p of summary.plies) {
        const hasEval = p.importedScore !== undefined || p.importedMate !== undefined;
        this.db.run(
          `INSERT INTO plies (game_id, ply, usi, text, sfen, comment, elapsed_ms, score, mate, eval_source)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          gameId,
          p.ply,
          p.usi,
          p.text,
          p.sfen,
          p.comment,
          p.elapsedMs,
          p.importedScore ?? null,
          p.importedMate ?? null,
          hasEval ? "file" : "",
        );
      }
      return gameId;
    });
    if (summary.plies.some((p) => p.importedScore !== undefined || p.importedMate !== undefined)) {
      this.db.run("UPDATE games SET analysis_status = 'imported' WHERE id = ?", id);
      this.regrade(id);
    }
    return { status: "added", id, name: fileName };
  }

  /** A duplicate may carry evals the stored copy lacks (e.g. re-exported from ShogiHome). */
  private mergeImportedEvals(id: number, summary: GameSummary) {
    let changed = false;
    for (const p of summary.plies) {
      if (p.importedScore === undefined && p.importedMate === undefined) continue;
      const r = this.db.run(
        `UPDATE plies SET score = ?, mate = ?, eval_source = 'file'
         WHERE game_id = ? AND ply = ? AND score IS NULL AND mate IS NULL`,
        p.importedScore ?? null,
        p.importedMate ?? null,
        id,
        p.ply,
      );
      if (Number(r.changes)) changed = true;
    }
    if (changed) {
      this.db.run("UPDATE games SET analysis_status = CASE analysis_status WHEN 'none' THEN 'imported' ELSE analysis_status END WHERE id = ?", id);
      this.regrade(id);
    }
  }

  // ---------------------------------------------------------------- list

  private myNames(): string[] {
    return this.settings.myNames.map((n) => normalizePlayerName(n).toLowerCase()).filter(Boolean);
  }

  mySide(row: { black: string; white: string }, names = this.myNames()): "black" | "white" | "" {
    const b = normalizePlayerName(row.black).toLowerCase();
    const w = normalizePlayerName(row.white).toLowerCase();
    if (names.includes(b)) return "black";
    if (names.includes(w)) return "white";
    return "";
  }

  listGames(filter: GameFilter = {}): GameListItem[] {
    const rows = this.db.all<GameRow>(`SELECT ${LIST_COLUMNS} FROM games`);
    const tagRows = this.db.all<{ game_id: number; tag: string }>("SELECT game_id, tag FROM tags ORDER BY tag");
    const tags = new Map<number, string[]>();
    for (const t of tagRows) {
      if (!tags.has(t.game_id)) tags.set(t.game_id, []);
      tags.get(t.game_id)!.push(t.tag);
    }
    const mistakeRows = this.db.all<{ game_id: number; ply: number; level: number }>(
      "SELECT game_id, ply, level FROM plies WHERE level >= 3",
    );
    const mistakes = new Map<number, number[]>();
    for (const m of mistakeRows) {
      if (!mistakes.has(m.game_id)) mistakes.set(m.game_id, []);
      mistakes.get(m.game_id)!.push(m.ply);
    }
    const names = this.myNames();
    const firstColor = new Map(
      this.db.all<{ id: number; initial_sfen: string }>("SELECT id, initial_sfen FROM games").map((r) => [r.id, r.initial_sfen]),
    );
    let items: GameListItem[] = rows.map((r) => {
      const mySide = this.mySide(r, names);
      const myResult: GameListItem["myResult"] =
        !mySide || r.result === "unknown" ? "" : r.result === "draw" ? "draw" : r.result === mySide ? "win" : "loss";
      const myOpening = r.opening || (mySide ? (mySide === "black" ? r.black_opening || r.black_style : r.white_opening || r.white_style) : "");
      const myCastle = mySide === "black" ? r.black_castle : mySide === "white" ? r.white_castle : "";
      const plies = mistakes.get(r.id) ?? [];
      const init = firstColor.get(r.id) ?? "";
      const me = mySide ? parseStrength(mySide === "black" ? r.black : r.white) : null;
      const opp = mySide ? parseStrength(mySide === "black" ? r.white : r.black) : null;
      return {
        ...r,
        tags: tags.get(r.id) ?? [],
        mySide,
        myResult,
        // Without rating or rank, so one opponent stays one opponent as their rating moves.
        opponent: mySide === "black" ? normalizePlayerName(r.white) : mySide === "white" ? normalizePlayerName(r.black) : "",
        myOpening,
        myCastle,
        myAccuracy: mySide === "black" ? r.accuracy_black : mySide === "white" ? r.accuracy_white : null,
        mistakes: mySide ? plies.filter((p) => sideOfMove(init, p) === mySide).length : plies.length,
        myRating: me?.rating ?? null,
        myRank: me?.rank ?? "",
        opponentRating: opp?.rating ?? null,
      };
    });
    // Search text also matches what you wrote: move comments and game notes.
    const textHits = filter.q
      ? new Set(
          this.db
            .all<{ id: number }>(
              `SELECT DISTINCT game_id id FROM plies WHERE instr(lower(comment), ?) > 0
               UNION SELECT id FROM games WHERE instr(lower(notes), ?) > 0`,
              filter.q.toLowerCase(),
              filter.q.toLowerCase(),
            )
            .map((r) => r.id),
        )
      : undefined;
    items = items.filter((g) => matchesFilter(g, filter, textHits));
    const key = (filter.sort ?? "date") as keyof GameListItem;
    const dir = filter.desc === false ? 1 : -1;
    items.sort((a, b) => {
      const x = a[key] ?? "";
      const y = b[key] ?? "";
      if (x < y) return -dir;
      if (x > y) return dir;
      return b.id - a.id;
    });
    return items;
  }

  facets() {
    const games = this.listGames();
    const count = (vals: string[]) => {
      const m = new Map<string, number>();
      for (const v of vals) if (v) m.set(v, (m.get(v) ?? 0) + 1);
      return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([value, n]) => ({ value, n }));
    };
    return {
      openings: count(games.flatMap((g) => [g.opening, g.black_opening, g.white_opening, g.myOpening])),
      castles: count(games.flatMap((g) => [g.black_castle, g.white_castle])),
      opponents: count(games.map((g) => g.opponent)),
      players: count(games.flatMap((g) => [normalizePlayerName(g.black), normalizePlayerName(g.white)])),
      tags: count(games.flatMap((g) => g.tags)),
      sources: count(games.map((g) => g.source)),
      matchups: count(games.map((g) => g.matchup)),
    };
  }

  // ---------------------------------------------------------------- detail

  getGame(id: number) {
    const row = this.db.get<GameRow & { initial_sfen: string; classification: string; notes: string; strategy_header: string; original_text: string; analysis_engine: string }>(
      "SELECT * FROM games WHERE id = ?",
      id,
    );
    if (!row) return undefined;
    const plies = this.db.all<{
      ply: number; usi: string; text: string; sfen: string; comment: string; elapsed_ms: number;
      score: number | null; mate: number | null; best_usi: string; pv: string; eval_source: string;
      loss: number | null; level: number; missed: "" | "mate" | "win";
    }>("SELECT * FROM plies WHERE game_id = ? ORDER BY ply", id);
    const tags = this.db.all<{ tag: string }>("SELECT tag FROM tags WHERE game_id = ? ORDER BY tag", id).map((t) => t.tag);
    const cards = this.db.all<{ id: number; ply: number }>("SELECT id, ply FROM cards WHERE game_id = ?", id);
    const pvText = (ply: number, pv: string) => {
      if (!pv) return "";
      const pos = Position.newBySFEN(plies[ply].sfen);
      if (!pos) return "";
      const moves: Move[] = [];
      const p = pos.clone();
      for (const u of pv.split(" ")) {
        const m = p.createMoveByUSI(u);
        if (!m || !p.doMove(m)) break;
        moves.push(m);
      }
      return formatPV(pos, moves);
    };
    const mySide = this.mySide(row);
    return {
      ...row,
      original_text: undefined,
      classification: JSON.parse(row.classification) as Classification,
      tags,
      mySide,
      plies: plies.map((p) => ({
        ...p,
        pvText: pvText(p.ply, p.pv),
        situation: p.score !== null ? getSituationText(p.score) : "",
        label: mistakeLabels[p.level as 0 | 1 | 2 | 3 | 4] ?? "",
        side: p.ply === 0 ? "" : sideOfMove(row.initial_sfen, p.ply),
        cardId: cards.find((c) => c.ply === p.ply)?.id ?? null,
      })),
    };
  }

  updateGame(id: number, patch: { tags?: string[]; notes?: string; black?: string; white?: string; date?: string }) {
    this.db.tx(() => {
      if (patch.tags) {
        this.db.run("DELETE FROM tags WHERE game_id = ?", id);
        for (const t of new Set(patch.tags.map((x) => x.trim()).filter(Boolean))) {
          this.db.run("INSERT INTO tags (game_id, tag) VALUES (?, ?)", id, t);
        }
      }
      for (const k of ["notes", "black", "white", "date"] as const) {
        if (patch[k] !== undefined) {
          this.db.run(`UPDATE games SET ${k} = ?, updated_at = ? WHERE id = ?`, patch[k], Date.now(), id);
        }
      }
    });
  }

  setComment(id: number, ply: number, comment: string) {
    this.db.run("UPDATE plies SET comment = ? WHERE game_id = ? AND ply = ?", comment, id, ply);
  }

  deleteGame(id: number) {
    this.db.run("DELETE FROM games WHERE id = ?", id);
  }

  // ---------------------------------------------------------------- evals

  /** Store an engine eval (black's view) for a ply and the shared cache. */
  setPlyEval(
    id: number,
    ply: number,
    e: { score?: number; mate?: number; best: string; pv: string; depth?: number; nodes?: number },
    engine: string,
    limitKey: string,
  ) {
    const row = this.db.get<{ sfen: string }>("SELECT sfen FROM plies WHERE game_id = ? AND ply = ?", id, ply);
    if (!row) return;
    this.db.run(
      `UPDATE plies SET score = ?, mate = ?, best_usi = ?, pv = ?, eval_source = 'engine' WHERE game_id = ? AND ply = ?`,
      e.score ?? null,
      e.mate ?? null,
      e.best,
      e.pv,
      id,
      ply,
    );
    this.db.run(
      `INSERT INTO evals (sfen, engine, limit_key, score, mate, best_usi, pv, depth, nodes, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(sfen, engine, limit_key) DO UPDATE SET score = excluded.score, mate = excluded.mate,
         best_usi = excluded.best_usi, pv = excluded.pv, depth = excluded.depth, nodes = excluded.nodes`,
      sfenKey(row.sfen),
      engine,
      limitKey,
      e.score ?? null,
      e.mate ?? null,
      e.best,
      e.pv,
      e.depth ?? null,
      e.nodes ?? null,
      Date.now(),
    );
  }

  cachedEval(sfen: string, engine: string, limitKey: string) {
    return this.db.get<{ score: number | null; mate: number | null; best_usi: string; pv: string }>(
      "SELECT score, mate, best_usi, pv FROM evals WHERE sfen = ? AND engine = ? AND limit_key = ?",
      sfenKey(sfen),
      engine,
      limitKey,
    );
  }

  /** Recompute mistake labels, accuracy and cards from the stored evals. */
  regrade(id: number) {
    const s = this.settings;
    const game = this.db.get<{ initial_sfen: string; black: string; white: string }>(
      "SELECT initial_sfen, black, white FROM games WHERE id = ?",
      id,
    );
    if (!game) return;
    const plies = this.db.all<{ ply: number; usi: string; text: string; sfen: string; score: number | null; mate: number | null; best_usi: string; pv: string }>(
      "SELECT ply, usi, text, sfen, score, mate, best_usi, pv FROM plies WHERE game_id = ? ORDER BY ply",
      id,
    );
    const evals: (Eval | null)[] = plies.map((p) =>
      p.score === null && p.mate === null ? null : { score: p.score ?? undefined, mate: p.mate ?? undefined },
    );
    const first = game.initial_sfen.split(" ")[1] === "w" ? "white" : "black";
    const grades = gradeMoves(evals, first, s.grading);
    const tp = turningPoint(grades);
    const mySide = this.mySide(game);
    const cardSides = new Set<string>(mySide ? [mySide] : this.myNames().length ? [] : ["black", "white"]);
    this.db.tx(() => {
      for (const g of grades) {
        const missed = g.missedMate ? "mate" : g.missedWin ? "win" : "";
        this.db.run("UPDATE plies SET loss = ?, level = ?, missed = ? WHERE game_id = ? AND ply = ?", g.loss, g.level, missed, id, g.ply);
        const prev = plies[g.ply - 1];
        const cur = plies[g.ply];
        const isCard = (g.level >= s.cardMinLevel || g.missedMate) && cardSides.has(g.color) && prev.best_usi && prev.best_usi !== cur.usi;
        if (isCard) {
          const phase = g.ply <= 30 ? "opening" : g.ply <= 80 ? "middlegame" : "endgame";
          this.db.run(
            `INSERT INTO cards (game_id, ply, sfen, side, played_usi, played_text, best_usi, pv, loss, level, kind, phase, due_at, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(game_id, ply) DO UPDATE SET best_usi = excluded.best_usi, pv = excluded.pv,
               loss = excluded.loss, level = excluded.level, kind = excluded.kind`,
            id,
            g.ply,
            prev.sfen,
            g.color,
            cur.usi,
            cur.text,
            prev.best_usi,
            prev.pv,
            g.loss,
            g.level,
            g.missedMate ? "missed_mate" : "mistake",
            phase,
            newSm2State().dueAt,
            Date.now(),
          );
        }
      }
      this.db.run(
        "UPDATE games SET accuracy_black = ?, accuracy_white = ?, turning_ply = ?, updated_at = ? WHERE id = ?",
        accuracy(grades, "black") ?? null,
        accuracy(grades, "white") ?? null,
        tp?.ply ?? null,
        Date.now(),
        id,
      );
    });
  }

  // ---------------------------------------------------------------- export

  /** Rebuild the record with current comments plus analysis in ShogiHome's comment format. */
  buildRecord(id: number, opts: { withAnalysis?: boolean; engineName?: string } = {}): Record | undefined {
    const game = this.db.get<{ original_text: string; analysis_engine: string }>(
      "SELECT original_text, analysis_engine FROM games WHERE id = ?",
      id,
    );
    if (!game) return undefined;
    const record = importRecordFromText(game.original_text);
    if (record instanceof Error) return undefined;
    const plies = this.db.all<{ ply: number; comment: string; score: number | null; mate: number | null; pv: string; level: number; eval_source: string }>(
      "SELECT ply, comment, score, mate, pv, level, eval_source FROM plies WHERE game_id = ? ORDER BY ply",
      id,
    );
    const engineName = opts.engineName ?? game.analysis_engine;
    let node = record.first.next;
    let ply = 0;
    while (node && node.move instanceof Move) {
      ply++;
      const p = plies[ply];
      if (p) {
        let comment = stripSearchComment(p.comment);
        if (opts.withAnalysis !== false && p.eval_source === "engine") {
          const header = p.level ? `【${mistakeLabels[p.level as 1 | 2 | 3 | 4]}】\n` : "";
          // The PV at a node is the engine's line from the position after that move.
          const pos = Position.newBySFEN(node.sfen);
          let pvText = "";
          if (pos && p.pv) {
            const moves: Move[] = [];
            const q = pos.clone();
            for (const u of p.pv.split(" ")) {
              const m = q.createMoveByUSI(u);
              if (!m || !q.doMove(m)) break;
              moves.push(m);
            }
            pvText = moves.length ? formatPV(pos, moves) : "";
          }
          let block = header;
          if (p.mate !== null && p.mate !== 0) {
            block += `#詰み=${p.mate > 0 ? "先手勝ち" : "後手勝ち"}`;
            if (Math.abs(p.mate) !== SCORE_MATE_INFINITE) block += `:${Math.abs(p.mate)}手`;
            block += "\n";
          }
          if (p.score !== null) {
            block += getSituationText(p.score) + "\n" + `#評価値=${p.score}\n`;
          }
          if (pvText) block += `#読み筋=${pvText}\n`;
          if (engineName) block += `#エンジン=${engineName}\n`;
          comment = comment ? `${comment}\n${block}` : block;
        }
        node.comment = comment.replace(/\n+$/, "");
      }
      node = node.next;
    }
    return record;
  }

  exportGame(id: number, format: RecordFileFormat, utf8 = false) {
    const record = this.buildRecord(id);
    if (!record) return undefined;
    return exportRecordAsBuffer(record, format, { utf8 });
  }

  // ---------------------------------------------------------------- moves

  /** Japanese text for a USI move at a position. */
  static moveText(sfen: string, usi: string): string {
    const pos = Position.newBySFEN(sfen);
    if (!pos) return usi;
    const m = pos.createMoveByUSI(usi);
    if (!m) return usi;
    return formatMove(pos, m); // already starts with ☗/☖
  }

  static pvText(sfen: string, pv: string): string {
    const pos = Position.newBySFEN(sfen);
    if (!pos || !pv) return "";
    const moves: Move[] = [];
    const q = pos.clone();
    for (const u of pv.split(" ")) {
      const m = q.createMoveByUSI(u);
      if (!m || !q.doMove(m)) break;
      moves.push(m);
    }
    return formatPV(pos, moves);
  }

  /** Find games that reached a position (exact, ignoring the move number). */
  findPosition(sfen: string) {
    const key = sfenKey(sfen);
    const rows = this.db.all<{ game_id: number; ply: number; sfen: string }>(
      "SELECT game_id, ply, sfen FROM plies WHERE sfen GLOB ? ORDER BY game_id, ply",
      key + " *",
    );
    const firstByGame = new Map<number, number>();
    for (const r of rows) if (!firstByGame.has(r.game_id)) firstByGame.set(r.game_id, r.ply);
    return [...firstByGame.entries()].map(([gameId, ply]) => ({ gameId, ply }));
  }
}

function stripSearchComment(comment: string): string {
  return comment
    .split("\n")
    .filter(
      (l) =>
        !/^#(評価値|読み筋|深さ|ノード数|エンジン|詰み)=/.test(l) &&
        !/^(先手|後手)(勝勢|優勢|有利|有望)$|^互角$/.test(l) &&
        !/^【(緩手|疑問手|悪手|大悪手)】$/.test(l),
    )
    .join("\n")
    .trim();
}

function matchesFilter(g: GameListItem, f: GameFilter, textHits?: Set<number>): boolean {
  if (f.side && g.mySide !== f.side) return false;
  if (f.result && g.myResult !== f.result) return false;
  if (f.opening && ![g.opening, g.black_opening, g.white_opening, g.myOpening, g.strategy].includes(f.opening)) return false;
  if (f.castle && ![g.black_castle, g.white_castle].includes(f.castle)) return false;
  if (f.opponent && g.opponent !== f.opponent && !normalizePlayerName(g.black).includes(f.opponent) && !normalizePlayerName(g.white).includes(f.opponent)) return false;
  if (f.tag && !g.tags.includes(f.tag)) return false;
  if (f.source && g.source !== f.source) return false;
  if (f.matchup && g.matchup !== f.matchup) return false;
  if (f.dateFrom && g.date && g.date < f.dateFrom) return false;
  if (f.dateTo && g.date && g.date.slice(0, 10) > f.dateTo) return false;
  if (f.analysed === "yes" && g.analysis_status === "none") return false;
  if (f.analysed === "no" && g.analysis_status !== "none") return false;
  if (f.q) {
    const q = f.q.toLowerCase();
    const hay = [g.black, g.white, g.event, g.strategy, g.black_castle, g.white_castle, g.file_name, ...g.tags]
      .join(" ")
      .toLowerCase();
    if (!hay.includes(q) && !textHits?.has(g.id)) return false;
  }
  return true;
}

