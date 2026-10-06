<template>
  <div class="page">
    <div class="head">
      <h1>検討盤 Study board</h1>
      <span v-if="studyId" class="study-title">
        <label class="sr-only" for="study-title">Study title</label>
        <input id="study-title" v-model="studyTitle" class="serif" />
        <span class="muted small" role="status">{{ { saving: "Saving…", saved: "Saved", error: "Couldn't save", "": "" }[saveState] }}</span>
      </span>
      <span class="muted">Play both sides from any position. A different move starts a variation; the engine looks at each new position.</span>
      <a v-if="backHref" class="btn small" :href="backHref">← Back to the game</a>
    </div>

    <form class="setup" @submit.prevent="loadInput">
      <label class="sr-only" for="board-input">Position or kifu</label>
      <input
        id="board-input"
        v-model="input"
        placeholder="Paste an SFEN, a USI position (position startpos moves 7g7f …) or a kifu"
        autocomplete="off"
        spellcheck="false"
      />
      <button type="submit" class="btn" :disabled="!input.trim()">Set up</button>
      <button type="button" class="btn" @click="reset">Initial position</button>
    </form>
    <div v-if="inputError" class="error" role="alert">{{ inputError }}</div>

    <div class="layout">
      <section class="board-col">
        <div class="board-wrap">
          <div class="evalbar" role="img" :aria-label="`Evaluation bar: sente ${barPct.toFixed(0)}%`" :title="`☗ ${barPct.toFixed(0)}%`">
            <span class="w" :style="{ flex: flip ? barPct : 100 - barPct }"></span>
            <span class="b" :style="{ flex: flip ? 100 - barPct : barPct }"></span>
          </div>
          <div style="flex: 1; min-width: 0">
            <ShogiBoard
              :sfen="editing ? editSfen : shown.sfen"
              :last-move="editing ? null : lastMove"
              :arrows="editing ? [] : arrows"
              :flip="flip"
              :allow-move="!editing"
              :allow-edit="editing"
              :max-height="560"
              @move="play"
              @edit="applyEdit"
            />
          </div>
        </div>
        <div v-if="editing" class="nav">
          <button type="button" class="btn" @click="flip = !flip">Flip 反転</button>
          <span class="here muted">Editing the position</span>
        </div>
        <div v-else class="nav">
          <button type="button" class="btn" aria-label="Start position" @click="cursor = 0">|◀</button>
          <button type="button" class="btn" aria-label="Previous move" @click="step(-1)">◀</button>
          <button type="button" class="btn" aria-label="Next move" @click="step(1)">▶</button>
          <button type="button" class="btn" aria-label="Last move" @click="cursor = line.length - 1">▶|</button>
          <button type="button" class="btn" @click="flip = !flip">Flip 反転</button>
          <span class="here serif">{{ cursor ? `${shown.ply}手目 ${shown.text}` : "開始局面" }}</span>
        </div>
      </section>

      <section class="panel moves-col">
        <div class="cap" style="padding: 12px 14px 6px">棋譜 Moves</div>
        <ol class="moves" aria-label="棋譜 Moves">
          <li v-for="(p, i) in line" :key="i" :class="{ on: i === cursor, side: p.index > 0 }" :data-index="i" @click="cursor = i">
            <span class="n">{{ i ? p.ply : "" }}</span>
            <span class="m serif">{{ i ? p.text : "開始局面" }}</span>
            <span v-if="p.node.comment" class="cm" title="Has a comment">✎</span>
            <button
              v-for="a in p.alts"
              :key="a.index"
              type="button"
              class="alt-mark"
              :title="`Switch to the variation ${a.text}`"
              @click.stop="switchTo(i, a.index)"
            >
              変 {{ a.text }}
            </button>
            <span class="ev">{{ i && evalOf(p.sfen) ? evalText(evalOf(p.sfen)!.score ?? null, evalOf(p.sfen)!.mate ?? null) : "" }}</span>
          </li>
        </ol>
        <div v-if="!editing" class="row pad">
          <button type="button" class="btn small" :disabled="onMainLine" title="Make the line up to here the main line" @click="makeMain">Make main line</button>
          <button type="button" class="btn small" :disabled="cursor === 0" title="Delete this move and everything after it" @click="deleteVariation">Delete variation</button>
          <button type="button" class="btn small" :disabled="cursor >= line.length - 1" title="Delete the moves after this one" @click="cutHere">Delete after here</button>
        </div>
        <div v-if="!editing" class="comment">
          <label class="cap" for="board-comment">コメント Comment · {{ cursor ? `${shown.ply}手目 ${shown.text}` : "start position" }}</label>
          <textarea id="board-comment" v-model="comment" rows="3" placeholder="Why this move, what to remember…"></textarea>
        </div>
      </section>

      <section v-if="editing" class="side-col">
        <div class="panel box edit">
          <div class="cap">局面編集 Edit position</div>
          <p class="muted small">
            Drag pieces between the board and the stands. Double-click or right-click a piece to promote it or turn it to the other side. Pieces not in play wait on ☖'s stand.
          </p>
          <label class="field">
            Start from
            <select v-model="template" @change="applyTemplate">
              <option value="">— keep the current position —</option>
              <option v-for="t in TEMPLATES" :key="t.sfen" :value="t.sfen">{{ t.label }}</option>
            </select>
          </label>
          <div class="field">
            <span>To move</span>
            <div class="row" role="group" aria-label="Side to move">
              <button type="button" class="chip" :class="{ on: editColor === 'black' }" :aria-pressed="editColor === 'black'" @click="setColor('black')">☗ 先手</button>
              <button type="button" class="chip" :class="{ on: editColor === 'white' }" :aria-pressed="editColor === 'white'" @click="setColor('white')">☖ 後手</button>
            </div>
          </div>
          <ul v-if="problems.length" class="problems" role="alert">
            <li v-for="p in problems" :key="p">{{ p }}</li>
          </ul>
          <div class="row">
            <button type="button" class="btn primary" :disabled="problems.length > 0" @click="finishEdit">Done</button>
            <button type="button" class="btn" @click="editing = false">Cancel</button>
          </div>
          <div class="muted small">Done starts a new study from this position; the moves on the board now are dropped.</div>
        </div>
      </section>

      <section v-else class="side-col">
        <div class="panel box">
          <div class="cap">検討 Engine</div>
          <template v-if="!engineSet">
            <div class="muted">Set a USI engine in <a href="#/settings">Settings</a> to see evaluations.</div>
          </template>
          <template v-else>
            <div v-if="current" class="big">
              <span class="serif">{{ moverWin }}%</span>
              <span class="muted">{{ evalText(topScore ?? null, topMate ?? null) }} · {{ sideToMove === "black" ? "☗" : "☖" }} to move</span>
            </div>
            <div v-else class="muted">{{ running ? "Thinking…" : "No evaluation yet." }}</div>
            <div class="depth muted">
              <template v-if="current?.lines[0]?.depth">depth {{ current.lines[0].depth }} · {{ (current.elapsedMs / 1000).toFixed(1) }}s</template>
              <span v-if="running" class="pulse" aria-hidden="true"></span>
              <button v-if="running" type="button" class="btn small" @click="stopSearch">Stop</button>
              <button v-else-if="current && !current.done" type="button" class="btn small" @click="restart">Think again</button>
            </div>
            <div v-if="current?.lines.length" class="lines">
              <button
                v-for="l in current.lines"
                :key="l.multipv"
                type="button"
                class="lrow"
                :title="`Play ${l.text.split(' ')[0]}`"
                @click="l.pv[0] && play(l.pv[0])"
              >
                <span class="lev">{{ evalText(l.score ?? null, l.mate ?? null) }}</span>
                <span class="serif">{{ l.text }}</span>
              </button>
            </div>
            <label class="field">
              Think for up to
              <select v-model.number="maxMs">
                <option :value="3000">3 s</option>
                <option :value="10000">10 s</option>
                <option :value="30000">30 s</option>
                <option :value="300000">5 min</option>
              </select>
            </label>
            <div v-if="engineError" class="error">{{ engineError }}</div>
          </template>
        </div>

        <div class="panel box">
          <form v-if="!studyId" class="row" @submit.prevent="createStudy">
            <label class="sr-only" for="new-study-title">Study title</label>
            <input id="new-study-title" v-model="newTitle" placeholder="Title, e.g. 角換わり ▲4五桂" />
            <button type="submit" class="btn primary">Save study</button>
          </form>
          <div class="cap">この局面 This position</div>
          <div class="row">
            <button type="button" class="btn" :disabled="line.length < 2 || saving" @click="saveAsGame">Save as game</button>
            <button
              v-if="gameId"
              type="button"
              class="btn"
              :disabled="!(hasAlts || anyComments) || saving"
              title="Add this board's variations and comments to the game it came from"
              @click="saveIntoGame"
            >
              Save into the game
            </button>
            <button type="button" class="btn" @click="notebookOpen = true">Add to notebook</button>
            <a class="btn" :href="practiceHref" title="Play this position out against the engine">Play it out</a>
            <a class="btn" :href="diagramHref" download>Diagram (.svg)</a>
            <button type="button" class="btn" @click="copyPosition">Copy position</button>
            <button type="button" class="btn" @click="startEdit">Edit position</button>
          </div>
          <code class="sfen">{{ usiString }}</code>
        </div>
      </section>
    </div>

    <section v-if="studies.length" class="panel studies">
      <div class="cap">保存した研究 Saved studies</div>
      <ul>
        <li v-for="st in studies" :key="st.id" :class="{ on: st.id === studyId }">
          <a :href="`#/board/${st.id}`" class="serif">{{ st.title }}</a>
          <span class="muted small">{{ st.moves }} move{{ st.moves === 1 ? "" : "s" }} · {{ new Date(st.updated_at).toLocaleDateString() }}</span>
          <button type="button" class="btn small" :aria-label="`Delete the study ${st.title}`" @click="deleteStudy(st)">Delete</button>
        </li>
      </ul>
    </section>

    <AddToNotebook v-if="notebookOpen" :snippet="notebookSnippet" default-title="Study board" @close="notebookOpen = false" />
  </div>
