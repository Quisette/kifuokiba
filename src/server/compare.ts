// A second opinion on a game: a second engine evaluates every position, and
// the moves where it and the main analysis disagree are listed. The second
// engine is its own process, so a comparison doesn't wait behind the analysis
// queue; its evals go into the shared cache under its own name and options.
import { Library } from "./library.js";
import { UsiEngine } from "./engine/usi.js";
import { toBlackView } from "./analysis.js";
import { Eval, gradeMoves, mistakeLabels, winRate } from "../core/grading.js";

/** Winning chances (0–100) the engines must differ by for a position to be listed. */
export const WINRATE_GAP = 15;

export type Disagreement = {
  ply: number;
  text: string;
  side: "black" | "white";
  main: { level: number; label: string; loss: number };
  second: { level: number; label: string; loss: number };
  /** Black's winning chances before the move, per engine. */
  winBefore: { main: number | null; second: number | null };
  bestMain: string;
  bestSecond: string;
};

export type Comparison = {
  engine: string;
  moves: number;
  /** Share of graded moves both engines put at the same level. */
  agreement: number | null;
  bestMovesDiffer: number;
  disagreements: Disagreement[];
};

export type CompareStatus = { gameId: number; running: boolean; done: number; total: number; engine: string; error: string; result: Comparison | null };

export class SecondOpinion {
  private engine: UsiEngine | null = null;
  private engineKey = "";
  private jobs = new Map<number, CompareStatus>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly lib: Library) {}

  get configured() {
    return !!this.lib.settings.engine2.path;
  }

  status(gameId: number): CompareStatus {
    return this.jobs.get(gameId) ?? { gameId, running: false, done: 0, total: 0, engine: "", error: "", result: null };
  }

  /** Starts (or re-uses) a comparison of one game; jobs run one after another. */
  start(gameId: number): CompareStatus {
    const cur = this.jobs.get(gameId);
    if (cur?.running) return cur;
    const total = this.lib.db.get<{ n: number }>("SELECT COUNT(*) n FROM plies WHERE game_id = ?", gameId)?.n ?? 0;
    const job: CompareStatus = { gameId, running: true, done: 0, total, engine: "", error: "", result: null };
    this.jobs.set(gameId, job);
    this.chain = this.chain.then(() =>
      this.run(job).catch((e) => {
        job.error = e instanceof Error ? e.message : String(e);
      }).finally(() => (job.running = false)),
    );
    return job;
  }

  private async getEngine(): Promise<UsiEngine> {
    const s = this.lib.settings.engine2;
    if (!s.path) throw new Error("No second engine set. Add one in Settings.");
    const key = JSON.stringify([s.path, s.options]);
    if (this.engine?.running && this.engineKey === key) return this.engine;
    await this.engine?.quit();
    const e = new UsiEngine(s.path, s.options);
    await e.start();
    this.engine = e;
    this.engineKey = key;
    return e;
  }

  private async run(job: CompareStatus) {
    const s = this.lib.settings;
    const engine = await this.getEngine();
    job.engine = engine.name;
    // The same binary with other options is another opinion: keep their caches apart.
    const opts = Object.keys(s.engine2.options).sort().map((k) => `${k}=${s.engine2.options[k]}`).join(",");
    const key = `movetime:${s.engine2.movetimeMs}` + (opts ? `|${opts}` : "");
    const game = this.lib.db.get<{ initial_sfen: string }>("SELECT initial_sfen FROM games WHERE id = ?", job.gameId);
    if (!game) throw new Error("game not found");
    const plies = this.lib.db.all<{ ply: number; usi: string; text: string; sfen: string; score: number | null; mate: number | null; best_usi: string; level: number; loss: number | null }>(
      "SELECT ply, usi, text, sfen, score, mate, best_usi, level, loss FROM plies WHERE game_id = ? ORDER BY ply",
      job.gameId,
    );
    const second: (Eval & { best: string })[] = [];
    for (const p of plies) {
      let e = this.lib.cachedEval(p.sfen, engine.name, key);
      if (!e) {
        const position = `sfen ${game.initial_sfen}` + (p.ply ? ` moves ${plies.slice(1, p.ply + 1).map((x) => x.usi).join(" ")}` : "");
        const r = toBlackView(p.sfen, await engine.search(position, { movetimeMs: s.engine2.movetimeMs }));
        this.lib.storeEval(p.sfen, r, engine.name, key);
        e = { score: r.score ?? null, mate: r.mate ?? null, best_usi: r.best, pv: r.pv };
      }
      second.push({ score: e.score ?? undefined, mate: e.mate ?? undefined, best: e.best_usi });
      job.done++;
    }
    job.result = compare(plies, second, engine.name, game.initial_sfen.split(" ")[1] === "w" ? "white" : "black", s.grading);
  }

  async shutdown() {
    await this.engine?.quit();
  }
}

/** The disagreements between the stored (main) analysis and a second engine's evals. */
export function compare(
  plies: { ply: number; text: string; sfen: string; score: number | null; mate: number | null; best_usi: string }[],
  second: (Eval & { best: string })[],
  engine: string,
  firstMover: "black" | "white",
  grading: Parameters<typeof gradeMoves>[2],
): Comparison {
  const main: (Eval | null)[] = plies.map((p) => (p.score === null && p.mate === null ? null : { score: p.score ?? undefined, mate: p.mate ?? undefined }));
  const g1 = gradeMoves(main, firstMover, grading);
  const g2 = gradeMoves(second, firstMover, grading);
  let graded = 0;
  let same = 0;
  let bestMovesDiffer = 0;
  const disagreements: Disagreement[] = [];
  for (let i = 0; i < g1.length; i++) {
    const a = g1[i];
    const b = g2[i];
    const before = plies[a.ply - 1];
    if (before.best_usi && second[a.ply - 1].best && before.best_usi !== second[a.ply - 1].best) bestMovesDiffer++;
    if (!main[a.ply - 1] || !main[a.ply]) continue;
    graded++;
    if (a.level === b.level) same++;
    const w1 = winRate(main[a.ply - 1], grading);
    const w2 = winRate(second[a.ply - 1], grading);
    const flagSplit = a.level >= 3 !== b.level >= 3;
    const gap = w1 !== undefined && w2 !== undefined && Math.abs(w1 - w2) >= WINRATE_GAP;
    if (!flagSplit && !gap) continue;
    disagreements.push({
      ply: a.ply,
      text: plies[a.ply].text,
      side: a.color,
      main: { level: a.level, label: mistakeLabels[a.level], loss: Math.round(a.loss * 10) / 10 },
      second: { level: b.level, label: mistakeLabels[b.level], loss: Math.round(b.loss * 10) / 10 },
      winBefore: { main: w1 === undefined ? null : Math.round(w1), second: w2 === undefined ? null : Math.round(w2) },
      bestMain: before.best_usi ? Library.moveText(before.sfen, before.best_usi) : "",
      bestSecond: second[a.ply - 1].best ? Library.moveText(before.sfen, second[a.ply - 1].best) : "",
    });
  }
  return { engine, moves: graded, agreement: graded ? (same / graded) * 100 : null, bestMovesDiffer, disagreements };
}
