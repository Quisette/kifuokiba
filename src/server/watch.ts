// Watch folders for kifu files written by other apps (ShogiGUI, Kifu for Windows,
// a Shogi Wars downloader...) and import new or changed files.
import { readdirSync, readFileSync, statSync, watch, FSWatcher } from "node:fs";
import path from "node:path";
import { Library } from "./library.js";

const KIFU_EXT = /\.(kif|kifu|ki2|ki2u|csa|jkf)$/i;
const MAX_DEPTH = 4;

export type ScanResult = { scanned: number; added: number[]; duplicates: number; errors: { file: string; error: string }[]; missing: string[] };

export class FolderWatcher {
  private watchers: FSWatcher[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private folders: string[] = [];
  private scanning: Promise<ScanResult> | null = null;

  constructor(
    private readonly lib: Library,
    private readonly onImported: (r: ScanResult) => void,
  ) {}

  /** Replace the watched folders, scan them once, then import on change. */
  configure(folders: string[]) {
    this.close();
    this.folders = [...new Set(folders.map((f) => f.trim()).filter(Boolean))];
    for (const dir of this.folders) {
      try {
        // Recursive watching works on macOS, Windows and Linux (Node 20+).
        this.watchers.push(watch(dir, { recursive: true }, () => this.schedule()));
      } catch {
        // A missing folder is reported by scan(); keep watching the others.
      }
    }
    if (this.folders.length) this.schedule(0);
  }

  close() {
    clearTimeout(this.timer);
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }

  /** Editors write files in several steps; wait for the folder to settle before scanning. */
  private schedule(delay = 1500) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.scan().then((r) => {
        if (r.added.length || r.errors.length) this.onImported(r);
      });
    }, delay);
  }

  scan(): Promise<ScanResult> {
    // One scan at a time; a request during a scan shares its result.
    this.scanning ??= Promise.resolve()
      .then(() => this.scanNow())
      .finally(() => (this.scanning = null));
    return this.scanning;
  }

  private scanNow(): ScanResult {
    const seen = this.lib.db.getSetting<{ [file: string]: number }>("watch.seen", {});
    const out: ScanResult = { scanned: 0, added: [], duplicates: 0, errors: [], missing: [] };
    for (const dir of this.folders) {
      let files: string[];
      try {
        files = listKifu(dir, MAX_DEPTH);
      } catch {
        out.missing.push(dir);
        continue;
      }
      for (const file of files) {
        let mtime: number;
        try {
          mtime = statSync(file).mtimeMs;
        } catch {
          continue;
        }
        if (seen[file] === mtime) continue;
        out.scanned++;
        const r = this.lib.importBuffer(readFileSync(file), path.basename(file));
        if (r.status === "added") out.added.push(r.id);
        else if (r.status === "duplicate") out.duplicates++;
        else out.errors.push({ file, error: r.error });
        seen[file] = mtime;
      }
    }
    this.lib.db.setSetting("watch.seen", seen);
    return out;
  }
}

function listKifu(dir: string, depth: number): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) out.push(...listKifu(p, depth - 1));
    else if (e.isFile() && KIFU_EXT.test(e.name)) out.push(p);
  }
  return out;
}