</template>

<script setup lang="ts">
// A free board for studying any position: not tied to a saved game. The line
// (start position + moves + cursor) lives in the URL so it can be linked.
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { Color, InitialPositionSFEN, Position, PositionChange, Record as KRecord, RecordFormatType, detectRecordFormat, exportKIF, formatMove, importCSA, importJKFString, importKI2, importKIF } from "tsshogi";
import { api, evalText, live, toast, winRate } from "../api";
import { route } from "../router";
import ShogiBoard from "../components/ShogiBoard.vue";
import AddToNotebook from "../components/AddToNotebook.vue";
import { liveSearch, LiveResult } from "../live";
import { setupProblems } from "../../core/setup";
import { MoveTree, emptyTree, formatTree, hasComments, hasVariations, parseTree, pruneIllegal, recordToTree, selectedLine, treeToRecord } from "../../core/movetree";

type Alt = { index: number; text: string };
type Step = { sfen: string; usi: string; text: string; ply: number; prevSfen: string; node: MoveTree; index: number; alts: Alt[] };

const STANDARD = InitialPositionSFEN.STANDARD;

function treeFromQuery(text: string, sfen: string): MoveTree {
  try {
    return pruneIllegal(parseTree(text), sfen);
  } catch {
    return emptyTree();
  }
}
const start = ref(Position.newBySFEN(route.query.get("sfen") ?? "")?.sfen ?? STANDARD);
const tree = ref<MoveTree>(treeFromQuery(route.query.get("moves") ?? "", start.value));
// Child index chosen at each depth; past its end the line follows main moves.
const path = ref<number[]>((route.query.get("path") ?? "").split(".").filter(Boolean).map(Number));
const cursor = ref(0);
const flip = ref(route.query.get("flip") === "1");
const backHref = route.query.get("back") ? "#/" + route.query.get("back") : "";
// The game this board was opened from, which its variations can be saved into.
const gameId = ref(Number(route.query.get("game")) || 0);
// A saved study (#/board/<id>) saves itself as it changes; other boards live in the URL only.
const studyId = ref(Number(route.params[0]) || 0);
const studyTitle = ref("");
const saveState = ref<"" | "saving" | "saved" | "error">("");

