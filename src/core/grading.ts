// Mistake grading. The win-rate model (sigmoid with coefficient 600) and the
// thresholds 5/10/20/50 % come from ShogiHome's analysis settings
// (src/common/settings/app.ts, src/renderer/store/analysis.ts; MIT), so labels
// match what ShogiHome writes as 【緩手】【疑問手】【悪手】【大悪手】.
import { scoreToPercentage } from "./score.js";
import { SCORE_MATE_INFINITE } from "./usi.js";

export type GradingSettings = {
  coefficientInSigmoid: number;
  thresholds: [number, number, number, number];
};

export const defaultGradingSettings: GradingSettings = {
  coefficientInSigmoid: 600,
  thresholds: [5, 10, 20, 50],
};

export type MistakeLevel = 0 | 1 | 2 | 3 | 4; // none, 緩手, 疑問手, 悪手, 大悪手

export const mistakeLabels = ["", "緩手", "疑問手", "悪手", "大悪手"] as const;
export const mistakeLabelsEn = ["", "inaccuracy", "dubious", "mistake", "blunder"] as const;

/** Evaluation of a position from black's point of view. */
export type Eval = {
  score?: number; // centipawns
  mate?: number; // >0 black mates, <0 white mates (plies)
};

/** Convert an eval to a single number, mate mapped to a large finite score. */
export function evalToScore(e: Eval | undefined | null): number | undefined {
  if (!e) return undefined;
  if (e.mate !== undefined && e.mate !== null && e.mate !== 0) {
    const n = Math.min(Math.abs(e.mate), SCORE_MATE_INFINITE);
    // Shorter mates are worth slightly more; still saturates the sigmoid.
    return Math.sign(e.mate) * (100000 - n);
  }
  if (e.mate === 0) return undefined;
  return e.score ?? undefined;
}

/** Black's winning chance in percent. */
export function winRate(e: Eval | undefined | null, s = defaultGradingSettings): number | undefined {
  const score = evalToScore(e);
  return score === undefined ? undefined : scoreToPercentage(score, s.coefficientInSigmoid);
}

export type MoveGrade = {
  ply: number;
  color: "black" | "white";
  /** Win-rate loss for the side that moved, in percentage points (>= 0). */
  loss: number;
  level: MistakeLevel;
  missedMate: boolean;
  missedWin: boolean;
};

/**
 * Grade every move. `evals[i]` is the evaluation of the position after ply i
 * (evals[0] = initial position). The move at ply i is played by black when
 * `firstMover === "black"` and i is odd, and so on.
 */
export function gradeMoves(
  evals: (Eval | undefined | null)[],
  firstMover: "black" | "white" = "black",
  s = defaultGradingSettings,
): MoveGrade[] {
  const grades: MoveGrade[] = [];
  for (let ply = 1; ply < evals.length; ply++) {
    const color = (ply % 2 === 1) === (firstMover === "black") ? "black" : "white";
    const before = winRate(evals[ply - 1], s);
    const after = winRate(evals[ply], s);
    if (before === undefined || after === undefined) {
      grades.push({ ply, color, loss: 0, level: 0, missedMate: false, missedWin: false });
      continue;
    }
    const sign = color === "black" ? 1 : -1;
    const loss = Math.max(0, sign * (before - after));
    let level: MistakeLevel = 0;
    for (let i = s.thresholds.length - 1; i >= 0; i--) {
      if (loss >= s.thresholds[i]) {
        level = (i + 1) as MistakeLevel;
        break;
      }
    }
    const beforeMate = evals[ply - 1]?.mate;
    const afterMate = evals[ply]?.mate;
    const hadMate = beforeMate !== undefined && beforeMate !== 0 && Math.sign(beforeMate) === sign;
    const stillMate = afterMate !== undefined && afterMate !== 0 && Math.sign(afterMate) === sign;
    const moverBefore = color === "black" ? before : 100 - before;
    const moverAfter = color === "black" ? after : 100 - after;
    grades.push({
      ply,
      color,
      loss,
      level,
      missedMate: hadMate && !stillMate,
      missedWin: moverBefore >= 85 && moverAfter < 60,
    });
  }
  return grades;
}

/** Mean win-rate loss per move for one side; lower is better. */
export function averageLoss(grades: MoveGrade[], color: "black" | "white"): number | undefined {
  const own = grades.filter((g) => g.color === color);
  if (!own.length) return undefined;
  return own.reduce((a, g) => a + g.loss, 0) / own.length;
}

/**
 * Accuracy 0–100 from average win-rate loss, so a perfect game scores 100 and
 * an average loss of ~10 points per move lands near 50.
 */
export function accuracy(grades: MoveGrade[], color: "black" | "white"): number | undefined {
  const avg = averageLoss(grades, color);
  if (avg === undefined) return undefined;
  return Math.max(0, Math.min(100, 100 * Math.exp(-avg / 14.4)));
}

/** The ply where the evaluation swung the most (largest single-move loss). */
export function turningPoint(grades: MoveGrade[]): MoveGrade | undefined {
  let best: MoveGrade | undefined;
  for (const g of grades) {
    if (!best || g.loss > best.loss) best = g;
  }
  return best && best.loss > 0 ? best : undefined;
}
