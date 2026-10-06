# 棋譜帖 Kifu Study: design

This is how the app is put together and what to build next. The README says what the app does for a user. This file is for whoever changes the code.

## Goals

1. **Study your own games.** Each feature starts from games you played and the mistakes you made in them. Pro games and tsume are extras.
2. **Local and private.** Everything stays in one SQLite file. Nothing is sent anywhere unless you ask (Lishogi fetch). No accounts, no telemetry.
3. **The engine does the tedious part.** It grades every move, finds mates and checks its own flags. You spend your time thinking about positions.
4. **Short daily loop.** The Today page should always say what to do next: due cards, unreviewed losses, missed mates, weak openings.

Non-goals: playing online, being a full kifu editor like ShogiHome or KifuForWindows, cloud sync.

## Architecture

```
            ┌──────────── Electron main (src/electron) ────────────┐
            │ starts the server, opens a BrowserWindow, dock badge │
            └──────────────────────────┬───────────────────────────┘
 browser / phone ──HTTP+SSE──►  src/server/app.ts  (127.0.0.1:3210, LAN gate for phones)
                                       │
          ┌───────────────┬────────────┼──────────────┬────────────────┐
     library.ts      analysis.ts    cards.ts      stats.ts …      engine/usi.ts
     import, plies   queue, cache   SM-2/FSRS     aggregations    USI child process
          └───────────────┴──── db.ts (node:sqlite, one file) ───────┘
                                       ▲
                     src/core: parsing, grading, classifier, schedulers (no I/O)
```

- **`src/core`** is pure TypeScript with no I/O, so unit tests run without the server: record import/export (tsshogi), grading thresholds (from ShogiHome), the 戦型/castle/tactic classifier (generated from HiraganaSuisho and sylwi-kifu-vue rules by `tools/convert-classifier-rules.py`), SM-2, FSRS and the SVG diagram.
- **`src/server`** owns the database and the engine. `app.ts` is a small router (`route(method, path, handler)`) over `node:http`. Handlers return JSON, and `HttpError` sets the status. Live updates (analysis progress, library changes) go out over one SSE stream, `/api/events`.
- **`src/renderer`** is a Vue 3 single-page app with a hash router (`router.ts`: `#/name/param?query`). Each screen is one file in `views/`. `api.ts` holds the fetch wrapper, shared types and the reactive `live` store fed by SSE. The board is ShogiHome's `BoardView`, vendored under `vendor/shogihome` and wrapped by `components/ShogiBoard.vue`, which takes an SFEN, arrows and a last move and emits USI moves.
- **`src/electron`** only starts the server and opens a window. The same build also runs in a browser with `npm run serve`.

### Data model

| table | what it holds |
| --- | --- |
| `games` | one row per imported record: original text (re-exported as is), players, result, classification, analysis summary (accuracy, turning ply, first clearly-won ply per side) |
| `plies` | one row per position in a game's main line: USI, Japanese move text, SFEN, comment, think time, eval (black's view), loss, level, missed mate/win, the user's mark |
| `evals` | eval cache keyed by `(sfen without move number, engine, limit)`, so transpositions and re-imports cost nothing |
| `cards` | review cards (mistakes, guesses, manual) with SM-2 and FSRS state; `reviews` is their history |
| `tags`, `collections` | game tags and saved library filters |
| `pages` | notebook pages (Markdown with `:::shogi-view` and `:kifu[]` directives) |
| `tsume` | imported mate problems and how each attempt went |
| `settings` | JSON values by key (`settings.ts` has the defaults) |

New columns are added in `Db`'s constructor with `ensureColumn`, so old library files upgrade in place. Restore (`restore.ts`) merges by game hash and never deletes, so every new table needs a merge rule there and a round-trip test in `test/restore.test.ts`.

### Analysis pipeline

1. Import stores the plies and classifies the game. If auto-analyse is on and an engine is set, the game is queued.
2. `AnalysisQueue` walks each position with the configured limit and reuses `evals` hits.
3. `core/grading.ts` turns evals into win-rate loss per move and grades each move (緩手 → 大悪手), plus missed mates and missed wins.
4. Each flagged move is searched again with `verifyFactor`× the limit, and flags that don't hold up are dropped (with their unreviewed cards).
5. Cards are made for the user's moves at or above `cardMinLevel`, and the game summary columns are filled in.

Ad-hoc searches (candidate moves, Play it out, guesses, card answers) go through `analysis.searchPosition`. It uses the same engine process between queue items, so the UI never starts a second engine.

