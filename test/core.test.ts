import { describe, expect, it } from "vitest";
import { importRecordFromBuffer, importRecordFromText } from "../src/core/recordFile.js";
import { summarizeRecord, normalizePlayerName, normalizeDate } from "../src/core/summarize.js";
import { classify, strategyLabel, styleMatchup } from "../src/core/classifier/index.js";
import { gradeMoves, accuracy } from "../src/core/grading.js";
import { reviewSm2, newSm2State } from "../src/core/sm2.js";
import { Record } from "tsshogi";
import { makeKif, sjis, SHIKEN_VS_FUNA } from "./fixtures.js";

describe("import", () => {
  it("reads a Shift_JIS KIF with a Shogi Wars header", () => {
    const kif = makeKif({ moves: SHIKEN_VS_FUNA, black: "me 三段", white: "rival 二段", date: "2026/09/01 21:05:00", event: "将棋ウォーズ(10分切れ負け)" });
    const r = importRecordFromBuffer(sjis(kif), "game.kif");
    expect(r).toBeInstanceOf(Record);
    const s = summarizeRecord(r as Record, kif);
    expect(s.moveCount).toBe(24);
    expect(s.result).toBe("white"); // black resigns after an even number of moves → black to move resigns
    expect(s.source).toBe("wars");
    expect(s.timeControl).toBe("10分切れ負け");
    expect(s.date).toBe("2026-09-01 21:05");
    expect(normalizePlayerName(s.blackName)).toBe("me");
  });

  it("sniffs pasted USI and CSA", () => {
    expect(importRecordFromText("position startpos moves 7g7f 3c3d")).toBeInstanceOf(Record);
    const csa = "V2.2\nN+a\nN-b\nPI\n+\n+7776FU\n-3334FU\n%TORYO\n";
    const r = importRecordFromText(csa) as Record;
    const s = summarizeRecord(r);
    expect(s.moveCount).toBe(2);
    expect(s.result).toBe("white");
  });

  it("reads ShogiHome eval comments", () => {
    const kif = makeKif({ moves: "7g7f 3c3d", black: "a", white: "b", comments: { 1: "互角\n#評価値=52\n#読み筋=△３四歩", 2: "*評価値=-30" } });
    const s = summarizeRecord(importRecordFromText(kif) as Record);
    expect(s.plies[0].importedScore).toBe(52);
    expect(s.plies[1].importedScore).toBe(-30);
  });

  it("normalises dates", () => {
    expect(normalizeDate("2024年3月5日(火) 9:05")).toBe("2024-03-05 09:05");
    expect(normalizeDate("2024/03/05")).toBe("2024-03-05");
  });
});

describe("classifier", () => {
  it("finds 四間飛車 vs 舟囲い / 美濃", () => {
    const r = Record.newByUSI("position startpos moves " + SHIKEN_VS_FUNA) as Record;
    const sfens = [r.initialPosition.sfen, ...r.moves.slice(1).map((n) => n.sfen)];
    const c = classify(sfens);
    expect(c.sideOpening.white?.name).toBe("四間飛車");
    expect(c.style).toEqual({ black: "居飛車", white: "振り飛車" });
    expect(c.mainCastle.black).toBe("舟囲い");
    expect(c.castles.white.map((x) => x.name)).toEqual(["片美濃", "本美濃"]);
    expect(strategyLabel(c)).toBe("居飛車 vs 四間飛車");
    expect(styleMatchup(c)).toBe("対抗形");
  });
});

describe("grading", () => {
  it("labels moves with ShogiHome thresholds", () => {
    // ply1 black keeps balance, ply2 white loses ~25 points (悪手), ply3 black blunders a mate.
    const g = gradeMoves([{ score: 0 }, { score: 50 }, { score: 700 }, { mate: -3 }]);
    expect(g.map((x) => x.level)).toEqual([0, 3, 4]);
    expect(g[1].color).toBe("white");
    expect(accuracy(g, "black")).toBeLessThan(accuracy(g, "white")!);
  });
  it("flags a missed mate", () => {
    const g = gradeMoves([{ mate: 5 }, { score: 800 }]);
    expect(g[0].missedMate).toBe(true);
  });
});

describe("sm2", () => {
  it("grows intervals and resets on again", () => {
    let s = newSm2State(0);
    s = reviewSm2(s, "good", 0);
    expect(s.intervalDays).toBe(1);
    s = reviewSm2(s, "good", 0);
    expect(s.intervalDays).toBe(6);
    s = reviewSm2(s, "good", 0);
    expect(s.intervalDays).toBe(15);
    s = reviewSm2(s, "again", 0);
    expect(s.repetitions).toBe(0);
    expect(s.lapses).toBe(1);
  });
});
