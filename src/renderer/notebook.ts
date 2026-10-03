// Notebook markup: Markdown plus the board directives from Q's
// personal-shogi-note site, pointed at games in the library:
//
//   :::shogi-view{game=12 ply=40}          board after ply 40 of game 12
//   :::
//   :::shogi-view{move=8}                  board from a USI body, after ply 8
//   position startpos moves 7g7f 3c3d ...
//   :::
//   :kifu[game:12]{start=1 stop=28}        move excerpt with a synced board
import { Marked } from "marked";

export type Block =
  | { type: "md"; html: string }
  | { type: "board"; attrs: Record<string, string>; body: string }
  | { type: "kifu"; ref: string; attrs: Record<string, string> };

export function parseAttrs(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!s) return out;
  const re = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s}]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1]] = m[2] ?? m[3] ?? m[4] ?? "";
  return out;
}

const marked = new Marked({ gfm: true, breaks: true });
// Notes are the user's own, but keep raw HTML inert anyway.
marked.use({
  renderer: {
    html({ text }) {
      return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    },
  },
});

export function parseNotebook(src: string): Block[] {
  const lines = src.split("\n");
  const blocks: Block[] = [];
  let md: string[] = [];
  const flush = () => {
    if (md.join("").trim()) blocks.push({ type: "md", html: marked.parse(md.join("\n")) as string });
    md = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const open = /^:::\s*(shogi-view|shogi-move|shogi-move-view|shogi)\s*(\{.*\})?\s*$/.exec(line);
    if (open) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^:::\s*$/.test(lines[i])) body.push(lines[i++]);
      flush();
      blocks.push({ type: "board", attrs: parseAttrs(open[2]), body: body.join("\n").trim() });
      continue;
    }
    const leaf = /^:kifu\[([^\]]+)\]\s*(\{.*\})?\s*$/.exec(line);
    if (leaf) {
      flush();
      blocks.push({ type: "kifu", ref: leaf[1].trim(), attrs: parseAttrs(leaf[2]) });
      continue;
    }
    md.push(line);
  }
  flush();
  return blocks;
}
