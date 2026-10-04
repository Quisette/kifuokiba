import { Db } from "./db.js";
import { defaultGradingSettings, GradingSettings } from "../core/grading.js";

export type EngineSettings = {
  path: string;
  options: Record<string, string | number>;
  movetimeMs: number;
  nodes: number; // 0 = use movetime
  multipv: number;
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
};

export const defaultSettings: AppSettings = {
  myNames: [],
  engine: {
    path: "",
    options: { USI_Hash: 256, Threads: 2 },
    movetimeMs: 1000,
    nodes: 0,
    multipv: 1,
  },
  grading: defaultGradingSettings,
  cardMinLevel: 3,
  cardOkLoss: 3,
  autoAnalyze: true,
  accounts: { lishogi: "" },
  watchFolders: [],
};

export function loadSettings(db: Db): AppSettings {
  const saved = db.getSetting<Partial<AppSettings>>("app", {});
  return {
    ...defaultSettings,
    ...saved,
    engine: { ...defaultSettings.engine, ...(saved.engine ?? {}) },
    grading: { ...defaultSettings.grading, ...(saved.grading ?? {}) },
    accounts: { ...defaultSettings.accounts, ...(saved.accounts ?? {}) },
  };
}

export function saveSettings(db: Db, s: AppSettings) {
  db.setSetting("app", s);
}
