// A weekly report page: the week's games and results, accuracy against the week
// before, where the points went, the costliest moves as boards, and practice done.
// It goes into the "Weekly" notebook; boards point at the library like review notes.
import { Library, GameListItem } from "./library.js";

const DAY = 24 * 60 * 60 * 1000;
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);
const PHASE = (ply: number) => (ply <= 30 ? "序盤" : ply <= 80 ? "中盤" : "終盤");
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function weeklyNote(lib: Library, end = Date.now()): { title: string; body: string } {
  const to = ymd(end);
  const from = ymd(end - 6 * DAY);
  const prevFrom = ymd(end - 13 * DAY);
  const prevTo = ymd(end - 7 * DAY);
  const inRange = (g: GameListItem, a: string, b: string) => g.date.slice(0, 10) >= a && g.date.slice(0, 10) <= b;
  const all = lib.listGames().filter((g) => g.mySide);
  const week = all.filter((g) => inRange(g, from, to)).sort((a, b) => (a.date < b.date ? -1 : 1));
  const before = all.filter((g) => inRange(g, prevFrom, prevTo));

  const title = `週報 ${from} – ${to}`;
  const lines: string[] = [`# ${title}`, ""];
  const tally = (gs: GameListItem[]) => ({
    w: gs.filter((g) => g.myResult === "win").length,
    l: gs.filter((g) => g.myResult === "loss").length,
    d: gs.filter((g) => g.myResult === "draw").length,
  });
  const t = tally(week);
  const acc = mean(week.flatMap((g) => (g.myAccuracy !== null ? [g.myAccuracy] : [])));
  const accBefore = mean(before.flatMap((g) => (g.myAccuracy !== null ? [g.myAccuracy] : [])));
  if (!week.length) {
    lines.push("No games this week.", "");
  } else {
    const rate = t.w + t.l ? Math.round((t.w / (t.w + t.l)) * 100) : null;
    const facts = [`${week.length} game${week.length === 1 ? "" : "s"}`, `${t.w}勝 ${t.l}敗${t.d ? ` ${t.d}分` : ""}`];
    if (rate !== null) facts.push(`win rate ${rate}%`);
    if (acc !== null) {
      const delta = accBefore !== null ? ` (${acc - accBefore >= 0 ? "+" : "−"}${Math.abs(acc - accBefore).toFixed(1)} on the week before)` : "";
      facts.push(`accuracy ${acc.toFixed(1)}%${delta}`);
    }
    lines.push(facts.join(" · "), "");

    lines.push("## 対局 Games", "", "| Date | Opponent | Side | Opening | Result | Accuracy | 悪手 |", "| --- | --- | --- | --- | --- | --- | --- |");
    for (const g of week) {
      const res = { win: "勝", loss: "負", draw: "分" }[g.myResult as "win"] ?? "–";
      lines.push(
        `| [${g.date.slice(0, 10)}](#/game/${g.id}) | ${g.opponent || "?"} | ${g.mySide === "black" ? "☗" : "☖"} | ${g.myOpening || g.strategy || ""} | ${res} | ${g.myAccuracy !== null ? Math.round(g.myAccuracy) + "%" : "–"} | ${g.mistakes} |`,
      );
    }
    lines.push("");

    // My costliest moves of the week, and how the points split by phase.
    const ids = week.map((g) => g.id);
    const side = new Map(week.map((g) => [g.id, g.mySide]));
    const firstBlack = new Map(lib.db.all<{ id: number; s: string }>(`SELECT id, initial_sfen s FROM games WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids)).map((r) => [r.id, r.s.split(" ")[1] !== "w"]));
    const rows = lib.db
      .all<{ game_id: number; ply: number; text: string; loss: number | null; level: number; missed: string }>(
        `SELECT game_id, ply, text, loss, level, missed FROM plies WHERE ply > 0 AND loss IS NOT NULL AND game_id IN (SELECT value FROM json_each(?))`,
        JSON.stringify(ids),
      )
      .filter((r) => ((r.ply % 2 === 1) === (firstBlack.get(r.game_id) ?? true)) === (side.get(r.game_id) === "black"));
    if (rows.length) {
      const byPhase = new Map<string, number[]>();
      for (const r of rows) byPhase.set(PHASE(r.ply), [...(byPhase.get(PHASE(r.ply)) ?? []), r.loss!]);
      const parts = ["序盤", "中盤", "終盤"].filter((p) => byPhase.has(p)).map((p) => {
        const xs = byPhase.get(p)!;
        return `${p} ${mean(xs)!.toFixed(2)} a move (${xs.length} moves)`;
      });
      lines.push("## 形勢の損失 Where the points went", "", parts.join(" · "), "");

      const worst = rows.filter((r) => r.level >= 3 || r.missed).sort((a, b) => b.loss! - a.loss!).slice(0, 3);
      if (worst.length) {
        lines.push("## 今週の悪手 Costliest moves", "");
        for (const r of worst) {
          const g = week.find((x) => x.id === r.game_id)!;
          const what = r.missed === "mate" ? "missed mate" : r.missed === "win" ? "missed win" : "";
          lines.push(`### vs ${g.opponent || "?"}, ${r.ply}手目 ${r.text}（−${Math.round(r.loss!)}%${what ? `, ${what}` : ""}）`, "", `:::shogi-view{game=${r.game_id} ply=${r.ply - 1}}`, ":::", "");
        }
      }
    }
  }

  // Practice done in the same seven days.
  const start = new Date(from + "T00:00:00").getTime();
  const stop = new Date(to + "T00:00:00").getTime() + DAY;
  const rev = lib.db.get<{ n: number; again: number }>(
    "SELECT COUNT(*) n, SUM(CASE WHEN rating = 'again' THEN 1 ELSE 0 END) again FROM reviews WHERE at >= ? AND at < ?",
    start,
    stop,
  );
  const made = lib.db.get<{ n: number }>("SELECT COUNT(*) n FROM cards WHERE created_at >= ? AND created_at < ?", start, stop);
  const tsume = lib.db.get<{ n: number; ok: number }>(
    "SELECT COUNT(*) n, SUM(CASE WHEN last_result = 'solved' THEN 1 ELSE 0 END) ok FROM tsume WHERE last_at >= ? AND last_at < ?",
    start,
    stop,
  );
  const practice: string[] = [];
  if (rev?.n) practice.push(`${rev.n} card review${rev.n === 1 ? "" : "s"}, ${Math.round(((rev.n - (rev.again ?? 0)) / rev.n) * 100)}% remembered`);
  if (made?.n) practice.push(`${made.n} new card${made.n === 1 ? "" : "s"}`);
  if (tsume?.n) practice.push(`${tsume.ok ?? 0} of ${tsume.n} tsume problems solved`);
  lines.push("## 練習 Practice", "", practice.length ? practice.join(" · ") : "No practice recorded this week.", "");

  lines.push("## 来週 Next week", "", "- ", "");
  return { title, body: lines.join("\n") };
}
