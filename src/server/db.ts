// SQLite storage through Node's built-in node:sqlite (also available inside
// Electron), so there is no native module to rebuild.
import { DatabaseSync, StatementSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  original_text TEXT NOT NULL,
  file_name TEXT NOT NULL DEFAULT '',
  black TEXT NOT NULL DEFAULT '',
  white TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL DEFAULT '',
  event TEXT NOT NULL DEFAULT '',
  time_control TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT 'unknown',
  end_reason TEXT NOT NULL DEFAULT '',
  move_count INTEGER NOT NULL DEFAULT 0,
  initial_sfen TEXT NOT NULL,
  strategy TEXT NOT NULL DEFAULT '',
  strategy_header TEXT NOT NULL DEFAULT '',
  opening TEXT NOT NULL DEFAULT '',
  black_opening TEXT NOT NULL DEFAULT '',
  white_opening TEXT NOT NULL DEFAULT '',
  black_style TEXT NOT NULL DEFAULT '',
  white_style TEXT NOT NULL DEFAULT '',
  black_castle TEXT NOT NULL DEFAULT '',
  white_castle TEXT NOT NULL DEFAULT '',
  matchup TEXT NOT NULL DEFAULT '',
  classification TEXT NOT NULL DEFAULT '{}',
  analysis_status TEXT NOT NULL DEFAULT 'none',
  analysis_engine TEXT NOT NULL DEFAULT '',
  accuracy_black REAL,
  accuracy_white REAL,
  turning_ply INTEGER,
  notes TEXT NOT NULL DEFAULT '',
  imported_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plies (
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  ply INTEGER NOT NULL,
  usi TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  sfen TEXT NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  score INTEGER,
  mate INTEGER,
  best_usi TEXT NOT NULL DEFAULT '',
  pv TEXT NOT NULL DEFAULT '',
  eval_source TEXT NOT NULL DEFAULT '',
  loss REAL,
  level INTEGER NOT NULL DEFAULT 0,
  missed TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (game_id, ply)
);
CREATE INDEX IF NOT EXISTS plies_sfen ON plies(sfen);
CREATE TABLE IF NOT EXISTS evals (
  sfen TEXT NOT NULL,
  engine TEXT NOT NULL,
  limit_key TEXT NOT NULL,
  score INTEGER,
  mate INTEGER,
  best_usi TEXT NOT NULL DEFAULT '',
  pv TEXT NOT NULL DEFAULT '',
  depth INTEGER,
  nodes INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (sfen, engine, limit_key)
);
CREATE TABLE IF NOT EXISTS tags (
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (game_id, tag)
);
CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  filter TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY,
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  ply INTEGER NOT NULL,
  sfen TEXT NOT NULL,
  side TEXT NOT NULL,
  played_usi TEXT NOT NULL,
  played_text TEXT NOT NULL DEFAULT '',
  best_usi TEXT NOT NULL,
  pv TEXT NOT NULL DEFAULT '',
  loss REAL NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'mistake',
  phase TEXT NOT NULL DEFAULT '',
  repetitions INTEGER NOT NULL DEFAULT 0,
  interval_days REAL NOT NULL DEFAULT 0,
  ease REAL NOT NULL DEFAULT 2.5,
  stability REAL,
  difficulty REAL,
  last_review_at INTEGER,
  due_at INTEGER NOT NULL,
  lapses INTEGER NOT NULL DEFAULT 0,
  suspended INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE (game_id, ply)
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  rating TEXT NOT NULL,
  answer_usi TEXT NOT NULL DEFAULT '',
  loss REAL
);
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY,
  notebook TEXT NOT NULL DEFAULT 'Notes',
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tsume (
  id INTEGER PRIMARY KEY,
  collection TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  sfen TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  mate_len INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  solved INTEGER NOT NULL DEFAULT 0,
  last_at INTEGER,
  last_result TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE (collection, sfen)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export type Row = Record<string, unknown>;

export class Db {
  readonly db: DatabaseSync;
  private cache = new Map<string, StatementSync>();

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    // Columns added after the first release; CREATE TABLE IF NOT EXISTS won't add them to old files.
    this.ensureColumn("plies", "missed", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("cards", "stability", "REAL");
    this.ensureColumn("cards", "difficulty", "REAL");
    this.ensureColumn("cards", "last_review_at", "INTEGER");
    // First ply each side was clearly winning (-1 never, NULL not computed yet).
    this.ensureColumn("games", "clear_black_ply", "INTEGER");
    this.ensureColumn("games", "clear_white_ply", "INTEGER");
  }

  private ensureColumn(table: string, column: string, decl: string) {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  all<T = Row>(sql: string, ...params: any[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get<T = Row>(sql: string, ...params: any[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run(sql: string, ...params: any[]) {
    return this.stmt(sql).run(...params);
  }

  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  getSetting<T>(key: string, fallback: T): T {
    const row = this.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key);
    return row ? (JSON.parse(row.value) as T) : fallback;
  }

  setSetting(key: string, value: unknown) {
    this.run(
      "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      JSON.stringify(value),
    );
  }

  /** A consistent copy of the whole library, safe to take while the app runs. */
  backupTo(file: string) {
    this.db.prepare("VACUUM INTO ?").run(file);
  }

  close() {
    this.db.close();
  }
}

/** SFEN without the move number, so transpositions share an eval cache entry. */
export function sfenKey(sfen: string): string {
  return sfen.replace(/^sfen /, "").split(" ").slice(0, 3).join(" ");
}
