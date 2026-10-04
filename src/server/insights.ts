// A few plain-language observations for the dashboard, drawn from the stats.
// Each one only appears when the numbers are big enough to mean something.
import type { computeStats } from "./stats.js";

type Stats = ReturnType<typeof computeStats>;
export type Insight = { kind: string; text: string; link?: string };

const pct = (x: number) => `${Math.round(x)}%`;
const PHASE = { opening: "序盤", middlegame: "中盤", endgame: "終盤" } as const;

export function insightsFromStats(s: Stats, cards: { leeches: number }): Insight[] {
  const out: Insight[] = [];
  const overall = s.totals.winRate;

  const weakest = s.byOpening.filter((o) => o.games >= 3 && o.winRate !== null).sort((a, b) => a.winRate! - b.winRate!)[0];
  if (weakest && overall !== null && weakest.winRate! <= overall - 10) {
    out.push({
      kind: "opening",
      text: `${weakest.name} is your weakest opening: ${weakest.wins}勝 ${weakest.losses}敗 (${pct(weakest.winRate!)}), against ${pct(overall)} overall.`,
      link: `#/library?opening=${encodeURIComponent(weakest.name)}`,
    });
  }

  const nemesis = s.byOpponentOpening.filter((o) => o.games >= 3 && o.winRate !== null).sort((a, b) => a.winRate! - b.winRate!)[0];
  if (nemesis && overall !== null && nemesis.winRate! <= overall - 10) {
    out.push({
      kind: "opponent-opening",
      text: `You score ${pct(nemesis.winRate!)} against ${nemesis.name} (${nemesis.wins}勝 ${nemesis.losses}敗).`,
      link: `#/library?opening=${encodeURIComponent(nemesis.name)}`,
    });
  }

  const phases = s.phaseProfile.filter((p) => p.avgLoss !== null && p.moves >= 30);
  if (phases.length >= 2) {
    const worst = [...phases].sort((a, b) => b.avgLoss! - a.avgLoss!)[0];
    const best = [...phases].sort((a, b) => a.avgLoss! - b.avgLoss!)[0];
    if (worst.avgLoss! >= best.avgLoss! * 1.5 && worst.avgLoss! >= 0.5) {
      out.push({
        kind: "phase",
        text: `You lose the most in ${PHASE[worst.phase as keyof typeof PHASE]}: ${worst.avgLoss!.toFixed(1)} points a move, against ${best.avgLoss!.toFixed(1)} in ${PHASE[best.phase as keyof typeof PHASE]}.`,
        link: "#/stats",
      });
    }
  }

  const fast = s.thinkTime.find((b) => b.label === "< 5s");
  const rest = s.thinkTime.filter((b) => b.label !== "< 5s");
  const restMoves = rest.reduce((a, b) => a + b.moves, 0);
  const restMistakes = rest.reduce((a, b) => a + b.mistakes, 0);
  if (fast && fast.moves >= 20 && restMoves >= 20 && fast.mistakeRate !== null) {
    const restRate = (restMistakes / restMoves) * 100;
    if (fast.mistakeRate >= 1 && fast.mistakeRate >= restRate * 2) {
      const times = restRate > 0 ? `${(fast.mistakeRate / restRate).toFixed(1)}×` : "far more";
      out.push({
        kind: "time",
        text: `Moves played in under 5 seconds become 悪手 ${times} as often as the rest (${fast.mistakeRate.toFixed(1)}% vs ${restRate.toFixed(1)}%).`,
        link: "#/stats",
      });
    }
  }

  const recent = s.rolling.length >= 20 ? s.rolling.at(-1)!.winRate : null;
  if (recent !== null && overall !== null && Math.abs(recent - overall) >= 10) {
    out.push({
      kind: "trend",
      text: recent > overall ? `In form: ${pct(recent)} over your last 20 games, up from ${pct(overall)} overall.` : `A dip: ${pct(recent)} over your last 20 games, below your ${pct(overall)} overall.`,
      link: "#/stats",
    });
  }

  const c = s.conversion;
  if (c.winning >= 5 && c.conversionRate !== null && c.conversionRate < 75) {
    const last = c.blown[0];
    out.push({
      kind: "conversion",
      text: `You won ${c.converted} of the ${c.winning} games where you were clearly winning (${pct(c.conversionRate)}). Playing out the positions you let slip helps.`,
      link: last ? `#/game/${last.id}?ply=${last.slipPly - 1}` : "#/stats",
    });
  }

  if (cards.leeches > 0) {
    out.push({
      kind: "leeches",
      text: `${cards.leeches} card${cards.leeches === 1 ? " keeps" : "s keep"} failing. Writing down the idea behind ${cards.leeches === 1 ? "it" : "them"} helps more than drilling.`,
      link: "#/review",
    });
  }
  return out.slice(0, 4);
}