const line = computed<Step[]>(() => {
  const nodes = selectedLine(tree.value, path.value);
  const pos = Position.newBySFEN(start.value)!;
  const firstPly = Number(start.value.split(" ")[3] ?? 1) - 1;
  const out: Step[] = [{ sfen: pos.sfen, usi: "", text: "", ply: firstPly, prevSfen: "", node: tree.value, index: 0, alts: [] }];
  for (let d = 1; d < nodes.length; d++) {
    const { node, index } = nodes[d];
    const parent = nodes[d - 1].node;
    const prevSfen = pos.sfen;
    const alts = parent.children.flatMap((c, i) => {
      if (i === index) return [];
      const m = pos.createMoveByUSI(c.usi);
      return m ? [{ index: i, text: formatMove(pos, m) }] : [];
    });
    const m = pos.createMoveByUSI(node.usi)!;
    const text = formatMove(pos, m);
    pos.doMove(m);
    out.push({ sfen: pos.sfen, usi: node.usi, text, ply: out[d - 1].ply + 1, prevSfen, node, index, alts });
  }
  return out;
});
const moves = computed(() => line.value.slice(1).map((s) => s.usi));
cursor.value = Math.min(Math.max(Number(route.query.get("ply") ?? line.value.length - 1) || 0, 0), line.value.length - 1);

