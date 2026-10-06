// Background analysis queue. Per game it walks every position like ShogiHome's
// analysis loop (src/renderer/store/analysis.ts), but stores results in the
// library DB and reuses cached evals for positions seen in earlier games.
import { EventEmitter } from "node:events";
import { Position } from "tsshogi";
import { Library } from "./library.js";
import { UsiEngine, SearchLimit, SearchLine, SearchResult } from "./engine/usi.js";
import { EngineSettings } from "./settings.js";
import { passedPosition } from "../core/threat.js";

export type AnalysisStatus = {
  running: boolean;
  engineName: string;
  current: { gameId: number; ply: number; total: number; verifying?: { done: number; total: number } } | null;
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

  /**
   * A search that runs until `maxMs` or until the signal aborts it, reporting
   * its lines (side to move's view) as the engine deepens.
   */
  async liveSearch(position: string, opts: { multipv: number; maxMs: number; signal: AbortSignal; onLines: (lines: SearchLine[]) => void }) {
    const e = await this.getEngine();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await e.search(position, { infinite: true }, {
        multipv: opts.multipv,
        signal: opts.signal,
        // The time limit counts from when the engine starts, not from the wait in its queue.
        onStart: () => (timer = setTimeout(() => e.stop(), opts.maxMs)),
        onLines: opts.onLines,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Evaluation (black's view) of the position after `moves` from `initialSfen`, at the
   * analysis settings: from the cache when this position was searched before, else
   * searched now and cached.
   */
  async evalLine(initialSfen: string, moves: string[]) {
    const pos = Position.newBySFEN(initialSfen);
    if (!pos) throw new Error("bad sfen");
    for (const u of moves) {
      const m = pos.createMoveByUSI(u);
      if (!m || !pos.doMove(m)) throw new Error(`illegal move ${u}`);
    }
    const settings = this.lib.settings.engine;
    const e = await this.getEngine();
    const key = limitKey(settings);
    const cached = this.lib.cachedEval(pos.sfen, e.name, key);
    if (cached) return { score: cached.score ?? undefined, mate: cached.mate ?? undefined, best: cached.best_usi, pv: cached.pv };
    const position = `sfen ${initialSfen}` + (moves.length ? ` moves ${moves.join(" ")}` : "");
    const r = toBlackView(pos.sfen, await e.search(position, settings.nodes ? { nodes: settings.nodes } : { movetimeMs: settings.movetimeMs }));
    this.lib.storeEval(pos.sfen, r, e.name, key);
    return r;
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
    const positionAt = (ply: number) =>
      `sfen ${game.initial_sfen}` + (ply > 0 ? ` moves ${plies.slice(1, ply + 1).map((x) => x.usi).join(" ")}` : "");
    // Cached eval for this limit, else a search; the full move list lets the engine see repetitions.
    const evalPly = async (p: (typeof plies)[number], lim: SearchLimit, key: string) => {
      const cached = this.lib.cachedEval(p.sfen, engine.name, key);
      if (cached) {
        this.lib.setPlyEval(id, p.ply, { score: cached.score ?? undefined, mate: cached.mate ?? undefined, best: cached.best_usi, pv: cached.pv }, engine.name, key);
        return;
      }
      const r = await engine.search(positionAt(p.ply), lim);
      if (!this.stopRequested) this.lib.setPlyEval(id, p.ply, toBlackView(p.sfen, r), engine.name, key);
    };
    for (const p of plies) {
      if (this.stopRequested) break;
      this.current = { gameId: id, ply: p.ply, total: plies.length - 1 };
      this.emitStatus();
      await evalPly(p, limit, lk);
    }
    if (this.stopRequested) {
      this.lib.db.run("UPDATE games SET analysis_status = 'none' WHERE id = ? AND analysis_status = 'queued'", id);
      this.lib.regrade(id);
      return;
    }
    // Second look: re-search the positions around each flagged move with more time,
    // so a short search's horizon doesn't turn a fine move into a "mistake".
    this.lib.regrade(id);
    const factor = settings.verifyFactor ?? 0;
    if (factor > 1) {
      const deep: SearchLimit = settings.nodes ? { nodes: settings.nodes * factor } : { movetimeMs: settings.movetimeMs * factor };
      const deepKey = settings.nodes ? `nodes:${settings.nodes * factor}` : `movetime:${settings.movetimeMs * factor}`;
      const flagged = this.lib.db
        .all<{ ply: number }>("SELECT ply FROM plies WHERE game_id = ? AND (level >= 2 OR missed != '') ORDER BY ply", id)
        .flatMap((r) => [r.ply - 1, r.ply]);
      const todo = [...new Set(flagged)].filter((k) => k >= 0 && k < plies.length);
      for (const [i, k] of todo.entries()) {
        if (this.stopRequested) break;
        this.current = { gameId: id, ply: k, total: plies.length - 1, verifying: { done: i, total: todo.length } };
        this.emitStatus();
        await evalPly(plies[k], deep, deepKey);
      }
      if (this.stopRequested) {
        this.lib.db.run("UPDATE games SET analysis_status = 'none' WHERE id = ? AND analysis_status = 'queued'", id);
        this.lib.regrade(id);
        return;
      }
    }
    await this.findThreats(id, engine, limit, lk);
    if (this.stopRequested) {
      this.lib.db.run("UPDATE games SET analysis_status = 'none' WHERE id = ? AND analysis_status = 'queued'", id);
      return;
    }
    this.lib.db.run("UPDATE games SET analysis_status = 'done', analysis_engine = ? WHERE id = ?", engine.name, id);
    this.lib.regrade(id);
    this.emit("gameDone", id);
  }

  /**
   * The threat before each 悪手 or worse: the opponent's best move if the mover had
   * passed. A move whose best reply is that threat ignored it ("missed threat").
   */
  private async findThreats(id: number, engine: UsiEngine, limit: SearchLimit, key: string) {
    const rows = this.lib.db.all<{ ply: number; prev_sfen: string }>(
      `SELECT p.ply, q.sfen prev_sfen FROM plies p JOIN plies q ON q.game_id = p.game_id AND q.ply = p.ply - 1
       WHERE p.game_id = ? AND p.ply > 0 AND p.level >= 3 ORDER BY p.ply`,
      id,
    );
    for (const r of rows) {
      if (this.stopRequested) return;
      const passed = passedPosition(r.prev_sfen);
      let threat = "";
      if (passed) {
        const cached = this.lib.cachedEval(passed, engine.name, key);
        if (cached) threat = cached.best_usi;
        else {
          const e = toBlackView(passed, await engine.search(`sfen ${passed}`, limit));
          this.lib.storeEval(passed, e, engine.name, key);
          threat = e.best;
        }
      }
      this.lib.db.run("UPDATE plies SET threat_usi = ? WHERE game_id = ? AND ply = ?", threat, id, r.ply);
    }
  }

  async shutdown() {
    this.stop();
    await this.engine?.quit();
  }
}
