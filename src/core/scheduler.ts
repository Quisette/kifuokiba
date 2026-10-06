// One entry point for card scheduling, so the server and the review screen's
// interval preview always agree on which algorithm runs.
import { reviewSm2, Rating } from "./sm2.js";
import { fsrsFromSm2, reviewFsrs } from "./fsrs.js";

export type SchedulerName = "sm2" | "fsrs";

export type CardSchedule = {
  repetitions: number;
  intervalDays: number;
  ease: number;
  dueAt: number;
  lapses: number;
  stability: number | null;
  difficulty: number | null;
  lastReviewAt: number | null;
};

export function scheduleCard(
  card: CardSchedule,
  rating: Rating,
  now: number,
  opts: { scheduler: SchedulerName; desiredRetention: number },
): CardSchedule {
  if (opts.scheduler === "fsrs") {
    const start = card.stability === null && card.repetitions > 0 ? { ...card, ...fsrsFromSm2(card) } : card;
    const r = reviewFsrs(start, rating, now, opts.desiredRetention);
    return { ...card, ...r };
  }
  const r = reviewSm2(card, rating, now);
  // SM-2 keeps the FSRS fields untouched, apart from the review time.
  return { ...card, ...r, lastReviewAt: now };
}
