<template>
  <div class="page">
    <div class="head">
      <h1>検討盤 Study board</h1>
      <span class="muted">Play both sides from any position. The engine looks at each new position.</span>
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
            <ShogiBoard :sfen="shown.sfen" :last-move="lastMove" :arrows="arrows" :flip="flip" :allow-move="true" :max-height="560" @move="play" />
          </div>
        </div>
        <div class="nav">
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
          <li v-for="(p, i) in line" :key="i" :class="{ on: i === cursor }" :data-index="i" @click="cursor = i">
            <span class="n">{{ i ? p.ply : "" }}</span>
            <span class="m serif">{{ i ? p.text : "開始局面" }}</span>
            <span class="ev">{{ i && evalOf(p.sfen) ? evalText(evalOf(p.sfen)!.score ?? null, evalOf(p.sfen)!.mate ?? null) : "" }}</span>
          </li>
        </ol>
        <div class="row pad">
          <button type="button" class="btn small" :disabled="cursor >= line.length - 1" title="Delete the moves after this one" @click="cutHere">Delete after here</button>
        </div>
      </section>

      <section class="side-col">
        <div class="panel box">
          <div class="cap">検討 Engine</div>
          <template v-if="!engineSet">
            <div class="muted">Set a USI engine in <a href="#/settings">Settings</a> to see evaluations.</div>
          </template>
          <template v-else>
            <div v-if="current" class="big">
              <span class="serif">{{ moverWin }}%</span>
              <span class="muted">{{ evalText(current.score ?? null, current.mate ?? null) }} · {{ sideToMove === "black" ? "☗" : "☖" }} to move</span>
            </div>
            <div v-else class="muted">{{ thinking ? "Thinking…" : "No evaluation yet." }}</div>
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
              Time per position
              <select v-model.number="movetimeMs">
                <option :value="500">0.5 s</option>
                <option :value="1000">1 s</option>
                <option :value="3000">3 s</option>
                <option :value="10000">10 s</option>
              </select>
            </label>
            <div v-if="engineError" class="error">{{ engineError }}</div>
          </template>
        </div>

        <div class="panel box">
          <div class="cap">この局面 This position</div>
          <div class="row">
            <button type="button" class="btn" :disabled="line.length < 2 || saving" @click="saveAsGame">Save as game</button>
            <button type="button" class="btn" @click="notebookOpen = true">Add to notebook</button>
            <a class="btn" :href="practiceHref" title="Play this position out against the engine">Play it out</a>
            <a class="btn" :href="diagramHref" download>Diagram (.svg)</a>
            <button type="button" class="btn" @click="copyPosition">Copy position</button>
          </div>
          <code class="sfen">{{ usiString }}</code>
        </div>
      </section>
    </div>

    <AddToNotebook v-if="notebookOpen" :snippet="notebookSnippet" default-title="Study board" @close="notebookOpen = false" />
  </div>
</template>

<script setup lang="ts">
// A free board for studying any position: not tied to a saved game. The line
// (start position + moves + cursor) lives in the URL so it can be linked.
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { InitialPositionSFEN, Position, Record as KRecord, RecordFormatType, detectRecordFormat, formatMove, importCSA, importJKFString, importKI2, importKIF } from "tsshogi";
import { api, evalText, live, toast, winRate } from "../api";
import { route } from "../router";
import ShogiBoard from "../components/ShogiBoard.vue";
import AddToNotebook from "../components/AddToNotebook.vue";

type Line = { multipv: number; pv: string[]; text: string; score?: number; mate?: number; scoreCP?: number };
type Search = { score?: number; mate?: number; lines: Line[] };
type Step = { sfen: string; usi: string; text: string; ply: number; prevSfen: string };

const STANDARD = InitialPositionSFEN.STANDARD;

const start = ref(Position.newBySFEN(route.query.get("sfen") ?? "")?.sfen ?? STANDARD);
const moves = ref<string[]>((route.query.get("moves") ?? "").split(/[\s,]+/).filter(Boolean));
const cursor = ref(0);
const flip = ref(route.query.get("flip") === "1");
const backHref = route.query.get("back") ? "#/" + route.query.get("back") : "";

const line = computed<Step[]>(() => {
  const pos = Position.newBySFEN(start.value)!;
  const firstPly = Number(start.value.split(" ")[3] ?? 1) - 1;
  const out: Step[] = [{ sfen: pos.sfen, usi: "", text: "", ply: firstPly, prevSfen: "" }];
  for (const usi of moves.value) {
    const m = pos.createMoveByUSI(usi);
    if (!m || !pos.isValidMove(m)) break;
    const prevSfen = pos.sfen;
    const text = formatMove(pos, m);
    pos.doMove(m);
    out.push({ sfen: pos.sfen, usi, text, ply: out[out.length - 1].ply + 1, prevSfen });
  }
  return out;
});
// Moves in the URL that don't apply are dropped rather than shown.
watch(line, (l) => {
  if (l.length - 1 < moves.value.length) moves.value = moves.value.slice(0, l.length - 1);
}, { immediate: true });
cursor.value = Math.min(Math.max(Number(route.query.get("ply") ?? moves.value.length) || 0, 0), line.value.length - 1);

