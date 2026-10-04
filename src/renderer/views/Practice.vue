<template>
  <div class="page">
    <div class="head">
      <h1 v-if="goalMate">詰将棋 Mate in {{ goalMate }}</h1>
      <h1 v-else>実戦練習 Play it out</h1>
      <span v-if="goalMate" class="muted">{{ mySideMark }} to move and mate. Every move must keep the mate; the engine defends.</span>
      <span v-else class="muted">You play {{ mySideMark }} from this position; the engine answers. Good for converting won positions you let slip.</span>
      <a v-if="backHref" class="btn small" :href="backHref">← Back</a>
    </div>
    <div v-if="!start" class="empty">No position given. Open a game or a card and choose "Play it out".</div>
    <div v-else class="layout">
      <div>
        <ShogiBoard
          :sfen="current"
          :last-move="lastMove"
          :allow-move="state === 'yours'"
          :flip="mySide === 'white'"
          :black-name="mySide === 'black' ? 'You' : 'Engine'"
          :white-name="mySide === 'white' ? 'You' : 'Engine'"
          :max-height="640"
          @move="play"
        />
      </div>
      <div class="side">
        <section class="panel box">
          <div class="status" :class="state">{{ statusText }}</div>
          <div v-if="warning" class="warning">{{ warning }}</div>
          <div class="bar" :title="evalLabel">
            <span :style="{ width: (myWinRate ?? 50) + '%' }"></span>
          </div>
          <div class="muted small">{{ evalLabel }}</div>
          <label class="field">
            Engine time per move
            <select v-model.number="movetimeMs" :disabled="state === 'thinking'">
              <option :value="100">0.1 s (weak)</option>
              <option :value="500">0.5 s</option>
              <option :value="2000">2 s</option>
              <option :value="5000">5 s (strong)</option>
            </select>
          </label>
          <div class="row">
            <button type="button" class="btn" :disabled="state === 'thinking' || myMoves === 0" @click="takeBack">↶ Take back</button>
            <button type="button" class="btn" :disabled="state === 'thinking' || moves.length === 0" @click="restart">Restart</button>
            <button type="button" class="btn danger" :disabled="state !== 'yours'" @click="resign">{{ goalMate ? "Give up" : "Resign" }}</button>
          </div>
        </section>
        <section class="panel box moves">
          <div class="cap">Moves</div>
          <ol v-if="texts.length" :start="startPly + 1">
            <li v-for="(t, i) in texts" :key="i">{{ t }}</li>
          </ol>
          <div v-else class="muted small">Your move.</div>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// Play a position out against the configured USI engine, one /api/analyze-position call per engine move.
import { computed, ref } from "vue";
import { Color, Position, formatMove } from "tsshogi";
import { api, evalText, winRate } from "../api";
import { route } from "../router";
import ShogiBoard from "../components/ShogiBoard.vue";

type Line = { score?: number; mate?: number };
type SearchReply = { best: string; score?: number; mate?: number; lines: Line[] };
type State = "yours" | "thinking" | "won" | "lost" | "error";

const start = Position.newBySFEN(route.query.get("sfen") ?? "")?.sfen ?? "";
const startPly = Number(start.split(" ")[3] ?? 1) - 1;
const backHref = route.query.get("back") ? "#/" + route.query.get("back") : "";
const mySide = start && Position.newBySFEN(start)!.color === Color.WHITE ? "white" : "black";
const mySideMark = mySide === "black" ? "☗" : "☖";
// Mate puzzles: the user must keep a forced mate on every move.
const goalMate = route.query.get("goal") === "mate" ? Number(route.query.get("mate")) || 0 : 0;
const warning = ref("");

const moves = ref<string[]>([]);
const state = ref<State>("yours");
const error = ref("");
const movetimeMs = ref(500);
// Engine evals are black's view; null until the engine has looked.
const score = ref<number | null>(null);
const mate = ref<number | null>(null);

