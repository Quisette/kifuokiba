import { Position } from "tsshogi";
import { Library } from "./library.js";
import { positionSvg } from "../core/diagram.js";
import { AnalysisQueue } from "./analysis.js";
import { Rating, ratingFromLoss } from "../core/sm2.js";
import { scheduleCard } from "../core/scheduler.js";
import { winRate } from "../core/grading.js";
import { normalizePlayerName } from "../core/summarize.js";

export type CardRow = {
  id: number;
  game_id: number;
  ply: number;
  sfen: string;
  side: string;
  played_usi: string;
  played_text: string;
  best_usi: string;
  pv: string;
  loss: number;
  level: number;
  kind: string;
  phase: string;
  repetitions: number;
  interval_days: number;
  ease: number;
  due_at: number;
  lapses: number;
  stability: number | null;
  difficulty: number | null;
  last_review_at: number | null;
  suspended: number;
  note: string;
  created_at: number;
};

export type CardFilter = {
  kind?: string;
  phase?: string;
  /** Substring of the game's 戦型 label. */
  opening?: string;
  /** The opening of the side the card is for. */
  myOpening?: string;
  opponent?: string;
  tag?: string;
  /** A kind of the move played (see core/movekind.ts). */
  moveKind?: string;
  side?: string;
  due?: boolean;
  leech?: boolean;
};
/** The filter fields a saved deck can hold. */
export const DECK_KEYS = ["kind", "phase", "myOpening", "opponent", "tag", "moveKind", "side", "leech"] as const;
export type Deck = { id: number; name: string; filter: CardFilter };

type ListRow = CardRow & {
  black: string;
  white: string;
  date: string;
  strategy: string;
  black_opening: string;
  white_opening: string;
  black_style: string;
  white_style: string;
  move_kind: string | null;
  tag_list: string | null;
};

/** Lapses after which a card counts as a leech (Anki's default is 8; mistakes from your own games deserve attention sooner). */
export const LEECH_LAPSES = 4;

export class Cards {
  constructor(
    private readonly lib: Library,
    private readonly analysis: AnalysisQueue,
  ) {}

  list(filter: CardFilter = {}, now = Date.now()) {
    const rows = this.lib.db.all<ListRow>(
      `SELECT c.*, g.black, g.white, g.date, g.strategy, g.black_opening, g.white_opening, g.black_style, g.white_style,
              p.move_kind, (SELECT group_concat(tag, char(31)) FROM tags t WHERE t.game_id = c.game_id) tag_list
       FROM cards c JOIN games g ON g.id = c.game_id
       LEFT JOIN plies p ON p.game_id = c.game_id AND p.ply = c.ply
       ORDER BY c.due_at, c.id`,
    );
    return rows
      .map((c) => this.describe(c))
      .filter((c) => !filter.kind || c.kind === filter.kind)
      .filter((c) => !filter.phase || c.phase === filter.phase)
      .filter((c) => !filter.opening || c.strategy.includes(filter.opening))
      .filter((c) => !filter.myOpening || c.opening === filter.myOpening)
      .filter((c) => !filter.opponent || c.opponent === filter.opponent)
      .filter((c) => !filter.tag || c.tags.includes(filter.tag))
      .filter((c) => !filter.moveKind || c.moveKinds.includes(filter.moveKind))
      .filter((c) => !filter.side || c.side === filter.side)
      .filter((c) => !filter.due || (c.due_at <= now && !c.suspended))
      .filter((c) => !filter.leech || c.lapses >= LEECH_LAPSES)
      .map((c) => this.present(c));
  }

  /** Where a card comes from, seen from the side it is for. */
  private describe(c: ListRow) {
    const mine = c.side === "white" ? "white" : "black";
    const { black_opening, white_opening, black_style, white_style, move_kind, tag_list, ...rest } = c;
    const opening = mine === "black" ? black_opening || black_style : white_opening || white_style;
    return {
      ...rest,
      opening,
      opponent: normalizePlayerName(mine === "black" ? c.white : c.black),
      tags: tag_list ? tag_list.split("\x1f") : [],
      moveKinds: move_kind ? move_kind.split(",") : [],
    };
  }

