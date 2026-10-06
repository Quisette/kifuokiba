// A USI engine wrapper for analysis: one position at a time, no pondering.
// The process handling (ChildProcess) and info parsing come from ShogiHome
// (MIT); the state handling is a smaller version of ShogiHome's EngineProcess.
import { ChildProcess } from "./process.js";
import { parseInfoCommand } from "./info.js";
import { USIInfoCommand } from "../../core/usi.js";

export type EngineOption = { name: string; type: string; default?: string; min?: number; max?: number; vars?: string[] };

/** Parses a USI "option name … type …" line. */
export function parseOptionLine(line: string): EngineOption | null {
  const m = /^option name (.+?) type (\S+)(.*)$/.exec(line.trim());
  if (!m) return null;
  const o: EngineOption = { name: m[1], type: m[2] };
  const re = /\b(default|min|max|var) (\S*)/g;
  let t: RegExpExecArray | null;
  while ((t = re.exec(m[3]))) {
    if (t[1] === "default") o.default = t[2] === "<empty>" ? "" : t[2];
    else if (t[1] === "min") o.min = Number(t[2]);
    else if (t[1] === "max") o.max = Number(t[2]);
    else (o.vars ??= []).push(t[2]);
  }
  return o;
}

export type SearchLimit = {
  movetimeMs?: number;
  nodes?: number;
  depth?: number;
  /** "go infinite": runs until stop() or the signal aborts it. */
  infinite?: boolean;
};

export type SearchLine = {
  multipv: number;
  /** From the side to move's point of view. */
  scoreCP?: number;
  scoreMate?: number;
  pv: string[];
  depth?: number;
  nodes?: number;
};

export type MateResult = { status: "mate"; moves: string[] } | { status: "nomate" | "timeout" | "notimplemented" };

export type SearchResult = {
  bestmove: string; // "resign" / "win" possible
  lines: SearchLine[]; // index 0 = multipv 1
};

const LAUNCH_TIMEOUT_MS = 30_000;