const line = computed(() => {
  const pos = Position.newBySFEN(start)!;
  const steps: { prevSfen: string; usi: string; text: string }[] = [];
  for (const usi of moves.value) {
    const m = pos.createMoveByUSI(usi);
    if (!m || !pos.isValidMove(m)) break;
    const prevSfen = pos.sfen;
    const text = formatMove(pos, m);
    pos.doMove(m);
    steps.push({ prevSfen, usi, text });
  }
  return { sfen: pos.sfen, steps };
});
const current = computed(() => (start ? line.value.sfen : ""));
const lastMove = computed(() => line.value.steps.at(-1) ?? null);
const texts = computed(() => line.value.steps.map((s) => s.text));
const myMoves = computed(() => Math.ceil(moves.value.length / 2));

const myWinRate = computed(() => {
  const r = winRate(score.value, mate.value);
  return r === null ? null : mySide === "black" ? r : 100 - r;
});
const evalLabel = computed(() =>
  score.value === null && mate.value === null ? "No evaluation yet" : `${evalText(score.value, mate.value)} · your winning chances ${Math.round(myWinRate.value ?? 50)}%`,
);
const statusText = computed(
  () =>
    ({
      yours: "Your move",
      thinking: "Engine is thinking…",
      won: goalMate ? `詰み. Solved in ${myMoves.value} move${myMoves.value === 1 ? "" : "s"}. 🎉` : "You won. The engine resigned. 🎉",
      lost: "You lost.",
      error: error.value,
    })[state.value],
);

async function play(usi: string) {
  if (state.value !== "yours") return;
  moves.value = [...moves.value, usi];
  state.value = "thinking";
  try {
    const r = await api.post<SearchReply>("/api/analyze-position", { sfen: start, moves: moves.value, movetimeMs: movetimeMs.value });
    score.value = r.score ?? null;
    mate.value = r.mate ?? null;
    const myMateSign = mySide === "black" ? 1 : -1;
    warning.value =
      goalMate && r.best && !(r.mate !== undefined && r.mate * myMateSign > 0)
        ? "That move lets the king escape: there is no forced mate any more. Take it back and try again."
        : "";
    if (!r.best || r.best === "win") {
      // "resign", or "win" for an entering-king declaration by the engine.
      state.value = r.best === "win" ? "lost" : "won";
      return;
    }
    // A mate-in-1 reply from the engine ends the game once it is played.
    const engineSign = mySide === "black" ? -1 : 1;
    const matesNow = r.mate !== undefined && r.mate * engineSign === 1;
    moves.value = [...moves.value, r.best];
    state.value = matesNow ? "lost" : "yours";
  } catch (e) {
    moves.value = moves.value.slice(0, -1);
    error.value = String(e);
    state.value = "error";
    setTimeout(() => state.value === "error" && (state.value = "yours"), 4000);
  }
}

function takeBack() {
  warning.value = "";
  // Back to before my last move (and the engine's reply to it).
  const n = moves.value.length % 2 === 0 ? 2 : 1;
  moves.value = moves.value.slice(0, -n);
  state.value = "yours";
}
function restart() {
  warning.value = "";
  moves.value = [];
  score.value = mate.value = null;
  state.value = "yours";
}
function resign() {
  state.value = "lost";
}
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
.status.won {
  color: var(--win);
}
.status.lost,
.status.error {
  color: var(--loss);
}
.warning {
  color: var(--loss);
  font-size: 13px;
}
.bar {
  height: 10px;
  border-radius: 5px;
  background: var(--line);
  overflow: hidden;
}
.bar span {
  display: block;
  height: 100%;
  background: var(--accent, var(--win));
  transition: width 0.3s;
}
.row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.small {
  font-size: 12px;
}
.moves ol {
  margin: 0;
  padding-left: 2.5em;
  columns: 3 120px;
  font-family: var(--serif);
  font-size: 15px;
}
</style>
