// Damaged and hostile kifu files must give an error result, never crash the import.
import { describe, expect, it } from "vitest";
import { RecordFileFormat } from "../src/core/recordFile.js";
import { Db } from "../src/server/db.js";
import { Library } from "../src/server/library.js";
import { makeKif, sjis, SHIKEN_VS_FUNA } from "./fixtures.js";
import { exportGame } from "../src/server/records.js";

let seed = 7;
const rand = (n: number) => ((seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) % n);

describe("import fuzzing", () => {
  it("survives mutated, truncated and junk files", () => {
    const lib = new Library(new Db(":memory:"));
    const base = Buffer.from(sjis(makeKif({ moves: SHIKEN_VS_FUNA, black: "a", white: "b", date: "2026/09/01" })));
    const utf8 = Buffer.from(makeKif({ moves: SHIKEN_VS_FUNA, black: "甲", white: "乙" }), "utf8");
    const statuses = new Map<string, number>();
    const N = Number(process.env.FUZZ_N ?? 400);
    for (let i = 0; i < N; i++) {
      const src = i % 2 ? base : utf8;
      let data: Buffer;
      switch (i % 5) {
        case 0: // flip random bytes
          data = Buffer.from(src);
          for (let k = 0; k < 1 + rand(20); k++) data[rand(data.length)] = rand(256);
          break;
        case 1: // truncate
          data = src.subarray(0, rand(src.length));
          break;
        case 2: // drop a random line
          data = Buffer.from(
            src
              .toString("latin1")
              .split("\n")
              .filter(() => rand(8) !== 0)
              .join("\n"),
            "latin1",
          );
          break;
        case 3: // random bytes
          data = Buffer.from(Array.from({ length: rand(3000) }, () => rand(256)));
          break;
        default: // duplicate a block of lines (repeated moves, headers)
          data = Buffer.concat([src, src.subarray(rand(src.length))]);
      }
      const ext = [".kif", ".kifu", ".ki2", ".csa", ".jkf", ".txt"][rand(6)];
      let status: string;
      try {
        status = lib.importBuffer(new Uint8Array(data), `fuzz${i}${ext}`).status;
      } catch (e) {
        throw new Error(`import threw on case ${i} (${ext}): ${e}`);
      }
      statuses.set(status, (statuses.get(status) ?? 0) + 1);
    }
    // Some survive as games, junk is rejected; nothing threw.
    expect(statuses.get("error")).toBeGreaterThan(0);
    expect((statuses.get("added") ?? 0) + (statuses.get("duplicate") ?? 0)).toBeGreaterThan(0);
    // Everything that was added can be opened and exported.
    for (const g of lib.listGames()) {
      expect(lib.getGame(g.id)).toBeTruthy();
      expect(exportGame(lib, g.id, RecordFileFormat.KIF)).toBeTruthy();
    }
  });
});

describe("notebook parser fuzzing", () => {
  it("never throws on odd directive text", async () => {
    const { parseNotebook } = await import("../src/renderer/notebook.js");
    const pieces = [":::shogi-view", "{game=", "1", " ply=", "}", "\n", ":::", ":kifu[", "]", "{start=", '"', "position startpos moves ", "7g7f", "# h", "<script>", "`", "\n\n"];
    for (let i = 0; i < 2000; i++) {
      const src = Array.from({ length: rand(40) }, () => pieces[rand(pieces.length)]).join("");
      const blocks = parseNotebook(src);
      for (const b of blocks) if (b.type === "md") expect(b.html).not.toContain("<script>");
    }
  });
});
