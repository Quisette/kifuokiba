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

describe("player strength", () => {
  it("reads ratings and ranks written after names", async () => {
    const { parseStrength } = await import("../src/core/summarize.js");
    expect(parseStrength("me (1650)")).toEqual({ rating: 1650, rank: "" });
    expect(parseStrength("森下 遼 二段")).toEqual({ rating: null, rank: "二段" });
    expect(parseStrength("Q 3級")).toEqual({ rating: null, rank: "3級" });
    expect(parseStrength("tsubame_7")).toEqual({ rating: null, rank: "" });
    // A name that merely ends in a rank-like word with no space is left alone.
    expect(parseStrength("初段").rank).toBe("初段");
    expect(parseStrength("七段目").rank).toBe("");
  });
});

describe("FSRS scheduling", () => {
  const DAY = 86400000;
  const fresh = { stability: null, difficulty: null, lastReviewAt: null, repetitions: 0, lapses: 0 };

  it("starts new cards from the default parameters", async () => {
    const { reviewFsrs } = await import("../src/core/fsrs.js");
    const good = reviewFsrs(fresh, "good", 0);
    expect(good.stability).toBeCloseTo(3.7145, 4);
    expect(good.difficulty).toBeCloseTo(5.1618, 4);
    expect(good.intervalDays).toBe(4);
    const again = reviewFsrs(fresh, "again", 0);
    expect(again.dueAt).toBe(10 * 60 * 1000);
    expect(again.lapses).toBe(0); // failing a new card is not a lapse
    expect(reviewFsrs(fresh, "easy", 0).intervalDays).toBeGreaterThan(good.intervalDays);
  });

  it("grows stability on a recall at 90% and shrinks it on a lapse", async () => {
    const { reviewFsrs, retrievability } = await import("../src/core/fsrs.js");
    const first = reviewFsrs(fresh, "good", 0);
    const t = first.stability! * DAY;
    expect(retrievability(first.stability!, first.stability!)).toBeCloseTo(0.9, 6);
    const second = reviewFsrs(first, "good", t);
    expect(second.stability!).toBeGreaterThan(13);
    expect(second.stability!).toBeLessThan(15);
    const lapse = reviewFsrs(second, "again", t + second.intervalDays * DAY);
    expect(lapse.stability!).toBeLessThan(second.stability!);
    expect(lapse.lapses).toBe(1);
    expect(lapse.difficulty!).toBeGreaterThan(second.difficulty!);
  });

  it("asks for reviews sooner with a higher target recall", async () => {
    const { reviewFsrs } = await import("../src/core/fsrs.js");
    const s = { ...fresh, stability: 30, difficulty: 5, lastReviewAt: 0, repetitions: 3 };
    const at = 30 * DAY;
    expect(reviewFsrs(s, "good", at, 0.95).intervalDays).toBeLessThan(reviewFsrs(s, "good", at, 0.85).intervalDays);
  });

  it("picks up SM-2 cards when switching schedulers", async () => {
    const { scheduleCard } = await import("../src/core/scheduler.js");
    const sm2Card = { repetitions: 3, intervalDays: 20, ease: 2.5, dueAt: 20 * DAY, lapses: 0, stability: null, difficulty: null, lastReviewAt: 0 };
    const next = scheduleCard(sm2Card, "good", 20 * DAY, { scheduler: "fsrs", desiredRetention: 0.9 });
    expect(next.stability!).toBeGreaterThan(20);
    expect(next.intervalDays).toBeGreaterThan(20);
    const viaSm2 = scheduleCard(sm2Card, "good", 20 * DAY, { scheduler: "sm2", desiredRetention: 0.9 });
    expect(viaSm2.intervalDays).toBe(50);
    expect(viaSm2.stability).toBeNull();
  });
});
