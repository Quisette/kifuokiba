// Local HTTP API + static file server. Electron's main process starts this on
// 127.0.0.1 and opens a window on it; `npm run serve` runs the same thing for a
// plain browser tab.
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Db } from "./db.js";
import { Library, GameFilter } from "./library.js";
import { AnalysisQueue } from "./analysis.js";
import { Cards } from "./cards.js";
import { computeStats } from "./stats.js";
import { Pages } from "./pages.js";
import { loadSettings, saveSettings, AppSettings } from "./settings.js";
import { RecordFileFormat } from "../core/recordFile.js";
import { UsiEngine } from "./engine/usi.js";
import { InitialPositionSFEN, Position } from "tsshogi";
import { explore } from "./explorer.js";
import { syncLishogi } from "./fetchers/sync.js";
import type { FetchLike } from "./fetchers/lishogi.js";

export type AppOptions = {
  dbPath: string;
  staticDir?: string;
  port?: number;
  host?: string;
  /** Network access for account sync; tests pass a stub. */
  fetchImpl?: FetchLike;
  lishogiBase?: string;
};

type Handler = (req: http.IncomingMessage, url: URL, params: string[], body: unknown) => Promise<unknown> | unknown;

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
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return undefined;
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
  const pages = new Pages(db);
  const sseClients = new Set<http.ServerResponse>();

  const broadcast = (event: string, data: unknown) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) res.write(msg);
  };
  analysis.on("status", (s) => broadcast("analysis", s));
  analysis.on("gameDone", (id) => broadcast("gameDone", { id }));

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
    if (r.added.length && lib.settings.autoAnalyze && lib.settings.engine.path) analysis.enqueue(r.added);
    broadcast("library", { added: r.added.length });
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
  route("PUT", "/api/games/:id/comments/:ply", (_r, _u, p, body) => {
    lib.setComment(id(p), Number(p[1]), (body as { comment: string }).comment ?? "");
    return { ok: true };
  });
  route("GET", "/api/explorer", (_r, url) => {
    const side = url.searchParams.get("side") ?? "";
    return explore(lib, url.searchParams.get("sfen") || InitialPositionSFEN.STANDARD, {
      side: side === "black" || side === "white" ? side : "",
      source: url.searchParams.get("source") ?? "",
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

  // ---- stats
  route("GET", "/api/stats", (_r, url) => computeStats(lib, filterFromQuery(url)));

  // ---- cards
  route("GET", "/api/cards", (_r, url) =>
    cards.list({
      kind: url.searchParams.get("kind") ?? undefined,
      phase: url.searchParams.get("phase") ?? undefined,
      opening: url.searchParams.get("opening") ?? undefined,
      due: url.searchParams.get("due") === "1",
      leech: url.searchParams.get("leech") === "1",
    }),
  );
  route("GET", "/api/cards/export/anki", (_r, url) => ({
    __raw: Buffer.from(cards.exportAnki({ kind: url.searchParams.get("kind") ?? undefined, phase: url.searchParams.get("phase") ?? undefined })),
    type: "text/tab-separated-values; charset=utf-8",
    name: "kifu-study-cards.txt",
  }));
  route("GET", "/api/cards/counts", () => cards.counts());
  route("POST", "/api/cards", (_r, _u, _p, body) => {
    const b = body as { gameId: number; ply: number; note?: string };
    return cards.create(b.gameId, b.ply, b.note);
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
  route("GET", "/api/settings", () => loadSettings(db));
  route("PUT", "/api/settings", (_r, _u, _p, body) => {
    const next = { ...loadSettings(db), ...(body as Partial<AppSettings>) };
    saveSettings(db, next);
    // Names decide "my side"; regrade so cards follow.
    for (const g of db.all<{ id: number }>("SELECT id FROM games WHERE analysis_status IN ('done','imported')")) lib.regrade(g.id);
    return next;
  });
  route("POST", "/api/engine/test", async (_r, _u, _p, body) => {
    const b = body as { path: string };
    const e = new UsiEngine(b.path);
    try {
      await e.start();
      const r = await e.search("startpos", { movetimeMs: 300 });
      return { ok: true, name: e.name, author: e.author, options: e.options.map((o) => o.name), bestmove: r.bestmove };
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

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/api/events") return handleEvents(req, res);
      if (!url.pathname.startsWith("/api/")) return await serveStatic(url, res);
      for (const [method, re, h] of routes) {
        const m = re.exec(url.pathname);
        if (m && method === req.method) {
          const body = req.method === "GET" ? undefined : await readBody(req);
          const out = (await h(req, url, m.slice(1), body)) as { __raw?: Uint8Array; type?: string; name?: string };
          if (out && out.__raw) {
            res.writeHead(200, {
              "Content-Type": out.type!,
              "Content-Disposition": `attachment; filename="${out.name}"`,
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
  });

  return {
    db,
    lib,
    analysis,
    cards,
    server,
    listen(): Promise<number> {
      return new Promise((resolve) => {
        server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => {
          const addr = server.address();
          resolve(typeof addr === "object" && addr ? addr.port : 0);
        });
      });
    },
    async close() {
      for (const r of sseClients) r.end();
      await analysis.shutdown();
      await new Promise<void>((r) => server.close(() => r()));
      db.close();
    },
  };
}
