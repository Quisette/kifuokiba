import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Position, Record, exportKIF } from "tsshogi";
import { createApp } from "../src/server/app.js";
import { parseTsume } from "../src/server/tsume.js";

// 1手詰: ▲1二金打.
const ONE = "8k/9/8P/9/9/9/9/9/9 b G 1";
const dir = mkdtempSync(path.join(tmpdir(), "kifu-tsume-"));
let app: ReturnType<typeof createApp>;
let base = "";
const call = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(base + p, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
beforeAll(async () => {
  app = createApp({ dbPath: path.join(dir, "t.db"), autoBackup: false });
  base = `http://127.0.0.1:${await app.listen()}`;
});
afterAll(async () => app.close());

it("reads SFEN lines, JSON, NDJSON and tsume KIF files", () => {
  const lines = parseTsume(`# from shogimap-crawler\nsfen ${ONE} moves G*1b\n${ONE.replace(" 1", "")}\n`, "book1.txt");
  expect(lines.problems).toHaveLength(2);
  expect(lines.problems[0]).toMatchObject({ answer: ["G*1b"], title: "book1 1" });
  expect(lines.problems[1].answer).toEqual([]);
  expect(Position.newBySFEN(lines.problems[0].sfen)).toBeTruthy();

  const json = parseTsume(JSON.stringify([{ sfen: ONE, answer: ["G*1b"], title: "第1問" }, { nope: 1 }]));
  expect(json.problems).toHaveLength(1);
  expect(json.problems[0].title).toBe("第1問");
  expect(json.skipped).toBe(1);

  const nd = parseTsume(`{"position":"sfen ${ONE}","moves":"G*1b","id":7}\n{"sfen":"${ONE}","solution":"G*9i"}\n`);
  expect(nd.problems.map((p) => p.answer)).toEqual([["G*1b"], ["G*9i"]]);
  expect(nd.problems[0].title).toBe("7");

  // An illegal answer move is cut off, not trusted.
  expect(parseTsume(`${ONE} moves 5e5d`).problems[0].answer).toEqual([]);

  const r = Record.newByUSI(`position sfen ${ONE} moves G*1b`) as Record;
  const kif = parseTsume(exportKIF(r), "tsume-001.kif");
  expect(kif.problems).toHaveLength(1);
  expect(kif.problems[0]).toMatchObject({ answer: ["G*1b"], title: "tsume-001" });
});

it("imports a collection, records results and puts failed ones first", async () => {
  const text = [`${ONE} moves G*1b`, "4k4/9/4P4/9/9/9/9/9/9 b G 1 moves G*5b"].join("\n");
  const imp = await call("POST", "/api/tsume/import", { text, collection: "1手詰 drills" });
  expect(imp.body).toMatchObject({ collection: "1手詰 drills", found: 2, added: 2 });
  // Again: duplicates are skipped.
  expect((await call("POST", "/api/tsume/import", { text, collection: "1手詰 drills" })).body).toMatchObject({ added: 0, duplicates: 2 });

  const list = (await call("GET", "/api/tsume/problems?collection=" + encodeURIComponent("1手詰 drills"))).body;
  expect(list).toHaveLength(2);
  expect(list[0]).toMatchObject({ mate_len: 1, firstText: "☗１二金" });

  await call("POST", `/api/tsume/${list[0].id}/result`, { solved: true });
  await call("POST", `/api/tsume/${list[1].id}/result`, { solved: false });
  const again = (await call("GET", "/api/tsume/problems?collection=" + encodeURIComponent("1手詰 drills"))).body;
  expect(again[0].id).toBe(list[1].id);
  expect(again[0].last_result).toBe("failed");
  const cols = (await call("GET", "/api/tsume")).body;
  expect(cols[0]).toMatchObject({ collection: "1手詰 drills", problems: 2, solved: 1, tried: 2 });

  expect((await call("DELETE", "/api/tsume?collection=" + encodeURIComponent("1手詰 drills"))).body.deleted).toBe(2);
  expect((await call("GET", "/api/tsume")).body).toEqual([]);
});