const shown = computed(() => line.value[cursor.value]);
const lastMove = computed(() => (cursor.value ? { prevSfen: shown.value.prevSfen, usi: shown.value.usi } : null));
const sideToMove = computed(() => (shown.value.sfen.split(" ")[1] === "w" ? "white" : "black"));
const pathTo = (depth: number) => line.value.slice(1, depth + 1).map((s) => s.index);

function play(usi: string) {
  // A move that isn't the next one becomes a variation; the old line stays.
  const node = shown.value.node;
  let i = node.children.findIndex((c) => c.usi === usi);
  if (i < 0) i = node.children.push({ usi, children: [] }) - 1;
  path.value = [...pathTo(cursor.value), i];
  cursor.value++;
}
function switchTo(depth: number, index: number) {
  path.value = [...pathTo(depth - 1), index];
  cursor.value = depth;
}
function step(d: number) {
  cursor.value = Math.min(Math.max(cursor.value + d, 0), line.value.length - 1);
}
function cutHere() {
  shown.value.node.children = [];
}
// The current line becomes the main line at every branch point on the way here.
function makeMain() {
  for (let d = 1; d <= cursor.value; d++) {
    const parent = line.value[d - 1].node;
    const i = line.value[d].index;
    if (i) parent.children.unshift(...parent.children.splice(i, 1));
  }
  path.value = [];
}
function deleteVariation() {
  const d = cursor.value;
  if (!d) return;
  line.value[d - 1].node.children.splice(line.value[d].index, 1);
  path.value = pathTo(d - 1);
  cursor.value = d - 1;
}
const onMainLine = computed(() => line.value.slice(1, cursor.value + 1).every((s) => s.index === 0));
const hasAlts = computed(() => hasVariations(tree.value));
// Starting over leaves a saved study as it was and begins a new, unsaved board.
function detach() {
  studyId.value = 0;
  studyTitle.value = "";
  saveState.value = "";
}
function reset() {
  detach();
  start.value = STANDARD;
  tree.value = emptyTree();
  path.value = [];
  cursor.value = 0;
  gameId.value = 0;
  input.value = "";
  inputError.value = "";
}

