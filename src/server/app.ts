// Local HTTP API + static file server. Electron's main process starts this on
// 127.0.0.1 and opens a window on it; `npm run serve` runs the same thing for a
// plain browser tab.
import http from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Db } from "./db.js";
import { Library, GameFilter } from "./library.js";
import { AnalysisQueue, toBlackView } from "./analysis.js";
import { CardFilter, Cards } from "./cards.js";
import { computeStats, playerProfile, similarGames } from "./stats.js";
import { Pages } from "./pages.js";
import { reviewNote } from "./review-note.js";
import { weeklyNote } from "./weekly.js";
import { prepNote } from "./prep.js";
import { findPuzzles } from "./puzzles.js";
import { repertoire } from "./repertoire.js";
import { AutoBackup } from "./backup.js";
import { makeZip } from "./zip.js";
import { todayPlan } from "./today.js";
import { mergeBackup } from "./restore.js";
import { positionSvg } from "../core/diagram.js";
import { loadSettings, saveSettings, AppSettings } from "./settings.js";
import { RecordFileFormat } from "../core/recordFile.js";
import { SearchLine, UsiEngine } from "./engine/usi.js";
import { InitialPositionSFEN, Position } from "tsshogi";
import { explore } from "./explorer.js";
import { syncLishogi } from "./fetchers/sync.js";
import { FolderWatcher } from "./watch.js";
import { BookCache } from "./book.js";
import { insightsFromStats } from "./insights.js";
import { checkGuess, GuessError } from "./guess.js";
import { LanServer } from "./lan.js";
import { Tsume } from "./tsume.js";
import { decodeText } from "../core/encode.js";
import { parseTree } from "../core/movetree.js";
import type { FetchLike } from "./fetchers/lishogi.js";

export type AppOptions = {
  dbPath: string;
  staticDir?: string;
  port?: number;
  host?: string;
  /** Network access for account sync; tests pass a stub. */
  fetchImpl?: FetchLike;
  lishogiBase?: string;
  /** Daily backups next to the database (default on). */
  autoBackup?: boolean;
  /** Interface for phone access (default all, 0.0.0.0); tests use 127.0.0.1. */
  lanHost?: string;
};

type Handler = (req: http.IncomingMessage, url: URL, params: string[], body: unknown) => Promise<unknown> | unknown;

/** Annotation symbols a move can carry ("" clears it). */
export const MOVE_MARKS = ["", "!!", "!", "!?", "?!", "?", "??"];

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return undefined;
  // Binary uploads (a library backup) arrive as-is.
  if (req.headers["content-type"]?.startsWith("application/octet-stream")) return Buffer.concat(chunks);
  const text = Buffer.concat(chunks).toString("utf-8");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

function filterFromQuery(url: URL): GameFilter {
  const q = Object.fromEntries(url.searchParams.entries()) as Record<string, string>;
  return { ...q, desc: q.desc === undefined ? true : q.desc !== "false" } as GameFilter;
}

