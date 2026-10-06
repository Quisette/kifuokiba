// FSRS v4.5 scheduler (Free Spaced Repetition Scheduler, open-spaced-repetition),
// with the published default parameters. Long-term scheduling only: a failed card
// comes back after a short relearning step, like Anki.
import type { Rating } from "./sm2.js";

export const FSRS_DEFAULT_W = [
  0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031, 1.6474, 0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755,
];

const DECAY = -0.5;
const FACTOR = Math.pow(0.9, 1 / DECAY) - 1; // 19/81, so R = 90% when t = S
const DAY = 24 * 60 * 60 * 1000;
const RELEARN_MS = 10 * 60 * 1000;
const MAX_INTERVAL_DAYS = 36500;

export type FsrsState = {
  /** Days until recall probability falls to 90%. Null before the first FSRS review. */
  stability: number | null;
  /** 1 (easy) .. 10 (hard). */
  difficulty: number | null;
  lastReviewAt: number | null;
  repetitions: number;
  lapses: number;
};

export type FsrsResult = FsrsState & { intervalDays: number; dueAt: number };

const grade: Record<Rating, number> = { again: 1, hard: 2, good: 3, easy: 4 };
const clampD = (d: number) => Math.min(10, Math.max(1, d));

/** Probability of recall after `days` with stability `s`. */
export function retrievability(days: number, s: number): number {
  return Math.pow(1 + (FACTOR * days) / s, DECAY);
}

/** Days until recall probability drops to `retention`. */
export function intervalFor(s: number, retention = 0.9): number {
  return (s / FACTOR) * (Math.pow(retention, 1 / DECAY) - 1);
}

function initialDifficulty(g: number, w: number[]) {
  return clampD(w[4] - (g - 3) * w[5]);
}

export function reviewFsrs(state: FsrsState, rating: Rating, now = Date.now(), retention = 0.9, w = FSRS_DEFAULT_W): FsrsResult {
  const g = grade[rating];
  let { stability: s, difficulty: d } = state;
  let { repetitions, lapses } = state;

  if (s === null || d === null) {
    s = w[g - 1];
    d = initialDifficulty(g, w);
  } else {
    const days = state.lastReviewAt !== null ? Math.max(0, (now - state.lastReviewAt) / DAY) : 0;
    const r = retrievability(days, s);
    // Difficulty moves with the grade and drifts back toward a "good" default.
    d = clampD(w[7] * initialDifficulty(3, w) + (1 - w[7]) * (d - w[6] * (g - 3)));
    if (g === 1) {
      const sf = w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp(w[14] * (1 - r));
      s = Math.min(sf, s);
    } else {
      const bonus = (g === 2 ? w[15] : 1) * (g === 4 ? w[16] : 1);
      s = s * (Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9]) * (Math.exp(w[10] * (1 - r)) - 1) * bonus + 1);
    }
  }

  if (g === 1) {
    lapses += state.stability === null ? 0 : 1;
    return { stability: s, difficulty: d, lastReviewAt: now, repetitions: 0, lapses, intervalDays: 0, dueAt: now + RELEARN_MS };
  }
  const intervalDays = Math.min(MAX_INTERVAL_DAYS, Math.max(1, Math.round(intervalFor(s, retention))));
  return { stability: s, difficulty: d, lastReviewAt: now, repetitions: repetitions + 1, lapses, intervalDays, dueAt: now + intervalDays * DAY };
}

/** Starting point for a card that was scheduled with SM-2 before switching to FSRS. */
export function fsrsFromSm2(card: { intervalDays: number; ease: number; repetitions: number }): Pick<FsrsState, "stability" | "difficulty"> {
  if (card.repetitions === 0) return { stability: null, difficulty: null };
  // Ease 1.3..2.5+ maps onto difficulty 9..5; the current interval is a fair stability guess.
  return { stability: Math.max(0.5, card.intervalDays), difficulty: clampD(5 + (2.5 - card.ease) * 3.3) };
}
