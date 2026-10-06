// A move tree for the study board. The first child of each node is the main
// line. Its text form is PGN-like: "7g7f 3c3d (8c8d 2g2f) 2g2f", where a
// bracketed group is an alternative to the move just before it.
import { ImmutableNode, Move, Position, Record } from "tsshogi";

export type MoveTree = { usi: string; children: MoveTree[] };

export const emptyTree = (): MoveTree => ({ usi: "", children: [] });

export function lineTree(usis: string[]): MoveTree {
  const root = emptyTree();
  addLine(root, usis);
  return root;
}

/** Adds a line from the root, following moves already there. Returns its path of child indexes. */
export function addLine(root: MoveTree, usis: string[]): number[] {
  let n = root;
  const path: number[] = [];
  for (const u of usis) {
    let i = n.children.findIndex((c) => c.usi === u);
    if (i < 0) i = n.children.push({ usi: u, children: [] }) - 1;
    path.push(i);
    n = n.children[i];
  }
  return path;
}

/** Parses the text form. Throws on unbalanced brackets. */
export function parseTree(text: string): MoveTree {
  const tokens = text.replace(/[()]/g, " $& ").split(/[\s,]+/).filter(Boolean);
  let i = 0;
  // Reads a sequence of moves (with their alternatives) hanging from `parent`.
  const seq = (parent: MoveTree) => {
    let cur = parent;
    let prev: MoveTree | null = null; // parent of the last move, where its alternatives go
    while (i < tokens.length) {
      const t = tokens[i];
      if (t === ")") return;
      i++;
      if (t === "(") {
        if (!prev) throw new Error("a variation must follow a move");
        seq(prev);
        if (tokens[i++] !== ")") throw new Error("unclosed variation");
        continue;
      }
      const node = { usi: t, children: [] };
      cur.children.push(node);
      prev = cur;
      cur = node;
    }
  };
  const root = emptyTree();
  seq(root);
  if (i < tokens.length) throw new Error("unexpected )");
  return root;
}

export function formatTree(root: MoveTree): string {
  const out: string[] = [];
  const seq = (n: MoveTree) => {
    let cur = n;
    while (cur.children.length) {
      const [main, ...alts] = cur.children;
      out.push(main.usi);
      for (const a of alts) {
        out.push("(" + a.usi);
        seq(a);
        out[out.length - 1] += ")";
      }
      cur = main;
    }
  };
  seq(root);
  return out.join(" ");
}

export const hasVariations = (n: MoveTree): boolean => n.children.length > 1 || n.children.some(hasVariations);

/**
 * The nodes along a selection: `path[d]` picks the child at depth d, and the
 * line continues along first children once the path runs out. Index 0 is the root.
 */
export function selectedLine(root: MoveTree, path: number[]): { node: MoveTree; index: number }[] {
  const out = [{ node: root, index: 0 }];
  let n = root;
  for (let d = 0; n.children.length; d++) {
    const idx = Math.min(path[d] ?? 0, n.children.length - 1);
    n = n.children[idx];
    out.push({ node: n, index: idx });
  }
  return out;
}

/** Drops moves that are illegal in their position, with everything after them. */
export function pruneIllegal(root: MoveTree, initialSfen: string): MoveTree {
  const walk = (n: MoveTree, pos: Position): MoveTree => ({
    usi: n.usi,
    children: n.children.flatMap((c) => {
      const m = pos.createMoveByUSI(c.usi);
      if (!m || !pos.isValidMove(m)) return [];
      const p = pos.clone();
      p.doMove(m);
      return [walk(c, p)];
    }),
  });
  const pos = Position.newBySFEN(initialSfen);
  return pos ? walk(root, pos) : emptyTree();
}

/** The tree of a record's moves, branches included. */
export function recordToTree(record: Record): MoveTree {
  const root = emptyTree();
  const add = (parent: MoveTree, first: ImmutableNode | null) => {
    for (let alt = first; alt; alt = alt.branch) {
      if (!(alt.move instanceof Move)) continue;
      const node = { usi: alt.move.usi, children: [] };
      parent.children.push(node);
      add(node, alt.next);
    }
  };
  add(root, record.first.next);
  return root;
}

/**
 * Adds every line of the tree to the record. Moves the record already has are
 * followed, new ones become branches after the existing ones, so the record's
 * main line stays its main line. Illegal moves are skipped with what follows.
 */
export function mergeTreeIntoRecord(record: Record, root: MoveTree): void {
  const walk = (at: ImmutableNode, n: MoveTree) => {
    for (const c of n.children) {
      record.gotoNode(at);
      const m = record.position.createMoveByUSI(c.usi);
      if (!m || !record.position.isValidMove(m) || !record.append(m)) continue;
      walk(record.current, c);
    }
  };
  walk(record.first, root);
  record.resetAllBranchSelection();
  record.goto(0);
}

export function treeToRecord(initialSfen: string, root: MoveTree): Record {
  const pos = Position.newBySFEN(initialSfen);
  if (!pos) throw new Error("bad sfen");
  const record = new Record(pos);
  mergeTreeIntoRecord(record, root);
  return record;
}
