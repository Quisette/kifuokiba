// Load test: N synthetic games (random legal moves after real openings) with
// fake evals, then time the heavy endpoints. Usage: npx tsx tools/perf.ts [N]
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Position, Record, RecordMetadataKey, SpecialMoveType, exportKIF, InitialPositionSFEN } from "tsshogi";
import { createApp } from "../src/server/app.js";

const N = Number(process.argv[2] ?? 1000);
let seed = 42;
const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x80000000);
const openings = ["7g7f 3c3d 2g2f 4c4d", "7g7f 3c3d 6g6f 8c8d", "2g2f 8c8d 2f2e 8d8e", "5g5f 8c8d 2h5h 8d8e"];

function randomGame(i: number): string {
  const moves = openings[i % openings.length].split(" ");
  const pos = Position.newBySFEN(InitialPositionSFEN.STANDARD)!;
  for (const u of moves) pos.doMove(pos.createMoveByUSI(u)!);
  const len = 60 + Math.floor(rand() * 80);
  while (moves.length < len) {
    // Random legal move: try random from/to squares until one is valid.
    let done = false;
    for (let t = 0; t < 4000 && !done; t++) {
      const f = 1 + Math.floor(rand() * 9), r = 1 + Math.floor(rand() * 9);
      const tf = 1 + Math.floor(rand() * 9), tr = 1 + Math.floor(rand() * 9);
      const u = `${f}${"abcdefghi"[r - 1]}${tf}${"abcdefghi"[tr - 1]}${rand() < 0.3 ? "+" : ""}`;
      const m = pos.createMoveByUSI(u);
      if (m && pos.isValidMove(m)) {
        pos.doMove(m);
        moves.push(u);
        done = true;
      }
    }
    if (!done) break;
  }
  const rec = Record.newByUSI("position startpos moves " + moves.join(" "));
  if (rec instanceof Error) throw rec;
  const me = i % 2 === 0;
  rec.metadata.setStandardMetadata(RecordMetadataKey.BLACK_NAME, me ? "me" : `opp${i % 40}`);
  rec.metadata.setStandardMetadata(RecordMetadataKey.WHITE_NAME, me ? `opp${i % 40}` : "me");
  const d = new Date(2024, 0, 1 + Math.floor(i / 3));
  rec.metadata.setStandardMetadata(RecordMetadataKey.START_DATETIME, `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`);
  rec.goto(Number.MAX_SAFE_INTEGER);
  rec.append(SpecialMoveType.RESIGN);
  return exportKIF(rec);
}

async function main() {
  const dir = mkdtempSync(path.join(tmpdir(), "kifu-perf-"));
  console.log(`library: ${dir}/perf.db`);
  const app = createApp({ dbPath: path.join(dir, "perf.db"), autoBackup: false });
  const base = `http://127.0.0.1:${await app.listen()}`;
  const call = async (method: string, p: string, body?: unknown) => {
    const t = performance.now();
    const r = await fetch(base + p, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    if (!r.ok) throw new Error(`${p}: ${text.slice(0, 200)}`);
    return { ms: performance.now() - t, bytes: text.length };
  };
  await call("PUT", "/api/settings", { myNames: ["me"], autoAnalyze: false });
  let t = performance.now();
  const statuses = new Map<string, number>();
  for (let i = 0; i < N; i += 50) {
    const texts = Array.from({ length: Math.min(50, N - i) }, (_, k) => randomGame(i + k));
    const r = await fetch(base + "/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: texts.map((text, k) => ({ name: `g${i + k}.kif`, data: Buffer.from(text).toString("base64") })) }),
    });
    const j = (await r.json()) as { results: { status: string; error?: string }[] };
    for (const x of j.results) statuses.set(x.status + (x.error ? `: ${x.error}` : ""), (statuses.get(x.status + (x.error ? `: ${x.error}` : "")) ?? 0) + 1);
  }
  console.log(statuses);
  console.log(`import ${N} games: ${((performance.now() - t) / 1000).toFixed(1)}s`);
  // Fake an analysis so stats, cards and drills have data: alternating evals, a few blunders.
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(path.join(dir, "perf.db"));
  raw.exec(`UPDATE plies SET score = ((ply * 37) % 400) - 200, best_usi = usi, eval_source = 'perf'`);
  raw.exec(`UPDATE plies SET mate = 5, score = NULL WHERE ply % 97 = 50`);
  raw.exec(`UPDATE games SET analysis_status = 'done', analysis_engine = 'perf'`);
  raw.close();
  t = performance.now();
  // Regrade every game through the normal path.
  const ids = (await (await fetch(base + "/api/games")).json()) as { id: number }[];
  console.log(`games listed: ${ids.length}`);
  for (const p of [
    "/api/games",
    "/api/games?sort=date&desc=true",
    "/api/facets",
    "/api/stats",
    "/api/insights",
    "/api/today",
    "/api/today",
    "/api/puzzles",
    "/api/repertoire?side=black",
    "/api/explorer?sfen=" + encodeURIComponent(InitialPositionSFEN.STANDARD),
    "/api/cards",
    "/api/cards/activity",
    `/api/games/${ids[0].id}`,
    `/api/games/${ids[0].id}/similar`,
    "/api/players/opp1",
    "/api/export/games",
  ]) {
    const r = await call("GET", p);
    console.log(`${p.padEnd(48)} ${r.ms.toFixed(0).padStart(6)} ms  ${(r.bytes / 1024).toFixed(0)} KB`);
  }
  await app.close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
