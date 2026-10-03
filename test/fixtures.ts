// Test games built from USI move lists so the fixtures are always legal.
import { Record, RecordMetadataKey, SpecialMoveType, exportKIF } from "tsshogi";
import { encodeText } from "../src/core/encode.js";

export const SHIKEN_VS_FUNA =
  "7g7f 3c3d 2g2f 4c4d 2f2e 2b3c 3i4h 8b4b 5i6h 5a6b 6h7h 6b7b 5g5f 7b8b 4i5h 7a7b 1g1f 1c1d 3g3f 4a5b 4h3g 9c9d 9g9f 6a5a";

// A short game where white blunders a rook at ply 12 (△同飛?? style hanging piece).
export const KAKUGAWARI =
  "7g7f 8c8d 2g2f 3c3d 8h2b+ 3a2b 7i8h 2b3c 2f2e 8d8e 3i4h 7a7b";

export function makeKif(opts: {
  moves: string;
  black: string;
  white: string;
  date?: string;
  event?: string;
  end?: SpecialMoveType;
  comments?: { [ply: number]: string };
}): string {
  const r = Record.newByUSI("position startpos moves " + opts.moves);
  if (r instanceof Error) throw r;
  r.metadata.setStandardMetadata(RecordMetadataKey.BLACK_NAME, opts.black);
  r.metadata.setStandardMetadata(RecordMetadataKey.WHITE_NAME, opts.white);
  if (opts.date) r.metadata.setStandardMetadata(RecordMetadataKey.START_DATETIME, opts.date);
  if (opts.event) r.metadata.setStandardMetadata(RecordMetadataKey.TOURNAMENT, opts.event);
  r.goto(Number.MAX_SAFE_INTEGER);
  r.append(opts.end ?? SpecialMoveType.RESIGN);
  if (opts.comments) {
    for (const [ply, c] of Object.entries(opts.comments)) {
      r.goto(Number(ply));
      r.current.comment = c;
    }
  }
  return exportKIF(r, { returnCode: "\r\n" });
}

export function sjis(text: string): Uint8Array {
  return encodeText(text, "SJIS");
}
