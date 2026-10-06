// A prep sheet for the next game against one opponent: my record against them,
// their openings and castles, the positions I reach most often against them,
// my costliest moves against them, and room for a plan. It goes into the
// "Opponents" notebook; boards point at the library like review notes.
import { Library, GameListItem } from "./library.js";
import { sfenKey } from "./db.js";
import { playerProfile } from "./stats.js";

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const pct = (w: number, l: number) => (w + l ? `${Math.round((w / (w + l)) * 100)}%` : "–");
const mark = (side: string) => (side === "black" ? "☗" : "☖");
// Positions from this stretch of the game count as "reached often": past the first
// few moves (every game shares those) and before the middlegame scatters them.
const FIRST_PLY = 6;
const LAST_PLY = 40;

type PlyRow = { game_id: number; ply: number; sfen: string; usi: string; text: string; loss: number | null; level: number; missed: string; best_usi: string };

export function prepNote(lib: Library, opponent: string, today = new Date().toISOString().slice(0, 10)): { title: string; body: string } | null {
  const p = playerProfile(lib, opponent);
  if (!p.games.length) return null;
  const games = p.games;
  const title = `対策 vs ${opponent}`;
  const lines: string[] = [`# ${title}`, "", `Written ${today}.`, ""];

  const t = p.totals;
  const facts = [`${t.games} game${t.games === 1 ? "" : "s"}`, `${t.wins}勝 ${t.losses}敗${t.draws ? ` ${t.draws}分` : ""}`, `my win rate ${pct(t.wins, t.losses)}`];
  if (p.form) facts.push(`recent form ${p.form} (newest first)`);
  if (p.theirRating) facts.push(`their rating ${p.theirRating}`);
  if (p.meanAccuracy !== null) facts.push(`my accuracy ${p.meanAccuracy.toFixed(1)}%`);
  lines.push(facts.join(" · "), "");

  // Their openings and castles, by the side I had.
  const theirOpening = (g: GameListItem) => g.opening || (g.mySide === "black" ? g.white_opening || g.white_style : g.black_opening || g.black_style) || "?";
  const theirCastle = (g: GameListItem) => (g.mySide === "black" ? g.white_castle : g.black_castle) || "–";
  lines.push("## 相手の作戦 Their openings", "", "| I had | Their opening | Their castle | Games | My score |", "| --- | --- | --- | --- | --- |");
  const groups = new Map<string, GameListItem[]>();
  for (const g of games) {
    const k = `${g.mySide}|${theirOpening(g)}|${theirCastle(g)}`;
    groups.set(k, [...(groups.get(k) ?? []), g]);
  }
  for (const [k, gs] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const [side, opening, castle] = k.split("|");
    const w = gs.filter((g) => g.myResult === "win").length;
    const l = gs.filter((g) => g.myResult === "loss").length;
    lines.push(`| ${mark(side)} | ${opening} | ${castle} | ${gs.length} | ${w}勝 ${l}敗 (${pct(w, l)}) |`);
  }
  lines.push("");

  // My moves in these games, from my side only.
  const ids = games.map((g) => g.id);
  const side = new Map(games.map((g) => [g.id, g.mySide]));
  const firstBlack = new Map(
    lib.db.all<{ id: number; s: string }>("SELECT id, initial_sfen s FROM games WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(ids)).map((r) => [r.id, r.s.split(" ")[1] !== "w"]),
  );
  const all = lib.db.all<PlyRow>(
    "SELECT game_id, ply, sfen, usi, text, loss, level, missed, best_usi FROM plies WHERE game_id IN (SELECT value FROM json_each(?)) ORDER BY game_id, ply",
    JSON.stringify(ids),
  );
  const byGame = new Map<number, PlyRow[]>();
  for (const r of all) byGame.set(r.game_id, [...(byGame.get(r.game_id) ?? []), r]);
  const isMine = (r: PlyRow) => r.ply > 0 && ((r.ply % 2 === 1) === (firstBlack.get(r.game_id) ?? true)) === (side.get(r.game_id) === "black");

  // Positions I keep reaching with me to move, and what I play there.
  const reached = new Map<string, { gameId: number; ply: number; sfen: string; moves: Map<string, { text: string; losses: number[]; n: number }>; games: Set<number>; best: string }>();
  for (const [gameId, rows] of byGame) {
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!isMine(r) || r.ply < FIRST_PLY || r.ply > LAST_PLY) continue;
      const before = rows[i - 1];
      const key = sfenKey(before.sfen);
      const e = reached.get(key) ?? { gameId, ply: before.ply, sfen: before.sfen, moves: new Map(), games: new Set<number>(), best: "" };
      if (e.games.has(gameId)) continue;
      e.games.add(gameId);
      const m = e.moves.get(r.usi) ?? { text: r.text, losses: [], n: 0 };
      m.n++;
      if (r.loss !== null) m.losses.push(r.loss);
      e.moves.set(r.usi, m);
      if (!e.best && before.best_usi) e.best = before.best_usi;
      reached.set(key, e);
    }
  }
  // Keep the deepest of positions that share their games (one line, not every move of it).
  const often = [...reached.values()].filter((e) => e.games.size >= 2).sort((a, b) => b.games.size - a.games.size || b.ply - a.ply);
  const shown: typeof often = [];
  for (const e of often) {
    if (shown.some((s) => s.games.size === e.games.size && [...e.games].every((g) => s.games.has(g)))) continue;
    shown.push(e);
    if (shown.length === 3) break;
  }
  if (shown.length) {
    lines.push("## よく現れる局面 Positions I keep reaching", "");
    for (const e of shown) {
      const usual = [...e.moves.entries()].sort((a, b) => b[1].n - a[1].n)[0];
      const loss = mean(usual[1].losses);
      const best = e.best && e.best !== usual[0] ? `; the engine prefers ${Library.moveText(e.sfen, e.best)}` : e.best ? "; the engine agrees" : "";
      lines.push(
        `### ${e.ply}手目 · reached in ${e.games.size} games`,
        "",
        `:::shogi-view{game=${e.gameId} ply=${e.ply}}`,
        ":::",
        "",
        `I usually play ${usual[1].text} (${usual[1].n} of ${e.games.size}${loss !== null ? `, −${loss.toFixed(1)} a move` : ""})${best}.`,
        "",
      );
    }
  }

  const worst = all.filter((r) => isMine(r) && r.loss !== null && (r.level >= 3 || r.missed)).sort((a, b) => b.loss! - a.loss!).slice(0, 3);
  if (worst.length) {
    lines.push("## 悪手 My costliest moves against them", "");
    for (const r of worst) {
      const g = games.find((x) => x.id === r.game_id)!;
      const what = r.missed === "mate" ? ", missed mate" : r.missed === "win" ? ", missed win" : "";
      lines.push(`### ${g.date.slice(0, 10)}, ${r.ply}手目 ${r.text}（−${Math.round(r.loss!)}%${what}）`, "", `:::shogi-view{game=${r.game_id} ply=${r.ply - 1}}`, ":::", "");
    }
    lines.push(`[Review my cards from these games](#/review?opponent=${encodeURIComponent(opponent)})`, "");
  }

  lines.push("## 対局 Recent games", "");
  for (const g of games.slice(0, 10)) {
    const res = { win: "勝", loss: "負", draw: "分" }[g.myResult as "win"] ?? "–";
    lines.push(`- [${g.date.slice(0, 10)}](#/game/${g.id}) ${mark(g.mySide)} ${res} · ${g.strategy || "?"}${g.mistakes ? ` · 悪手 ${g.mistakes}` : ""}`);
  }
  lines.push("", "## 作戦 Plan", "", "- ", "");
  return { title, body: lines.join("\n") };
}