export function createApp(opts: AppOptions) {
  const db = new Db(opts.dbPath);
  const lib = new Library(db);
  const analysis = new AnalysisQueue(lib);
  const cards = new Cards(lib, analysis);
  const tsume = new Tsume(lib);
  const pages = new Pages(db);
  const backups = new AutoBackup(db, opts.dbPath, () => lib.settings.autoBackupKeep);
  if (opts.autoBackup !== false) backups.start();
  const sseClients = new Set<http.ServerResponse>();

  const broadcast = (event: string, data: unknown) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) res.write(msg);
  };
  analysis.on("status", (s) => broadcast("analysis", s));
  analysis.on("gameDone", (id) => broadcast("gameDone", { id }));

  const afterImport = (added: number[]) => {
    if (added.length && lib.settings.autoAnalyze && lib.settings.engine.path) analysis.enqueue(added);
    broadcast("library", { added: added.length });
  };
  const watcher = new FolderWatcher(lib, (r) => afterImport(r.added));
  const books = new BookCache();
  const loadBook = async () => {
    try {
      return await books.get(lib.settings.bookPath);
    } catch (e) {
      throw new HttpError(400, `Could not read the opening book: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  watcher.configure(lib.settings.watchFolders);

  const routes: [string, RegExp, Handler][] = [];
  const route = (method: string, pattern: string, h: Handler) => {
    const re = new RegExp("^" + pattern.replace(/:(\w+)/g, "([^/]+)") + "$");
    routes.push([method, re, h]);
  };
  const id = (p: string[]) => {
    const n = Number(p[0]);
    if (!Number.isInteger(n)) throw new HttpError(400, "bad id");
    return n;
  };

  // ---- import
  route("POST", "/api/import", (_req, _url, _p, body) => {
    const b = body as { files?: { name: string; data: string }[]; text?: string };
    const results = [];
    for (const f of b.files ?? []) {
      results.push(lib.importBuffer(Buffer.from(f.data, "base64"), f.name));
    }
    if (b.text) {
      // Several games pasted at once are split on blank-line-separated headers is risky; keep one.
      results.push(lib.importText(b.text));
    }
    const added = results.filter((r) => r.status === "added").map((r) => (r as { id: number }).id);
    if (added.length && lib.settings.autoAnalyze && lib.settings.engine.path) analysis.enqueue(added);
    broadcast("library", { added: added.length });
    return { results };
  });

  // ---- account sync
  route("POST", "/api/sync/lishogi", async (_r, _u, _p, body) => {
    const b = (body ?? {}) as { username?: string; full?: boolean };
    const username = (b.username ?? lib.settings.accounts.lishogi).trim();
    if (!username) throw new HttpError(400, "Set your Lishogi username in Settings first");
    let r;
    try {
      r = await syncLishogi(lib, username, { fetchImpl: opts.fetchImpl, base: opts.lishogiBase, full: b.full });
    } catch (e) {
      throw new HttpError(502, e instanceof Error ? e.message : String(e));
    }
    afterImport(r.added);
    return r;
  });
  route("POST", "/api/watch/scan", async () => {
    const r = await watcher.scan();
    afterImport(r.added);
    return r;
  });

  // ---- games
  route("GET", "/api/games", (_req, url) => lib.listGames(filterFromQuery(url)));
  route("GET", "/api/facets", () => lib.facets());
  route("GET", "/api/games/:id", (_r, _u, p) => {
    const g = lib.getGame(id(p));
    if (!g) throw new HttpError(404, "game not found");
    return g;
  });
  route("PATCH", "/api/games/:id", (_r, _u, p, body) => {
    lib.updateGame(id(p), body as Parameters<Library["updateGame"]>[1]);
    return { ok: true };
  });
  route("DELETE", "/api/games/:id", (_r, _u, p) => {
    lib.deleteGame(id(p));
    broadcast("library", {});
    return { ok: true };
  });
  route("PUT", "/api/games/:id/marks/:ply", (_r, _u, p, body) => {
    const mark = (body as { mark: string }).mark ?? "";
    if (!MOVE_MARKS.includes(mark)) throw new HttpError(400, "unknown mark");
    lib.setMark(id(p), Number(p[1]), mark);
    return { ok: true };
  });
  route("PUT", "/api/games/:id/comments/:ply", (_r, _u, p, body) => {
    lib.setComment(id(p), Number(p[1]), (body as { comment: string }).comment ?? "");
    return { ok: true };
  });
  route("GET", "/api/explorer", (_r, url) => {
    const side = url.searchParams.get("side") ?? "";
    return explore(lib, url.searchParams.get("sfen") || InitialPositionSFEN.STANDARD, {
      side: side === "black" || side === "white" ? side : "",
      source: url.searchParams.get("source") ?? "",
      opponent: url.searchParams.get("opponent") ?? "",
    });
  });

  route("GET", "/api/position-search", (_r, url) => {
    const sfen = url.searchParams.get("sfen") ?? "";
    const hits = lib.findPosition(sfen);
    const games = new Map(lib.listGames().map((g) => [g.id, g]));
    return hits.filter((h) => games.has(h.gameId)).map((h) => ({ ...h, game: games.get(h.gameId) }));
  });

  // ---- smart collections (saved filters)
  route("GET", "/api/collections", () =>
    db.all<{ id: number; name: string; filter: string }>("SELECT * FROM collections ORDER BY name").map((c) => ({ ...c, filter: JSON.parse(c.filter) })),
  );
  route("POST", "/api/collections", (_r, _u, _p, body) => {
    const b = body as { name: string; filter: GameFilter };
    const r = db.run("INSERT INTO collections (name, filter) VALUES (?, ?)", b.name, JSON.stringify(b.filter ?? {}));
    return { id: Number(r.lastInsertRowid) };
  });
  route("DELETE", "/api/collections/:id", (_r, _u, p) => {
    db.run("DELETE FROM collections WHERE id = ?", id(p));
    return { ok: true };
  });
  route("POST", "/api/games/bulk-tag", (_r, _u, _p, body) => {
    const b = body as { ids: number[]; tag: string; remove?: boolean };
    for (const gid of b.ids) {
      if (b.remove) db.run("DELETE FROM tags WHERE game_id = ? AND tag = ?", gid, b.tag);
      else db.run("INSERT OR IGNORE INTO tags (game_id, tag) VALUES (?, ?)", gid, b.tag);
    }
    return { ok: true };
  });

  // ---- analysis
  route("POST", "/api/analysis", (_r, _u, _p, body) => {
    const b = (body ?? {}) as { ids?: number[]; all?: boolean; force?: boolean };
    const ids = b.all ? lib.listGames({ sort: "date", desc: true }).map((g) => g.id) : (b.ids ?? []);
    analysis.enqueue(ids, { force: b.force });
    return analysis.status();
  });
  route("GET", "/api/analysis", () => analysis.status());
  route("POST", "/api/analysis/stop", () => {
    analysis.stop();
    return analysis.status();
  });
  route("POST", "/api/mate", async (_r, _u, _p, body) => {
    const b = body as { sfen: string; timeMs?: number };
    const pos = Position.newBySFEN(b.sfen);
    if (!pos) throw new HttpError(400, "bad sfen");
    const timeMs = Math.min(Math.max(b.timeMs ?? 5000, 100), 60_000);
    const r = await analysis.mateSearch(`sfen ${pos.sfen}`, timeMs);
    return r.status === "mate" ? { ...r, text: Library.pvText(pos.sfen, r.moves.join(" ")) } : r;
  });
  route("POST", "/api/analyze-position", async (_r, _u, _p, body) => {
    const b = body as { sfen: string; moves?: string[]; multipv?: number; movetimeMs?: number };
    const pos = Position.newBySFEN(b.sfen);
    if (!pos) throw new HttpError(400, "bad sfen");
    for (const u of b.moves ?? []) {
      const m = pos.createMoveByUSI(u);
      if (!m || !pos.doMove(m)) throw new HttpError(400, `illegal move ${u}`);
    }
    const position = `sfen ${b.sfen}` + (b.moves?.length ? ` moves ${b.moves.join(" ")}` : "");
    const r = await analysis.searchPosition(position, pos.sfen, b.movetimeMs ? { movetimeMs: b.movetimeMs } : undefined, b.multipv ?? 1);
    const sign = pos.color === "black" ? 1 : -1;
    return {
      ...r,
      lines: r.lines.map((l) => ({
        ...l,
        score: l.scoreCP !== undefined ? sign * l.scoreCP : undefined,
        mate: l.scoreMate !== undefined ? sign * l.scoreMate : undefined,
        text: Library.pvText(pos.sfen, l.pv.join(" ")),
      })),
    };
  });

  // ---- export
  route("GET", "/api/book", async (_r, url) => {
    const book = await loadBook();
    if (!book) return { configured: false, moves: [] };
    const sfen = url.searchParams.get("sfen") || InitialPositionSFEN.STANDARD;
    return { configured: true, moves: book.moves(sfen).map((m) => ({ ...m, text: Library.moveText(sfen, m.usi) })) };
  });
  route("POST", "/api/games/:id/guess", async (_r, _u, p, body) => {
    const b = body as { ply: number; usi: string };
    try {
      return await checkGuess(lib, analysis, id(p), Number(b.ply), String(b.usi));
    } catch (e) {
      if (e instanceof GuessError || /illegal move/.test(String(e))) throw new HttpError(400, (e as Error).message);
      throw e;
    }
  });
  route("GET", "/api/games/:id/branches", (_r, _u, p) => lib.branches(id(p)));
  route("POST", "/api/games/:id/variations", (_r, _u, p, body) => {
    let tree;
    try {
      tree = parseTree(String((body as { tree?: string }).tree ?? ""));
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : String(e));
    }
    const n = lib.mergeVariations(id(p), tree);
    if (n === null) throw new HttpError(404, "game not found");
    return { branches: n };
  });
  route("GET", "/api/games/:id/similar", (_r, _u, p) => similarGames(lib, id(p)));
  route("GET", "/api/games/:id/book", async (_r, _u, p) => {
    const book = await loadBook();
    if (!book) return { configured: false, inBook: [], leftBookAt: null, alternatives: [] };
    const plies = db.all<{ ply: number; usi: string; sfen: string }>("SELECT ply, usi, sfen FROM plies WHERE game_id = ? ORDER BY ply", id(p));
    if (!plies.length) throw new HttpError(404, "game not found");
    const inBook: number[] = [];
    let leftBookAt: number | null = null;
    let alternatives: { usi: string; text: string; count: number | null }[] = [];
    for (let k = 1; k < plies.length; k++) {
      const before = plies[k - 1].sfen;
      const moves = book.moves(before);
      if (moves.some((m) => m.usi === plies[k].usi)) {
        inBook.push(k);
        continue;
      }
      leftBookAt = k;
      alternatives = moves.slice(0, 3).map((m) => ({ usi: m.usi, text: Library.moveText(before, m.usi), count: m.count }));
      break;
    }
    return { configured: true, inBook, leftBookAt, alternatives };
  });
  // Every game matching the library filter, one file each, in a zip.
  route("GET", "/api/export/games", async (_r, url) => {
    const fmt = url.searchParams.get("format") === "csa" ? RecordFileFormat.CSA : RecordFileFormat.KIF;
    const utf8 = url.searchParams.get("utf8") === "1";
    const safe = (t: string) => t.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40);
    const files = [];
    const list = lib.listGames(filterFromQuery(url));
    for (const [i, g] of list.entries()) {
      // Let other requests (and the analysis queue) through on big exports.
      if (i % 100 === 99) await new Promise((r) => setImmediate(r));
      const r = lib.exportGame(g.id, fmt, utf8);
      if (!r) continue;
      const name = `${g.date.slice(0, 10) || "nodate"}_${safe(g.black || "先手")}_vs_${safe(g.white || "後手")}_${g.id}${fmt}`;
      files.push({ name, data: r.data, date: g.date ? new Date(g.date.replace(" ", "T")) : undefined });
    }
    const valid = (d?: Date) => (d && !Number.isNaN(d.getTime()) ? d : undefined);
    const zip = makeZip(files.map((f) => ({ ...f, date: valid(f.date) })));
    return { __raw: zip, type: "application/zip", name: `kifu-study-${files.length}-games.zip` };
  });
  route("GET", "/api/diagram.svg", (_r, url) => {
    const sfen = url.searchParams.get("sfen") ?? "";
    if (!Position.newBySFEN(sfen)) throw new HttpError(400, "bad sfen");
    const svg = positionSvg(sfen, {
      lastMove: url.searchParams.get("last") ?? undefined,
      flip: url.searchParams.get("flip") === "1",
      caption: url.searchParams.get("caption") ?? undefined,
    });
    return { __raw: Buffer.from(svg, "utf8"), type: "image/svg+xml", name: url.searchParams.get("download") === "1" ? "position.svg" : undefined };
  });
  route("GET", "/api/games/:id/export", (_r, url, p) => {
    const fmt = (url.searchParams.get("format") ?? "kif") as string;
    const formats: Record<string, RecordFileFormat> = {
      kif: RecordFileFormat.KIF,
      kifu: RecordFileFormat.KIFU,
      ki2: RecordFileFormat.KI2,
      csa: RecordFileFormat.CSA,
      jkf: RecordFileFormat.JKF,
      sfen: RecordFileFormat.SFEN,
    };
    const f = formats[fmt];
    if (!f) throw new HttpError(400, "unknown format");
    const r = lib.exportGame(id(p), f, url.searchParams.get("utf8") === "1");
    if (!r) throw new HttpError(404, "game not found");
    return { __raw: r.data, type: "application/octet-stream", name: `game-${p[0]}${f}` };
  });

  route("GET", "/api/games/:id/note", (_r, url, p) => {
    const portable = url.searchParams.get("portable") === "1";
    const n = reviewNote(lib, id(p), { portable });
    if (!n) throw new HttpError(404, "game not found");
    if (url.searchParams.get("download") === "1") return { __raw: Buffer.from(n.body, "utf8"), type: "text/markdown; charset=utf-8", name: `game-${p[0]}.mdx` };
    return n;
  });
  route("POST", "/api/games/:id/note", (_r, _u, p) => {
    const n = reviewNote(lib, id(p));
    if (!n) throw new HttpError(404, "game not found");
    return pages.create({ title: n.title, notebook: "Game reviews", body: n.body });
  });

  route("POST", "/api/notes/prep", (_r, _u, _p, body) => {
    const n = prepNote(lib, String((body as { opponent?: string }).opponent ?? ""));
    if (!n) throw new HttpError(404, "no games against that opponent");
    return pages.create({ title: n.title, notebook: "Opponents", body: n.body });
  });
  route("POST", "/api/notes/weekly", () => {
    const n = weeklyNote(lib);
    return pages.create({ title: n.title, notebook: "Weekly", body: n.body });
  });

  // ---- stats
  route("GET", "/api/stats", (_r, url) => computeStats(lib, filterFromQuery(url)));
  route("GET", "/api/insights", () => insightsFromStats(computeStats(lib), cards.counts()));
  route("GET", "/api/players/:name", (_r, _u, p) => {
    const prof = playerProfile(lib, decodeURIComponent(p[0]));
    if (!prof.games.length) throw new HttpError(404, "no games against that player");
    return prof;
  });

  // ---- cards
  // A deck's filter from the query string; ?deck=<id> starts from a saved deck.
  const cardFilter = (url: URL): CardFilter => {
    const q = url.searchParams;
    const deckId = Number(q.get("deck"));
    const base = deckId ? (cards.decks().find((d) => d.id === deckId)?.filter ?? {}) : {};
    const f: CardFilter = { ...base, due: q.get("due") === "1" };
    for (const k of ["kind", "phase", "opening", "myOpening", "opponent", "tag", "moveKind", "side"] as const) {
      const v = q.get(k);
      if (v) f[k] = v;
    }
    if (q.get("leech") === "1") f.leech = true;
    return f;
  };
  route("GET", "/api/cards", (_r, url) => cards.list(cardFilter(url)));
  route("GET", "/api/cards/facets", () => cards.facets());
  route("GET", "/api/cards/export/anki", (_r, url) => ({
    __raw: Buffer.from(cards.exportAnki({ ...cardFilter(url), due: false })),
    type: "text/tab-separated-values; charset=utf-8",
    name: "kifu-study-cards.txt",
  }));
  route("GET", "/api/decks", () => cards.decks());
  route("POST", "/api/decks", (_r, _u, _p, body) => {
    const b = body as { name?: string; filter?: CardFilter };
    if (!b.name?.trim()) throw new HttpError(400, "a deck needs a name");
    return cards.saveDeck(b.name, b.filter ?? {});
  });
  route("DELETE", "/api/decks/:id", (_r, _u, p) => {
    cards.deleteDeck(id(p));
    return { ok: true };
  });
  route("GET", "/api/repertoire", async (_r, url) => {
    const side = url.searchParams.get("side") === "white" ? "white" : "black";
    // A broken book path shouldn't block the drill; it just judges without the book.
    const book = await loadBook().catch(() => null);
    const maxPly = Number(url.searchParams.get("maxPly")) || 24;
    return lib.cached(`repertoire:${side}:${maxPly}:${book?.mtimeMs ?? ""}`, () => repertoire(lib, { side, maxPly, book }));
  });
  route("GET", "/api/today", async () => todayPlan(lib, cards, await loadBook().catch(() => null)));
  route("GET", "/api/puzzles", (_r, url) => {
    const mineOnly = url.searchParams.get("mine") !== "0";
    const all = lib.cached(mineOnly ? "puzzles:mine" : "puzzles:all", () => findPuzzles(lib, { mineOnly }));
    // Each puzzle renders a board; send a page, not thousands.
    const limit = Math.min(Number(url.searchParams.get("limit")) || 60, 500);
    return {
      total: all.length,
      missed: all.filter((p) => p.missed).length,
      puzzles: all.slice(0, limit).map((p) => ({ ...p, bestText: Library.moveText(p.sfen, p.bestUsi) })),
    };
  });
  route("GET", "/api/cards/counts", () => cards.counts());
  route("GET", "/api/cards/activity", (_r, url) => cards.activity(Math.min(Math.max(Number(url.searchParams.get("days")) || 182, 7), 730)));
  route("POST", "/api/cards", (_r, _u, _p, body) => {
    const b = body as { gameId: number; ply: number; note?: string; guess?: { usi: string; loss: number | null; level: number; best?: string; pv?: string } };
    return cards.create(b.gameId, b.ply, b.note, b.guess);
  });
  route("GET", "/api/cards/:id", (_r, _u, p) => cards.get(id(p)) ?? Promise.reject(new HttpError(404, "card not found")));
  route("POST", "/api/cards/:id/answer", (_r, _u, p, body) => cards.answer(id(p), (body as { usi: string }).usi));
  route("POST", "/api/cards/:id/rate", (_r, _u, p, body) => {
    const b = body as { rating: "again" | "hard" | "good" | "easy"; usi?: string; loss?: number | null };
    return cards.rate(id(p), b.rating, b.usi, b.loss ?? null);
  });
  route("PATCH", "/api/cards/:id", (_r, _u, p, body) => {
    cards.update(id(p), body as { suspended?: boolean; note?: string });
    return { ok: true };
  });
  route("DELETE", "/api/cards/:id", (_r, _u, p) => {
    cards.delete(id(p));
    return { ok: true };
  });

  // ---- notebooks
  route("GET", "/api/pages", () => pages.list());
  route("GET", "/api/pages/:id", (_r, _u, p) => pages.get(id(p)) ?? Promise.reject(new HttpError(404, "page not found")));
  route("POST", "/api/pages", (_r, _u, _p, body) => pages.create(body as { title: string; notebook?: string; body?: string }));
  route("PUT", "/api/pages/:id", (_r, _u, p, body) => pages.update(id(p), body as { title?: string; notebook?: string; body?: string }));
  route("POST", "/api/pages/:id/append", (_r, _u, p, body) => pages.append(id(p), (body as { text: string }).text));
  route("DELETE", "/api/pages/:id", (_r, _u, p) => {
    pages.delete(id(p));
    return { ok: true };
  });

  // ---- settings
  route("POST", "/api/restore", async (_r, _u, _p, body) => {
    if (!Buffer.isBuffer(body) || body.length < 100) throw new HttpError(400, "Send the backup file as application/octet-stream.");
    if (body.subarray(0, 15).toString("latin1") !== "SQLite format 3") throw new HttpError(400, "This file is not a Kifu Study library.");
    const dir = await mkdtemp(path.join(os.tmpdir(), "kifu-restore-"));
    try {
      const file = path.join(dir, "backup.db");
      await writeFile(file, body);
      let r;
      try {
        r = mergeBackup(lib, file);
      } catch (e) {
        throw new HttpError(400, e instanceof Error ? e.message : String(e));
      }
      broadcast("library", { added: r.added });
      return r;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  route("GET", "/api/backups", () => ({ dir: backups.dir, keep: lib.settings.autoBackupKeep, files: backups.list() }));
  route("POST", "/api/backups/run", () => ({ made: backups.runIfDue(), files: backups.list() }));
  route("GET", "/api/backup", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kifu-backup-"));
    const file = path.join(dir, "library.db");
    try {
      db.backupTo(file);
      const stamp = new Date().toISOString().slice(0, 10);
      return { __raw: await readFile(file), type: "application/vnd.sqlite3", name: `kifu-study-${stamp}.db` };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  route("GET", "/api/settings", () => loadSettings(db));
  route("PUT", "/api/settings", (_r, _u, _p, body) => {
    const prev = loadSettings(db);
    const next = { ...prev, ...(body as Partial<AppSettings>) };
    saveSettings(db, next);
    if (JSON.stringify(next.watchFolders) !== JSON.stringify(prev.watchFolders)) watcher.configure(next.watchFolders);
    // Names decide "my side"; regrade so cards follow.
    for (const g of db.all<{ id: number }>("SELECT id FROM games WHERE analysis_status IN ('done','imported')")) lib.regrade(g.id);
    return next;
  });
  // ---- tsume collections
  route("GET", "/api/tsume", () => tsume.collections());
  route("GET", "/api/tsume/problems", (_r, url) => tsume.list(url.searchParams.get("collection") ?? ""));
  route("POST", "/api/tsume/import", (_r, _u, _p, body) => {
    const b = body as { text?: string; base64?: string; collection?: string; fileName?: string };
    const text = b.base64 ? decodeText(new Uint8Array(Buffer.from(b.base64, "base64"))) : (b.text ?? "");
    return tsume.import(text, b.collection ?? "", b.fileName ?? "");
  });
  route("POST", "/api/tsume/:id/result", (_r, _u, p, body) => tsume.record(id(p), !!(body as { solved: boolean }).solved) ?? Promise.reject(new HttpError(404, "no such problem")));
  route("DELETE", "/api/tsume", (_r, url) => tsume.deleteCollection(url.searchParams.get("collection") ?? ""));

  route("GET", "/api/lan", () => lan.info());
  route("PUT", "/api/lan", (_r, _u, _p, body) => {
    const b = body as { enabled?: boolean; port?: number };
    const port = b.port === undefined ? undefined : Number(b.port);
    if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port < 65536)) throw new HttpError(400, "bad port");
    return lan.configure({ ...(b.enabled !== undefined ? { enabled: !!b.enabled } : {}), ...(port !== undefined ? { port } : {}) });
  });
  route("POST", "/api/lan/token", () => lan.rotateToken());
  route("POST", "/api/engine/test", async (_r, _u, _p, body) => {
    const b = body as { path: string };
    const e = new UsiEngine(b.path);
    try {
      await e.start();
      const r = await e.search("startpos", { movetimeMs: 300 });
      return { ok: true, name: e.name, author: e.author, options: e.options, bestmove: r.bestmove };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err), log: e.log.slice(-20) };
    } finally {
      await e.quit();
    }
  });

  // ---- events
  const handleEvents = (req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`event: analysis\ndata: ${JSON.stringify(analysis.status())}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
  };

  // One streamed search: "lines" events while the engine thinks, then "done".
  // Closing the stream stops the search.
  const LIVE_MAX_MS = 5 * 60_000;
  const handleLive = async (res: http.ServerResponse, url: URL) => {
    const q = url.searchParams;
    const pos = Position.newBySFEN(q.get("sfen") ?? "");
    const moves = (q.get("moves") ?? "").split(/\s+/).filter(Boolean);
    let ok = !!pos;
    for (const u of moves) {
      const m = ok ? pos!.createMoveByUSI(u) : null;
      if (!m || !pos!.doMove(m)) ok = false;
    }
    if (!ok) throw new HttpError(400, "bad position");
    const sign = pos!.color === "black" ? 1 : -1;
    const sfenAfter = pos!.sfen;
    const position = `sfen ${q.get("sfen")}` + (moves.length ? ` moves ${moves.join(" ")}` : "");
    const view = (lines: SearchLine[]) =>
      lines.map((l) => ({
        multipv: l.multipv,
        pv: l.pv,
        depth: l.depth,
        nodes: l.nodes,
        scoreCP: l.scoreCP,
        score: l.scoreCP !== undefined ? sign * l.scoreCP : undefined,
        mate: l.scoreMate !== undefined ? sign * l.scoreMate : undefined,
        text: Library.pvText(sfenAfter, l.pv.join(" ")),
      }));
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const t0 = Date.now();
    // At most five updates a second; the last one is always sent with "done".
    let last = 0;
    let pending: SearchLine[] | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      flushTimer = undefined;
      if (!pending) return;
      send("lines", { lines: view(pending), elapsedMs: Date.now() - t0 });
      pending = null;
      last = Date.now();
    };
    try {
      const r = await analysis.liveSearch(position, {
        multipv: Math.min(Math.max(Number(q.get("multipv")) || 1, 1), 5),
        maxMs: Math.min(Math.max(Number(q.get("maxMs")) || 10_000, 100), LIVE_MAX_MS),
        signal: abort.signal,
        onLines: (lines) => {
          pending = lines;
          if (!flushTimer) flushTimer = setTimeout(flush, Math.max(0, 200 - (Date.now() - last)));
        },
      });
      clearTimeout(flushTimer);
      pending = null;
      send("done", { ...toBlackView(sfenAfter, r), lines: view(r.lines), elapsedMs: Date.now() - t0 });
    } catch (e) {
      clearTimeout(flushTimer);
      if (!abort.signal.aborted) send("failed", { error: e instanceof Error ? e.message : String(e) });
    } finally {
      res.end();
    }
  };

  const serveStatic = async (url: URL, res: http.ServerResponse) => {
    if (!opts.staticDir) {
      res.writeHead(404).end();
      return;
    }
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
    let file = path.resolve(opts.staticDir, rel);
    if (!file.startsWith(path.resolve(opts.staticDir))) {
      res.writeHead(403).end();
      return;
    }
    try {
      if (!(await stat(file)).isFile()) throw new Error();
    } catch {
      file = path.join(opts.staticDir, "index.html"); // SPA fallback
    }
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
    res.end(data);
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/api/events") return handleEvents(req, res);
      if (url.pathname === "/api/live" && req.method === "GET") return await handleLive(res, url);
      if (!url.pathname.startsWith("/api/")) return await serveStatic(url, res);
      for (const [method, re, h] of routes) {
        const m = re.exec(url.pathname);
        if (m && method === req.method) {
          const body = req.method === "GET" ? undefined : await readBody(req);
          const out = (await h(req, url, m.slice(1), body)) as { __raw?: Uint8Array; type?: string; name?: string };
          if (out && out.__raw) {
            // No name: shown inline (e.g. a diagram used as an <img>).
            res.writeHead(200, {
              "Content-Type": out.type!,
              ...(out.name ? { "Content-Disposition": `attachment; filename="${out.name}"` } : {}),
            });
            res.end(Buffer.from(out.__raw));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(out ?? null));
          return;
        }
      }
      throw new HttpError(404, "not found");
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
  };
  const server = http.createServer(handle);
  const lan = new LanServer(db, handle, opts.lanHost);
  if (lan.config().enabled) void lan.start();

  return {
    db,
    lib,
    analysis,
    cards,
    server,
    lan,
    /** Import files opened from the OS (double-click, "Open with"); returns the game to show, if any. */
    async importPaths(paths: string[]): Promise<number | undefined> {
      const added: number[] = [];
      let show: number | undefined;
      for (const file of paths) {
        try {
          const r = lib.importBuffer(new Uint8Array(await readFile(file)), path.basename(file));
          if (r.status === "added") added.push(r.id);
          if (r.status !== "error") show ??= r.id;
        } catch {
          /* unreadable file: skip */
        }
      }
      afterImport(added);
      return show;
    },
    listen(): Promise<number> {
      return new Promise((resolve) => {
        server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => {
          const addr = server.address();
          resolve(typeof addr === "object" && addr ? addr.port : 0);
        });
      });
    },
    async close() {
      watcher.close();
      backups.stop();
      for (const r of sseClients) r.end();
      await analysis.shutdown();
      await lan.stop();
      await new Promise<void>((r) => server.close(() => r()));
      db.close();
    },
  };
}