// ---- editing a position by hand
const TEMPLATES = [
  { label: "平手 Even", sfen: STANDARD },
  { label: "詰将棋 Tsume (one king)", sfen: InitialPositionSFEN.TSUME_SHOGI },
  { label: "詰将棋 Tsume (both kings)", sfen: InitialPositionSFEN.TSUME_SHOGI_2KINGS },
  { label: "香落ち Lance handicap", sfen: InitialPositionSFEN.HANDICAP_LANCE },
  { label: "角落ち Bishop handicap", sfen: InitialPositionSFEN.HANDICAP_BISHOP },
  { label: "飛車落ち Rook handicap", sfen: InitialPositionSFEN.HANDICAP_ROOK },
  { label: "二枚落ち Two pieces", sfen: InitialPositionSFEN.HANDICAP_2PIECES },
  { label: "四枚落ち Four pieces", sfen: InitialPositionSFEN.HANDICAP_4PIECES },
  { label: "六枚落ち Six pieces", sfen: InitialPositionSFEN.HANDICAP_6PIECES },
];
const editing = ref(false);
const editSfen = ref("");
const template = ref("");
const editColor = computed(() => (editSfen.value.split(" ")[1] === "w" ? "white" : "black"));
const problems = computed(() => (editing.value ? setupProblems(editSfen.value) : []));
// Move numbers restart at 1 for a position set up by hand.
const withMoveOne = (sfen: string) => sfen.split(" ").slice(0, 3).join(" ") + " 1";
function startEdit() {
  cancel();
  editSfen.value = withMoveOne(shown.value.sfen);
  template.value = "";
  editing.value = true;
}
function applyEdit(changes: PositionChange[]) {
  const pos = Position.newBySFEN(editSfen.value);
  if (!pos) return;
  for (const c of changes) pos.edit(c);
  editSfen.value = pos.sfen;
}
function applyTemplate() {
  if (template.value) editSfen.value = template.value;
}
function setColor(c: "black" | "white") {
  const pos = Position.newBySFEN(editSfen.value);
  if (!pos) return;
  pos.setColor(c === "black" ? Color.BLACK : Color.WHITE);
  editSfen.value = pos.sfen;
}
function finishEdit() {
  if (problems.value.length) return;
  detach();
  start.value = withMoveOne(editSfen.value);
  tree.value = emptyTree();
  path.value = [];
  cursor.value = 0;
  gameId.value = 0;
  editing.value = false;
}

// ---- setting up from pasted text
const input = ref("");
const inputError = ref("");
function parseInput(text: string): KRecord | Error {
  let t = text.replace(/^﻿/, "").trim();
  if (/^[1-9lnsgkrbpLNSGKRBP+/]+\s+[bw]\s/.test(t)) t = "sfen " + t;
  if (/^(sfen|startpos)\b/.test(t)) t = "position " + t;
  switch (detectRecordFormat(t)) {
    case RecordFormatType.KIF:
      return importKIF(t);
    case RecordFormatType.KI2:
      return importKI2(t);
    case RecordFormatType.CSA:
      return importCSA(t);
    case RecordFormatType.JKF:
      return importJKFString(t);
    case RecordFormatType.USEN:
      return KRecord.newByUSEN(t);
    case RecordFormatType.USI:
    case RecordFormatType.SFEN:
      return KRecord.newByUSI(t);
  }
  return new Error("Not a position or kifu this board understands.");
}
function loadInput() {
  const rec = parseInput(input.value);
  if (rec instanceof Error) {
    inputError.value = rec.message;
    return;
  }
  inputError.value = "";
  detach();
  start.value = rec.initialPosition.sfen;
  tree.value = recordToTree(rec);
  path.value = [];
  gameId.value = 0;
  cursor.value = line.value.length - 1;
  input.value = "";
}

// ---- URL: replaceState keeps it linkable without a hashchange (which scrolls to the top)
const usiString = computed(() => {
  const base = start.value === STANDARD ? "position startpos" : `position sfen ${start.value}`;
  return moves.value.length ? `${base} moves ${moves.value.join(" ")}` : base;
});
watch([start, tree, path, cursor, flip, gameId, studyId], () => {
  if (loadingStudy) return;
  const q = new URLSearchParams();
  // A saved study's moves are on the server; its URL only says where on the board you are.
  if (!studyId.value) {
    if (start.value !== STANDARD) q.set("sfen", start.value);
    if (tree.value.children.length) q.set("moves", formatTree(tree.value));
    if (gameId.value) q.set("game", String(gameId.value));
  }
  if (path.value.some((i) => i)) q.set("path", path.value.join("."));
  if (cursor.value !== moves.value.length) q.set("ply", String(cursor.value));
  if (flip.value) q.set("flip", "1");
  if (backHref) q.set("back", backHref.slice(2));
  const s = q.toString();
  history.replaceState(null, "", "#/board" + (studyId.value ? `/${studyId.value}` : "") + (s ? "?" + s : ""));
}, { deep: true });

