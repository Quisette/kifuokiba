// "What does the opponent threaten?": the same position with the other side to move.
import { Color, Position } from "tsshogi";

/**
 * The position after the side to move passes, or null when passing isn't
 * possible: the side to move is in check (its king would be taken).
 */
export function passedPosition(sfen: string): string | null {
  const pos = Position.newBySFEN(sfen);
  if (!pos || pos.checked) return null;
  pos.setColor(pos.color === Color.BLACK ? Color.WHITE : Color.BLACK);
  return pos.sfen;
}
