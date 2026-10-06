// End-to-end check: start the built server, import kifu, analyse with a USI
// engine, then drive every screen in Chromium and save screenshots.
//
//   E2E_ENGINE=/path/to/engine E2E_KIFU=/dir/with/kifu node test/e2e/run.mjs
//
// Defaults: the mock engine in tools/ and two generated games.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { Record, RecordMetadataKey, SpecialMoveType, exportKIF } from "tsshogi";

const root = path.resolve(import.meta.dirname, "../..");
const engine = process.env.E2E_ENGINE ?? path.join(root, process.platform === "win32" ? "tools/mock-usi-engine.cmd" : "tools/mock-usi-engine.mjs");
const kifuDir = process.env.E2E_KIFU;
const shots = process.env.E2E_SHOTS ?? path.join(root, "test-results/e2e");
mkdirSync(shots, { recursive: true });
const port = 3300 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
const data = mkdtempSync(path.join(tmpdir(), "kifu-e2e-"));

const server = spawn(process.execPath, ["--no-warnings", path.join(root, "dist/server/main.mjs")], {
  env: { ...process.env, PORT: String(port), KIFU_STUDY_DATA: data },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve, reject) => {
  server.stdout.on("data", (d) => String(d).includes("running at") && resolve());
  server.on("exit", (c) => reject(new Error("server exited " + c)));
});

