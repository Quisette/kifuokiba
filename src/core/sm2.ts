// SM-2 spaced repetition (Wozniak 1990), with Anki-style button names.

export type Sm2State = {
  repetitions: number;
  intervalDays: number;
  ease: number;
  dueAt: number; // epoch ms
  lapses: number;
};

export type Rating = "again" | "hard" | "good" | "easy";

const qualityOf: Record<Rating, number> = { again: 1, hard: 3, good: 4, easy: 5 };
const DAY = 24 * 60 * 60 * 1000;

export function newSm2State(now = Date.now()): Sm2State {
  return { repetitions: 0, intervalDays: 0, ease: 2.5, dueAt: now, lapses: 0 };
}

export function reviewSm2(state: Sm2State, rating: Rating, now = Date.now()): Sm2State {
  const q = qualityOf[rating];
  let { repetitions, intervalDays, ease, lapses } = state;
  if (q < 3) {
    repetitions = 0;
    lapses += 1;
    // Relearn soon: 10 minutes.
    return {
      repetitions,
      intervalDays: 0,
      ease: Math.max(1.3, ease - 0.2),
      dueAt: now + 10 * 60 * 1000,
      lapses,
    };
  }
  if (repetitions === 0) intervalDays = 1;
  else if (repetitions === 1) intervalDays = 6;
  else intervalDays = Math.round(intervalDays * ease);
  if (rating === "hard") intervalDays = Math.max(1, Math.round(intervalDays * 0.6));
  if (rating === "easy") intervalDays = Math.round(intervalDays * 1.3) || 1;
  repetitions += 1;
  ease = Math.max(1.3, ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  return { repetitions, intervalDays, ease, dueAt: now + intervalDays * DAY, lapses };
}

/**
 * Auto-grade a card answer from the engine's view of the answer move.
 * `loss` is the win-rate loss (percentage points) of the user's move against the
 * best move. Within `okLoss` of best counts as correct.
 */
export function ratingFromLoss(loss: number, okLoss = 3): Rating {
  if (loss <= 0.5) return "easy";
  if (loss <= okLoss) return "good";
  if (loss <= okLoss * 3) return "hard";
  return "again";
}
