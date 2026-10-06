// A game's tsshogi Record, rebuilt from the stored KIF: its 変化, merging study
// lines into it, and exporting it with comments and ShogiHome-style eval notes.
import { Move, Position, Record, formatPV } from "tsshogi";
import { Library } from "./library.js";
import { importRecordFromText, exportRecordAsBuffer, RecordFileFormat } from "../core/recordFile.js";
import { MoveTree, mergeTreeIntoRecord } from "../core/movetree.js";
import { mistakeLabels } from "../core/grading.js";
import { getSituationText } from "../core/score.js";
import { SCORE_MATE_INFINITE } from "../core/usi.js";

/**
 * Variations stored in the original file (変化), branching off the main line:
 * at main-line ply k, an alternative to move k with its continuation.
 */
export function branches(lib: Library, id: number): { ply: number; usis: string[]; texts: string[]; comment: string }[] {
  const row = lib.db.get<{ original_text: string }>("SELECT original_text FROM games WHERE id = ?", id);
  if (!row) return [];
  const record = importRecordFromText(row.original_text);
  if (record instanceof Error) return [];
  const out: { ply: number; usis: string[]; texts: string[]; comment: string }[] = [];
  // record.moves is the main line (first branch everywhere after import).
  for (const node of record.moves) {
    if (!node.hasBranch || !node.isFirstBranch) continue;
    for (let alt = node.branch; alt; alt = alt.branch) {
      const usis: string[] = [];
      const texts: string[] = [];
      let comment = "";
      for (let n: typeof alt | null = alt; n && n.move instanceof Move; n = n.next) {
        usis.push(n.move.usi);
        texts.push(n.displayText);
        if (!comment && n.comment) comment = n.comment.trim();
      }
      if (usis.length) out.push({ ply: alt.ply, usis, texts, comment });
    }
  }
  return out;
}

/**
 * Adds the lines of a move tree (from the game's start position) to the game's
 * stored record as 変化. The main line, plies, analysis and hash don't change.
 * Returns how many branches the game has afterwards, or null for no such game.
 */
export function mergeVariations(lib: Library, id: number, tree: MoveTree): number | null {
  const row = lib.db.get<{ original_text: string }>("SELECT original_text FROM games WHERE id = ?", id);
  if (!row) return null;
  const record = importRecordFromText(row.original_text);
  if (record instanceof Error) throw record;
  mergeTreeIntoRecord(record, tree);
  const kif = exportRecordAsBuffer(record, RecordFileFormat.KIF, { utf8: true, returnCode: "\n" }).text;
  lib.db.tx(() => {
    lib.db.run("UPDATE games SET original_text = ?, updated_at = ? WHERE id = ?", kif, Date.now(), id);
    // Main-line comments live in plies (the game view and exports read them there); fill only empty ones.
    for (const node of record.moves) {
      if (node.comment.trim()) lib.db.run("UPDATE plies SET comment = ? WHERE game_id = ? AND ply = ? AND comment = ''", node.comment.trim(), id, node.ply);
    }
  });
  return branches(lib, id).length;
}

/** Rebuild the record with current comments plus analysis in ShogiHome's comment format. */
export function buildRecord(lib: Library, id: number, opts: { withAnalysis?: boolean; engineName?: string } = {}): Record | undefined {
  const game = lib.db.get<{ original_text: string; analysis_engine: string }>(
    "SELECT original_text, analysis_engine FROM games WHERE id = ?",
    id,
  );
  if (!game) return undefined;
  const record = importRecordFromText(game.original_text);
  if (record instanceof Error) return undefined;
  const plies = lib.db.all<{ ply: number; comment: string; score: number | null; mate: number | null; pv: string; level: number; eval_source: string }>(
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

export function exportGame(lib: Library, id: number, format: RecordFileFormat, utf8 = false) {
  const record = buildRecord(lib, id);
  if (!record) return undefined;
  return exportRecordAsBuffer(record, format, { utf8 });
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
