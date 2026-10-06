// What kind of move a move is, for "which moves do I get wrong" stats.
import { PieceType, Position } from "tsshogi";

export const MOVE_KINDS = ["drop", "capture", "check", "promotion", "king", "quiet"] as const;
export type MoveKind = (typeof MOVE_KINDS)[number];

/**
 * The kinds a move belongs to: a move can be several at once (a capture that
 * promotes and gives check). A move that is none of them is "quiet". Returns
 * null when the move doesn't apply to the position.
 */
export function moveKinds(prevSfen: string, usi: string): MoveKind[] | null {
  const pos = Position.newBySFEN(prevSfen);
  const m = pos?.createMoveByUSI(usi);
  if (!pos || !m || !pos.isValidMove(m)) return null;
  const kinds: MoveKind[] = [];
  if (usi.includes("*")) kinds.push("drop");
  if (m.capturedPieceType) kinds.push("capture");
  if (m.promote) kinds.push("promotion");
  if (m.pieceType === PieceType.KING) kinds.push("king");
  pos.doMove(m);
  if (pos.checked) kinds.push("check");
  return kinds.length ? kinds : ["quiet"];
}
