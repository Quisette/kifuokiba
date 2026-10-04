// Daily automatic backups next to the library file: backups/kifu-study-YYYY-MM-DD.db,
// keeping the newest few. VACUUM INTO makes a consistent copy while the app runs.
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { Db } from "./db.js";

const NAME = /^kifu-study-(\d{4}-\d{2}-\d{2})\.db$/;

export class AutoBackup {
  readonly dir: string;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    dbPath: string,
    private readonly keep: () => number,
  ) {
    this.dir = dbPath === ":memory:" ? "" : path.join(path.dirname(path.resolve(dbPath)), "backups");
  }

  /** Check now and then hourly; a backup is made at most once per local day. */
  start() {
    this.runIfDue();
    this.timer = setInterval(() => this.runIfDue(), 60 * 60 * 1000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  list(): { name: string; date: string; size: number }[] {
    if (!this.dir || !existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .map((name) => ({ name, m: NAME.exec(name) }))
      .filter((f) => f.m)
      .map((f) => ({ name: f.name, date: f.m![1], size: statSync(path.join(this.dir, f.name)).size }))
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  runIfDue(now = new Date()): string | null {
    const keep = this.keep();
    if (!this.dir || keep <= 0) return null;
    const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const file = path.join(this.dir, `kifu-study-${d}.db`);
    if (existsSync(file)) return null;
    mkdirSync(this.dir, { recursive: true });
    this.db.backupTo(file);
    for (const old of this.list().slice(keep)) unlinkSync(path.join(this.dir, old.name));
    return file;
  }
}
