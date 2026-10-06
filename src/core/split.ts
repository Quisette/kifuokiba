// Cut text holding several kifu into one string per record.
const KIF_HEADER = /^(#KIF|(開始日時|終了日時|対局日|棋戦|戦型|手合割|先手|後手|下手|上手|場所|持ち時間|表題|作者|発売日|出典)[：:])/;
// A numbered KIF move line, or a KI2 move.
const KIF_MOVE = /^\s*\d+\s+\S/;
const KI2_MOVE = /^\s*[▲△☗☖]/;
const VARIATION = /^変化[：:]/;
const USI_LINE = /^(position\s|sfen\s|startpos\b|[1-9lnsgkrbpLNSGKRBP+/]{17,}\s+[bw]\s)/;
const CSA_MOVE = /^[+-]\d{4}[A-Z]{2}|^%/;

export function splitRecords(text: string): string[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const nonEmpty = lines.map((l) => l.trim()).filter(Boolean);
  if (!nonEmpty.length) return [];

  // One USI/SFEN position per line.
  if (nonEmpty.length > 1 && nonEmpty.every((l) => USI_LINE.test(l))) return nonEmpty;

  // CSA: "/" separates records; a new version line after moves also starts one.
  if (nonEmpty.some((l) => CSA_MOVE.test(l)) && nonEmpty.some((l) => /^(V2|PI|P1|N[+-])/.test(l))) {
    const out: string[][] = [[]];
    let moves = false;
    for (const l of lines) {
      const t = l.trim();
      if (t === "/") {
        out.push([]);
        moves = false;
        continue;
      }
      if (/^V\d/.test(t) && moves) {
        out.push([]);
        moves = false;
      }
      if (CSA_MOVE.test(t)) moves = true;
      out[out.length - 1].push(l);
    }
    return clean(out);
  }

  // KIF / KI2: a header after moves starts the next record (but 変化 belong to their game).
  const out: string[][] = [[]];
  let moves = false;
  for (const l of lines) {
    const t = l.trim();
    if (VARIATION.test(t)) {
      out[out.length - 1].push(l);
      continue;
    }
    if (moves && KIF_HEADER.test(t)) {
      out.push([]);
      moves = false;
    }
    if (KIF_MOVE.test(l) || KI2_MOVE.test(l)) moves = true;
    out[out.length - 1].push(l);
  }
  return clean(out);
}

function clean(parts: string[][]): string[] {
  return parts.map((p) => p.join("\n").trim()).filter(Boolean);
}
