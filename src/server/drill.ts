// Drilling a saved study: the positions where one side is to move and the
// study says what to play, scheduled with SM-2 per position. History is keyed
// by the position, so editing the study keeps it for positions still there.
import { Position, formatMove } from "tsshogi";
import { Db, sfenKey } from "./db.js";
import { Studies } from "./studies.js";
import { MoveTree } from "../core/movetree.js";
import { newSm2State, reviewSm2 } from "../core/sm2.js";

export type DrillSide = "black" | "white";
export type DrillPosition = {
  sfen: string;
  key: string;
  depth: number;
  /** Child indexes from the study's root to this position, to open it on the board. */
  path: number[];
  lastMove: { prevSfen: string; usi: string } | null;
  accepted: { usi: string; text: string; main: boolean }[];
  /** The comment on the study's main move here, shown after answering. */
  comment: string;
  dueAt: number;
  isNew: boolean;
};
type Row = { sfen_key: string; repetitions: number; interval_days: number; ease: number; due_at: number; lapses: number };

/** Every position in the tree with `side` to move and at least one study move after it. */
export function drillPositionsOf(startSfen: string, tree: MoveTree, side: DrillSide) {
  const out: Omit<DrillPosition, "dueAt" | "isNew">[] = [];
  const seen = new Set<string>();
  const walk = (n: MoveTree, pos: Position, depth: number, path: number[], last: DrillPosition["lastMove"]) => {
    if (!n.children.length) return;
    const key = sfenKey(pos.sfen);
    if (pos.color === side && !seen.has(key)) {
      seen.add(key);
      const accepted = n.children.flatMap((c, i) => {
        const m = pos.createMoveByUSI(c.usi);
        return m ? [{ usi: c.usi, text: formatMove(pos, m), main: i === 0 }] : [];
      });
      out.push({ sfen: pos.sfen, key, depth, path, lastMove: last, accepted, comment: n.children[0].comment ?? "" });
    }
    n.children.forEach((c, i) => {
      const m = pos.createMoveByUSI(c.usi);
      if (!m || !pos.isValidMove(m)) return;
      const next = pos.clone();
      next.doMove(m);
      walk(c, next, depth + 1, [...path, i], { prevSfen: pos.sfen, usi: c.usi });
    });
  };
  const pos = Position.newBySFEN(startSfen);
  if (pos) walk(tree, pos, 0, [], null);
  return out;
}

export class Drill {
  constructor(
    private readonly db: Db,
    private readonly studies: Studies,
  ) {}

  positions(studyId: number, side: DrillSide, opts: { all?: boolean; now?: number } = {}) {
    const st = this.studies.get(studyId);
    if (!st) return null;
    const now = opts.now ?? Date.now();
    const rows = new Map(
      this.db.all<Row>("SELECT * FROM study_drill WHERE study_id = ? AND side = ?", studyId, side).map((r) => [r.sfen_key, r]),
    );
    const all = drillPositionsOf(st.start_sfen, st.tree, side).map((p) => {
      const r = rows.get(p.key);
      return { ...p, dueAt: r?.due_at ?? 0, isNew: !r };
    });
    const due = all.filter((p) => p.dueAt <= now);
    const list = (opts.all ? all : due).sort((a, b) => a.dueAt - b.dueAt || a.depth - b.depth);
    return { title: st.title, side, total: all.length, due: due.length, positions: list };
  }

  /** Checks an answer and reschedules the position. */
  answer(studyId: number, side: DrillSide, sfen: string, usi: string, now = Date.now()) {
    const st = this.studies.get(studyId);
    if (!st) return null;
    const key = sfenKey(sfen);
    const pos = drillPositionsOf(st.start_sfen, st.tree, side).find((p) => p.key === key);
    if (!pos) return null;
    const hit = pos.accepted.find((a) => a.usi === usi);
    const r = this.db.get<Row>("SELECT * FROM study_drill WHERE study_id = ? AND side = ? AND sfen_key = ?", studyId, side, key);
    const prev = r ? { repetitions: r.repetitions, intervalDays: r.interval_days, ease: r.ease, dueAt: r.due_at, lapses: r.lapses } : newSm2State(now);
    const next = reviewSm2(prev, hit ? "good" : "again", now);
    this.db.run(
      `INSERT INTO study_drill (study_id, side, sfen_key, repetitions, interval_days, ease, due_at, lapses, last_review_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(study_id, side, sfen_key) DO UPDATE SET repetitions = excluded.repetitions, interval_days = excluded.interval_days,
         ease = excluded.ease, due_at = excluded.due_at, lapses = excluded.lapses, last_review_at = excluded.last_review_at`,
      studyId, side, key, next.repetitions, next.intervalDays, next.ease, next.dueAt, next.lapses, now,
    );
    return { correct: !!hit, main: !!hit?.main, accepted: pos.accepted, comment: pos.comment, dueAt: next.dueAt };
  }

  /** Due positions per study and side, for studies that have been drilled at least once. */
  due(now = Date.now()) {
    const drilled = this.db.all<{ study_id: number; side: DrillSide }>("SELECT DISTINCT study_id, side FROM study_drill");
    return drilled
      .flatMap(({ study_id, side }) => {
        const p = this.positions(study_id, side, { now });
        return p ? [{ id: study_id, title: p.title, side, due: p.due, total: p.total }] : [];
      })
      .sort((a, b) => b.due - a.due);
  }
}
