// Account sync: fetch new games from online sites and import them like files.
import { Library, ImportResult } from "../library.js";
import { FetchLike, fetchLishogiGames, lishogiGameToKif } from "./lishogi.js";

export type SyncResult = { site: "lishogi"; username: string; fetched: number; added: number[]; duplicates: number; skipped: number; errors: string[] };

// Re-fetch a day of overlap each time; dedup makes repeats harmless and it covers clock skew.
const OVERLAP_MS = 24 * 3600 * 1000;

export async function syncLishogi(
  lib: Library,
  username: string,
  opts: { fetchImpl?: FetchLike; base?: string; max?: number; full?: boolean } = {},
): Promise<SyncResult> {
  const stateKey = `sync.lishogi.${username.toLowerCase()}`;
  const state = lib.db.getSetting<{ lastSync: number }>(stateKey, { lastSync: 0 });
  const since = opts.full || !state.lastSync ? undefined : state.lastSync - OVERLAP_MS;
  const games = await fetchLishogiGames(username, { since, max: opts.max ?? 300, fetchImpl: opts.fetchImpl, base: opts.base });
  const out: SyncResult = { site: "lishogi", username, fetched: games.length, added: [], duplicates: 0, skipped: 0, errors: [] };
  let newest = state.lastSync;
  for (const g of games) {
    newest = Math.max(newest, g.lastMoveAt ?? g.createdAt ?? 0);
    const kif = lishogiGameToKif(g);
    if (!kif) {
      out.skipped++;
      continue;
    }
    const r: ImportResult = lib.importText(kif, `lishogi-${g.id}.kif`);
    if (r.status === "added") out.added.push(r.id);
    else if (r.status === "duplicate") out.duplicates++;
    else out.errors.push(`${g.id}: ${r.error}`);
  }
  lib.db.setSetting(stateKey, { lastSync: newest || Date.now() });
  return out;
}