export class UsiEngine {
  private proc: ChildProcess | null = null;
  private lineHandlers: ((line: string) => void)[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  name = "";
  author = "";
  options: EngineOption[] = [];
  log: string[] = [];

  constructor(
    readonly path: string,
    private readonly setOptions: Record<string, string | number> = {},
  ) {}

  get running(): boolean {
    return !!this.proc && !this.closed;
  }

  private send(line: string) {
    this.log.push("> " + line);
    if (this.log.length > 200) this.log.shift();
    this.proc?.send(line);
  }

  private waitFor(pred: (line: string) => boolean, timeoutMs: number, onLine?: (line: string) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              cleanup();
              reject(new Error(`engine timeout (${this.path})`));
            }, timeoutMs)
          : undefined;
      const handler = (line: string) => {
        onLine?.(line);
        if (pred(line)) {
          cleanup();
          resolve(line);
        }
      };
      const onClose = () => {
        cleanup();
        reject(new Error(`The engine stopped unexpectedly${this.exitInfo ? ` (${this.exitInfo})` : ""}. Analysis paused; start it again to continue.`));
      };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        this.lineHandlers = this.lineHandlers.filter((h) => h !== handler);
        this.closeHandlers = this.closeHandlers.filter((h) => h !== onClose);
      };
      this.lineHandlers.push(handler);
      this.closeHandlers.push(onClose);
    });
  }
  private closeHandlers: (() => void)[] = [];
  private exitInfo = "";

  async start(): Promise<void> {
    this.proc = new ChildProcess(this.path);
    this.proc.on("receive", (line: string) => {
      this.log.push("< " + line);
      if (this.log.length > 200) this.log.shift();
      for (const h of [...this.lineHandlers]) h(line);
    });
    const failed = new Promise<never>((_, reject) => {
      this.proc!.on("error", (e: Error) => reject(e));
    });
    failed.catch(() => undefined);
    this.proc.on("close", (code, signal) => {
      this.closed = true;
      this.exitInfo = signal ? `signal ${signal}` : code !== null ? `exit code ${code}` : "";
      for (const h of [...this.closeHandlers]) h();
    });
    this.send("usi");
    await Promise.race([
      this.waitFor(
        (l) => l === "usiok",
        LAUNCH_TIMEOUT_MS,
        (l) => {
          if (l.startsWith("id name ")) this.name = l.slice(8);
          else if (l.startsWith("id author ")) this.author = l.slice(10);
          else if (l.startsWith("option name ")) {
            const o = parseOptionLine(l);
            if (o) this.options.push(o);
          }
        },
      ),
      failed,
    ]);
    for (const [k, v] of Object.entries(this.setOptions)) {
      if (this.options.some((o) => o.name === k)) {
        this.send(`setoption name ${k} value ${v}`);
      }
    }
    this.send("isready");
    await Promise.race([this.waitFor((l) => l === "readyok", LAUNCH_TIMEOUT_MS), failed]);
    this.send("usinewgame");
  }

  hasOption(name: string): boolean {
    return this.options.some((o) => o.name === name);
  }

  /**
   * Search one position. `position` is a USI position command body, e.g.
   * "startpos moves 7g7f" or "sfen ... moves ...". Calls are serialised.
   */
  search(
    position: string,
    limit: SearchLimit,
    opts: { multipv?: number; onInfo?: (info: USIInfoCommand) => void; onLines?: (lines: SearchLine[]) => void; onStart?: () => void; signal?: AbortSignal } = {},
  ): Promise<SearchResult> {
    const run = async () => {
      // Cancelled while waiting for the engine: never sent.
      if (opts.signal?.aborted) throw new Error("search cancelled");
      if (!this.running) throw new Error("engine is not running");
      const multipv = opts.multipv ?? 1;
      if (this.hasOption("MultiPV")) this.send(`setoption name MultiPV value ${multipv}`);
      const lines = new Map<number, SearchLine>();
      this.send(`position ${position}`);
      const go = limit.infinite
        ? "go infinite"
        : limit.nodes
          ? `go nodes ${limit.nodes}`
          : limit.depth
            ? `go depth ${limit.depth}`
            : `go movetime ${limit.movetimeMs ?? 1000}`;
      this.send(go);
      opts.onStart?.();
      // A running search that is aborted is stopped; its bestmove still arrives and ends it.
      const onAbort = () => this.send("stop");
      opts.signal?.addEventListener("abort", onAbort);
      const budget = limit.infinite ? 0 : (limit.movetimeMs ?? 0) + 60_000;
      const sortedLines = () => [...lines.values()].sort((a, b) => a.multipv - b.multipv);
      const best = await this.waitFor(
        (l) => l.startsWith("bestmove"),
        budget,
        (l) => {
          if (!l.startsWith("info ")) return;
          const info = parseInfoCommand(l.slice(5));
          opts.onInfo?.(info);
          if (info.lowerbound || info.upperbound) return;
          if (info.scoreCP === undefined && info.scoreMate === undefined) return;
          const k = info.multipv ?? 1;
          lines.set(k, {
            multipv: k,
            scoreCP: info.scoreMate === undefined ? info.scoreCP : undefined,
            scoreMate: info.scoreMate,
            pv: info.pv ?? lines.get(k)?.pv ?? [],
            depth: info.depth,
            nodes: info.nodes,
          });
          opts.onLines?.(sortedLines());
        },
      ).finally(() => opts.signal?.removeEventListener("abort", onAbort));
      const bestmove = best.split(" ")[1] ?? "resign";
      const sorted = sortedLines();
      if (sorted.length && bestmove !== "resign" && bestmove !== "win" && sorted[0].pv[0] !== bestmove) {
        sorted[0].pv = [bestmove];
      }
      return { bestmove, lines: sorted };
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /**
   * Mate search ("go mate"). Engines with a mate solver answer "checkmate <moves>",
   * "checkmate nomate", "checkmate timeout" or "checkmate notimplemented"; an engine
   * that runs a normal search instead is judged by the mate score it reports.
   */
  mate(position: string, timeMs: number): Promise<MateResult> {
    const run = async (): Promise<MateResult> => {
      if (!this.running) throw new Error("engine is not running");
      this.send(`position ${position}`);
      this.send(`go mate ${timeMs}`);
      // Some builds treat "go mate" as an unbounded normal search; stop them at the limit.
      // A mate score in that search's output still answers the question.
      let mateLine: string[] | null = null;
      const timer = setTimeout(() => this.send("stop"), timeMs + 200);
      try {
        const line = await this.waitFor(
          (l) => l.startsWith("checkmate") || l.startsWith("bestmove"),
          timeMs + 30_000,
          (l) => {
            if (!l.startsWith("info ")) return;
            const info = parseInfoCommand(l.slice(5));
            if (info.scoreMate !== undefined && info.scoreMate > 0 && info.pv?.length) mateLine = info.pv;
            else if (info.scoreCP !== undefined) mateLine = null;
          },
        );
        if (line.startsWith("bestmove")) return mateLine ? { status: "mate", moves: mateLine } : { status: "nomate" };
        const rest = line.slice("checkmate".length).trim();
        if (rest === "nomate") return { status: "nomate" };
        if (rest === "timeout" || rest === "") return { status: "timeout" };
        if (rest === "notimplemented") return { status: "notimplemented" };
        return { status: "mate", moves: rest.split(/\s+/) };
      } finally {
        clearTimeout(timer);
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  stop(): void {
    if (this.running) this.send("stop");
  }

  async quit(): Promise<void> {
    if (!this.proc || this.closed) return;
    this.send("quit");
    const proc = this.proc;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        proc.kill();
        resolve();
      }, 3000);
      this.closeHandlers.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}