### Conventions

- UI text is short and bilingual where it names a shogi concept (`復習 Review`). Shogi terms stay in Japanese.
- Evals are always stored from black's point of view and turned into the mover's view only for display.
- Any write a phone may need must be allowed explicitly in `lan.ts`. By default the LAN gate is read-only.
- Each feature gets at least one API test in `test/` and one step in `test/e2e/run.mjs`, which also takes the screenshot the README describes. Run `npm run typecheck && npm test && npm run e2e` before pushing.
- Cloud sessions install dependencies through `.claude/hooks/session-start.sh`.

## Roadmap

Ordered by value for the daily study loop. ✅ marks items that are built.

### Next

1. ✅ **Study board (検討盤)** at `#/board`. A free board that isn't tied to a saved game. Start from the initial position, a pasted SFEN/USI string, or any game position ("Study board" in the game view). Play both sides; going back and playing a new move cuts the line off there. The engine looks at each new position automatically (multi-PV 3, arrows on the board), and its results are kept per position so stepping back and forth costs nothing. The line lives in the URL, so it can be bookmarked or linked from a note. From the board you can save the line as a game, add the position to a notebook, play it out, download a diagram and copy the SFEN.
2. ✅ **Mistakes by kind of move.** Stats shows how often each kind of my moves goes wrong: drops, captures, checks, king moves, promotions and quiet moves, with the average loss and how often each is a 悪手 or worse. "I blunder with drops" is something you can practise. "I lose points in the middlegame" is too vague to act on.
3. ✅ **Streaming analysis.** Run `go infinite` and stream `info` lines over SSE, so the study board and the game view show the eval deepening live instead of after a fixed movetime. This needs one engine owner that can take a search away from the queue and give it back.
4. ✅ **Variations in the study board.** Keep a move tree instead of a single line, and save it as KIF 変化 (`Record` in tsshogi already supports branches). Saving back into an existing game would add the line as a branch of that game.
5. ✅ **Position setup.** A piece palette for the study board, so positions from books and magazines can be entered without typing SFEN.

### Later

- ✅ **Custom review decks.** Review only cards from one opening, tag, opponent or kind of move (this would reuse the move kinds from item 2).
- ✅ **Opponent prep sheet.** A notebook page made from a player profile: their openings against you, the positions where you score badly, and your usual mistakes against them.
- ✅ **Paste several games at once.** `/api/import` with `text` imports only one record today. Split pasted text on record boundaries (KIF headers, CSA `V2` lines, one SFEN per line).
- ✅ **Light theme.** The palette is in CSS variables in `styles.css`. Add a light set and follow `prefers-color-scheme`, with a setting to override it.
- ✅ **Compare engines.** Analyse one game with a second engine and show where the two disagree.

## Feature plans

Each feature gets a short plan here before it is built. The plan stays afterwards as a record of what was decided.

### Streaming analysis (roadmap 3)

- **Engine.** `UsiEngine.search` takes `{ infinite: true }`, which sends `go infinite`, and an `AbortSignal`. Aborting a search that hasn't started yet drops it from the engine queue. Aborting a running search sends `stop`, and the engine still answers with `bestmove`, so the queue stays in order. The background game queue keeps its place: it waits for the live search to finish, as it already does for one-off searches.
- **Server.** `GET /api/live?sfen=…&moves=…&multipv=3&maxMs=…` is an SSE stream for one search. It sends a `lines` event at most 5 times a second, with the lines in black's view plus Japanese text, depth, nodes and elapsed time, then `done` with the best move. The server sends `stop` at `maxMs`, capped at 5 minutes. If the client closes the stream, the search is aborted. It's a GET, so phones may use it like `analyze-position`.
- **Client.** `renderer/live.ts` has a small `liveSearch()` helper around `EventSource`. The study board uses it in place of the fixed-time search. Its time setting becomes a maximum (3 s, 10 s, 30 s, 5 min), a "Stop" button ends the search early, and the eval shows its depth as it climbs. Completed searches are still cached per position. The game view's "Candidate moves" streams the same way.
- **Tests.** The mock engine answers `go infinite` with an `info` line every 50 ms at rising depth until `stop`. An API test reads the stream, checks that depth rises and that closing the stream frees the engine for the next search. The e2e test checks that the study board shows a depth.

### Variations on the study board (roadmap 4)