  /** The values the deck filters can take among the cards, with total and due counts. */
  facets(now = Date.now()) {
    const all = this.list({}, now);
    const tally = (values: (c: (typeof all)[number]) => string[]) => {
      const m = new Map<string, { total: number; due: number }>();
      for (const c of all) {
        for (const v of new Set(values(c))) {
          if (!v) continue;
          const e = m.get(v) ?? { total: 0, due: 0 };
          e.total++;
          if (c.due_at <= now && !c.suspended) e.due++;
          m.set(v, e);
        }
      }
      return [...m.entries()].map(([value, n]) => ({ value, ...n })).sort((a, b) => b.total - a.total || a.value.localeCompare(b.value));
    };
    return {
      myOpening: tally((c) => [c.opening]),
      opponent: tally((c) => [c.opponent]),
      tag: tally((c) => c.tags),
      moveKind: tally((c) => c.moveKinds),
      side: tally((c) => [c.side]),
    };
  }

  // ---- saved decks (the cardDecks setting)
  decks(now = Date.now()): (Deck & { total: number; due: number })[] {
    return this.lib.db.getSetting<Deck[]>("cardDecks", []).map((d) => {
      const cards = this.list(d.filter, now);
      return { ...d, total: cards.length, due: cards.filter((c) => c.due_at <= now && !c.suspended).length };
    });
  }

  saveDeck(name: string, filter: CardFilter): Deck {
    const clean: CardFilter = {};
    for (const k of DECK_KEYS) {
      const v = filter[k];
      if (v !== undefined && v !== "" && v !== false) (clean as Record<string, unknown>)[k] = v;
    }
    const decks = this.lib.db.getSetting<Deck[]>("cardDecks", []);
    const deck = { id: Math.max(0, ...decks.map((d) => d.id)) + 1, name: name.trim() || "Deck", filter: clean };
    this.lib.db.setSetting("cardDecks", [...decks, deck]);
    return deck;
  }

  deleteDeck(id: number) {
    this.lib.db.setSetting("cardDecks", this.lib.db.getSetting<Deck[]>("cardDecks", []).filter((d) => d.id !== id));
  }

