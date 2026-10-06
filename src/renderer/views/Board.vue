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
import { liveSearch, LiveResult } from "../live";

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
  if (!engineSet.value) return;
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
watch([() => shown.value.sfen, maxMs], () => {
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
  analyse();
});
onUnmounted(() => {
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