- **Model.** `core/movetree.ts` keeps a move tree (`{ usi, children }`, where the first child is the main line). Its text form is PGN-style: `7g7f 3c3d (8c8d 2g2f) 2g2f`, where a group in brackets is an alternative to the move just before it. A plain line is a valid tree, so old `moves=` links still work. Pure helpers convert the tree to and from a tsshogi `Record` (KIF 変化 come in and go out through that) and walk a path.
- **Board.** The selection is a path of child indexes plus a cursor depth. Playing a move that differs from the next one adds a variation instead of cutting the line off. Rows where alternatives exist show 変 chips that switch to them. For the current move there are "Make main line" (moves it to the front at every level along the path), "Delete variation" and "Delete after here". The URL carries the tree text.
- **In and out.** Pasting a KIF with 変化 brings the branches in. "Study board" from a game brings the game's stored variations along. "Save as game" writes KIF with 変化. A board opened from a game also offers "Save into the game": `POST /api/games/:id/variations` merges the tree's lines into the game's record as branches and rewrites the stored KIF. The main line, plies, analysis and dedup hash stay as they are, and the new branches show in the game view's move list.
- **Tests.** Unit tests cover parsing, formatting and the Record round trip. An API test merges variations into a game and reads them back through `/branches`. The e2e test plays an alternative move, checks that the 変 chip appears and that the variation survives a reload, then saves it into the game.

### Position setup (roadmap 5)

- **Editing.** ShogiHome's `BoardView` already has an edit mode (`allow-edit`). Pieces are dragged between the board and the stands, and a double-click or right-click rotates a piece (promote, then turn it to the other side). `ShogiBoard` passes the prop through and re-emits the `edit` changes, and the study board applies them with tsshogi's `Position.edit`. As in ShogiHome, pieces that aren't on the board wait on gote's stand, which works as the piece box.
- **Board.** "Edit position" switches the study board to an edit panel in place of the engine: a starting template (平手, 詰将棋 with one or two kings, 香/角/飛/二枚/四枚/六枚落ち, empty), the side to move, "Done" and "Cancel". "Done" checks the position, then makes it the new start with an empty move tree, ending any link to a game.
- **Checks.** `core/setup.ts` lists what's wrong with a position: more than one king for a side or no king at all, more pieces than a set has, pawns, lances or knights with nowhere to move, 二歩, and the side not to move being in check. "Done" stays disabled while there are problems, and they're listed under the board.
- **Tests.** Unit tests for each check. The e2e test edits a position (starts from the 詰将棋 template, drags a gold from the stand onto the board, sets the side to move), finishes, and sees the engine start on it.

### Custom review decks

- **Filters.** Cards can also be filtered by the opening of the side the card is for, the opponent (the other side, with names normalised as in the library), a game tag, the kind of the move played (from `plies.move_kind`) and the side. `Cards.list` joins the card's game, tags and ply, and each card says its `opening`, `opponent`, `tags` and `moveKinds`, so the review screen can show where it came from.
- **Facets.** `GET /api/cards/facets` gives the values present among the cards, each with its total and due count, so the deck builder only offers choices that have cards.
- **Saved decks.** A deck is a name and a filter, kept in the `cardDecks` setting. `GET/POST/DELETE /api/decks` manage them. Phones only read them, through the existing LAN gate.
- **Review screen.** The deck menu lists the built-in decks, then saved decks with their due counts, then "Custom…". "Custom…" opens a row of filter menus with counts and a "Save as deck" button. Anki export follows the chosen deck.
- **Today.** The plan names the saved deck with the most due cards when there is one ("四間飛車 deck: 5 due"), linking to review with that deck chosen (`#/review?deck=<id>`).
- **Tests.** API tests for each filter, for facets and for creating, listing and deleting decks. The e2e test builds a custom deck, saves it and checks that the deck menu offers it.

### Opponent prep sheet

- **Page.** `server/prep.ts` writes a notebook page into the "Opponents" notebook, like the weekly report: `対策 vs <name>`. It has:
  - my record, win rate and recent form against them, plus their rating
  - their openings and castles, split by which side I had, with my score against each
  - the positions I reach most often against them with me to move (between moves 6 and 40, reached in two or more games), each as a board with my usual move, its average loss and the engine's choice
  - my costliest moves against them as boards
  - the recent games as links
  - an empty "作戦 Plan" list to fill in