  counts(now = Date.now()) {
    const r = this.lib.db.get<{ total: number; due: number; fresh: number; leeches: number; nextDueAt: number | null }>(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN due_at <= ? AND suspended = 0 THEN 1 ELSE 0 END) due,
              SUM(CASE WHEN repetitions = 0 AND lapses = 0 THEN 1 ELSE 0 END) fresh,
              SUM(CASE WHEN lapses >= ${LEECH_LAPSES} THEN 1 ELSE 0 END) leeches,
              MIN(CASE WHEN suspended = 0 THEN due_at END) nextDueAt
       FROM cards`,
      now,
    );
    const reviewedToday = this.lib.db.get<{ n: number }>(
      "SELECT COUNT(*) n FROM reviews WHERE at >= ?",
      new Date(new Date(now).toDateString()).getTime(),
    );
    return { total: r?.total ?? 0, due: r?.due ?? 0, fresh: r?.fresh ?? 0, leeches: r?.leeches ?? 0, nextDueAt: r?.nextDueAt ?? null, reviewedToday: reviewedToday?.n ?? 0 };
  }

  get(id: number) {
    const c = this.lib.db.get<CardRow & { black: string; white: string; date: string; strategy: string }>(
      `SELECT c.*, g.black, g.white, g.date, g.strategy FROM cards c JOIN games g ON g.id = c.game_id WHERE c.id = ?`,
      id,
    );
    return c ? this.present(c) : undefined;
  }

  private present<T extends CardRow>(c: T) {
    return {
      ...c,
      bestText: Library.moveText(c.sfen, c.best_usi),
      playedText: Library.moveText(c.sfen, c.played_usi),
      pvText: Library.pvText(c.sfen, c.pv),
      leech: c.lapses >= LEECH_LAPSES,
    };
  }

  /**
   * Check an answer. The best move is always correct; any other move is checked
   * with the engine (when one is configured) and counts as correct when its
   * win-rate loss against the best move is within `cardOkLoss`.
   */
  async answer(id: number, answerUsi: string) {
    const card = this.get(id);
    if (!card) throw new Error("card not found");
    const pos = Position.newBySFEN(card.sfen);
    if (!pos) throw new Error("bad card position");
    const move = pos.createMoveByUSI(answerUsi);
    if (!move || !pos.isValidMove(move)) {
      return { legal: false as const };
    }
    const okLoss = this.lib.settings.cardOkLoss;
    const answerText = Library.moveText(card.sfen, answerUsi);
    const base = {
      legal: true as const,
      answerText,
      bestText: card.bestText,
      pvText: card.pvText,
      playedText: card.playedText,
    };
    if (answerUsi === card.best_usi) {
      return { ...base, correct: true, loss: 0, suggested: "good" as Rating, checkedByEngine: false };
    }
    if (answerUsi === card.played_usi) {
      return { ...base, correct: false, loss: card.loss, suggested: "again" as Rating, checkedByEngine: false, sameAsGame: true };
    }
    if (!this.lib.settings.engine.path) {
      return { ...base, correct: false, loss: null, suggested: "again" as Rating, checkedByEngine: false };
    }
    // Evaluate the position before (best line) and after the answer.
    const after = pos.clone();
    after.doMove(move);
    const before = await this.analysis.searchPosition(`sfen ${card.sfen}`, card.sfen);
    const res = await this.analysis.searchPosition(`sfen ${card.sfen} moves ${answerUsi}`, after.sfen);
    const side = card.side as "black" | "white";
    const wrBefore = winRate({ score: before.score, mate: before.mate }) ?? 50;
    const wrAfter = winRate({ score: res.score, mate: res.mate }) ?? 50;
    const loss = Math.max(0, side === "black" ? wrBefore - wrAfter : wrAfter - wrBefore);
    const suggested = ratingFromLoss(loss, okLoss);
    return { ...base, correct: loss <= okLoss, loss, suggested, checkedByEngine: true };
  }

  rate(id: number, rating: Rating, answerUsi = "", loss: number | null = null, now = Date.now()) {
    const c = this.lib.db.get<CardRow>("SELECT * FROM cards WHERE id = ?", id);
    if (!c) throw new Error("card not found");
    const s = this.lib.settings;
    const next = scheduleCard(
      {
        repetitions: c.repetitions,
        intervalDays: c.interval_days,
        ease: c.ease,
        dueAt: c.due_at,
        lapses: c.lapses,
        stability: c.stability,
        difficulty: c.difficulty,
        lastReviewAt: c.last_review_at,
      },
      rating,
      now,
      { scheduler: s.scheduler, desiredRetention: s.desiredRetention },
    );
    this.lib.db.tx(() => {
      this.lib.db.run(
        `UPDATE cards SET repetitions = ?, interval_days = ?, ease = ?, due_at = ?, lapses = ?,
           stability = ?, difficulty = ?, last_review_at = ? WHERE id = ?`,
        next.repetitions,
        next.intervalDays,
        next.ease,
        next.dueAt,
        next.lapses,
        next.stability,
        next.difficulty,
        next.lastReviewAt,
        id,
      );
      this.lib.db.run("INSERT INTO reviews (card_id, at, rating, answer_usi, loss) VALUES (?,?,?,?,?)", id, now, rating, answerUsi, loss);
    });
    // Flag the lapse that turns a card into a leech (and every LEECH_LAPSES after) so the UI can step in.
    const becameLeech = next.lapses > c.lapses && next.lapses % LEECH_LAPSES === 0;
    return { ...next, becameLeech };
  }

  /** Reviews per local day for the last `days` days, with the current and best streaks of days reviewed. */
  activity(days = 182, now = Date.now()) {
    const dayKey = (t: number) => {
      const d = new Date(t);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    const today = new Date(new Date(now).toDateString());
    const counts = new Map<string, { n: number; again: number }>();
    for (const r of this.lib.db.all<{ at: number; rating: string }>("SELECT at, rating FROM reviews ORDER BY at")) {
      const k = dayKey(r.at);
      const c = counts.get(k) ?? { n: 0, again: 0 };
      c.n++;
      if (r.rating === "again") c.again++;
      counts.set(k, c);
    }
    const out: { date: string; n: number; again: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      // Step by calendar day, not 24h, so DST changes don't skip or repeat a day.
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
      const k = dayKey(d.getTime());
      out.push({ date: k, ...(counts.get(k) ?? { n: 0, again: 0 }) });
    }
    // Best streak over all history; the current one may end yesterday if today has no reviews yet.
    const shift = (k: string, n: number) => {
      const [y, m, d] = k.split("-").map(Number);
      return dayKey(new Date(y, m - 1, d + n).getTime());
    };
    const keys = [...counts.keys()].sort();
    let best = 0;
    let run = 0;
    keys.forEach((k, i) => {
      run = i > 0 && shift(keys[i - 1], 1) === k ? run + 1 : 1;
      best = Math.max(best, run);
    });
    let streak = 0;
    let k = dayKey(today.getTime());
    if (!counts.has(k)) k = shift(k, -1);
    while (counts.has(k)) {
      streak++;
      k = shift(k, -1);
    }
    return { days: out, streak, best, total: keys.reduce((a, k) => a + counts.get(k)!.n, 0) };
  }

  /** A hand-made card: the position before `ply`; the answer is the engine's best move, else the game move. */
  /**
   * A card from the position before `ply`. `guess` replaces the game move with one the
   * user guessed in guess-the-move mode (and the engine's choice found there).
   */
  create(gameId: number, ply: number, note = "", guess?: { usi: string; loss: number | null; level: number; best?: string; pv?: string }) {
    const plies = this.lib.db.all<{ ply: number; usi: string; text: string; sfen: string; best_usi: string; pv: string; loss: number | null; level: number }>(
      "SELECT ply, usi, text, sfen, best_usi, pv, loss, level FROM plies WHERE game_id = ? AND ply IN (?, ?) ORDER BY ply",
      gameId,
      ply - 1,
      ply,
    );
    if (plies.length !== 2) throw new Error("no such move");
    const [prev, cur] = plies;
    if (guess) {
      const best = guess.best || prev.best_usi;
      Object.assign(cur, { usi: guess.usi, text: Library.moveText(prev.sfen, guess.usi), loss: guess.loss, level: guess.level });
      if (best) Object.assign(prev, { best_usi: best, pv: guess.best ? guess.pv || best : prev.pv });
    }
    const side = prev.sfen.split(" ")[1] === "w" ? "white" : "black";
    const best = prev.best_usi || cur.usi;
    this.lib.db.run(
      `INSERT INTO cards (game_id, ply, sfen, side, played_usi, played_text, best_usi, pv, loss, level, kind, phase, due_at, created_at, note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(game_id, ply) DO UPDATE SET note = excluded.note, suspended = 0`,
      gameId,
      ply,
      prev.sfen,
      side,
      cur.usi,
      cur.text,
      best,
      prev.best_usi ? prev.pv : cur.usi,
      cur.loss ?? 0,
      cur.level,
      guess ? "guess" : "manual",
      ply <= 30 ? "opening" : ply <= 80 ? "middlegame" : "endgame",
      Date.now(),
      Date.now(),
      note,
    );
    return this.lib.db.get<{ id: number }>("SELECT id FROM cards WHERE game_id = ? AND ply = ?", gameId, ply);
  }

  update(id: number, patch: { suspended?: boolean; note?: string }) {
    if (patch.suspended !== undefined) this.lib.db.run("UPDATE cards SET suspended = ? WHERE id = ?", patch.suspended ? 1 : 0, id);
    if (patch.note !== undefined) this.lib.db.run("UPDATE cards SET note = ? WHERE id = ?", patch.note, id);
  }

  delete(id: number) {
    this.lib.db.run("DELETE FROM cards WHERE id = ?", id);
  }

  /**
   * Anki import file: tab-separated with Anki's header lines, HTML fields.
   * Front = the position as a KIF board (BOD) and the question; Back = the answer and the engine line.
   */
  exportAnki(filter: CardFilter = {}): string {
    const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const field = (t: string) => t.replace(/\t/g, " ").replace(/\r?\n/g, "<br>");
    const lines = ["#separator:tab", "#html:true", "#notetype:Basic", "#tags column:3"];
    for (const c of this.list(filter)) {
      if (c.suspended) continue;
      const pos = Position.newBySFEN(c.sfen);
      if (!pos) continue;
      const who = c.side === "black" ? "☗先手" : "☖後手";
      const front =
        // Inline SVG board (Anki renders HTML fields), from the mover's side.
        `<div style="max-width:420px">${positionSvg(c.sfen, { flip: c.side === "white" }).replace("<svg ", '<svg style="width:100%;height:auto" ')}</div>` +
        `<div>${esc(who)}番 · ${esc(c.black)} vs ${esc(c.white)} ${esc(c.date ?? "")} · ${c.ply}手目</div>` +
        `<div><b>Find a better move than ${esc(c.playedText)}</b></div>`;
      const back =
        `<div><b>${esc(c.bestText)}</b></div>` +
        (c.pvText ? `<div>読み筋 ${esc(c.pvText)}</div>` : "") +
        `<div>In the game: ${esc(c.playedText)} (−${c.loss.toFixed(1)} pts)</div>` +
        (c.note ? `<div>Note: ${esc(c.note)}</div>` : "") +
        `<div style="color:#888;font-size:small">sfen ${esc(c.sfen)}</div>`;
      const tags = ["kifu-study", c.kind, c.phase, ...(c.strategy ? [c.strategy.replace(/\s+/g, "_")] : [])].join(" ");
      lines.push([field(front), field(back), tags].join("\t"));
    }
    return lines.join("\n") + "\n";
  }
}
