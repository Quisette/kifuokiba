// Tsume collections: mate problems imported from files, solved on the puzzle page.
// Accepted: a tsume KIF/KI2/CSA/JKF file (start position plus the answer as the
// main line), SFEN lines with optional answer moves in USI ("<sfen> moves 2c2b+ …"),
// or JSON / NDJSON objects with an sfen and an answer. The NDJSON and SFEN forms
// cover what shogimap-crawler produces.
import { Move, Position, RecordMetadataKey } from "tsshogi";
import { importRecordFromText } from "../core/recordFile.js";
import { Library } from "./library.js";
import { moveText } from "../core/notation.js";

export type TsumeProblem = { sfen: string; answer: string[]; title: string };
export type TsumeRow = {
  id: number;
  collection: string;
  title: string;
  sfen: string;
  answer: string;
  mate_len: number;
  attempts: number;
  solved: number;
  last_at: number | null;
  last_result: string;
};

const SFEN_LINE = /^(?:position\s+)?(?:sfen\s+)?([1-9lnsgkrbpLNSGKRBP+/]+\s+[bw]\s+\S+)(?:\s+\d+)?(?:\s+moves)?((?:\s+\S+)*)\s*$/;

/** The answer moves that are legal from the position, stopping at the first that isn't. */
function legalLine(sfen: string, usis: string[]): string[] | null {
  const pos = Position.newBySFEN(sfen);
  if (!pos) return null;
  const out: string[] = [];
  for (const u of usis) {
    const m = pos.createMoveByUSI(u);
    if (!m || !pos.doMove(m)) break;
    out.push(u);
  }
  return out;
}

function fromObject(o: Record<string, unknown>, n: number): TsumeProblem | null {
  const raw = String(o.sfen ?? o.position ?? "").replace(/^(position\s+)?sfen\s+/, "");
  const m = SFEN_LINE.exec(raw);
  if (!m) return null;
  const sfen = Position.newBySFEN(m[1].trim() + " 1")?.sfen;
  if (!sfen) return null;
  const ans = o.answer ?? o.moves ?? o.solution ?? o.usi ?? m[2] ?? "";
  const usis = (Array.isArray(ans) ? ans.map(String) : String(ans).split(/[\s,]+/)).filter(Boolean);
  const title = String(o.title ?? o.name ?? o.id ?? `#${n}`);
  return { sfen, answer: legalLine(sfen, usis) ?? [], title };
}

export function parseTsume(text: string, fileName = ""): { problems: TsumeProblem[]; skipped: number } {
  const body = text.replace(/^﻿/, "").trim();
  const base = fileName.replace(/\.[^.]+$/, "");
  const problems: TsumeProblem[] = [];
  let skipped = 0;

  // JSON array, or one JSON object per line.
  if (body.startsWith("[") || body.startsWith("{")) {
    let items: unknown[] = [];
    try {
      const v = JSON.parse(body);
      items = Array.isArray(v) ? v : [v];
    } catch {
      items = body.split(/\r?\n/).filter((l) => l.trim()).map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      });
    }
    items.forEach((o, i) => {
      const p = o && typeof o === "object" ? fromObject(o as Record<string, unknown>, i + 1) : null;
      if (p) problems.push(p);
      else skipped++;
    });
    return { problems, skipped };
  }

  // SFEN lines (blank lines and # comments ignored).
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (lines.length && lines.every((l) => SFEN_LINE.test(l))) {
    lines.forEach((l, i) => {
      const p = fromObject({ sfen: l, title: `${base || "Problem"} ${i + 1}` }, i + 1);
      if (p) problems.push(p);
      else skipped++;
    });
    return { problems, skipped };
  }

  // A kifu file: the start position and its main line as the answer.
  const r = importRecordFromText(body);
  if (r instanceof Error) return { problems, skipped: 1 };
  const answer: string[] = [];
  for (const node of r.moves) if (node.move instanceof Move) answer.push(node.move.usi);
  const title = r.metadata.getStandardMetadata(RecordMetadataKey.TITLE) || base || "Problem";
  problems.push({ sfen: r.initialPosition.sfen, answer, title });
  return { problems, skipped };
}

export class Tsume {
  constructor(private readonly lib: Library) {}

  import(text: string, collection: string, fileName = "") {
    const { problems, skipped } = parseTsume(text, fileName);
    const name = collection.trim() || fileName.replace(/\.[^.]+$/, "") || "My problems";
    let added = 0;
    this.lib.db.tx(() => {
      for (const p of problems) {
        const r = this.lib.db.run(
          `INSERT OR IGNORE INTO tsume (collection, title, sfen, answer, mate_len, created_at) VALUES (?,?,?,?,?,?)`,
          name,
          p.title,
          p.sfen,
          p.answer.join(" "),
          p.answer.length,
          Date.now(),
        );
        if (Number(r.changes)) added++;
      }
    });
    return { collection: name, found: problems.length, added, duplicates: problems.length - added, skipped };
  }

  collections() {
    return this.lib.db.all<{ collection: string; problems: number; solved: number; tried: number }>(
      `SELECT collection, COUNT(*) problems, SUM(CASE WHEN last_result = 'solved' THEN 1 ELSE 0 END) solved,
              SUM(CASE WHEN attempts > 0 THEN 1 ELSE 0 END) tried
       FROM tsume GROUP BY collection ORDER BY MAX(created_at) DESC`,
    );
  }

  /** Problems of a collection: unsolved and failed first, in import order. */
  list(collection: string) {
    return this.lib.db
      .all<TsumeRow>(
        `SELECT * FROM tsume WHERE collection = ?
         ORDER BY CASE last_result WHEN 'failed' THEN 0 WHEN '' THEN 1 ELSE 2 END, id`,
        collection,
      )
      .map((t) => ({ ...t, firstText: t.answer ? moveText(t.sfen, t.answer.split(" ")[0]) : "" }));
  }

  get(id: number) {
    return this.lib.db.get<TsumeRow>("SELECT * FROM tsume WHERE id = ?", id);
  }

  record(id: number, solved: boolean) {
    this.lib.db.run(
      `UPDATE tsume SET attempts = attempts + 1, solved = solved + ?, last_at = ?, last_result = ? WHERE id = ?`,
      solved ? 1 : 0,
      Date.now(),
      solved ? "solved" : "failed",
      id,
    );
    return this.get(id);
  }

  deleteCollection(collection: string) {
    return { deleted: Number(this.lib.db.run("DELETE FROM tsume WHERE collection = ?", collection).changes) };
  }
}
