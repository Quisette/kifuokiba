// Restore from a backup by merging it into the current library: games are
// re-imported (duplicates are recognised), then their analysis, notes, move marks, tags,
// cards with their review history, and notebook pages are copied over.
// Settings are left alone. Works across app versions since the backup is
// opened with the same migrations.
import { Db } from "./db.js";
import { Library } from "./library.js";
import { importRecordFromText } from "../core/recordFile.js";
import { hasVariations, recordToTree } from "../core/movetree.js";
import { mergeVariations } from "./records.js";

export type RestoreResult = { games: number; added: number; cards: number; reviews: number; pages: number; studies: number };

export function mergeBackup(lib: Library, backupPath: string): RestoreResult {
  const src = new Db(backupPath);
  const db = lib.db;
  const result: RestoreResult = { games: 0, added: 0, cards: 0, reviews: 0, pages: 0, studies: 0 };
  try {
    const tables = new Set(src.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name));
    if (!tables.has("games") || !tables.has("plies")) throw new Error("This file is not a Kifu Study library.");

    const gameMap = new Map<number, number>();
    for (const g of src.all<{ id: number; original_text: string; file_name: string; notes: string; analysis_status: string; analysis_engine: string }>(
      "SELECT id, original_text, file_name, notes, analysis_status, analysis_engine FROM games ORDER BY id",
    )) {
      result.games++;
      const r = lib.importText(g.original_text, g.file_name || "backup");
      if (r.status === "error") continue;
      if (r.status === "added") result.added++;
      // Variations added in the backup's copy join the ones here.
      else {
        const rec = importRecordFromText(g.original_text);
        const tree = rec instanceof Error ? null : recordToTree(rec);
        if (tree && hasVariations(tree)) mergeVariations(lib, r.id, tree);
      }
      gameMap.set(g.id, r.id);
      db.tx(() => {
        if (g.notes) db.run("UPDATE games SET notes = CASE WHEN notes = '' THEN ? ELSE notes END WHERE id = ?", g.notes, r.id);
        for (const t of src.all<{ tag: string }>("SELECT tag FROM tags WHERE game_id = ?", g.id)) db.run("INSERT OR IGNORE INTO tags (game_id, tag) VALUES (?, ?)", r.id, t.tag);
        // Engine analysis and comments, where the current copy has none.
        if (g.analysis_status === "done") {
          for (const p of src.all<{ ply: number; score: number | null; mate: number | null; best_usi: string; pv: string; eval_source: string; comment: string; threat_usi: string }>(
            "SELECT ply, score, mate, best_usi, pv, eval_source, comment, threat_usi FROM plies WHERE game_id = ?",
            g.id,
          )) {
            db.run(
              `UPDATE plies SET score = ?, mate = ?, best_usi = ?, pv = ?, eval_source = ?, threat_usi = ?
               WHERE game_id = ? AND ply = ? AND eval_source != 'engine'`,
              p.score, p.mate, p.best_usi, p.pv, p.eval_source, p.threat_usi, r.id, p.ply,
            );
          }
          db.run(
            "UPDATE games SET analysis_status = 'done', analysis_engine = ? WHERE id = ? AND analysis_status != 'done'",
            g.analysis_engine,
            r.id,
          );
        }
        for (const p of src.all<{ ply: number; comment: string }>("SELECT ply, comment FROM plies WHERE game_id = ? AND comment != ''", g.id)) {
          db.run("UPDATE plies SET comment = ? WHERE game_id = ? AND ply = ? AND comment = ''", p.comment, r.id, p.ply);
        }
        for (const p of src.all<{ ply: number; user_mark: string }>("SELECT ply, user_mark FROM plies WHERE game_id = ? AND user_mark != ''", g.id)) {
          db.run("UPDATE plies SET user_mark = ? WHERE game_id = ? AND ply = ? AND user_mark = ''", p.user_mark, r.id, p.ply);
        }
      });
      lib.regrade(r.id);
    }

    // Cached evals help later analysis of other games too.
    if (tables.has("evals")) {
      db.tx(() => {
        for (const e of src.all<Record<string, unknown>>("SELECT * FROM evals")) {
          db.run(
            `INSERT OR IGNORE INTO evals (sfen, engine, limit_key, score, mate, best_usi, pv, depth, nodes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
            e.sfen, e.engine, e.limit_key, e.score, e.mate, e.best_usi, e.pv, e.depth, e.nodes, e.created_at,
          );
        }
      });
    }

    // Cards keep their schedule and history; a card the regrade just made for the same move takes the backup's state.
    if (tables.has("cards")) {
      db.tx(() => {
        for (const c of src.all<Record<string, unknown> & { id: number; game_id: number; ply: number }>("SELECT * FROM cards")) {
          const gid = gameMap.get(c.game_id);
          if (!gid) continue;
          const existing = db.get<{ id: number; reviews: number }>(
            "SELECT id, (SELECT COUNT(*) FROM reviews r WHERE r.card_id = cards.id) AS reviews FROM cards WHERE game_id = ? AND ply = ?",
            gid,
            c.ply,
          );
          // Never overwrite a card that already has its own reviews here.
          if (existing && existing.reviews > 0) continue;
          if (existing) db.run("DELETE FROM cards WHERE id = ?", existing.id);
          const r = db.run(
            `INSERT INTO cards (game_id, ply, sfen, side, played_usi, played_text, best_usi, pv, loss, level, kind, phase,
               repetitions, interval_days, ease, stability, difficulty, last_review_at, due_at, lapses, suspended, note, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            gid, c.ply, c.sfen, c.side, c.played_usi, c.played_text, c.best_usi, c.pv, c.loss, c.level, c.kind, c.phase,
            c.repetitions, c.interval_days, c.ease, c.stability ?? null, c.difficulty ?? null, c.last_review_at ?? null,
            c.due_at, c.lapses, c.suspended, c.note, c.created_at,
          );
          result.cards++;
          const newId = Number(r.lastInsertRowid);
          for (const v of src.all<{ at: number; rating: string; answer_usi: string; loss: number | null }>(
            "SELECT at, rating, answer_usi, loss FROM reviews WHERE card_id = ?",
            c.id,
          )) {
            db.run("INSERT INTO reviews (card_id, at, rating, answer_usi, loss) VALUES (?,?,?,?,?)", newId, v.at, v.rating, v.answer_usi, v.loss);
            result.reviews++;
          }
        }
      });
    }

    // Saved studies, before pages so embedded ones can be re-pointed. One with the
    // same title, start and tree already here is the same study.
    const studyMap = new Map<number, number>();
    if (tables.has("studies")) {
      db.tx(() => {
        for (const st of src.all<{ id: number; title: string; start_sfen: string; tree: string; game_id: number | null; created_at: number; updated_at: number }>("SELECT * FROM studies ORDER BY id")) {
          const same = db.get<{ id: number }>("SELECT id FROM studies WHERE title = ? AND start_sfen = ? AND tree = ?", st.title, st.start_sfen, st.tree);
          if (same) {
            studyMap.set(st.id, same.id);
            continue;
          }
          const r = db.run(
            "INSERT INTO studies (title, start_sfen, tree, game_id, created_at, updated_at) VALUES (?,?,?,?,?,?)",
            st.title, st.start_sfen, st.tree, st.game_id !== null ? (gameMap.get(st.game_id) ?? null) : null, st.created_at, st.updated_at,
          );
          const newId = Number(r.lastInsertRowid);
          studyMap.set(st.id, newId);
          result.studies++;
          // Its drill history comes with it.
          if (tables.has("study_drill")) {
            for (const d of src.all<{ side: string; sfen_key: string; repetitions: number; interval_days: number; ease: number; due_at: number; lapses: number; last_review_at: number | null }>(
              "SELECT * FROM study_drill WHERE study_id = ?",
              st.id,
            )) {
              db.run(
                "INSERT OR IGNORE INTO study_drill (study_id, side, sfen_key, repetitions, interval_days, ease, due_at, lapses, last_review_at) VALUES (?,?,?,?,?,?,?,?,?)",
                newId, d.side, d.sfen_key, d.repetitions, d.interval_days, d.ease, d.due_at, d.lapses, d.last_review_at,
              );
            }
          }
        }
      });
    }

    // Notebook pages: board directives point at game and study ids, which may have changed.
    if (tables.has("pages")) {
      db.tx(() => {
        for (const p of src.all<{ notebook: string; title: string; body: string; created_at: number; updated_at: number }>("SELECT * FROM pages")) {
          const body = p.body
            .replace(/\bgame([=:])(\d+)/g, (m, sep: string, n: string) => {
              const to = gameMap.get(Number(n));
              return to ? `game${sep}${to}` : m;
            })
            .replace(/(:::\s*shogi-study\s*\{[^}]*\bid=)(\d+)/g, (m, head: string, n: string) => {
              const to = studyMap.get(Number(n));
              return to ? `${head}${to}` : m;
            });
          const same = db.get("SELECT 1 FROM pages WHERE notebook = ? AND title = ? AND body = ?", p.notebook, p.title, body);
          if (same) continue;
          db.run("INSERT INTO pages (notebook, title, body, created_at, updated_at) VALUES (?,?,?,?,?)", p.notebook, p.title, body, p.created_at, p.updated_at);
          result.pages++;
        }
      });
    }
    return result;
  } finally {
    src.close();
  }
}
