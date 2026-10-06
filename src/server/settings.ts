import { Db } from "./db.js";
import { defaultGradingSettings, GradingSettings } from "../core/grading.js";

export type EngineSettings = {
  path: string;
  options: Record<string, string | number>;
  movetimeMs: number;
  nodes: number; // 0 = use movetime
  multipv: number;
  /** Re-search around flagged moves with this many times the time/nodes (0 or 1 = off). */
  verifyFactor: number;
};

export type AppSettings = {
  /** Your player names on every site; decides "my side" in each game. */
  myNames: string[];
  engine: EngineSettings;
  grading: GradingSettings;
  /** Minimum mistake level that becomes a card: 2 疑問手, 3 悪手, 4 大悪手. */
  cardMinLevel: number;
  /** A card answer within this win-rate loss of the best move counts as correct. */
  cardOkLoss: number;
  autoAnalyze: boolean;
  /** Online accounts to pull games from. */
  accounts: { lishogi: string };
  /** Folders whose kifu files are imported automatically. */
  watchFolders: string[];
  /** Card scheduling: SM-2 (default) or FSRS v4.5. */
  scheduler: "sm2" | "fsrs";
  /** FSRS target recall probability; higher means more reviews. */
  desiredRetention: number;
  /** YaneuraOu-format opening book (.db), to mark book moves and where games leave the book. */
  bookPath: string;
  /** Daily backups to keep next to the library file; 0 turns them off. */
  autoBackupKeep: number;
  /** A second engine to compare a game's analysis with (empty path = none). */
  engine2: { path: string; options: Record<string, string | number>; movetimeMs: number };
};

export const defaultSettings: AppSettings = {
  myNames: [],
  engine: {
    path: "",
    options: { USI_Hash: 256, Threads: 2 },
    movetimeMs: 1000,
    nodes: 0,
    multipv: 1,
    verifyFactor: 4,
  },
  grading: defaultGradingSettings,
  cardMinLevel: 3,
  cardOkLoss: 3,
  autoAnalyze: true,
  accounts: { lishogi: "" },
  watchFolders: [],
  scheduler: "sm2",
  desiredRetention: 0.9,
  bookPath: "",
  autoBackupKeep: 7,
  engine2: { path: "", options: {}, movetimeMs: 1000 },
};

export function loadSettings(db: Db): AppSettings {
  const saved = db.getSetting<Partial<AppSettings>>("app", {});
  return {
    ...defaultSettings,
    ...saved,
    engine: { ...defaultSettings.engine, ...(saved.engine ?? {}) },
    grading: { ...defaultSettings.grading, ...(saved.grading ?? {}) },
    accounts: { ...defaultSettings.accounts, ...(saved.accounts ?? {}) },
    engine2: { ...defaultSettings.engine2, ...(saved.engine2 ?? {}) },
  };
}

export function saveSettings(db: Db, s: AppSettings) {
  db.setSetting("app", s);
}
