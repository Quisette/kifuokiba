import {
  Color,
  ImmutableRecord,
  Move,
  RecordMetadataKey,
  SpecialMoveType,
  isKnownSpecialMove,
} from "tsshogi";
import { parseComment } from "./comment.js";

export type GameResult = "black" | "white" | "draw" | "unknown";

export type PlyInfo = {
  ply: number; // 1-based; the move that produced `sfen`
  usi: string;
  text: string; // ☗７六歩 style
  sfen: string; // position after the move
  comment: string;
  elapsedMs: number;
  /** Evaluation found in the file's comments (black's view). */
  importedScore?: number;
  importedMate?: number;
};

export type GameSummary = {
  blackName: string;
  whiteName: string;
  date: string; // ISO-ish "YYYY-MM-DD HH:MM" or ""
  event: string;
  timeControl: string;
  source: string;
  strategyHeader: string; // 戦型 header from the file, if any
  result: GameResult;
  endReason: string; // e.g. "resign", "timeout"
  initialSfen: string;
  moveCount: number;
  plies: PlyInfo[];
  /** Normalised main line: initial SFEN + USI moves. Basis for dedup. */
  canonical: string;
};

const losingForSideToMove = new Set<string>([
  SpecialMoveType.RESIGN,
  SpecialMoveType.MATE,
  SpecialMoveType.TIMEOUT,
  SpecialMoveType.FOUL_LOSE,
  SpecialMoveType.LOSE_BY_DEFAULT,
]);
const winningForSideToMove = new Set<string>([
  SpecialMoveType.FOUL_WIN,
  SpecialMoveType.ENTERING_OF_KING,
  SpecialMoveType.WIN_BY_DEFAULT,
  SpecialMoveType.TRY,
]);
const drawn = new Set<string>([
  SpecialMoveType.DRAW,
  SpecialMoveType.REPETITION_DRAW,
  SpecialMoveType.IMPASS,
  SpecialMoveType.MAX_MOVES,
]);

/** Strip rank suffixes like "三段" / "(1500)" that Wars and 81Dojo append. */
export function normalizePlayerName(name: string): string {
  return name
    .replace(/[\s　]+(?:[一二三四五六七八九十]+[段級]|初段|名人|竜王|\d+[段級])$/u, "")
    .replace(/\s*\(\d+\)$/, "")
    .trim();
}

export function normalizeDate(text: string): string {
  const m = /(\d{4})[/\-年](\d{1,2})[/\-月](\d{1,2})日?(?:\s*\(.\))?\s*(\d{1,2}:\d{2})?/.exec(text);
  if (!m) {
    return "";
  }
  const pad = (s: string) => s.padStart(2, "0");
  return `${m[1]}-${pad(m[2])}-${pad(m[3])}` + (m[4] ? ` ${m[4].padStart(5, "0")}` : "");
}

function detectSource(event: string, title: string, raw: string): string {
  const all = `${event} ${title} ${raw}`;
  if (/ウォーズ|shogiwars/i.test(all)) return "wars";
  if (/81dojo|81道場/i.test(all)) return "81dojo";
  if (/lishogi/i.test(all)) return "lishogi";
  if (/floodgate/i.test(all)) return "floodgate";
  if (/将棋倶楽部24|shogidojo/i.test(all)) return "24";
  return "file";
}

function detectTimeControl(record: ImmutableRecord, event: string): string {
  const m = record.metadata;
  const limit = m.getStandardMetadata(RecordMetadataKey.TIME_LIMIT) ?? "";
  const byoyomi = m.getStandardMetadata(RecordMetadataKey.BYOYOMI) ?? "";
  if (limit || byoyomi) {
    return [limit, byoyomi && `秒読み${byoyomi}`].filter(Boolean).join(" ");
  }
  // 将棋ウォーズ(10分切れ負け) → 10分切れ負け
  const paren = /[（(]([^)）]*(?:分|秒)[^)）]*)[)）]/.exec(event);
  return paren ? paren[1] : "";
}

export function summarizeRecord(record: ImmutableRecord, rawText = ""): GameSummary {
  const meta = record.metadata;
  const get = (k: RecordMetadataKey) => meta.getStandardMetadata(k) ?? "";
  const blackName = get(RecordMetadataKey.BLACK_NAME) || get(RecordMetadataKey.SHITATE_NAME);
  const whiteName = get(RecordMetadataKey.WHITE_NAME) || get(RecordMetadataKey.UWATE_NAME);
  const event = get(RecordMetadataKey.TOURNAMENT);
  const title = get(RecordMetadataKey.TITLE);
  const date = normalizeDate(
    get(RecordMetadataKey.START_DATETIME) || get(RecordMetadataKey.DATE) || get(RecordMetadataKey.END_DATETIME),
  );

  const plies: PlyInfo[] = [];
  let result: GameResult = "unknown";
  let endReason = "";
  // Walk the main line (first branch at every fork).
  let node = record.first.next;
  let ply = 0;
  while (node) {
    const move = node.move;
    if (move instanceof Move) {
      ply++;
      const data = parseComment(node.comment);
      const info = data.researchInfo ?? data.playerSearchInfo;
      plies.push({
        ply,
        usi: move.usi,
        text: node.displayText,
        sfen: node.sfen,
        comment: node.comment,
        elapsedMs: node.elapsedMs,
        importedScore: info?.score,
        importedMate: info?.mate,
      });
    } else {
      // Special move: the side to move is the one whose turn it is after `ply` moves.
      const sideToMove: Color = record.initialPosition.color === Color.BLACK
        ? (ply % 2 === 0 ? Color.BLACK : Color.WHITE)
        : (ply % 2 === 0 ? Color.WHITE : Color.BLACK);
      const other = sideToMove === Color.BLACK ? "white" : "black";
      const self = sideToMove === Color.BLACK ? "black" : "white";
      if (isKnownSpecialMove(move)) {
        endReason = move.type;
        if (losingForSideToMove.has(move.type)) result = other;
        else if (winningForSideToMove.has(move.type)) result = self;
        else if (drawn.has(move.type)) result = "draw";
      } else {
        endReason = move.name;
      }
      break;
    }
    node = node.next;
  }

  const initialSfen = record.initialPosition.sfen;
  return {
    blackName,
    whiteName,
    date,
    event,
    timeControl: detectTimeControl(record, event),
    source: detectSource(event, title, rawText.slice(0, 2000)),
    strategyHeader: get(RecordMetadataKey.STRATEGY),
    result,
    endReason,
    initialSfen,
    moveCount: plies.length,
    plies,
    canonical: `${initialSfen}|${plies.map((p) => p.usi).join(" ")}`,
  };
}
