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
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
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

  await page.goto(base + "/#/review");
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

  await page.goto(base + "/#/stats");
  await page.waitForSelector(".tiles");
  await page.waitForTimeout(300);
  await shot("06-stats");
  const opp = games.find((g) => g.opponent)?.opponent;
  if (opp) {
    await page.goto(base + `/#/player/${encodeURIComponent(opp)}`);
    await page.waitForSelector(".game");
    check((await page.$$(".game")).length === games.filter((g) => g.opponent === opp).length, "player profile lists games vs that opponent");
    await shot("06c-player");
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

  // Play the opening position out against the engine: ☗7六歩, and the engine answers.
  await page.goto(base + "/#/practice?sfen=" + encodeURIComponent("lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1"));
  await page.waitForSelector(".board.operation", { state: "attached" });
  await page.waitForTimeout(400);
  await clickSquare(7, 7);
  await clickSquare(7, 6);
  await page.waitForFunction(() => document.querySelectorAll(".moves li").length === 2, null, { timeout: 20000 });
  check((await page.textContent(".status")).includes("Your move"), "engine answers in practice mode");
  await shot("08b-practice");

  await page.goto(base + "/#/puzzles");
  await page.waitForSelector(".grid, .empty");
  check(!(await page.textContent(".page")).includes("Loading"), "mate puzzles page loads");
  await shot("08c-puzzles");
  await page.goto(base + "/#/practice?goal=mate&mate=1&sfen=" + encodeURIComponent("4k4/9/4P4/9/9/9/9/9/9 b G2r2b3g4s4n4l17p 1"));
  await page.waitForSelector("h1");
  check((await page.textContent("h1")).includes("Mate in 1"), "a puzzle opens in mate mode");
  await shot("08d-puzzle");

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
  await shot("08-settings");

  await page.keyboard.press("?");
  await page.waitForSelector("dialog.help[open]");
  check((await page.textContent("dialog.help")).includes("Next / previous mistake") || (await page.textContent("dialog.help")).includes("next mistake"), "? shows the keyboard shortcuts");
  await shot("08f-help");
  await page.keyboard.press("Escape");
  await page.keyboard.press("/");
  await page.waitForFunction(() => location.hash.startsWith("#/library") && document.activeElement?.getAttribute("type") === "search");
  check(true, "/ jumps to library search");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base + `/#/game/${worst.id}`);
  await page.waitForSelector(".moves li");
  await page.waitForTimeout(500);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  await shot("09-game-phone");
  check(!overflow, "game page has no horizontal scroll at phone width");

  for (const [id, e] of a11y) console.log(`a11y ${e.impact} ${id}: ${e.help} [${[...e.pages].join(", ")}] e.g. ${[...e.targets].slice(0, 3).join(" | ")}`);
  const blocking = [...a11y].filter(([, e]) => e.impact === "critical" || e.impact === "serious");
  check(blocking.length === 0, "no serious accessibility problems" + (blocking.length ? ": " + blocking.map(([id]) => id).join(", ") : ""));
  check(errors.length === 0, "no page errors" + (errors.length ? ": " + errors.join(" | ") : ""));
  console.log("screenshots in", shots);
} finally {
  await browser?.close();
  server.kill();
}
