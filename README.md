# 棋譜帖 Kifu Study

A local desktop app for studying your own shogi games: import kifu, let a USI engine find your mistakes, drill them as cards, and keep study notes with live boards.

Everything stays on your machine, in one SQLite file.

## What it does

- **Today.** The dashboard lists what to do now: due cards, recent losses that have no review note yet, mates you missed, and opening positions where your usual move is weak.
- **Library.** Import KIF, KIFU, KI2, CSA, JKF, SFEN or USI by drag-drop, file picker or paste. Shift_JIS and UTF-8 are detected automatically, and duplicates are skipped.
  - **Lishogi:** set your username in Settings and press "Fetch from Lishogi". Later fetches only ask for new games.
  - **Watched folders:** kifu saved by ShogiGUI, Kifu for Windows or a Wars downloader into a watched folder are imported while the app runs.
  - Each game gets its 戦型, the castles on both sides over time, and its tactics (149 rules converted from HiraganaSuisho and sylwi-kifu-vue).
  - Filter by side, result, opening, castle, opponent, tag, source or date, and save a filter as a collection. "Export shown" downloads the filtered games as KIF files in a zip.
- **Analysis.** A background queue runs your USI engine (YaneuraOu, 水匠 etc.) over every position. Evaluations are cached per position.
  - Moves are graded 緩手 / 疑問手 / 悪手 / 大悪手 with ShogiHome's win-rate thresholds, plus missed mates and missed wins.
  - Each game gets accuracy, a turning point, and an eval graph with a think-time strip underneath. Missed mates and thrown-away wins are marked separately.
- **Game view.** ShogiHome's board, keyboard navigation (← → Home End, `[` `]` to jump between mistakes, `f` to flip), and engine candidate moves.
  - You can try your own move and get an engine verdict, edit comments, search for the same position across games, and export KIF/CSA with the evals written as ShogiHome-style comments.
- **Mistake cards.** Your 悪手 and worse become cards automatically. You can also make one from any position.
  - In review you play your answer on the board. The best move, or any move the engine says is within the tolerance, counts as correct. You can replay the engine line.
  - Scheduling is SM-2, or FSRS v4.5 if you pick it in Settings. A card missed four times becomes a leech, and the review screen then asks you to write down the idea or study the game.
  - "Export to Anki" writes a tab-separated file Anki imports directly.
- **Play it out.** From any game position or card, play on against the engine at a strength you pick. It's useful for practising the conversion of won positions you let slip.
- **Mates from my games.** Every analysed position where the side to move had a forced mate becomes a puzzle, with the ones you missed listed first. You solve it on the board while the engine defends, and it tells you the moment a move lets the king escape.
- **Stats.** Win rate by side, opening, opponent's opening, castle, matchup, time control and opponent, plus a monthly trend, where in the game you lose points, and whether fast moves go wrong more often.
- **Opening book.** Point Settings at a YaneuraOu-format book (.db) and games show which moves were book moves and where you left the book, with the book's choices there.
- **Explorer.** Walk the opening tree of your own games: each next move with how often you played it, your score after it, your average loss, and the engine's best move.
- **Opening drill.** The opening positions you reach most often with you to move, as a quiz. A move counts as correct if it's a book move, the engine's choice, or one you play there without losing points. It can filter to the positions where your usual move is weak.
- **Notebooks.** Markdown pages with live boards, using the personal-shogi-note directives:

  ```
  :::shogi-view{game=12 ply=48}
  :::

  :::shogi-view{move=4}
  position startpos moves 7g7f 3c3d 2g2f 4c4d 2f2e
  :::

  :kifu[game:12]{start=1 stop=20}
  ```

  "Write review note" on a game makes a page with the summary and each big mistake as a board with the engine's line, ready to annotate. The ".mdx" button downloads the same note with the moves written out, so it renders in personal-shogi-note as is.

## Run it

Requires Node 22.5 or newer (for `node:sqlite`).

```sh
npm install
npm start          # build and open the Electron app
npm run serve      # or: build and serve at http://127.0.0.1:3210 in a browser
npm run dev        # Vite with hot reload on :5173, API on :3210
```

The library is also backed up once a day to a `backups` folder next to it; the newest 7 are kept (change or turn off in Settings).

`serve` reads `PORT`, `KIFU_STUDY_DATA` (default `~/.kifu-study`) and `KIFU_STUDY_DB`. The Electron app keeps its database in the OS user-data folder.

On first launch, open Settings, enter your player names, and set the path to a USI engine.

## Installers

`npm run dist` builds an installer for the current OS into `release/` (dmg on macOS, NSIS exe on Windows, AppImage on Linux). The **Installers** GitHub workflow builds all three; run it from the Actions tab or push a `v*` tag.

The builds are not code-signed. On macOS, open the app the first time with right-click → Open; on Windows, choose "More info → Run anyway" in SmartScreen.

## Tests

```sh
npm test           # unit + API tests (vitest); uses tools/mock-usi-engine.mjs
npm run typecheck
npm run e2e        # builds, starts the server, drives every screen in Chromium, saves screenshots to test-results/e2e
```

`E2E_ENGINE=/path/to/engine E2E_KIFU=/dir/of/kifu npm run e2e` runs the browser test against a real engine and your own files. `CHROMIUM_PATH` picks the browser.

The mock engine only counts material and looks one capture ahead. It proves the plumbing works, not the quality of the analysis.

`tools/selfplay.ts` makes demo games by engine self-play.

## Layout

```
src/core/       record import/export, summaries, grading, SM-2, classifier (shared, no I/O)
src/server/     SQLite store, library, analysis queue, USI engine client, cards, stats, HTTP API
src/electron/   Electron shell: starts the server and opens a window
src/renderer/   Vue 3 UI; vendor/shogihome holds the board component
tools/          build, mock engine, classifier rule converter, self-play generator
```

## Licenses

The app itself is MIT. Code and images from ShogiHome, HiraganaSuisho and sylwi-kifu-vue are MIT; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
