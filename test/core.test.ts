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

describe("dashboard insights", () => {
  const row = (name: string, wins: number, losses: number) => ({ name, games: wins + losses, wins, losses, draws: 0, winRate: (wins / (wins + losses)) * 100 });
  const base = {
    totals: { games: 20, wins: 11, losses: 9, draws: 0, winRate: 55 },
    byOpening: [row("四間飛車", 9, 4), row("居飛車", 2, 5)],
    byOpponentOpening: [row("相掛かり", 1, 3), row("三間飛車", 6, 2)],
    phaseProfile: [
      { phase: "opening", avgLoss: 0.3, moves: 200, mistakes: 1, avgSeconds: 4 },
      { phase: "middlegame", avgLoss: 0.9, moves: 300, mistakes: 6, avgSeconds: 12 },
      { phase: "endgame", avgLoss: 0.5, moves: 150, mistakes: 2, avgSeconds: 8 },
    ],
    thinkTime: [
      { label: "< 5s", moves: 100, avgLoss: 1, mistakes: 6, mistakeRate: 6 },
      { label: "5–15s", moves: 300, avgLoss: 0.4, mistakes: 3, mistakeRate: 1 },
      { label: "15–60s", moves: 100, avgLoss: 0.3, mistakes: 1, mistakeRate: 1 },
      { label: "60s+", moves: 0, avgLoss: null, mistakes: 0, mistakeRate: null },
    ],
    rolling: Array.from({ length: 20 }, () => ({ date: "", winRate: 55 })),
    conversion: { winning: 3, converted: 1, losing: 2, comebacks: 0, conversionRate: 33, comebackRate: 0, blown: [] },
  };

  it("points at the weak opening, the costly phase and fast moves", async () => {
    const { insightsFromStats } = await import("../src/server/insights.js");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = insightsFromStats(base as any, { leeches: 2 });
    expect(out.map((i) => i.kind)).toEqual(["opening", "opponent-opening", "phase", "time"]);
    expect(out[0].text).toContain("居飛車");
    expect(out[0].link).toBe("#/library?opening=" + encodeURIComponent("居飛車"));
    expect(out[1].text).toContain("相掛かり");
    expect(out[2].text).toContain("中盤");
    expect(out[3].text).toContain("6.0×");
  });

  it("stays quiet when the numbers are small or even", async () => {
    const { insightsFromStats } = await import("../src/server/insights.js");
    const even = {
      ...base,
      byOpening: [row("四間飛車", 1, 1)],
      byOpponentOpening: [],
      phaseProfile: base.phaseProfile.map((p) => ({ ...p, avgLoss: 0.5 })),
      thinkTime: [],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(insightsFromStats(even as any, { leeches: 0 })).toEqual([]);
  });
});

describe("board diagram", () => {
  it("draws every piece, hands and the last move as SVG", async () => {
    const { positionSvg } = await import("../src/core/diagram.js");
    const svg = positionSvg("lnsgkgsnl/1r5b1/ppppppppp/9/9/2P6/PP1PPPPPP/1B5R1/LNSGKGSNL w - 2", { lastMove: "7g7f", caption: "1手目 <☗７六歩>" });
    expect(svg.startsWith("<svg")).toBe(true);
    expect((svg.match(/>歩</g) ?? []).length).toBe(18);
    // Hands are written vertically, one character each.
    expect(svg).toContain(">☗<");
    expect(svg).toContain(">な<");
    // Gote's pieces are drawn upside down; the caption is escaped.
    expect((svg.match(/rotate\(180/g) ?? []).length).toBe(20);
    expect(svg).toContain("&lt;☗７六歩&gt;");
    expect(svg).toContain('fill="#e8a33d"');
    expect(() => positionSvg("not a position")).toThrow();
  });
});

describe("USI option lines", () => {
  it("reads type, default, range and choices", async () => {
    const { parseOptionLine } = await import("../src/server/engine/usi.js");
    expect(parseOptionLine("option name USI_Hash type spin default 256 min 1 max 33554432")).toEqual({ name: "USI_Hash", type: "spin", default: "256", min: 1, max: 33554432 });
    expect(parseOptionLine("option name EvalDir type string default eval")).toEqual({ name: "EvalDir", type: "string", default: "eval" });
    expect(parseOptionLine("option name BookFile type combo default no_book var no_book var standard_book.db var user_book1.db")).toMatchObject({ default: "no_book", vars: ["no_book", "standard_book.db", "user_book1.db"] });
    expect(parseOptionLine("option name BookDir type string default <empty>")!.default).toBe("");
    expect(parseOptionLine("id name foo")).toBeNull();
  });
});

describe("move kinds", () => {
  it("tells drops, captures, checks, promotions, king and quiet moves apart", async () => {
    const { moveKinds } = await import("../src/core/movekind.js");
    const start = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1";
    expect(moveKinds(start, "7g7f")).toEqual(["quiet"]);
    expect(moveKinds(start, "5i5h")).toEqual(["king"]);
    // After 7g7f 3c3d: ☗2二角成 takes the bishop and promotes.
    const open = "lnsgkgsnl/1r5b1/pppppp1pp/6p2/9/2P6/PP1PPPPPP/1B5R1/LNSGKGSNL b - 3";
    expect(moveKinds(open, "8h2b+")).toEqual(["capture", "promotion"]);
    // A gold dropped right in front of a bare king gives check.
    expect(moveKinds("4k4/9/9/9/9/9/9/9/4K4 b G 1", "G*5b")).toEqual(["drop", "check"]);
    expect(moveKinds(start, "7g7e")).toBeNull();
  });
});

describe("move tree", () => {
  const START = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1";
  it("parses and formats PGN-style variations", async () => {
    const { parseTree, formatTree, selectedLine, hasVariations } = await import("../src/core/movetree.js");
    const text = "7g7f 3c3d (8c8d 2g2f (2h6h)) 2g2f 8c8d";
    const t = parseTree(text);
    expect(formatTree(t)).toBe(text);
    expect(t.children[0].children.map((c) => c.usi)).toEqual(["3c3d", "8c8d"]);
    expect(hasVariations(t)).toBe(true);
    expect(selectedLine(t, []).map((x) => x.node.usi)).toEqual(["", "7g7f", "3c3d", "2g2f", "8c8d"]);
    expect(selectedLine(t, [0, 1, 1]).map((x) => x.node.usi)).toEqual(["", "7g7f", "8c8d", "2h6h"]);
    expect(formatTree(parseTree("7g7f, 3c3d"))).toBe("7g7f 3c3d");
    expect(hasVariations(parseTree("7g7f 3c3d"))).toBe(false);
    expect(() => parseTree("7g7f (3c3d")).toThrow();
    expect(() => parseTree("(7g7f)")).toThrow();
  });

  it("round-trips through a record and KIF 変化", async () => {
    const { parseTree, formatTree, treeToRecord, recordToTree, pruneIllegal } = await import("../src/core/movetree.js");
    const { exportKIF, importKIF } = await import("tsshogi");
    const text = "7g7f 3c3d (8c8d 2g2f) 2g2f";
    const kif = exportKIF(treeToRecord(START, parseTree(text)));
    expect(kif).toContain("変化：2手");
    expect(formatTree(recordToTree(importKIF(kif) as Record))).toBe(text);
    expect(formatTree(pruneIllegal(parseTree("7g7f 3c3d (1a2a 1c1d) 2g2f 1a1a"), START))).toBe("7g7f 3c3d 2g2f");
  });

  it("merges a tree into a record without changing its main line", async () => {
    const { parseTree, formatTree, recordToTree, mergeTreeIntoRecord, lineTree, treeToRecord } = await import("../src/core/movetree.js");
    const rec = treeToRecord(START, lineTree(["7g7f", "3c3d", "2g2f"]));
    mergeTreeIntoRecord(rec, parseTree("7g7f 8c8d 2g2f (6i7h)"));
    expect(formatTree(recordToTree(rec))).toBe("7g7f 3c3d (8c8d 2g2f (6i7h)) 2g2f");
    expect(rec.moves.slice(1).map((n) => (n.move as { usi: string }).usi)).toEqual(["7g7f", "3c3d", "2g2f"]);
  });
});

describe("position setup checks", () => {
  it("accepts real positions and names what's wrong with others", async () => {
    const { setupProblems } = await import("../src/core/setup.js");
    expect(setupProblems("lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1")).toEqual([]);
    expect(setupProblems("4k4/9/9/9/9/9/9/9/9 b 2r2b4g4s4n4l18p 1")).toEqual([]);
    expect(setupProblems("9/9/9/9/9/9/9/9/9 b - 1")).toEqual(["There is no king on the board."]);
    expect(setupProblems("4k4/9/9/9/9/9/9/9/3KK4 b - 1")).toContain("☗ has more than one king.");
    expect(setupProblems("P3k4/9/9/9/9/9/9/9/4K4 b - 1")[0]).toMatch(/☗歩 on 91 can never move/);
    expect(setupProblems("4k4/9/9/9/9/9/9/9/n3K4 w - 1")[0]).toMatch(/☖桂 on 99 can never move/);
    expect(setupProblems("4k4/9/9/9/P8/P8/9/9/4K4 b - 1")).toEqual(["☗ has two pawns on file 9 (二歩)."]);
    expect(setupProblems("4k4/9/9/9/9/9/9/9/4K4 b 3R 1")).toEqual(["There are 3 飛; a set has 2."]);
    expect(setupProblems("4k4/9/9/9/9/9/9/+R8/4K4 b 2R 1")).toEqual(["There are 3 飛; a set has 2."]);
    // ☖'s king on 5a is attacked by the ☗ rook on 5i… with ☗ to move, ☖ left it in check.
    expect(setupProblems("4k4/9/9/9/9/9/9/9/K3R4 b - 1")).toEqual(["☖'s king is in check but it is ☗ to move."]);
    expect(setupProblems("4k4/9/9/9/9/9/9/9/K3R4 w - 1")).toEqual([]);
  });
});

describe("splitting pasted text into records", () => {
  it("cuts KIF, CSA and USI lines into games and keeps 変化 with their game", async () => {
    const { splitRecords } = await import("../src/core/split.js");
    const kifA = makeKif({ moves: "7g7f 3c3d 2g2f", black: "a", white: "b", date: "2026/09/01" });
    const kifB = makeKif({ moves: "2g2f 8c8d", black: "c", white: "d", date: "2026/09/02" });
    const withBranch = ["手合割：平手", "先手：x", "後手：y", "手数----指手---------消費時間--", "   1 ７六歩(77)", "   2 ３四歩(33)", "", "変化：2手", "   2 ８四歩(83)", ""].join("\n");
    const parts = splitRecords([kifA, withBranch, kifB].join("\n\n"));
    expect(parts).toHaveLength(3);
    expect(parts[1]).toContain("変化：2手");
    for (const p of parts) expect(importRecordFromText(p)).toBeInstanceOf(Record);
    expect(splitRecords(kifA)).toHaveLength(1);

    const csa = "V2.2\nN+a\nN-b\nPI\n+\n+7776FU\n-3334FU\n%TORYO\n/\nV2.2\nN+c\nN-d\nPI\n+\n+2726FU\n%TORYO\n";
    const csaParts = splitRecords(csa);
    expect(csaParts).toHaveLength(2);
    expect(csaParts[1]).toContain("N+c");

    expect(splitRecords("position startpos moves 7g7f\n\nsfen lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1 moves 2g2f\n")).toHaveLength(2);
    expect(splitRecords("position startpos moves 7g7f 3c3d")).toHaveLength(1);
    expect(splitRecords("  \n")).toEqual([]);
  });
});

describe("move tree comments", () => {
  const START = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1";
  it("carries comments through a record and KIF, and never overwrites a game's own", async () => {
    const { parseTree, treeToRecord, recordToTree, mergeTreeIntoRecord, lineTree } = await import("../src/core/movetree.js");
    const { exportKIF, importKIF } = await import("tsshogi");
    const t = parseTree("7g7f 3c3d (8c8d) 2g2f");
    t.comment = "start note";
    t.children[0].comment = "角道を開ける";
    t.children[0].children[1].comment = "居飛車にする";
    const kif = exportKIF(treeToRecord(START, t));
    expect(kif).toContain("*角道を開ける");
    expect(kif).toContain("*居飛車にする");
    const back = recordToTree(importKIF(kif) as Record);
    expect(back.comment).toBe("start note");
    expect(back.children[0].comment).toBe("角道を開ける");
    expect(back.children[0].children[1]).toMatchObject({ usi: "8c8d", comment: "居飛車にする" });
    expect(back.children[0].children[0].comment).toBeUndefined();

    // Merging into a game: a move that has a comment keeps it; a bare one gets the study's.
    const game = treeToRecord(START, lineTree(["7g7f", "3c3d"]));
    game.goto(1);
    game.current.comment = "mine";
    mergeTreeIntoRecord(game, t);
    const merged = recordToTree(game);
    expect(merged.children[0].comment).toBe("mine");
    expect(merged.children[0].children[1].comment).toBe("居飛車にする");
  });
});

describe("passing the move for threats", () => {
  it("flips the side to move, except when the side to move is in check", async () => {
    const { passedPosition } = await import("../src/core/threat.js");
    expect(passedPosition("lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1")).toBe("lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL w - 1");
    // ☗ to move and in check from the ☖ rook on 5a: it can't pass.
    expect(passedPosition("4r4/9/9/9/9/9/9/9/4K4 b - 1")).toBeNull();
    expect(passedPosition("nonsense")).toBeNull();
  });
});