// ---- saved studies
let loadingStudy = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let savePending = false;
const studyBody = () => ({ title: studyTitle.value, start_sfen: start.value, tree: tree.value, game_id: gameId.value || null });
async function saveStudy() {
  clearTimeout(saveTimer);
  if (!studyId.value || !savePending) return;
  savePending = false;
  try {
    await api.put(`/api/studies/${studyId.value}`, studyBody());
    saveState.value = savePending ? "saving" : "saved";
  } catch {
    saveState.value = "error";
  }
}
watch([start, tree, studyTitle, gameId], () => {
  if (!studyId.value || loadingStudy) return;
  savePending = true;
  saveState.value = "saving";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveStudy, 800);
}, { deep: true });
const newTitle = ref("");
async function createStudy() {
  try {
    const st = await api.post<{ id: number; title: string }>("/api/studies", { ...studyBody(), title: newTitle.value });
    loadingStudy = true;
    studyId.value = st.id;
    studyTitle.value = st.title;
    newTitle.value = "";
    saveState.value = "saved";
    loadingStudy = false;
    toast(`Saved the study ${st.title}. Changes now save as you go.`);
    void loadStudies();
  } catch (e) {
    toast(String(e instanceof Error ? e.message : e));
  }
}
async function loadStudy(id: number) {
  loadingStudy = true;
  try {
    const st = await api.get<{ title: string; start_sfen: string; tree: MoveTree; game_id: number | null }>(`/api/studies/${id}`);
    start.value = st.start_sfen;
    tree.value = st.tree;
    gameId.value = st.game_id ?? 0;
    studyTitle.value = st.title;
    const ply = route.query.get("ply");
    cursor.value = Math.min(ply !== null ? Number(ply) || 0 : Infinity, line.value.length - 1);
  } catch {
    toast("That study isn't there any more.");
    studyId.value = 0;
  } finally {
    await nextTick();
    loadingStudy = false;
  }
}
type StudySummary = { id: number; title: string; start_sfen: string; moves: number; updated_at: number };
const studies = ref<StudySummary[]>([]);
async function loadStudies() {
  studies.value = await api.get<StudySummary[]>("/api/studies").catch(() => []);
}
async function deleteStudy(st: StudySummary) {
  if (!confirm(`Delete the study ${st.title}?`)) return;
  await api.del(`/api/studies/${st.id}`);
  if (st.id === studyId.value) detach();
  await loadStudies();
}
// A board opened from a game brings the game's comments onto its main line.
async function bringGameComments() {
  const g = await api.get<{ plies: { usi: string; comment: string }[] }>(`/api/games/${gameId.value}`).catch(() => null);
  if (!g) return;
  let node: MoveTree | undefined = tree.value;
  if (g.plies[0]?.comment.trim() && !node.comment) node.comment = g.plies[0].comment.trim();
  for (const p of g.plies.slice(1)) {
    node = node?.children.find((c) => c.usi === p.usi);
    if (!node) break;
    if (p.comment.trim() && !node.comment) node.comment = p.comment.trim();
  }
}

// The current move's comment (the root's is about the start position).
const comment = computed({
  get: () => shown.value.node.comment ?? "",
  set: (v: string) => {
    if (v.trim()) shown.value.node.comment = v;
    else delete shown.value.node.comment;
  },
});
const anyComments = computed(() => hasComments(tree.value));

// ---- engine: one streamed search at a time; finished (or stopped) results are kept per position
const engineSet = ref(true);
const maxMs = ref(10_000);
const cache = ref(new Map<string, LiveResult>());
const partial = ref<{ key: string; result: LiveResult } | null>(null);
const running = ref(false);
const engineError = ref("");
const cacheKey = (sfen: string) => `${maxMs.value}|${sfen.split(" ").slice(0, 3).join(" ")}`;
const evalOf = (sfen: string) => cache.value.get(cacheKey(sfen));
const current = computed<LiveResult | undefined>(() => {
  const key = cacheKey(shown.value.sfen);
  return cache.value.get(key) ?? (partial.value?.key === key ? partial.value.result : undefined);
});
const topScore = computed(() => current.value?.score ?? current.value?.lines[0]?.score);
const topMate = computed(() => current.value?.mate ?? current.value?.lines[0]?.mate);