const api = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${p}: ${JSON.stringify(j)}`);
  return j;
};
const check = (cond, msg) => {
  if (!cond) throw new Error("FAILED: " + msg);
  console.log("ok -", msg);
};

let browser;
try {
  // A two-move opening book so book marks show up.
  const bookFile = path.join(data, "book.db");
  writeFileSync(bookFile, ["#YANEURAOU-DB2016 1.00", "sfen lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1", "7g7f 3c3d 0 20 10", "2g2f none 0 20 5", "5g5f none 0 20 1", "1g1f none 0 20 1", ""].join("\n"));
  await api("PUT", "/api/settings", {
    bookPath: bookFile,
    myNames: ["Q"],
    engine: { path: engine, options: { USI_Hash: 64, Threads: 1, BookFile: "no_book" }, movetimeMs: 60, nodes: 0, multipv: 1 },
    autoAnalyze: true,
  });
  const files = kifuDir
    ? readdirSync(kifuDir).filter((f) => /\.(kif|kifu|ki2|csa|jkf)$/i.test(f)).map((f) => ({ name: f, data: readFileSync(path.join(kifuDir, f)).toString("base64") }))
    : [];
  if (!files.length) {
    // Two short games with Q on each side; in the first Q hangs the bishop on move 3 for the mock engine to find.
    const lines = [
      ["Q", "rival", "2026/09/01", "7g7f 3c3d 8h5e 2b5e 2g2f 8b2b 6i7h 5e4d"],
      ["rival", "Q", "2026/09/02", "7g7f 3c3d 8h3c+ 2a3c 2g2f 4c4d 2f2e 8b4b"],
    ];
    for (const [black, white, date, usi] of lines) {
      const rec = Record.newByUSI("position startpos moves " + usi);
      rec.metadata.setStandardMetadata(RecordMetadataKey.BLACK_NAME, black);
      rec.metadata.setStandardMetadata(RecordMetadataKey.WHITE_NAME, white);
      rec.metadata.setStandardMetadata(RecordMetadataKey.START_DATETIME, date);
      rec.goto(Number.MAX_SAFE_INTEGER);
      rec.append(SpecialMoveType.RESIGN);
      files.push({ name: `${date.replaceAll("/", "")}.kif`, data: Buffer.from(exportKIF(rec)).toString("base64") });
    }
  }
  const imp = await api("POST", "/api/import", { files });
  check(imp.results.every((r) => r.status === "added"), `imported ${imp.results.length} file(s)`);

  // Wait for the background queue.
  const t0 = Date.now();
  for (;;) {
    const s = await api("GET", "/api/analysis");
    if (s.error) throw new Error("analysis error: " + s.error);
    if (!s.running && !s.queued.length) break;
    if (Date.now() - t0 > 10 * 60_000) throw new Error("analysis timeout");
    await new Promise((r) => setTimeout(r, 500));
  }
  const games = await api("GET", "/api/games");
  check(games.every((g) => g.analysis_status === "done"), `all ${games.length} games analysed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const cards = await api("GET", "/api/cards");
  console.log(`  ${cards.length} cards, mistakes per game: ${games.map((g) => g.mistakes).join(",")}`);

  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined) });
  // Dark by default (the app follows the system); the light theme gets its own pass at the end.
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // Web fonts come from Google Fonts; a sandbox without them is not an app error.
  page.on("console", (m) => m.type() === "error" && (m.location().url ?? "").startsWith(base) && errors.push(m.text()));
  // Every screenshot also runs an axe accessibility scan of the page.
  const axeSource = readFileSync(path.join(root, "node_modules/axe-core/axe.min.js"), "utf8");
  const a11y = new Map();
  const shot = async (name) => {
    await page.screenshot({ path: path.join(shots, name + ".png"), fullPage: true });
    await page.evaluate(axeSource);
    const r = await page.evaluate(() => window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa"] }));
    for (const v of r.violations) {
      const e = a11y.get(v.id) ?? { impact: v.impact, help: v.help, pages: new Set(), targets: new Set() };
      e.pages.add(name);
      for (const n of v.nodes.slice(0, 3)) e.targets.add(String(n.target));
      a11y.set(v.id, e);
    }
  };

  await page.goto(base + "/#/");
  await page.waitForSelector(".tiles");
  await page.waitForTimeout(300);
  await shot("01-dashboard");
  check((await page.textContent(".tiles")).includes(String(games.length)), "dashboard shows game count");

  await page.goto(base + "/#/library");
  await page.waitForSelector("table.grid tbody tr");
  check((await page.$$("table.grid tbody tr")).length === games.length, "library lists every game");
  await shot("02-library");
  await page.selectOption("select >> nth=1", "win");
  await page.waitForTimeout(400);
  const wins = (await page.$$("table.grid tbody tr")).length;
  check(wins === games.filter((g) => g.myResult === "win").length, `result filter shows ${wins} wins`);

  const worst = [...games].sort((a, b) => b.mistakes - a.mistakes)[0];
  await page.goto(base + `/#/game/${worst.id}`);
  await page.waitForSelector(".moves li");
  await page.waitForTimeout(500);
  check((await page.$$(".board img.piece-image")).length >= 38, "board renders pieces");
  await page.waitForSelector(".book-mark");
  check((await page.$$(".book-mark")).length >= 1, "game view marks book moves");
  await page.keyboard.press("]");
  await page.waitForTimeout(300);
  await page.click("text=詰みチェック");
  await page.waitForSelector(".mate-result", { timeout: 20000 });
  await page.click("button:has-text('狙い Threat?')");
  await page.waitForSelector(".threat-result", { timeout: 20000 });
  check(/passes:|no passing/.test(await page.textContent(".threat-result")), "the threat check says what the opponent would play");
  await page.click("button:has-text('Candidate moves')");
  await page.waitForFunction(() => /depth [2-9]/.test(document.querySelector(".mdepth")?.textContent ?? ""), null, { timeout: 20000 });
  check((await page.$$(".multipv .mrow")).length >= 1, "candidate moves stream with a rising depth");
  await page.click("button:has-text('Stop')");
  check(/手詰|No forced mate|no mate search|without an answer/.test(await page.textContent(".mate-result")), "mate check answers");
  await shot("03-game");
  check((await page.textContent(".here")).includes("手目"), "keyboard jumps to a mistake");

  await page.click("summary:has-text('Export')");
  check((await page.$$(".menu-list a")).length === 4, "export menu lists four formats");
  await page.click("summary:has-text('Export')");
  await page.click("text=Write review note");
  await page.waitForURL(/#\/notes\/\d+/);
  await page.waitForSelector(".board img.piece-image", { timeout: 10000 });
  check((await page.textContent("body")).includes("悪手 Mistakes"), "review note opens in the notebook with boards");
  await shot("03b-review-note");

  // A KIF with a stored variation: the move list offers it and clicking shows it as a line.
  const branchKif = ["手合割：平手", "先手：Q", "後手：study", "手数----指手---------消費時間--", "   1 ７六歩(77)", "   2 ３四歩(33)+", "   3 ２六歩(27)", "   4 投了", "", "変化：2手", "   2 ８四歩(83)", "*居飛車にする手", "   3 ６八銀(79)", ""].join("\n");
  const branchId = (await api("POST", "/api/import", { text: branchKif })).results[0].id;
  await page.goto(base + `/#/game/${branchId}`);
  await page.waitForSelector(".branch-mark");
  await page.click(".branch-mark");
  await page.waitForSelector(".branch-note");
  check((await page.textContent(".branch-note")).includes("居飛車にする手"), "stored variations open from the move list");
  await shot("03c-branch");

  // Second opinion: the mock engine with naive piece values grades the bishop sacrifice differently.
  await api("PUT", "/api/settings", { engine2: { path: engine, options: { Style: "naive" }, movetimeMs: 60 } });
  await page.goto(base + `/#/game/${worst.id}`);
  await page.waitForSelector(".second button");
  await page.click(".second button:has-text('Compare')");
  await page.waitForSelector(".second .dis li, .second :text('agree on every move')", { timeout: 30000 });
  check(/Agreement \d+%/.test(await page.textContent(".second")), "the second engine's comparison shows an agreement rate");
  await shot("03d-second-opinion");
  await api("PUT", "/api/settings", { engine2: { path: "", options: {}, movetimeMs: 1000 } });

  await page.goto(base + "/#/review");
  await api("DELETE", `/api/games/${branchId}`);
  await page.waitForTimeout(800);
  await shot("04-review");
  if (cards.length) {
    await page.click("text=Show answer");
    await page.waitForSelector(".grades");
    await shot("05-review-answer");
    await page.click(".grade >> nth=2");
    await page.waitForTimeout(300);
    const counts = await api("GET", "/api/cards/counts");
    check(counts.reviewedToday === 1, "rating a card records a review");
    if (cards.length === 1) {
      await page.waitForSelector(".session");
      check((await page.textContent(".session")).includes("This session: 1 card"), "review ends with a session summary");
    }
    await page.goto(base + "/#/");
    await page.waitForSelector(".cal .day.l1");
    check((await page.textContent(".streak")).includes("1 day in a row"), "dashboard shows the review streak");
    await shot("04b-dashboard-streak");
  }

  if (cards.length) {
    // Build a deck from the cards against one opponent and save it.
    await page.goto(base + "/#/review");
    await page.waitForSelector(".head select");
    await page.selectOption(".head select >> nth=0", "custom");
    await page.waitForSelector(".builder");
    const oppOption = await page.$eval(".builder select >> nth=1", (el) => [...el.options].find((o) => o.value)?.value ?? "");
    check(!!oppOption, "the deck builder offers the opponents that have cards");
    await page.selectOption(".builder select >> nth=1", oppOption);
    await page.fill(".builder input", "e2e deck");
    await page.click("button:has-text('Save as deck')");
    await page.waitForSelector("button:has-text('Delete deck')");
    check((await page.$$eval(".head select >> nth=0 >> option", (os) => os.map((o) => o.textContent))).some((t) => t?.startsWith("e2e deck")), "a saved deck appears in the deck menu");
    await shot("04c-review-deck");
  }

  await page.goto(base + "/#/stats");
  await page.waitForSelector(".tiles");
  await page.waitForTimeout(300);
  await shot("06-stats");
  check((await page.textContent("body")).includes("Mistakes by kind of move"), "stats shows mistakes by kind of move");
  const opp = games.find((g) => g.opponent)?.opponent;
  if (opp) {
    await page.goto(base + `/#/player/${encodeURIComponent(opp)}`);
    await page.waitForSelector(".game");
    check((await page.$$(".game")).length === games.filter((g) => g.opponent === opp).length, "player profile lists games vs that opponent");
    await shot("06c-player");
    await page.click("button:has-text('Write prep sheet')");
    await page.waitForURL(/#\/notes\/\d+/);
    await page.waitForFunction(() => document.body.textContent?.includes("対策 vs") && document.body.textContent?.includes("作戦 Plan"));
    check((await page.textContent("body")).includes("Their openings"), "a prep sheet for the opponent is written into the notebook");
    await shot("06f-prep");
    await page.goto(base + `/#/player/${encodeURIComponent(opp)}`);
    await page.waitForSelector(".game");
    await page.click("text=Openings against them");
    await page.waitForSelector(".chip.opp");
    await page.waitForTimeout(300);
    const vsGames = (await api("GET", `/api/explorer?opponent=${encodeURIComponent(opp)}`)).games;
    check((await page.textContent(".summary .stat")).trim() === String(vsGames) && vsGames <= games.filter((g) => g.opponent === opp).length, "explorer filters to one opponent");
  }

  await page.goto(base + "/#/explorer");
  await page.waitForSelector("table.moves tbody tr");
  check((await page.$$("table.moves tbody tr")).length >= 1, "explorer lists first moves");
  await page.waitForSelector("table.moves .tag:has-text('定跡')");
  check((await page.$$(".book-only .chip")).length >= 1, "explorer shows book moves");
  await page.click("table.moves tbody tr >> nth=0");
  await page.waitForFunction(() => location.hash.includes("moves="));
  await page.waitForSelector("table.moves tbody tr, .empty");
  await page.waitForTimeout(400);
  check((await page.$$(".crumbs a")).length === 2, "clicking a move walks the tree");
  await shot("06b-explorer");

  // Study board: open the worst game's line from the game view, let the engine look, play its move.
  await page.goto(base + `/#/game/${worst.id}`);
  await page.waitForSelector(".moves li");
  await page.click("a:has-text('Study board')");
  await page.waitForURL(/#\/board\?/);
  await page.waitForSelector(".moves li");
  check((await page.$$(".moves li")).length === worst.move_count + 1, "study board opens with the game's line");
  await page.click(".moves li[data-index=\"2\"]");
  await page.waitForSelector(".lrow", { timeout: 20000 });
  check((await page.$$(".lrow")).length >= 1, "study board shows engine lines");
  await page.waitForFunction(() => /depth [2-9]/.test(document.querySelector(".depth")?.textContent ?? ""), null, { timeout: 20000 });
  check(true, "study board streams a deepening search");
  await page.click(".depth button:has-text('Stop')");
  await page.waitForSelector(".depth button:has-text('Think again')");
  check(true, "stopping the search keeps its lines");
  await page.click(".lrow >> nth=0");
  await page.waitForFunction(() => document.querySelector(".moves li.on")?.getAttribute("data-index") === "3");
  check(/[?&]moves=/.test(await page.evaluate(() => location.hash)), "playing on the study board keeps the line in the URL");
  const boardMoves = (await page.$$(".moves li")).length;
  await page.reload();
  await page.waitForSelector(".moves li.on[data-index=\"3\"]");
  check((await page.$$(".moves li")).length === boardMoves, "the study board line survives a reload");
  // The engine's move differs from the game's ☗5五角, so the game line is kept as a variation.
  check((await page.$$(".alt-mark")).length === 1, "a different move starts a variation and keeps the old line");
  await page.click("button:has-text('Save into the game')");
  await page.waitForFunction(() => document.querySelector(".toast")?.textContent?.includes("variation"));
  const savedBranches = await api("GET", `/api/games/${worst.id}/branches`);
  check(savedBranches.length >= 1, "study board variations save into the game");
  await page.click(".alt-mark");
  await page.waitForFunction(() => document.querySelectorAll(".alt-mark").length === 1 && document.querySelector(".moves li.on")?.getAttribute("data-index") === "3");
  check((await page.$$(".moves li")).length === worst.move_count + 1, "the 変 chip switches back to the game line");
  await shot("06d-board");
  await page.fill("#board-input", "lnsgkgsnl/1r5b1/ppppppppp/9/9/2P6/PP1PPPPPP/1B5R1/LNSGKGSNL w - 2");
  await page.click("button:has-text('Set up')");
  await page.waitForFunction(() => document.querySelectorAll(".moves li").length === 1);
  check((await page.textContent(".sfen")).includes("2P6"), "the study board sets up a pasted SFEN");
  await page.click(".lrow >> nth=0", { timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll(".moves li").length === 2);
  await page.click("button:has-text('Save as game')");
  await page.waitForFunction(() => location.hash.startsWith("#/game/"));
  const savedId = Number((await page.evaluate(() => location.hash)).split("/")[2]);
  check((await api("GET", `/api/games/${savedId}`)).plies.length === 2, "a study board line saves as a game");
  // Leave the game page first, or its live refresh asks for the deleted game.
  await page.goto(base + "/#/");
  await page.waitForSelector(".tiles");
  await api("DELETE", `/api/games/${savedId}`);

  const p = await api("POST", "/api/pages", {
    notebook: "四間飛車",
    title: "Demo page",
    body: `# Demo\n\nA position from a game:\n\n:::shogi-view{game=${worst.id} ply=${worst.turning_ply ?? 10}}\n:::\n\nAn excerpt:\n\n:kifu[game:${worst.id}]{start=1 stop=12}\n\nFrom moves:\n\n:::shogi-view{move=4}\nposition startpos moves 7g7f 3c3d 2g2f 4c4d 2f2e\n:::\n`,
  });
  await page.goto(base + `/#/notes/${p.id}`);
  await page.waitForSelector(".note-board");
  await page.waitForTimeout(800);
  check((await page.$$(".note-board")).length === 3, "notebook renders three board blocks");
  await shot("07-notebook");
  await page.click("text=This week's report");
  await page.waitForFunction(() => document.body.textContent?.includes("週報") && document.body.textContent?.includes("練習 Practice"));
  check(true, "weekly report page is written into the notebook");
  await shot("07b-weekly");

  // Record an over-the-board game by clicking squares: ☗7六歩 △3四歩, then save.
  await page.goto(base + "/#/record");
  await page.waitForSelector(".board.operation", { state: "attached" });
  await page.waitForTimeout(400);
  const clickSquare = async (file, rank) => {
    const pt = await page.evaluate(([f, r]) => {
      const cells = [...document.querySelectorAll(".board.operation > div")].map((d) => d.getBoundingClientRect()).filter((b) => b.width > 0);
      const xs = [...new Set(cells.map((b) => Math.round(b.left)))].sort((a, b) => a - b);
      const ys = [...new Set(cells.map((b) => Math.round(b.top)))].sort((a, b) => a - b);
      const w = cells[0].width, h = cells[0].height;
      return { x: xs[9 - f] + w / 2, y: ys[r - 1] + h / 2 };
    }, [file, rank]);
    await page.mouse.click(pt.x, pt.y);
    await page.waitForTimeout(150);
  };
  await clickSquare(7, 7);
  await clickSquare(7, 6);
  await clickSquare(3, 3);
  await clickSquare(3, 4);
  check((await page.$$(".moves li")).length === 2, "recording a game by clicking moves");
  await page.fill("input[placeholder=name] >> nth=0", "Q");
  await page.fill("input[placeholder=name] >> nth=1", "club rival");
  await shot("08a-record");
  await page.click("text=Save to library");
  await page.waitForFunction(() => location.hash.startsWith("#/game/"));
  check((await api("GET", "/api/games")).length === games.length + 1, "recorded game is saved to the library");

  // Mark the first move as dubious; the mark shows in the move list and is saved.
  const recordedId = (await page.evaluate(() => location.hash)).split("/")[2].split("?")[0];
  await page.click(".moves li[data-ply=\"1\"]");
  await page.click(".umarks .chip[title=Dubious]");
  await page.waitForSelector(".moves .umark");
  check((await api("GET", `/api/games/${recordedId}`)).plies[1].user_mark === "?!", "marking a move with ?! saves it");

  // Set up a position by hand on the study board: tsume template, a piece from ☖'s stand to ☗'s, then onto 1九.
  await page.goto(base + "/#/board");
  await page.waitForSelector(".moves li");
  await page.click("button:has-text('Edit position')");
  await page.waitForSelector(".edit");
  await page.selectOption(".edit select", { label: "詰将棋 Tsume (one king)" });
  await page.waitForTimeout(300);
  const handPointers = (i) => page.$$(`.hand.operation >> nth=${i} >> div`);
  // The stand's touch area sits over its pieces for hit tests, so click the piece element itself.
  await (await handPointers(1))[1].dispatchEvent("click");
  await (await handPointers(0))[0].dispatchEvent("click");
  await page.waitForTimeout(200);
  await (await handPointers(0))[1].dispatchEvent("click");
  await clickSquare(1, 9);
  check((await page.$$(".problems li")).length === 0, "a hand-made position with one king passes the checks");
  await shot("06e-board-edit");
  await page.click(".edit button:has-text('Done')");
  await page.waitForSelector(".lrow", { timeout: 20000 });
  const editedSfen = new URLSearchParams((await page.evaluate(() => location.hash)).split("?")[1]).get("sfen") ?? "";
  check(/^4k4\/9\/9\/9\/9\/9\/9\/9\/[A-Z]{1}8 b /.test(editedSfen) || /^4k4\/9\/9\/9\/9\/9\/9\/9\/8[A-Z] b /.test(editedSfen), `the edited position becomes the board's start (${editedSfen})`);

  // Saved study: comment a move, save, reopen by id, then embed it in a notebook page.
  await page.goto(base + "/#/board");
  await page.waitForSelector(".lrow", { timeout: 20000 });
  await page.click(".lrow >> nth=0");
  await page.waitForFunction(() => document.querySelectorAll(".moves li").length === 2);
  await page.fill("#board-comment", "e2e: the engine's first choice");
  await page.fill("#new-study-title", "e2e study");
  await page.click("button:has-text('Save study')");
  await page.waitForFunction(() => /^#\/board\/\d+/.test(location.hash));
  const studyHash = await page.evaluate(() => location.hash);
  const studyIdE2e = Number(studyHash.split("/")[2].split("?")[0]);
  // A later edit saves itself.
  await page.click(".moves li[data-index=\"0\"]");
  await page.fill("#board-comment", "e2e: start position note");
  await page.waitForFunction(() => document.querySelector(".study-title [role=status]")?.textContent === "Saved", null, { timeout: 10000 });
  await page.reload();
  await page.waitForSelector(".moves li[data-index=\"1\"]");
  await page.click(".moves li[data-index=\"1\"]");
  check((await page.inputValue("#board-comment")) === "e2e: the engine's first choice", "a saved study keeps its move comments after a reload");
  check((await page.inputValue("#study-title")) === "e2e study" && (await page.textContent(".studies")).includes("e2e study"), "the saved study is listed by title");
  await shot("06g-study");
  await page.click("button:has-text('Add to notebook')");
  await page.waitForSelector("dialog[open]");
  await page.fill("dialog[open] input[required]", "e2e study page");
  await page.click("dialog[open] button:has-text('Add')");
  await page.waitForFunction(() => !document.querySelector("dialog[open]"));
  const studyPage = (await api("GET", "/api/pages")).find((x) => x.title === "e2e study page");
  check((await api("GET", `/api/pages/${studyPage.id}`)).body.includes(`:::shogi-study{id=${studyIdE2e}}`), "Add to notebook embeds the saved study");
  await page.goto(base + `/#/notes/${studyPage.id}`);
  await page.waitForSelector(".study-block .comment");
  await page.click(".study-block button[aria-label='Next move']");
  await page.waitForFunction(() => document.querySelector(".study-block .comment")?.textContent?.includes("first choice"));
  check(true, "the embedded study steps through its moves with their comments");

  // Drill a study: ☗7六歩 right, then a wrong move where the study plays ☗2六歩, which comes back at the end.
  const drillStudy = await api("POST", "/api/studies", {
    title: "e2e drill",
    start_sfen: "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1",
    tree: { usi: "", children: [{ usi: "7g7f", children: [{ usi: "3c3d", children: [{ usi: "2g2f", comment: "居飛車で", children: [] }] }] }] },
  });
  await page.goto(base + `/#/drill/${drillStudy.id}?side=black`);
  await page.waitForSelector(".prompt");
  await page.waitForTimeout(300);
  check((await page.textContent(".spread")).includes("1 / 2"), "the drill asks each ☗ position of the study");
  await clickSquare(7, 7);
  await clickSquare(7, 6);
  await page.waitForSelector(".verdict.good");
  await page.click("button:has-text('Next')");
  await page.waitForSelector(".prompt");
  await page.waitForTimeout(300);
  await clickSquare(5, 7);
  await clickSquare(5, 6);
  await page.waitForSelector(".verdict.bad");
  check((await page.textContent(".box")).includes("居飛車で"), "a missed drill position shows the study's move and comment");
  await shot("06h-drill");
  await page.click("button:has-text('Next')");
  await page.waitForFunction(() => document.querySelector(".spread")?.textContent?.includes("3 / 3"));
  check(true, "a missed position is asked again before the session ends");
  await api("DELETE", `/api/studies/${drillStudy.id}`);

  // Guess the moves of the game just recorded: ☗7六歩 is what was played.
  await page.goto(base + `/#/guess?game=${recordedId}&side=black`);
  await page.waitForSelector(".board.operation", { state: "attached" });
  await page.waitForTimeout(400);
  await clickSquare(7, 7);
  await clickSquare(7, 6);
  await page.waitForSelector(".result", { timeout: 20000 });
  check((await page.textContent(".status")).includes("Same as the game"), "guess mode recognises the game move");
  await shot("08b-guess");
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(200);
  check((await page.textContent(".status")).includes("1 of 1 matched"), "→ moves on, to the end of a short game");

  // Play the opening position out against the engine: ☗7六歩, and the engine answers.
  await page.goto(base + "/#/practice?sfen=" + encodeURIComponent("lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1"));
  await page.waitForSelector(".board.operation", { state: "attached" });
  await page.waitForTimeout(400);
  await clickSquare(7, 7);
  await clickSquare(7, 6);
  await page.waitForFunction(() => document.querySelectorAll(".moves li").length === 2, null, { timeout: 20000 });
  check((await page.textContent(".status")).includes("Your move"), "engine answers in practice mode");
  await shot("08b-practice");

  // Win it again: a rook up, the drill keeps the winning chances in view.
  await page.goto(base + "/?convert#/practice?goal=convert&back=stats&sfen=" + encodeURIComponent("lnsgkgsnl/7b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1"));
  await page.waitForSelector(".board.operation", { state: "attached" });
  await page.waitForTimeout(400);
  check((await page.textContent("h1")).includes("Win it again"), "convert drill opens from a won position");
  await clickSquare(7, 7);
  await clickSquare(7, 6);
  await page.waitForFunction(() => document.querySelectorAll(".moves li").length === 2, null, { timeout: 20000 });
  check(!(await page.$(".warning")) && /chances (8|9)\d%/.test(await page.textContent(".side")), "convert drill shows the winning chances kept");

  await page.goto(base + "/#/puzzles");
  await page.waitForSelector(".grid, .empty");
  check(!(await page.textContent(".page")).includes("Loading"), "mate puzzles page loads");
  await shot("08c-puzzles");
  await page.goto(base + "/#/practice?goal=mate&mate=1&sfen=" + encodeURIComponent("4k4/9/4P4/9/9/9/9/9/9 b G2r2b3g4s4n4l17p 1"));
  await page.waitForSelector("h1");
  check((await page.textContent("h1")).includes("Mate in 1"), "a puzzle opens in mate mode");
  await shot("08d-puzzle");

  // A tsume collection from a file of SFEN lines, as shogimap-crawler writes them.
  const tsumeFile = path.join(data, "1te.txt");
  writeFileSync(tsumeFile, ["8k/9/8P/9/9/9/9/9/9 b G 1 moves G*1b", "4k4/9/4P4/9/9/9/9/9/9 b G 1 moves G*5b", ""].join("\n"));
  await page.goto(base + "/#/puzzles?tab=tsume");
  await page.waitForSelector(".importer");
  await page.setInputFiles('.importer input[type="file"]', tsumeFile);
  await page.waitForFunction(() => document.querySelectorAll(".card").length === 2);
  check((await page.textContent(".cols")).includes("1te"), "tsume file becomes a collection");
  await shot("08g-tsume");
  await page.click(".card >> text=Solve");
  // The puzzle page has an h1 too: wait for the practice page itself.
  await page.waitForFunction(() => location.hash.startsWith("#/practice") && document.querySelector("h1")?.textContent?.includes("Mate in"), null, { timeout: 10000 }).catch(() => {});
  check((await page.textContent("h1")).includes("Mate in 1"), "a collection problem opens in mate mode");
  // Solve it: drop the gold from the hand onto 1二.
  await page.waitForSelector(".board.operation", { state: "attached" });
  await page.waitForTimeout(400);
  // The hand's click targets are laid out by size, so click where the gold is drawn.
  const gold = await page.locator(".hand.front img.piece-image").first().boundingBox();
  await page.mouse.click(gold.x + gold.width / 2, gold.y + gold.height / 2);
  await page.waitForTimeout(150);
  await clickSquare(1, 2);
  await page.waitForFunction(() => /詰み/.test(document.querySelector(".status")?.textContent ?? ""), null, { timeout: 20000 }).catch(async () => {
    await shot("08h-debug");
    console.log("status:", await page.textContent(".status"), "| moves:", await page.textContent(".moves"));
  });
  const solvedCol = (await api("GET", "/api/tsume")).find((c) => c.collection === "1te");
  check(solvedCol?.solved === 1, "solving a tsume problem on the board records it");
  await shot("08h-tsume-solved");

  await page.goto(base + "/#/repertoire");
  await page.waitForSelector(".layout, .empty");
  check(!(await page.textContent(".page")).includes("Loading"), "opening drill loads");
  if (await page.$(".layout")) {
    await page.waitForTimeout(400);
    await clickSquare(7, 7);
    await clickSquare(7, 6);
    await page.waitForSelector(".verdict");
    check(/Good|Not one/.test(await page.textContent(".verdict")), "opening drill judges a move");
  }
  await shot("08e-drill");

  await page.goto(base + "/#/settings");
  await page.waitForSelector("form");
  await page.click("text=Test engine");
  await page.waitForSelector("details.opts", { timeout: 20000 });
  await page.click("details.opts summary");
  check((await page.textContent("details.opts")).includes("USI_Hash"), "engine test lists the engine's options");
  // Restoring our own backup merges cleanly: nothing new.
  const backupFile = path.join(data, "e2e-backup.db");
  writeFileSync(backupFile, Buffer.from(await (await fetch(base + "/api/backup")).arrayBuffer()));
  await page.setInputFiles('input[type="file"][accept^=".db"]', backupFile);
  await page.waitForSelector(".toast:has-text('Restored')", { timeout: 30000 });
  check(/\(0 new\)/.test(await page.textContent(".toast")), "restoring a backup of the same library adds nothing");
  await page.click("text=Allow phones on this network");
  await page.waitForSelector(".qr svg");
  check(true, "phone access shows a QR code");
  await shot("08-settings");

  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("?");
  await page.waitForSelector("dialog.help[open]");
  check((await page.textContent("dialog.help")).includes("Next / previous mistake") || (await page.textContent("dialog.help")).includes("next mistake"), "? shows the keyboard shortcuts");
  await shot("08f-help");
  await page.keyboard.press("Escape");
  await page.keyboard.press("/");
  await page.waitForFunction(() => location.hash.startsWith("#/library") && document.activeElement?.getAttribute("type") === "search");
  check(true, "/ jumps to library search");

  // Ctrl/⌘+V on any page imports a copied kifu and opens it.
  await page.goto(base + "/#/stats");
  await page.waitForSelector(".tiles");
  const before = (await api("GET", "/api/games")).length;
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "position startpos moves 2g2f 8c8d 2f2e 8d8e 6i7h");
    document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
  });
  await page.waitForFunction(() => location.hash.startsWith("#/game/"));
  check((await api("GET", "/api/games")).length === before + 1, "pasting a kifu imports and opens it");
  // Several games in one paste land in the library with a count.
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "position startpos moves 7g7f 3c3d 2g2f 4c4d\nposition startpos moves 5g5f 5c5d 2h5h 8b5b\nposition startpos moves 2g2f 8c8d 2f2e 8d8e 6i7h");
    document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
  });
  await page.waitForFunction(() => location.hash.startsWith("#/library") && document.querySelector(".toast")?.textContent?.includes("Imported 2 games, 1 already there"));
  check((await api("GET", "/api/games")).length === before + 3, "pasting several games imports each of them");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base + `/#/game/${worst.id}`);
  await page.waitForSelector(".moves li");
  await page.waitForTimeout(500);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  await shot("09-game-phone");
  check(!overflow, "game page has no horizontal scroll at phone width");

  // The phone link: lands on the review page, without the settings tab.
  const lanInfo = await api("GET", "/api/lan");
  if (lanInfo.urls[0]) {
    await page.goto(lanInfo.urls[0]);
    await page.waitForFunction(() => location.hash === "#/review");
    await page.waitForTimeout(400);
    const navText = await page.textContent("nav");
    check(!navText.includes("Settings") && navText.includes("Review"), "phone link opens the review page");
    await shot("09b-phone-review");
  }
  await api("PUT", "/api/lan", { enabled: false });

  // Light theme: chosen in Settings, kept per device, and scanned for contrast like every other screenshot.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base + "/#/settings");
  await page.waitForSelector("select");
  await page.selectOption("section:has-text('Appearance') select", "light");
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  check((await page.evaluate(() => localStorage.getItem("kifu.theme"))) === "light", "the light theme is chosen and saved on this device");
  for (const [hash, ready, name] of [
    ["/#/", ".tiles", "10-light-dashboard"],
    [`/#/game/${worst.id}`, ".moves li", "10-light-game"],
    ["/#/stats", ".tiles", "10-light-stats"],
    ["/#/review", ".head select", "10-light-review"],
  ]) {
    await page.goto(base + hash);
    await page.waitForSelector(ready);
    await page.waitForTimeout(400);
    await shot(name);
  }
  check((await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === "rgb(246, 240, 228)", "the light theme survives a reload");
  await page.evaluate(() => localStorage.removeItem("kifu.theme"));

  for (const [id, e] of a11y) console.log(`a11y ${e.impact} ${id}: ${e.help} [${[...e.pages].join(", ")}] e.g. ${[...e.targets].slice(0, 3).join(" | ")}`);
  const blocking = [...a11y].filter(([, e]) => e.impact === "critical" || e.impact === "serious");
  check(blocking.length === 0, "no serious accessibility problems" + (blocking.length ? ": " + blocking.map(([id]) => id).join(", ") : ""));
  check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  console.log("screenshots in", shots);
} finally {
  await browser?.close();
  server.kill();
}