- **API and UI.** `POST /api/notes/prep { opponent }` creates the page and returns it. The player profile gets "Write prep sheet", which opens the new page. The page also links to the review screen with that opponent's cards picked (`#/review?opponent=<name>` opens the custom deck builder filled in).
- **Tests.** An API test writes a sheet for a known opponent and checks the record line, the openings table, a board directive and the review link. The e2e test makes one from the player page.

### Paste several games at once

- **Splitting.** `core/split.ts` has `splitRecords(text)`, which cuts text into one string per record:
  - KIF/KI2: a header line (開始日時, 手合割, 先手 and the like, or `#KIF`) after moves have begun starts a new record. 変化 sections don't count as moves for this, so a game's own variations stay with it.
  - CSA: a line holding only `/` (the CSA multi-record separator), or a new `V2…` version line after moves.
  - USI/SFEN: one record per line, when every non-empty line is a `position`, `sfen` or bare SFEN line.
  - Anything else is one record, as now.
- **Import.** `/api/import` splits pasted text, and files whose decoded text holds more than one record, naming the parts `name #2` and so on. A single-record file still goes through `importBuffer` as before, so the format is still chosen by its extension.
- **UI.** A Ctrl/⌘+V paste of several games opens the library with a toast that counts them ("Imported 5 games, 1 already there"). A single game still opens directly. The paste box hints that several games can go in at once.
- **Tests.** Unit tests split two KIFs (one with a 変化), CSA with `/`, and USI lines. An API test pastes three games and gets three results.

### Light theme

- **Tokens.** Every colour in the renderer comes from a CSS variable in `styles.css`. The hard-coded hex and rgba values in components (graph strokes, calendar heat steps, table stripes, hover borders, the `--accent` fallbacks) become tokens: `--link`, `--edge`, `--line-soft`, `--row-alt`, `--grid`, `--axis`, `--heat-1…4`, plus `--win-rgb` and `--loss-rgb` for translucent fills. The dark values stay exactly as they are.
- **Light palette.** A warm paper version of the lacquer theme under `:root[data-theme="light"]`, with `color-scheme: light`. Text and muted text stay at WCAG AA contrast against the panels. The board, pieces and stands keep their wood images.
- **Choosing.** `renderer/theme.ts` reads a per-device preference ("system", "light", "dark") from `localStorage` and sets `data-theme` on `<html>`. For "system" it follows `prefers-color-scheme`, including live changes. A tiny inline script in `index.html` applies it before the app loads, so there's no dark flash. Settings gets an "Appearance" menu. It's per device on purpose, because a phone and a desktop may want different themes.
- **Tests.** The e2e test switches to light, takes dashboard, game and stats screenshots, and the axe scan that runs on every screenshot checks contrast in the light palette too.

### Compare engines (second opinion)

- **Settings.** `engine2: { path, options, movetimeMs }`, empty by default. Settings gets a "Second engine" section with its own Test button, which reuses `/api/engine/test`.
- **Server.** `server/compare.ts` owns a second `UsiEngine` process, separate from the main one, so a comparison never waits behind the analysis queue. `POST /api/games/:id/compare` starts a job that evaluates every position of the game with the second engine and stores the results in `evals` under that engine's name. A repeat comparison, or another game through the same positions, is mostly cache hits. `GET /api/games/:id/compare` returns `{ running, done, total, engine, result }`. Only one comparison runs at a time, and starting another one queues behind it.
- **Result.** For each move, both engines' grades come from `gradeMoves` with the same grading settings. A move is listed when the two disagree:
  - one engine calls it a 悪手 or worse and the other doesn't
  - for the position before it, the two disagree on the winning chances by 15 points or more
  The result also gives a count of positions where their best moves differ, and the agreement rate (the share of moves graded the same).
- **UI.** The game view gets a "Second opinion" panel when a second engine is set. It has a "Compare with <name>" button, progress while the job runs, the agreement rate, and the disagreements as rows ("12手 ▲7六歩: 悪手 −14 vs fine −2"). Clicking a row jumps to that move.
- **Tests.** The API test uses the mock engine as the second engine, plus a mock variant that values pieces differently (`MOCK_STYLE=greedy`) so the two disagree. It checks the job's progress, the result shape, the listed disagreements and that a second run is served from the cache.

### Saved studies with move comments

