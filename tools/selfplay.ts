// Generate demo kifu by engine self-play from a few opening lines.
// Usage: npx tsx tools/selfplay.ts <engine> <outDir> [count]
// One side sometimes searches shallowly, so the games contain real mistakes.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Record, RecordMetadataKey, SpecialMoveType, exportKIF } from "tsshogi";
import { UsiEngine } from "../src/server/engine/usi.js";
import { encodeText } from "../src/core/encode.js";

const OPENINGS: { name: string; moves: string }[] = [
  { name: "四間飛車 vs 舟囲い", moves: "7g7f 3c3d 2g2f 4c4d 2f2e 2b3c 3i4h 8b4b 5i6h 5a6b 6h7h 6b7b 5g5f 7b8b 4i5h 7a7b" },
  { name: "居飛車 vs 四間 (black furi)", moves: "7g7f 3c3d 6g6f 8c8d 2h6h 8d8e 8h7g 7a6b 5i4h 5a4b 4h3h 4b3b 3h2h 6a5b 3i3h" },
  { name: "中飛車", moves: "5g5f 8c8d 2h5h 8d8e 7g7f 3c3d 5f5e 7a6b 5i4h 5a4b 4h3h 4b3b 3h2h" },
  { name: "相掛かり", moves: "2g2f 8c8d 2f2e 8d8e 6i7h 4a3b 2e2d 2c2d 2h2d 8e8f 8g8f 8b8f" },
  { name: "矢倉", moves: "7g7f 8c8d 6g6f 3c3d 6i7h 6a5b 5g5f 5a4b 3i4h 7a6b 5i6i 4b3b 4i5h 5c5d" },
  { name: "三間飛車", moves: "7g7f 3c3d 7f7e 8c8d 2h7h 8d8e 5i4h 5a4b 4h3h 4b3b 3h2h 7a6b 3i3h" },
];
const OPPONENTS = ["tsubame_7", "hayate88", "金沢 圭", "mikan_dojo", "shirokuma", "森下 遼"];

async function main() {
  const [enginePath, outDir, countArg] = process.argv.slice(2);
  const count = Number(countArg ?? 12);
  mkdirSync(outDir, { recursive: true });
  const engine = new UsiEngine(enginePath, { USI_Hash: 64, BookFile: "no_book", Threads: 1 });
  engineRef = engine;
  await engine.start();
  for (let g = 0; g < count; g++) {
    const op = OPENINGS[g % OPENINGS.length];
    const moves = op.moves.split(" ");
    const qIsBlack = g % 2 === 0;
    // Each side gets a depth; the weaker one blunders now and then.
    const depth = { black: 6 + (g % 3), white: 6 + ((g + 1) % 3) };
    let result: SpecialMoveType = SpecialMoveType.MAX_MOVES;
    while (moves.length < 220) {
      const side = moves.length % 2 === 0 ? "black" : "white";
      const sloppy = (g * 7 + moves.length * 13) % 29 === 0;
      const r = await engine.search(`startpos moves ${moves.join(" ")}`, { depth: sloppy ? 1 : depth[side] });
      if (r.bestmove === "resign") {
        result = SpecialMoveType.RESIGN;
        break;
      }
      if (r.bestmove === "win") {
        result = SpecialMoveType.ENTERING_OF_KING;
        break;
      }
      moves.push(r.bestmove);
    }
    const rec = Record.newByUSI("position startpos moves " + moves.join(" "));
    if (rec instanceof Error) throw rec;
    const opp = OPPONENTS[g % OPPONENTS.length];
    rec.metadata.setStandardMetadata(RecordMetadataKey.BLACK_NAME, qIsBlack ? "Q 三段" : `${opp} 二段`);
    rec.metadata.setStandardMetadata(RecordMetadataKey.WHITE_NAME, qIsBlack ? `${opp} 二段` : "Q 三段");
    const day = String(1 + g * 2).padStart(2, "0");
    rec.metadata.setStandardMetadata(RecordMetadataKey.START_DATETIME, `2026/09/${day} 21:${String(10 + g).padStart(2, "0")}:00`);
    rec.metadata.setStandardMetadata(RecordMetadataKey.TOURNAMENT, g % 3 === 0 ? "将棋ウォーズ(10分切れ負け)" : "81Dojo");
    rec.goto(Number.MAX_SAFE_INTEGER);
    rec.append(result);
    const kif = exportKIF(rec, { returnCode: "\r\n" });
    const file = path.join(outDir, `game${String(g + 1).padStart(2, "0")}.kif`);
    writeFileSync(file, encodeText(kif, "SJIS"));
    console.log(file, moves.length, result, op.name);
  }
  await engine.quit();
}

let engineRef: UsiEngine | null = null;
main().catch((e) => {
  console.error(engineRef?.log.slice(-8).join("\n"));
  console.error(e);
  process.exit(1);
});
