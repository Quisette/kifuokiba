// Background analysis queue. Per game it walks every position like ShogiHome's
// analysis loop (src/renderer/store/analysis.ts), but stores results in the
// library DB and reuses cached evals for positions seen in earlier games.
import { EventEmitter } from "node:events";
import { Library } from "./library.js";
import { UsiEngine, SearchLimit, SearchResult } from "./engine/usi.js";
import { EngineSettings } from "./settings.js";

export type AnalysisStatus = {
  running: boolean;
  engineName: string;
  current: { gameId: number; ply: number; total: number } | null;
  queued: number[];
  done: number;
  error: string;
};

export function limitKey(s: EngineSettings): string {
  return s.nodes ? `nodes:${s.nodes}` : `movetime:${s.movetimeMs}`;
}

function sideToMove(sfen: string): "black" | "white" {
  return sfen.split(" ")[1] === "w" ? "white" : "black";
}

/** Convert the first line of a search to black's point of view. */
export function toBlackView(sfen: string, r: SearchResult) {
  const line = r.lines[0];
  const sign = sideToMove(sfen) === "black" ? 1 : -1;
  if (!line) {
    // No info line (e.g. immediate resign): treat as mated side to move.
    if (r.bestmove === "resign") return { mate: -sign * 10000, best: "", pv: "" };
    return { best: r.bestmove, pv: r.bestmove };
  }
  return {
    score: line.scoreCP !== undefined ? sign * line.scoreCP : undefined,
    mate: line.scoreMate !== undefined ? sign * line.scoreMate : undefined,
    best: r.bestmove === "resign" || r.bestmove === "win" ? "" : r.bestmove,
    pv: line.pv.join(" "),
    depth: line.depth,
    nodes: line.nodes,
  };
}

export class AnalysisQueue extends EventEmitter {
  private queue: number[] = [];
  private engine: UsiEngine | null = null;
  private engineKey = "";
  private running = false;
  private stopRequested = false;
  private current: AnalysisStatus["current"] = null;
  private done = 0;
  private error = "";

  constructor(private readonly lib: Library) {
    super();
  }

  status(): AnalysisStatus {
    return {
      running: this.running,
      engineName: this.engine?.name ?? "",
      current: this.current,
      queued: [...this.queue],
      done: this.done,
      error: this.error,
    };
  }

  private emitStatus() {
    this.emit("status", this.status());
  }

  enqueue(ids: number[], opts: { force?: boolean } = {}) {
    for (const id of ids) {
      if (!this.queue.includes(id) && this.current?.gameId !== id) {
        if (!opts.force) {
          const g = this.lib.db.get<{ analysis_status: string }>("SELECT analysis_status FROM games WHERE id = ?", id);
          if (g?.analysis_status === "done") continue;
        }
        this.queue.push(id);
        this.lib.db.run("UPDATE games SET analysis_status = 'queued' WHERE id = ? AND analysis_status != 'done'", id);
      }
    }
    this.emitStatus();
    if (!this.running) void this.loop();
  }

  stop() {
    this.stopRequested = true;
    for (const id of this.queue) {
      this.lib.db.run("UPDATE games SET analysis_status = CASE WHEN EXISTS (SELECT 1 FROM plies WHERE game_id = ? AND eval_source != '') THEN 'imported' ELSE 'none' END WHERE id = ? AND analysis_status = 'queued'", id, id);
    }
    this.queue = [];
    this.engine?.stop();
    this.emitStatus();
  }

  async getEngine(): Promise<UsiEngine> {
    const s = this.lib.settings.engine;
    if (!s.path) throw new Error("No engine configured. Set the engine path in Settings.");
    const key = JSON.stringify([s.path, s.options]);
    if (this.engine && this.engine.running && this.engineKey === key) return this.engine;
    await this.engine?.quit();
    const e = new UsiEngine(s.path, s.options);
    await e.start();
    this.engine = e;
    this.engineKey = key;
    return e;
  }

  /** One-off search used by card review and the "try a move" panel. */
  async searchPosition(position: string, sfenAfter: string, limit?: SearchLimit, multipv = 1) {
    const s = this.lib.settings.engine;
    const e = await this.getEngine();
    const r = await e.search(position, limit ?? (s.nodes ? { nodes: s.nodes } : { movetimeMs: s.movetimeMs }), { multipv });
    return { ...toBlackView(sfenAfter, r), lines: r.lines, engine: e.name };
  }

  /** Definitive mate search on one position ("go mate"). */
  async mateSearch(position: string, timeMs: number) {
    const e = await this.getEngine();
    return { ...(await e.mate(position, timeMs)), engine: e.name };
  }

  private async loop() {
    this.running = true;
    this.stopRequested = false;
    this.error = "";
    try {
      while (this.queue.length && !this.stopRequested) {
        const id = this.queue.shift()!;
        try {
          await this.analyseGame(id);
        } catch (e) {
          // Keep the evals found so far; the game can be queued again.
          this.lib.db.run("UPDATE games SET analysis_status = 'none' WHERE id = ? AND analysis_status = 'queued'", id);
          throw e;
        }
        if (!this.stopRequested) this.done++;
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      for (const id of this.queue) this.lib.db.run("UPDATE games SET analysis_status = 'none' WHERE id = ? AND analysis_status = 'queued'", id);
      this.queue = [];
    } finally {
      this.running = false;
      this.current = null;
      this.emitStatus();
    }
  }

  private async analyseGame(id: number) {
    const settings = this.lib.settings.engine;
    const plies = this.lib.db.all<{ ply: number; usi: string; sfen: string }>(
      "SELECT ply, usi, sfen FROM plies WHERE game_id = ? ORDER BY ply",
      id,
    );
    const game = this.lib.db.get<{ initial_sfen: string }>("SELECT initial_sfen FROM games WHERE id = ?", id);
    if (!game || !plies.length) return;
    const engine = await this.getEngine();
    const lk = limitKey(settings);
    const limit: SearchLimit = settings.nodes ? { nodes: settings.nodes } : { movetimeMs: settings.movetimeMs };
    const moves: string[] = [];
    for (const p of plies) {
      if (this.stopRequested) break;
      if (p.ply > 0) moves.push(p.usi);
      this.current = { gameId: id, ply: p.ply, total: plies.length - 1 };
      this.emitStatus();
      const cached = this.lib.cachedEval(p.sfen, engine.name, lk);
      if (cached) {
        this.lib.setPlyEval(
          id,
          p.ply,
          { score: cached.score ?? undefined, mate: cached.mate ?? undefined, best: cached.best_usi, pv: cached.pv },
          engine.name,
          lk,
        );
        continue;
      }
      // Send the full move list so the engine sees repetitions.
      const position = `sfen ${game.initial_sfen}` + (moves.length ? ` moves ${moves.join(" ")}` : "");
      const r = await engine.search(position, limit);
      if (this.stopRequested) break;
      this.lib.setPlyEval(id, p.ply, toBlackView(p.sfen, r), engine.name, lk);
    }
    if (this.stopRequested) {
      this.lib.db.run("UPDATE games SET analysis_status = 'none' WHERE id = ? AND analysis_status = 'queued'", id);
      this.lib.regrade(id);
      return;
    }
    this.lib.db.run("UPDATE games SET analysis_status = 'done', analysis_engine = ? WHERE id = ?", engine.name, id);
    this.lib.regrade(id);
    this.emit("gameDone", id);
  }

  async shutdown() {
    this.stop();
    await this.engine?.quit();
  }
}