- **Model.** Tree nodes gain an optional `comment`. The URL text form stays comment-free. `movetree.ts` carries comments to and from tsshogi's `Record` (KIF comments, including on 変化). When merging into a game, `mergeTreeIntoRecord` sets a comment only where the game's move has none.
- **Storage.** A `studies` table holds `id, title, start_sfen, tree (JSON), game_id, created_at, updated_at`. `server/studies.ts` serves `GET/POST/PUT/DELETE /api/studies`. Restore adds a backup's studies unless one with the same title and tree is already there. Phones may read studies but not write them.
- **Board.** Each move can have a comment, edited under the move list, and moves with one show ✎. "Save study" names the board and moves it to `#/board/<id>`, after which changes save themselves (debounced `PUT`). Unsaved boards stay URL-only as before. A "Studies" list on the board page shows saved ones, with rename and delete. KIF in and out, "Save as game", "Save into the game" and "Study board" from a game all carry comments.
- **Notebooks.** `:::shogi-study{id=12}` embeds a saved study: a stepper over the main line with 変 chips and comments. "Add to notebook" on a saved study inserts that directive.
- **Tests.** Unit tests for the comment round trip through `Record`/KIF. API tests for study CRUD, for comment merging that never overwrites, and for restore. The e2e test comments a move, saves the study, reloads it by id and embeds it in a notebook.

### Drilling saved studies

- **What's asked.** For a study and a side, every position in the tree where that side is to move and the study has a next move. The study's moves there are the answers. The first one is the main move, and alternatives you wrote in as variations also count as right. Positions where the opponent is to move aren't asked about.
- **Scheduling.** The `study_drill` table holds SM-2 state keyed by `(study_id, side, sfen_key)`, so editing a study's tree keeps the history of positions that are still in it. A position without a row is new, and new counts as due. A right answer is rated "good" and a wrong one "again", as on cards.
- **Server.** `server/drill.ts` provides:
  - `GET /api/studies/:id/drill?side=black[&all=1]`: the due (or all) positions, each with its last move, accepted answers, the main move's comment and its path in the study, ordered by due date and then depth
  - `POST /api/studies/:id/drill { side, sfen, usi }`: checks the answer and reschedules
  - `GET /api/drill/due`: due counts per study, for studies that have been drilled at least once
  Phones may answer drills, as they may answer cards. Restore copies drill rows along with their studies.
- **UI.** `#/drill/<id>?side=…` shows the position from the drilled side. You play your move, then see right or wrong, the accepted moves with the main one starred, and the study's comment, then go on. The header has the side switch, due and total counts, and "Practise all". The board offers "Drill this study" for a saved study, the studies list gets a "Drill" link, and Today lists the study with the most due positions.
- **Tests.** API tests for the positions offered (side to move, accepted alternatives, the opponent's turns skipped), scheduling (right pushes the position back, wrong brings it back in ten minutes, and the drill screen re-asks it before the session ends), due counts, and a study edit that keeps history. The e2e test drills the study saved earlier in the run.

### Threats (狙い)

- **Idea.** Pass the move: give the opponent the move in the same position and ask the engine what they would play. That move is the threat. A mate search in that passed position tells whether the side to move is in 詰めろ (mate threat) and in how many moves. There's no threat to show while the side to move is in check.
- **Server.** `POST /api/threat { sfen, timeMs? }`. It flips the side to move with `Position.setColor`. While the side to move is in check, passing is impossible, and it answers `{ status: "check" }`. Otherwise it runs a normal search (the move time from settings, capped) and a mate search (2 s), and answers `{ status: "ok", move, text, score (black's view), mate: { moves, text } | null }`. Phones may ask, like `analyze-position`.
- **Core.** `core/threat.ts` holds `passedPosition(sfen)`, which returns the flipped SFEN or null when passing isn't possible. Both the server and the tests use it.
- **UI.** The game view's engine panel and the study board get "狙い Threat?". The answer reads "If ☗ passes: △5五角 (−820)" plus "詰めろ: 3手詰 △…" when there's a mate. The threat move shows as an arrow from the opponent's side, using the board's arrows in a passed position. The panel clears it when the position changes.
- **Tests.** Unit tests for `passedPosition` (normal, and in check where passing is impossible). An API test with a position where ☖ threatens mate in one if ☗ passes, using the mock engine's mate-in-one search. The e2e test asks for a threat in the game view.

### Tech debt

- `views/Game.vue` (~930 lines) and `server/library.ts` (~710 lines) do too much. Move the move list, the engine panel and the variation handling into components, and move the export code out of `Library`.
- `app.ts` registers all routes in one function. Group them by area (`routes/cards.ts` and so on) once it gets past ~800 lines.
- The mock engine only counts material, so grading quality is tested only by hand against a real engine.
