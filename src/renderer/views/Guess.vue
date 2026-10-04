<template>
  <div class="page">
    <div class="head">
      <h1>次の一手 Guess the move</h1>
      <span v-if="game" class="muted">{{ game.black }} vs {{ game.white }} · you guess {{ sideMark(side) }}'s moves</span>
      <a v-if="game" class="btn small" :href="`#/game/${game.id}?ply=${idx}`">← Back to the game</a>
    </div>
    <div v-if="loadError" class="empty">{{ loadError }}</div>
    <div v-else-if="game" class="layout">
      <div>
        <ShogiBoard
          :sfen="game.plies[idx].sfen"
          :last-move="lastMove"
          :arrows="arrows"
          :allow-move="state === 'yours'"
          :flip="side === 'white'"
          :black-name="game.black"
          :white-name="game.white"
          :max-height="640"
          @move="guess"
        />
      </div>
      <div class="side">
        <section class="panel box">
          <div class="status" aria-live="polite">{{ statusText }}</div>
          <div v-if="result" class="result">
            <div :class="['line', result.match ? 'hit' : '']">
              <span class="who">You</span>
              <span class="move">{{ result.guess.text }}</span>
              <span v-if="result.guess.level" :class="['mark', 'l' + result.guess.level]">{{ LABELS[result.guess.level] }}</span>
              <span class="muted">{{ lossText(result.guess.loss) }}</span>
            </div>
            <div class="line">
              <span class="who">Game</span>
              <span class="move">{{ result.played.text }}</span>
              <span v-if="result.played.level" :class="['mark', 'l' + result.played.level]">{{ LABELS[result.played.level] }}</span>
              <span class="muted">{{ lossText(result.played.loss) }}</span>
            </div>
            <div v-if="result.best" class="line">
              <span class="who">Engine</span>
              <span class="move">{{ result.best.text }}</span>
            </div>
            <div class="verdict">{{ verdict }}</div>
            <div v-if="!result.match && result.guess.level >= 2" class="row">
              <button type="button" class="btn small" :disabled="carded.has(result.ply)" @click="makeCard(result)">
                {{ carded.has(result.ply) ? "Card made" : "Make a card from this" }}
              </button>
            </div>
          </div>
          <div class="row">
            <button v-if="state === 'shown'" ref="nextBtn" type="button" class="btn primary" @click="next">Next →</button>
            <button type="button" class="btn" :disabled="state === 'checking' || !guesses.length" @click="undo">↶ Try again</button>
            <button type="button" class="btn" :disabled="state === 'checking'" @click="skip">Skip</button>
          </div>
          <label class="field">
            Start at move
            <input v-model.number="startAt" type="number" min="0" :max="game.plies.length - 1" style="width: 6em" @change="restart" />
          </label>
        </section>
        <section class="panel box">
          <div class="cap">Score</div>
          <div class="score">
            <div><b>{{ guesses.length }}</b><span>guessed</span></div>
            <div><b>{{ matches }}</b><span>same as the game</span></div>
            <div><b>{{ asGood }}</b><span>as good or better</span></div>
            <div><b>{{ avgLoss(guesses.map((g) => g.guess.loss)) }}</b><span>your avg loss</span></div>
            <div><b>{{ avgLoss(guesses.map((g) => g.played.loss)) }}</b><span>game's avg loss</span></div>
          </div>
          <ol v-if="guesses.length" class="log">
            <li v-for="g in guesses" :key="g.ply">
              <button type="button" class="linkish" @click="goTo(g.ply - 1)">{{ g.ply }}.</button>
              {{ g.guess.text }} <span class="muted">{{ g.match ? "✓" : "· " + g.played.text }}</span>
            </li>
          </ol>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// Replay a game and guess the moves of one side. Each guess goes to
// /api/games/:id/guess, which grades it like a played move.
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import { api, sideMark, toast, type GameDetail } from "../api";
import { route } from "../router";
import ShogiBoard from "../components/ShogiBoard.vue";

type GuessMove = { usi: string; text: string; loss: number | null; level: number };
type GuessResult = { ply: number; match: boolean; guess: GuessMove; played: GuessMove; best: { usi: string; text: string; pv: string } | null };
type State = "yours" | "checking" | "shown" | "done" | "error";

const LABELS = ["", "緩手", "疑問手", "悪手", "大悪手"];
const game = ref<GameDetail | null>(null);
const loadError = ref("");
const idx = ref(0);
const startAt = ref(Number(route.query.get("ply")) || 0);
const side = ref<"black" | "white">("black");
const state = ref<State>("yours");
const error = ref("");
const result = ref<GuessResult | null>(null);
const guesses = ref<GuessResult[]>([]);
const nextBtn = ref<HTMLButtonElement | null>(null);
const carded = ref(new Set<number>());

