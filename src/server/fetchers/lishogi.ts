// Pull a user's games from Lishogi's public API (GET /api/games/user/{name}, ndjson)
// and turn each into KIF text so it goes through the normal import path.
//
// Field names follow Lishogi's export (a Lichess fork): players.sente / players.gote,
// winner "sente" | "gote", moves as space-separated USI. Older or differently shaped
// payloads using black/white are accepted too.
import { Color, InitialPositionSFEN, Record, RecordMetadataKey, SpecialMoveType, exportKIF } from "tsshogi";

export type LishogiPlayer = { user?: { name?: string; id?: string }; name?: string; rating?: number; aiLevel?: number };
export type LishogiGame = {
  id: string;
  rated?: boolean;
  variant?: string;
  speed?: string;
  perf?: string;
  createdAt?: number;
  lastMoveAt?: number;
  status?: string;
  players?: { sente?: LishogiPlayer; gote?: LishogiPlayer; black?: LishogiPlayer; white?: LishogiPlayer };
  winner?: string;
  moves?: string;
  initialSfen?: string;
  clock?: { initial?: number; increment?: number; byoyomi?: number; periods?: number };
};

export type FetchLike = (url: string, init?: { headers?: { [name: string]: string }; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export const LISHOGI_BASE = "https://lishogi.org";

/** Games finished after `since` (ms), newest first, at most `max`. */
export async function fetchLishogiGames(
  username: string,
  opts: { since?: number; max?: number; fetchImpl?: FetchLike; base?: string } = {},
): Promise<LishogiGame[]> {
  const f = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const params = new URLSearchParams({ max: String(opts.max ?? 100), clocks: "false", evals: "false", opening: "false" });
  if (opts.since) params.set("since", String(opts.since));
  const url = `${opts.base ?? LISHOGI_BASE}/api/games/user/${encodeURIComponent(username)}?${params}`;
  const res = await f(url, { headers: { Accept: "application/x-ndjson" } });
  if (res.status === 404) throw new Error(`Lishogi has no user "${username}"`);
  if (res.status === 429) throw new Error("Lishogi is rate limiting requests; try again in a minute");
  if (!res.ok) throw new Error(`Lishogi returned HTTP ${res.status}`);
  const body = await res.text();
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LishogiGame);
}

const ENDINGS: { [status: string]: SpecialMoveType } = {
  resign: SpecialMoveType.RESIGN,
  timeout: SpecialMoveType.TIMEOUT,
  outoftime: SpecialMoveType.TIMEOUT,
  mate: SpecialMoveType.MATE,
  draw: SpecialMoveType.DRAW,
  repetition: SpecialMoveType.REPETITION_DRAW,
  sennichite: SpecialMoveType.REPETITION_DRAW,
  impasse27: SpecialMoveType.ENTERING_OF_KING,
  entering: SpecialMoveType.ENTERING_OF_KING,
  perpetualcheck: SpecialMoveType.FOUL_WIN,
  illegalmove: SpecialMoveType.FOUL_WIN,
  stalemate: SpecialMoveType.MATE,
};
// Endings where the side to move lost / won / drew, to check against `winner`.
const LOSES = new Set([SpecialMoveType.RESIGN, SpecialMoveType.TIMEOUT, SpecialMoveType.MATE]);
const WINS = new Set([SpecialMoveType.FOUL_WIN, SpecialMoveType.ENTERING_OF_KING]);

/** KIF text for one Lishogi game, or null for games we don't keep (variants, aborted, no moves). */
export function lishogiGameToKif(g: LishogiGame): string | null {
  if (g.variant && g.variant !== "standard" && g.variant !== "fromPosition") return null;
  if (!g.moves?.trim() || g.status === "aborted" || g.status === "created" || g.status === "started") return null;
  const start = g.initialSfen || InitialPositionSFEN.STANDARD;
  const rec = Record.newByUSI(`sfen ${start} moves ${g.moves.trim()}`);
  if (rec instanceof Error) return null;

  const sente = g.players?.sente ?? g.players?.black;
  const gote = g.players?.gote ?? g.players?.white;
  const name = (p?: LishogiPlayer) =>
    (p?.user?.name ?? p?.name ?? (p?.aiLevel ? `AI level ${p.aiLevel}` : "?")) + (p?.rating ? ` (${p.rating})` : "");
  const m = rec.metadata;
  m.setStandardMetadata(RecordMetadataKey.BLACK_NAME, name(sente));
  m.setStandardMetadata(RecordMetadataKey.WHITE_NAME, name(gote));
  const at = new Date(g.createdAt ?? g.lastMoveAt ?? Date.now());
  const pad = (n: number) => String(n).padStart(2, "0");
  m.setStandardMetadata(
    RecordMetadataKey.START_DATETIME,
    `${at.getFullYear()}/${pad(at.getMonth() + 1)}/${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`,
  );
  m.setStandardMetadata(RecordMetadataKey.TOURNAMENT, `Lishogi ${g.rated ? "rated" : "casual"} ${g.speed ?? g.perf ?? ""}`.trim());
  m.setStandardMetadata(RecordMetadataKey.PLACE, `${LISHOGI_BASE}/${g.id}`);
  if (g.clock?.initial !== undefined) m.setStandardMetadata(RecordMetadataKey.TIME_LIMIT, `${Math.round(g.clock.initial / 60)}分`);
  if (g.clock?.byoyomi) m.setStandardMetadata(RecordMetadataKey.BYOYOMI, `${g.clock.byoyomi}秒`);

  rec.goto(Number.MAX_SAFE_INTEGER);
  const sideToMove = rec.position.color === Color.BLACK ? "sente" : "gote";
  let end = ENDINGS[(g.status ?? "").toLowerCase()];
  if (g.winner && end !== undefined) {
    // KIF can only say how the side to move fared. When Lishogi's winner disagrees
    // (e.g. a resignation on the opponent's turn), record the result rather than the reason.
    const toMoveWon = g.winner === sideToMove;
    if ((LOSES.has(end) && toMoveWon) || (WINS.has(end) && !toMoveWon)) {
      end = toMoveWon ? SpecialMoveType.WIN_BY_DEFAULT : SpecialMoveType.LOSE_BY_DEFAULT;
    }
  } else if (g.winner && end === undefined) {
    end = g.winner === sideToMove ? SpecialMoveType.WIN_BY_DEFAULT : SpecialMoveType.LOSE_BY_DEFAULT;
  }
  if (end !== undefined) rec.append(end);
  return exportKIF(rec, { returnCode: "\r\n" });
}
