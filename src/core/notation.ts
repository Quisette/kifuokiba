// Japanese move notation for USI moves and lines (tsshogi does the formatting).
import { Move, Position, formatMove, formatPV } from "tsshogi";

/** Japanese text for a USI move at a position, e.g. "☗７六歩"; the USI itself if it doesn't apply. */
export function moveText(sfen: string, usi: string): string {
  const pos = Position.newBySFEN(sfen);
  if (!pos) return usi;
  const m = pos.createMoveByUSI(usi);
  if (!m) return usi;
  return formatMove(pos, m); // already starts with ☗/☖
}

/** Japanese text for a space-separated USI line from a position, as far as it stays legal. */
export function pvText(sfen: string, pv: string): string {
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
