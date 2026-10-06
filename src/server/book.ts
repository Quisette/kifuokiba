// Opening book in YaneuraOu's text format (#YANEURAOU-DB2016 1.00):
//   sfen <board> <turn> <hand> <ply>
//   <move> <ponder|none> <score|none> <depth|none> <count> [comment]
// Format notes follow ShogiHome's reader (MIT). Loaded into memory, keyed by the
// position without its move number.
import { createReadStream, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { sfenKey } from "./db.js";

export type BookMove = { usi: string; score: number | null; depth: number | null; count: number | null };

const MOVE_RE = /^(?:[1-9][a-i][1-9][a-i]\+?|[RBGSNLP]\*[1-9][a-i]) /;
const num = (s: string | undefined) => (s === undefined || s === "none" || s === "" ? null : Number.isFinite(Number(s)) ? Number(s) : null);

export class OpeningBook {
  private constructor(
    readonly path: string,
    readonly mtimeMs: number,
    private readonly positions: Map<string, BookMove[]>,
  ) {}

  get size() {
    return this.positions.size;
  }

  static async load(path: string): Promise<OpeningBook> {
    const mtimeMs = statSync(path).mtimeMs;
    const positions = new Map<string, BookMove[]>();
    let current: BookMove[] | null = null;
    const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith("//")) continue;
      if (line.startsWith("sfen ")) {
        const key = sfenKey(line);
        current = positions.get(key) ?? [];
        positions.set(key, current);
        continue;
      }
      if (current && MOVE_RE.test(line + " ")) {
        const [usi, , score, depth, count] = line.split(/\s+/);
        if (!current.some((m) => m.usi === usi)) current.push({ usi, score: num(score), depth: num(depth), count: num(count) });
      }
    }
    // Most played (or best scored) first.
    for (const moves of positions.values()) {
      moves.sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || (b.score ?? -1e9) - (a.score ?? -1e9));
    }
    return new OpeningBook(path, mtimeMs, positions);
  }

  moves(sfen: string): BookMove[] {
    return this.positions.get(sfenKey(sfen)) ?? [];
  }
}

/** Keeps one book loaded and reloads it when the path or file changes. */
export class BookCache {
  private book: OpeningBook | null = null;
  private loading: Promise<OpeningBook> | null = null;

  async get(path: string): Promise<OpeningBook | null> {
    if (!path) return null;
    const mtime = statSync(path).mtimeMs;
    if (this.book && this.book.path === path && this.book.mtimeMs === mtime) return this.book;
    this.loading ??= OpeningBook.load(path).finally(() => (this.loading = null));
    this.book = await this.loading;
    return this.book;
  }
}