const toMove = (sfen: string) => (sfen.split(" ")[1] === "w" ? "white" : "black");
const lastMove = computed(() => {
  const g = game.value;
  if (!g || idx.value === 0) return null;
  return { prevSfen: g.plies[idx.value - 1].sfen, usi: g.plies[idx.value].usi };
});
// After a guess: arrows for the guess, the game move and the engine's choice.
const arrows = computed(() => {
  const r = result.value;
  if (!r) return [];
  return [...new Set([r.guess.usi, r.played.usi, r.best?.usi ?? ""])].filter(Boolean).map((usi) => ({ usi }));
});
const matches = computed(() => guesses.value.filter((g) => g.match).length);
const asGood = computed(() => guesses.value.filter((g) => g.match || (g.guess.loss !== null && g.played.loss !== null && g.guess.loss <= g.played.loss)).length);
const statusText = computed(
  () =>
    ({
      yours: `Move ${idx.value + 1}: what would you play?`,
      checking: "Checking your move…",
      shown: result.value?.match ? "Same as the game." : "The game went differently.",
      done: `End of the game. ${matches.value} of ${guesses.value.length} matched.`,
      error: error.value,
    })[state.value],
);
const verdict = computed(() => {
  const r = result.value;
  if (!r || r.guess.loss === null || r.played.loss === null) return "";
  if (r.match) return r.played.level ? "You'd have made the same mistake." : "";
  const d = Math.round((r.played.loss - r.guess.loss) * 10) / 10;
  if (d > 0) return `Your move keeps ${d} points more winning chance than the game move.`;
  if (d < 0) return `Your move gives away ${-d} points more than the game move.`;
  return "About as good as the game move.";
});

function lossText(loss: number | null) {
  return loss === null ? "" : loss < 0.5 ? "no loss" : `−${loss.toFixed(1)}%`;
}
function avgLoss(xs: (number | null)[]) {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) : "–";
}

// Walk forward through the opponent's moves to the next one of ours.
function settle() {
  const g = game.value!;
  while (idx.value < g.plies.length - 1 && toMove(g.plies[idx.value].sfen) !== side.value) idx.value++;
  state.value = idx.value >= g.plies.length - 1 ? "done" : "yours";
}
function goTo(i: number) {
  idx.value = i;
  result.value = null;
  settle();
}
function restart() {
  guesses.value = [];
  goTo(Math.max(0, Math.min(startAt.value || 0, game.value!.plies.length - 1)));
}

async function guess(usi: string) {
  if (state.value !== "yours") return;
  state.value = "checking";
  try {
    const r = await api.post<GuessResult>(`/api/games/${game.value!.id}/guess`, { ply: idx.value + 1, usi });
    result.value = r;
    guesses.value = [...guesses.value.filter((g) => g.ply !== r.ply), r].sort((a, b) => a.ply - b.ply);
    state.value = "shown";
    await nextTick();
    nextBtn.value?.focus();
  } catch (e) {
    error.value = String(e);
    state.value = "error";
    setTimeout(() => state.value === "error" && (state.value = "yours"), 4000);
  }
}
// A review card for this position, with my guess as the move to fix.
async function makeCard(r: GuessResult) {
  try {
    await api.post("/api/cards", {
      gameId: game.value!.id,
      ply: r.ply,
      guess: { usi: r.guess.usi, loss: r.guess.loss, level: r.guess.level, best: r.best?.usi, pv: r.best?.pv },
    });
    carded.value = new Set([...carded.value, r.ply]);
    toast("Card made. It's in your review queue.");
  } catch (e) {
    toast(String(e));
  }
}
function next() {
  idx.value++;
  result.value = null;
  settle();
}
function skip() {
  if (state.value === "done") return;
  next();
}
function undo() {
  const last = guesses.value.at(-1);
  if (!last) return;
  guesses.value = guesses.value.slice(0, -1);
  goTo(last.ply - 1);
}

// → or Enter: next; s: skip; Backspace: take the last guess back.
function onKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  if (t && t.tagName === "INPUT") return;
  // A focused button or link handles Enter itself.
  if (t && (t.tagName === "BUTTON" || t.tagName === "A") && e.key === "Enter") return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if ((e.key === "ArrowRight" || e.key === "Enter") && state.value === "shown") next();
  else if (e.key === "s" && (state.value === "yours" || state.value === "shown")) skip();
  else if (e.key === "Backspace" && state.value !== "checking") undo();
  else return;
  e.preventDefault();
}
onMounted(() => window.addEventListener("keydown", onKey));
onUnmounted(() => window.removeEventListener("keydown", onKey));

(async () => {
  try {
    const g = await api.get<GameDetail>(`/api/games/${Number(route.query.get("game"))}`);
    game.value = g;
    const q = route.query.get("side");
    side.value = q === "white" || q === "black" ? q : g.mySide || "black";
    restart();
  } catch {
    loadError.value = "No game given. Open a game and choose “Guess the moves”.";
  }
})();
</script>

<style scoped>
.head {
  display: flex;
  align-items: baseline;
  gap: 14px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.layout {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
  gap: 24px;
  align-items: start;
}
@media (max-width: 1000px) {
  .layout {
    grid-template-columns: minmax(0, 1fr);
  }
}
.side {
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
.status {
  font-family: var(--serif);
  font-size: 20px;
}
.result {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.line {
  display: flex;
  gap: 10px;
  align-items: baseline;
}
.line.hit .move {
  color: var(--win);
}
.who {
  width: 4.5em;
  font-size: 12px;
  color: var(--muted);
}
.move {
  font-family: var(--serif);
  font-size: 18px;
}
.verdict {
  font-size: 13px;
}
.row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.score {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(90px, 1fr));
  gap: 10px;
}
.score div {
  display: flex;
  flex-direction: column;
}
.score b {
  font-family: var(--serif);
  font-size: 22px;
}
.score span {
  font-size: 11px;
  color: var(--muted);
}
.log {
  list-style: none;
  margin: 0;
  padding: 0;
  columns: 2 160px;
  font-family: var(--serif);
  font-size: 14px;
}
.linkish {
  background: none;
  border: 0;
  padding: 0;
  color: inherit;
  font: inherit;
  cursor: pointer;
  text-decoration: underline dotted;
}
</style>
