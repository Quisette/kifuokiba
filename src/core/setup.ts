// What's wrong with a position someone set up by hand, if anything.
import { Color, PieceType, Position, Square, countNotExistingPieces } from "tsshogi";

const FULL_SET: Partial<Record<PieceType, number>> = {
  [PieceType.KING]: 2,
  [PieceType.ROOK]: 2,
  [PieceType.BISHOP]: 2,
  [PieceType.GOLD]: 4,
  [PieceType.SILVER]: 4,
  [PieceType.KNIGHT]: 4,
  [PieceType.LANCE]: 4,
  [PieceType.PAWN]: 18,
};
const NAMES: Partial<Record<PieceType, string>> = {
  [PieceType.KING]: "玉",
  [PieceType.ROOK]: "飛",
  [PieceType.BISHOP]: "角",
  [PieceType.GOLD]: "金",
  [PieceType.SILVER]: "銀",
  [PieceType.KNIGHT]: "桂",
  [PieceType.LANCE]: "香",
  [PieceType.PAWN]: "歩",
};
const side = (c: Color) => (c === Color.BLACK ? "☗" : "☖");

/** Problems that make the position unplayable; empty when it's fine. */
export function setupProblems(sfen: string): string[] {
  const pos = Position.newBySFEN(sfen);
  if (!pos) return ["Not a valid position."];
  const out: string[] = [];
  const kings = { [Color.BLACK]: 0, [Color.WHITE]: 0 };
  const pawnFiles = { [Color.BLACK]: new Set<number>(), [Color.WHITE]: new Set<number>() };
  for (const sq of Square.all) {
    const p = pos.board.at(sq);
    if (!p) continue;
    if (p.type === PieceType.KING) kings[p.color]++;
    // Ranks counted from the piece owner's far side: 1 is the last rank.
    const rank = p.color === Color.BLACK ? sq.rank : 10 - sq.rank;
    if ((p.type === PieceType.PAWN || p.type === PieceType.LANCE) && rank === 1) out.push(`${side(p.color)}${NAMES[p.type]} on ${sq.file}${sq.rank} can never move.`);
    if (p.type === PieceType.KNIGHT && rank <= 2) out.push(`${side(p.color)}桂 on ${sq.file}${sq.rank} can never move.`);
    if (p.type === PieceType.PAWN) {
      if (pawnFiles[p.color].has(sq.file)) out.push(`${side(p.color)} has two pawns on file ${sq.file} (二歩).`);
      pawnFiles[p.color].add(sq.file);
    }
  }
  for (const c of [Color.BLACK, Color.WHITE]) if (kings[c] > 1) out.push(`${side(c)} has more than one king.`);
  if (!kings[Color.BLACK] && !kings[Color.WHITE]) out.push("There is no king on the board.");
  // Promoted pieces count as their unpromoted kind; below zero means too many.
  const missing = countNotExistingPieces(pos);
  for (const [type, max] of Object.entries(FULL_SET) as [PieceType, number][]) {
    if (missing[type] < 0) out.push(`There are ${max - missing[type]} ${NAMES[type]}; a set has ${max}.`);
  }
  // The side that just moved can't have left its king in check.
  const waiting = pos.color === Color.BLACK ? Color.WHITE : Color.BLACK;
  if (kings[waiting] === 1 && pos.board.isChecked(waiting)) out.push(`${side(waiting)}'s king is in check but it is ${side(pos.color)} to move.`);
  return [...new Set(out)];
}
