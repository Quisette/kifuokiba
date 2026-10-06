// Saved study boards: a start position and a move tree with comments, so the
// analysis on the study board can be kept, reopened by id and embedded in notes.
import { Position } from "tsshogi";
import { Db } from "./db.js";
import { MoveTree, emptyTree, pruneIllegal, treeFromJson } from "../core/movetree.js";

export type Study = { id: number; title: string; start_sfen: string; tree: MoveTree; game_id: number | null; created_at: number; updated_at: number };
type Row = Omit<Study, "tree"> & { tree: string };
export type StudyInput = { title?: string; start_sfen?: string; tree?: MoveTree; game_id?: number | null };

/** Keeps only what a tree may hold: legal moves, string comments of a sane length. */
const cleanTree = (tree: unknown, sfen: string): MoveTree => pruneIllegal(treeFromJson(tree), sfen);

export class Studies {
  constructor(private readonly db: Db) {}

  private present(r: Row): Study {
    let tree: MoveTree;
    try {
      tree = JSON.parse(r.tree) as MoveTree;
    } catch {
      tree = emptyTree();
    }
    return { ...r, tree };
  }

  list() {
    return this.db
      .all<Row>("SELECT * FROM studies ORDER BY updated_at DESC, id DESC")
      .map((r) => this.present(r))
      .map(({ tree, ...s }) => ({ ...s, moves: countMoves(tree) }));
  }

  get(id: number): Study | undefined {
    const r = this.db.get<Row>("SELECT * FROM studies WHERE id = ?", id);
    return r ? this.present(r) : undefined;
  }

  create(input: StudyInput): Study {
    const sfen = Position.newBySFEN(input.start_sfen ?? "")?.sfen;
    if (!sfen) throw new Error("bad start position");
    const now = Date.now();
    const gameId = input.game_id && this.db.get("SELECT 1 FROM games WHERE id = ?", input.game_id) ? input.game_id : null;
    const r = this.db.run(
      "INSERT INTO studies (title, start_sfen, tree, game_id, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      input.title?.trim() || "Study",
      sfen,
      JSON.stringify(cleanTree(input.tree, sfen)),
      gameId,
      now,
      now,
    );
    return this.get(Number(r.lastInsertRowid))!;
  }

  update(id: number, input: StudyInput): Study | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const sfen = input.start_sfen !== undefined ? Position.newBySFEN(input.start_sfen)?.sfen : cur.start_sfen;
    if (!sfen) throw new Error("bad start position");
    const tree = input.tree !== undefined ? cleanTree(input.tree, sfen) : sfen === cur.start_sfen ? cur.tree : emptyTree();
    this.db.run(
      "UPDATE studies SET title = ?, start_sfen = ?, tree = ?, game_id = ?, updated_at = ? WHERE id = ?",
      input.title !== undefined ? input.title.trim() || "Study" : cur.title,
      sfen,
      JSON.stringify(tree),
      input.game_id !== undefined ? input.game_id : cur.game_id,
      Date.now(),
      id,
    );
    return this.get(id);
  }

  delete(id: number) {
    this.db.run("DELETE FROM studies WHERE id = ?", id);
  }
}

export function countMoves(t: MoveTree): number {
  return t.children.reduce((n, c) => n + 1 + countMoves(c), 0);
}