let stopStream: (() => void) | null = null;
function cancel() {
  stopStream?.();
  stopStream = null;
  running.value = false;
}
function analyse() {
  cancel();
  if (!engineSet.value || editing.value) return;
  const key = cacheKey(shown.value.sfen);
  if (cache.value.has(key)) return;
  engineError.value = "";
  running.value = true;
  // The whole line goes to the engine so it can see repetitions.
  stopStream = liveSearch(
    { sfen: start.value, moves: moves.value.slice(0, cursor.value), multipv: 3, maxMs: maxMs.value },
    {
      update: (r) => {
        partial.value = { key, result: r };
        if (r.done) {
          cache.value.set(key, r);
          running.value = false;
          stopStream = null;
        }
      },
      error: (msg) => {
        engineError.value = msg;
        running.value = false;
        stopStream = null;
      },
    },
  );
}
// Stopping early keeps what the engine found so far, shown with "Think again".
function stopSearch() {
  cancel();
}
function restart() {
  cache.value.delete(cacheKey(shown.value.sfen));
  analyse();
}
let timer: ReturnType<typeof setTimeout> | undefined;
watch([() => shown.value.sfen, maxMs, editing], () => {
  clearTimeout(timer);
  cancel();
  // Wait a moment so stepping quickly through a line doesn't start a search per move.
  timer = setTimeout(analyse, 250);
});

const moverWin = computed(() => {
  const r = current.value ? winRate(topScore.value ?? null, topMate.value ?? null) : null;
  if (r === null) return "–";
  return Math.round(sideToMove.value === "black" ? r : 100 - r);
});
const barPct = computed(() => {
  return (current.value ? winRate(topScore.value ?? null, topMate.value ?? null) : null) ?? 50;
});
const arrows = computed(() => (current.value?.lines ?? []).filter((l) => l.pv[0]).map((l) => ({ usi: l.pv[0], score: l.scoreCP })));

// ---- actions
const notebookOpen = ref(false);
// A saved study embeds whole, with its variations and comments; otherwise the current line.
const notebookSnippet = computed(() => (studyId.value ? `:::shogi-study{id=${studyId.value}}\n:::` : `:::shogi-view{move=${cursor.value}}\n${usiString.value}\n:::`));
const practiceHref = computed(() => `#/practice?sfen=${encodeURIComponent(shown.value.sfen)}&back=${encodeURIComponent(location.hash.slice(2))}`);
const diagramHref = computed(() => `/api/diagram.svg?${new URLSearchParams({ sfen: shown.value.sfen, download: "1", flip: flip.value ? "1" : "0" })}`);

const saving = ref(false);
async function saveAsGame() {
  saving.value = true;
  try {
    // KIF keeps the variations as 変化.
    const text = exportKIF(treeToRecord(start.value, tree.value));
    const r = await api.post<{ results: { status: string; id: number; error?: string }[] }>("/api/import", { text });
    const first = r.results[0];
    if (!first || first.status === "error") throw new Error(first?.error ?? "import failed");
    live.libraryVersion++;
    toast(first.status === "added" ? "Saved to the library." : "This line is already in the library; opening it.");
    location.hash = `#/game/${first.id}`;
  } catch (e) {
    toast(String(e instanceof Error ? e.message : e));
  } finally {
    saving.value = false;
  }
}
async function saveIntoGame() {
  saving.value = true;
  try {
    const r = await api.post<{ branches: number }>(`/api/games/${gameId.value}/variations`, { tree: tree.value });
    toast(`Saved. The game now has ${r.branches} variation${r.branches === 1 ? "" : "s"}.`);
  } catch (e) {
    toast(String(e instanceof Error ? e.message : e));
  } finally {
    saving.value = false;
  }
}
async function copyPosition() {
  try {
    await navigator.clipboard.writeText(usiString.value);
    toast("Copied the position.");
  } catch {
    toast("Couldn't reach the clipboard; select the text below instead.");
  }
}

function onKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || e.ctrlKey || e.metaKey || e.altKey) return;
  if (editing.value && e.key !== "f") return;
  if (e.key === "ArrowRight") step(1);
  else if (e.key === "ArrowLeft") step(-1);
  else if (e.key === "Home") cursor.value = 0;
  else if (e.key === "End") cursor.value = line.value.length - 1;
  else if (e.key === "f") flip.value = !flip.value;
  else return;
  e.preventDefault();
}
onMounted(async () => {
  window.addEventListener("keydown", onKey);
  try {
    const s = await api.get<{ engine: { path: string } }>("/api/settings");
    engineSet.value = !!s.engine.path;
  } catch {
    engineSet.value = false;
  }
  if (studyId.value) await loadStudy(studyId.value);
  else if (gameId.value) await bringGameComments();
  void loadStudies();
  analyse();
});
onUnmounted(() => {
  void saveStudy();
  window.removeEventListener("keydown", onKey);
  clearTimeout(timer);
  cancel();
});