const shown = computed(() => line.value[cursor.value]);
const lastMove = computed(() => (cursor.value ? { prevSfen: shown.value.prevSfen, usi: shown.value.usi } : null));
const sideToMove = computed(() => (shown.value.sfen.split(" ")[1] === "w" ? "white" : "black"));

function play(usi: string) {
  if (moves.value[cursor.value] === usi) {
    cursor.value++;
    return;
  }
  // A new move from the middle of the line replaces everything after it.
  moves.value = [...moves.value.slice(0, cursor.value), usi];
  cursor.value = moves.value.length;
}
function step(d: number) {
  cursor.value = Math.min(Math.max(cursor.value + d, 0), line.value.length - 1);
}
function cutHere() {
  moves.value = moves.value.slice(0, cursor.value);
}
function reset() {
  start.value = STANDARD;
  moves.value = [];
  cursor.value = 0;
  input.value = "";
  inputError.value = "";
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
  start.value = rec.initialPosition.sfen;
  moves.value = rec.moves.slice(1).flatMap((n) => ("usi" in n.move ? [n.move.usi] : []));
  cursor.value = moves.value.length;
  input.value = "";
}

// ---- URL: replaceState keeps it linkable without a hashchange (which scrolls to the top)
const usiString = computed(() => {
  const base = start.value === STANDARD ? "position startpos" : `position sfen ${start.value}`;
  return moves.value.length ? `${base} moves ${moves.value.join(" ")}` : base;
});
watch([start, moves, cursor, flip], () => {
  const q = new URLSearchParams();
  if (start.value !== STANDARD) q.set("sfen", start.value);
  if (moves.value.length) q.set("moves", moves.value.join(" "));
  if (cursor.value !== moves.value.length) q.set("ply", String(cursor.value));
  if (flip.value) q.set("flip", "1");
  if (backHref) q.set("back", backHref.slice(2));
  const s = q.toString();
  history.replaceState(null, "", "#/board" + (s ? "?" + s : ""));
});

// ---- engine: one search at a time, results kept per position and time
const engineSet = ref(true);
const movetimeMs = ref(1000);
const cache = ref(new Map<string, Search>());
const thinking = ref(false);
const engineError = ref("");
const cacheKey = (sfen: string) => `${movetimeMs.value}|${sfen.split(" ").slice(0, 3).join(" ")}`;
const evalOf = (sfen: string) => cache.value.get(cacheKey(sfen));
const current = computed(() => evalOf(shown.value.sfen));

async function analyse() {
  if (!engineSet.value || thinking.value) return;
  const sfen = shown.value.sfen;
  const key = cacheKey(sfen);
  if (cache.value.has(key)) return;
  thinking.value = true;
  engineError.value = "";
  try {
    const r = await api.post<Search>("/api/analyze-position", { sfen, multipv: 3, movetimeMs: movetimeMs.value });
    cache.value.set(key, r);
  } catch (e) {
    engineError.value = String(e instanceof Error ? e.message : e);
  } finally {
    thinking.value = false;
  }
  // The user may have moved on while the engine was thinking.
  if (!engineError.value && cacheKey(shown.value.sfen) !== key) void analyse();
}
let timer: ReturnType<typeof setTimeout> | undefined;
watch([() => shown.value.sfen, movetimeMs], () => {
  clearTimeout(timer);
  // Wait a moment so stepping quickly through a line doesn't queue a search per move.
  timer = setTimeout(() => void analyse(), 250);
});

const moverWin = computed(() => {
  const c = current.value;
  const r = c ? winRate(c.score ?? null, c.mate ?? null) : null;
  if (r === null) return "–";
  return Math.round(sideToMove.value === "black" ? r : 100 - r);
});
const barPct = computed(() => {
  const c = current.value;
  return (c ? winRate(c.score ?? null, c.mate ?? null) : null) ?? 50;
});
const arrows = computed(() => (current.value?.lines ?? []).filter((l) => l.pv[0]).map((l) => ({ usi: l.pv[0], score: l.scoreCP })));

// ---- actions
const notebookOpen = ref(false);
const notebookSnippet = computed(() => `:::shogi-view{move=${cursor.value}}\n${usiString.value}\n:::`);
const practiceHref = computed(() => `#/practice?sfen=${encodeURIComponent(shown.value.sfen)}&back=${encodeURIComponent(location.hash.slice(2))}`);
const diagramHref = computed(() => `/api/diagram.svg?${new URLSearchParams({ sfen: shown.value.sfen, download: "1", flip: flip.value ? "1" : "0" })}`);

const saving = ref(false);
async function saveAsGame() {
  saving.value = true;
  try {
    const r = await api.post<{ results: { status: string; id: number; error?: string }[] }>("/api/import", { text: usiString.value });
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
  void analyse();
});
onUnmounted(() => {
  window.removeEventListener("keydown", onKey);
  clearTimeout(timer);
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
