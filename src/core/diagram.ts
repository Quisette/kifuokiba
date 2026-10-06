// A board diagram as standalone SVG (text pieces, no images), for downloads,
// Anki cards and notes outside the app.
import { Color, PieceType, Position, Square } from "tsshogi";

const NAMES: Record<PieceType, string> = {
  pawn: "歩",
  lance: "香",
  knight: "桂",
  silver: "銀",
  gold: "金",
  bishop: "角",
  rook: "飛",
  king: "玉",
  promPawn: "と",
  promLance: "杏",
  promKnight: "圭",
  promSilver: "全",
  horse: "馬",
  dragon: "龍",
};
const HAND_ORDER: PieceType[] = [PieceType.ROOK, PieceType.BISHOP, PieceType.GOLD, PieceType.SILVER, PieceType.KNIGHT, PieceType.LANCE, PieceType.PAWN];
const KANJI_NUM = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八"];
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export type DiagramOptions = { lastMove?: string; flip?: boolean; caption?: string };

export function positionSvg(sfen: string, opts: DiagramOptions = {}): string {
  const pos = Position.newBySFEN(sfen);
  if (!pos) throw new Error("bad sfen");
  const flip = !!opts.flip;
  const cell = 40;
  const handW = 44;
  const pad = 22;
  const boardX = handW + pad;
  const boardY = pad;
  const width = boardX + cell * 9 + pad + handW;
  const height = boardY + cell * 9 + pad + (opts.caption ? 26 : 0);
  // lastMove (USI) is the move that led here; its destination is highlighted.
  const lastToUsi = opts.lastMove ? /^(?:[RBGSNLP]\*|[1-9][a-i])([1-9][a-i])/.exec(opts.lastMove)?.[1] : undefined;
  const lastTo = lastToUsi ? Square.newByUSI(lastToUsi) : null;
  // Screen position of a square: file 9 on the left for sente's view.
  const xy = (file: number, rank: number) => (flip ? { x: boardX + (file - 1) * cell, y: boardY + (9 - rank) * cell } : { x: boardX + (9 - file) * cell, y: boardY + (rank - 1) * cell });

  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="'Noto Serif JP','Hiragino Mincho ProN','Yu Mincho',serif">`,
    `<rect width="${width}" height="${height}" fill="#fbf6ea"/>`,
    `<rect x="${boardX}" y="${boardY}" width="${cell * 9}" height="${cell * 9}" fill="#efd9a5" stroke="#3b2a14" stroke-width="2"/>`,
  );
  for (let i = 1; i < 9; i++) {
    out.push(`<line x1="${boardX + i * cell}" y1="${boardY}" x2="${boardX + i * cell}" y2="${boardY + 9 * cell}" stroke="#3b2a14" stroke-width="0.8"/>`);
    out.push(`<line x1="${boardX}" y1="${boardY + i * cell}" x2="${boardX + 9 * cell}" y2="${boardY + i * cell}" stroke="#3b2a14" stroke-width="0.8"/>`);
  }
  for (const [fx, fy] of [[3, 3], [6, 3], [3, 6], [6, 6]]) out.push(`<circle cx="${boardX + fx * cell}" cy="${boardY + fy * cell}" r="2.5" fill="#3b2a14"/>`);
  // Coordinates: files across the top, ranks down the right side.
  for (let f = 1; f <= 9; f++) {
    const { x } = xy(f, 1);
    out.push(`<text x="${x + cell / 2}" y="${boardY - 6}" font-size="11" text-anchor="middle" fill="#3b2a14">${f}</text>`);
  }
  for (let r = 1; r <= 9; r++) {
    const { y } = xy(1, r);
    out.push(`<text x="${boardX + 9 * cell + 6}" y="${y + cell / 2 + 4}" font-size="11" fill="#3b2a14">${KANJI_NUM[r]}</text>`);
  }
  if (lastTo) {
    const { x, y } = xy(lastTo.file, lastTo.rank);
    out.push(`<rect x="${x}" y="${y}" width="${cell}" height="${cell}" fill="#e8a33d" fill-opacity="0.45"/>`);
  }
  for (const sq of Square.all) {
    const p = pos.board.at(sq);
    if (!p) continue;
    const { x, y } = xy(sq.file, sq.rank);
    const upsideDown = (p.color === Color.WHITE) !== flip;
    const promoted = p.type.startsWith("prom") || p.type === PieceType.HORSE || p.type === PieceType.DRAGON;
    const cx = x + cell / 2;
    const cy = y + cell / 2;
    out.push(
      `<text x="${cx}" y="${cy + 9}" font-size="26" text-anchor="middle" fill="${promoted ? "#b3261e" : "#1b1209"}"${upsideDown ? ` transform="rotate(180 ${cx} ${cy})"` : ""}>${NAMES[p.type]}</text>`,
    );
  }
  // Hands: sente's on the right (bottom), gote's on the left (top), written vertically.
  const handText = (color: Color) => {
    const h = pos.hand(color);
    const parts = HAND_ORDER.filter((t) => h.count(t) > 0).map((t) => NAMES[t] + (h.count(t) > 1 ? KANJI_NUM[h.count(t)] : ""));
    return parts.length ? parts.join("") : "なし";
  };
  const vertical = (label: string, x: number, top: boolean, rotate: boolean) => {
    const chars = [...label];
    const y0 = top ? boardY + 14 : boardY + 9 * cell - chars.length * 22 + 8;
    return chars
      .map((ch, i) => {
        const y = y0 + i * 22;
        return `<text x="${x}" y="${y}" font-size="20" text-anchor="middle" fill="#1b1209"${rotate ? ` transform="rotate(180 ${x} ${y - 7})"` : ""}>${esc(ch)}</text>`;
      })
      .join("");
  };
  const blackLabel = "☗" + handText(Color.BLACK);
  const whiteLabel = "☖" + handText(Color.WHITE);
  // Unflipped: gote's stand top-left, sente's bottom-right.
  out.push(vertical(flip ? blackLabel : whiteLabel, handW / 2 + 4, true, false));
  out.push(vertical(flip ? whiteLabel : blackLabel, boardX + 9 * cell + pad + handW / 2 - 2, false, false));
  if (opts.caption) out.push(`<text x="${width / 2}" y="${height - 9}" font-size="14" text-anchor="middle" fill="#3b2a14">${esc(opts.caption)}</text>`);
  out.push("</svg>");
  return out.join("");
}
