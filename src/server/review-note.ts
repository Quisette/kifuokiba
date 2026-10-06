// A study note for one game: summary, then each big mistake as a board with the
// played move and the engine's line, in the notebook directive syntax.
//
// In-app notes point boards at the library (:::shogi-view{game=12 ply=40}).
// Portable notes carry the moves themselves (:::shogi-view{move=40} + a USI
// body), so the .mdx works in personal-shogi-note without the app.
import { Library } from "./library.js";
import { moveText } from "../core/notation.js";

export type ReviewNoteOptions = { portable?: boolean; maxMistakes?: number };

const END: Record<string, string> = {
  resign: "投了",
  timeout: "時間切れ",
  repetitionDraw: "千日手",
  enteringOfKing: "入玉宣言",
  mate: "詰み",
  foulWin: "反則勝ち",
  foulLose: "反則負け",
  impass: "持将棋",
  interrupt: "中断",
};
const PHASE = (ply: number) => (ply <= 30 ? "序盤" : ply <= 80 ? "中盤" : "終盤");

export function reviewNote(lib: Library, id: number, opts: ReviewNoteOptions = {}): { title: string; body: string } | undefined {
  const g = lib.getGame(id);
  if (!g) return undefined;
  const portable = !!opts.portable;
  const max = opts.maxMistakes ?? 8;
  const date = g.date.slice(0, 10);
  const title = `${date ? date + " " : ""}${g.black || "先手"} vs ${g.white || "後手"}`;

  const sideMark = (s: string) => (s === "black" ? "☗" : "☖");
  const resultText =
    g.result === "draw" ? "引き分け" : g.result === "black" || g.result === "white" ? `${sideMark(g.result)}勝ち` : "結果不明";
  const usiMoves = g.plies.slice(1).map((p) => p.usi).filter(Boolean);
  const initial = g.initial_sfen.replace(/^sfen /, "");
  const startpos = initial.startsWith("lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1");
  const usiBody = `position ${startpos ? "startpos" : "sfen " + initial} moves ${usiMoves.join(" ")}`.trim();

  const board = (ply: number) =>
    portable ? `:::shogi-view{move=${ply}}\n${usiBody}\n:::` : `:::shogi-view{game=${id} ply=${ply}}\n:::`;

  const lines: string[] = [];
  if (portable) lines.push("---", `title: "${title.replace(/"/g, "'")}"`, "---", "");
  lines.push(`# ${title}`, "");
  const facts = [
    resultText + (g.end_reason ? `（${END[g.end_reason] ?? g.end_reason}）` : ""),
    `${g.move_count}手`,
    g.strategy,
    g.event,
    g.time_control,
  ].filter(Boolean);
  lines.push(facts.join(" · "));
  if (g.mySide) {
    const acc = g.mySide === "black" ? g.accuracy_black : g.accuracy_white;
    lines.push("", `I played ${sideMark(g.mySide)}${acc != null ? `, accuracy ${Math.round(acc)}%` : ""}.`);
  }
  if (g.notes.trim()) lines.push("", "> " + g.notes.trim().replace(/\n/g, "\n> "));

  const mine = (side: string) => !g.mySide || side === g.mySide;
  const mistakes = g.plies
    .filter((p) => p.ply > 0 && mine(p.side) && (p.level >= 3 || p.missed || p.user_mark === "?" || p.user_mark === "??"))
    .sort((a, b) => (b.loss ?? 0) - (a.loss ?? 0))
    .slice(0, max)
    .sort((a, b) => a.ply - b.ply);

  // The turning point often is the worst mistake; show it once.
  if (g.turning_ply && !mistakes.some((m) => m.ply === g.turning_ply)) {
    lines.push("", `## 分岐点 Turning point`, "", `${g.turning_ply}手目 ${g.plies[g.turning_ply]?.text ?? ""}`, "", board(g.turning_ply));
  }

  lines.push("", "## 悪手 Mistakes", "");
  if (g.analysis_status !== "done") lines.push("_This game has not been fully analysed yet._", "");
  if (!mistakes.length && g.analysis_status === "done") lines.push("No big mistakes. 🎉", "");
  for (const p of mistakes) {
    const prev = g.plies[p.ply - 1];
    const what = p.missed === "mate" ? "missed mate" : p.missed === "win" ? "missed win" : p.label;
    lines.push(`### ${p.ply}手目 ${p.text}${p.user_mark}（${what || "my mark"}${p.loss ? `, −${Math.round(p.loss)}%` : ""}）`, "");
    lines.push(board(p.ply - 1), "");
    if (prev.best_usi) {
      const best = moveText(prev.sfen, prev.best_usi);
      lines.push(`${PHASE(p.ply)}. Played **${p.text}**; the engine prefers **${best}**.`);
      if (prev.pvText) lines.push("", `Line: ${prev.pvText}`);
    } else {
      lines.push(`${PHASE(p.ply)}. Played **${p.text}**.`);
    }
    if (p.comment.trim()) lines.push("", "> " + p.comment.trim().replace(/\n/g, "\n> "));
    lines.push("", "What I should remember:", "", "- ", "");
  }

  lines.push("## 感想 Takeaways", "", "- ", "");
  return { title, body: lines.join("\n") };
}