// Keep the current move in view in a long line.
watch(cursor, (i) => {
  setTimeout(() => document.querySelector(`.moves li[data-index="${i}"]`)?.scrollIntoView({ block: "nearest" }), 0);
});
</script>

<style scoped>
.head {
  display: flex;
  align-items: baseline;
  gap: 14px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.setup {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}
.setup input {
  flex: 1;
  min-width: 0;
}
.error {
  color: var(--loss);
  font-size: 13px;
  margin-bottom: 8px;
}
.layout {
  display: grid;
  grid-template-columns: minmax(0, 1.5fr) minmax(200px, 0.6fr) minmax(240px, 0.8fr);
  gap: 18px;
  align-items: start;
  margin-top: 12px;
}
@media (max-width: 1100px) {
  .layout {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }
  .board-col {
    grid-column: 1 / -1;
  }
}
@media (max-width: 700px) {
  .layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .setup {
    flex-wrap: wrap;
  }
}
.board-wrap {
  display: flex;
  gap: 8px;
}
.evalbar {
  width: 14px;
  border: 1px solid var(--line-2);
  border-radius: 4px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.evalbar .w {
  background: var(--gold-bg);
  transition: flex 0.3s;
}
.evalbar .b {
  background: var(--win);
  transition: flex 0.3s;
}
.nav {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 10px;
}
.here {
  margin-left: auto;
  font-size: 18px;
}
.moves-col {
  display: flex;
  flex-direction: column;
}
.moves {
  list-style: none;
  margin: 0;
  padding: 4px 6px;
  max-height: 460px;
  overflow-y: auto;
}
.moves li {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 4px 8px;
  border-radius: 6px;
  cursor: pointer;
}
.moves li.on {
  background: var(--gold-bg);
}
.moves li.side .m {
  color: var(--gold-soft);
}
.alt-mark {
  font: inherit;
  font-size: 11px;
  color: var(--muted);
  background: var(--panel-2);
  border: 1px solid var(--line-2);
  border-radius: 4px;
  padding: 0 5px;
  cursor: pointer;
  white-space: nowrap;
}
.alt-mark:hover {
  border-color: var(--gold);
  color: var(--text);
}
.moves .n {
  width: 2em;
  text-align: right;
  color: var(--muted);
  font-size: 12px;
}
.moves .m {
  flex: 1;
}
.moves .ev {
  color: var(--muted);
  font-size: 12px;
}
.pad {
  padding: 8px 12px 12px;
}
.side-col {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.box {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.big {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.big .serif {
  font-size: 32px;
}
.edit p {
  margin: 0;
}
.problems {
  margin: 0;
  padding-left: 1.2em;
  color: var(--loss);
  font-size: 13px;
}
.small {
  font-size: 12px;
}
.study-title {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
}
.study-title input {
  font-size: 18px;
  min-width: 14em;
}
.comment {
  padding: 0 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.comment textarea {
  width: 100%;
  resize: vertical;
}
.moves .cm {
  color: var(--muted);
  font-size: 12px;
}
.studies {
  margin-top: 18px;
  padding: 12px 16px;
}
.studies ul {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.studies li {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 6px;
  border-radius: 6px;
}
.studies li.on {
  background: var(--gold-bg);
}
.studies li a {
  flex: 1;
  min-width: 0;
}
.depth {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  min-height: 28px;
}
.pulse {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--gold);
  animation: pulse 1s ease-in-out infinite;
}
@keyframes pulse {
  50% {
    opacity: 0.25;
  }
}
@media (prefers-reduced-motion: reduce) {
  .pulse {
    animation: none;
  }
}
.lines {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.lrow {
  display: flex;
  gap: 10px;
  text-align: left;
  background: none;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 6px 8px;
  color: inherit;
  font: inherit;
  cursor: pointer;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.lrow:hover {
  border-color: var(--gold);
}
.lev {
  min-width: 4.5em;
  color: var(--muted);
  font-size: 13px;
}
.row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.sfen {
  font-size: 11px;
  word-break: break-all;
  color: var(--muted);
  user-select: all;
}
</style>
