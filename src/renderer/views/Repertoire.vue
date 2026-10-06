<template>
  <div class="page">
    <div class="head">
      <h1>定跡ドリル Opening drill</h1>
      <span class="muted">The opening positions you reach most, with you to move. Play the move you want to play there.</span>
      <div class="seg">
        <button type="button" class="btn small" :class="{ on: side === 'black' }" @click="side = 'black'">☗ 先手</button>
        <button type="button" class="btn small" :class="{ on: side === 'white' }" @click="side = 'white'">☖ 後手</button>
      </div>
      <label class="muted small"><input v-model="problemsOnly" type="checkbox" /> Only where my usual move is weak</label>
      <a class="btn small" href="#/explorer">Explorer →</a>
    </div>

    <div v-if="positions === null" class="empty">Loading…</div>
    <div v-else-if="!queue.length" class="empty">
      Nothing to drill yet. Positions show up once you have reached them in at least two analysed games as {{ side === "black" ? "先手" : "後手" }}<template v-if="problemsOnly">, and your usual move there is weak</template>.
    </div>
    <div v-else class="layout">
      <div>
        <ShogiBoard
          :key="pos.sfen"
          :sfen="shownSfen"
          :last-move="answer ? { prevSfen: pos.sfen, usi: answer } : null"
          :allow-move="!answer"
          :flip="side === 'white'"
          :max-height="620"
          @move="check"
        />
      </div>
      <div class="side">
        <section class="panel box">
          <div class="row spread">
            <span class="serif">{{ index + 1 }} / {{ queue.length }}</span>
            <span class="muted small">{{ right }} right · {{ wrong }} wrong</span>
          </div>
          <div class="muted small">Reached in {{ pos.count }} of your games · move {{ pos.ply + 1 }}</div>
          <div v-if="!answer" class="prompt">Your move.</div>
          <template v-else>
            <div class="verdict" :class="ok ? 'good' : 'bad'">{{ ok ? "✓ Good" : "✗ Not one of the good moves here" }}: {{ answerText }}</div>
            <div class="cap">Good moves</div>
            <div v-for="a in pos.accepted" :key="a.usi" class="mv">
              <span class="serif">{{ a.text }}</span>
              <span class="tag">{{ { book: "定跡 book", engine: "engine best", yours: "you play it well" }[a.why] }}</span>
            </div>
            <div class="cap">What you have played</div>
            <div v-for="m in pos.played" :key="m.usi" class="mv">
              <span class="serif">{{ m.text }}</span>
              <span class="muted small">{{ m.count }}× · {{ m.avgLoss != null ? `avg −${m.avgLoss.toFixed(1)}` : "not analysed" }}</span>
              <span v-if="!m.good" class="mark l2">weak</span>
            </div>
            <div class="row">
              <button type="button" class="btn primary" @click="next">Next →</button>
              <a class="btn small" :href="`#/explorer?sfen=${encodeURIComponent(pos.sfen)}&side=${side}`">Open in explorer</a>
            </div>
          </template>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// Drill opening positions from your own games; answers are judged against the book, the engine and your good moves.
import { computed, ref, watch } from "vue";
import { Position, formatMove } from "tsshogi";
import { api } from "../api";
import ShogiBoard from "../components/ShogiBoard.vue";

type Move = { usi: string; text: string; count: number; avgLoss: number | null; good: boolean };
type Pos = { sfen: string; count: number; ply: number; played: Move[]; accepted: { usi: string; text: string; why: string }[]; problem: boolean };

const side = ref<"black" | "white">("black");
const problemsOnly = ref(false);
const positions = ref<Pos[] | null>(null);
const index = ref(0);
const answer = ref("");
const right = ref(0);
const wrong = ref(0);

watch(
  side,
  async () => {
    positions.value = null;
    positions.value = await api.get<Pos[]>(`/api/repertoire?side=${side.value}`);
    restart();
  },
  { immediate: true },
);
watch(problemsOnly, restart);

const queue = computed(() => (positions.value ?? []).filter((p) => !problemsOnly.value || p.problem));
const pos = computed(() => queue.value[index.value % Math.max(1, queue.value.length)]);
const ok = computed(() => pos.value.accepted.some((a) => a.usi === answer.value));
const answerText = computed(() => {
  const p = Position.newBySFEN(pos.value.sfen);
  const m = p?.createMoveByUSI(answer.value);
  return p && m ? formatMove(p, m) : answer.value;
});
const shownSfen = computed(() => {
  if (!answer.value) return pos.value.sfen;
  const p = Position.newBySFEN(pos.value.sfen)!;
  const m = p.createMoveByUSI(answer.value);
  if (m) p.doMove(m);
  return p.sfen;
});

function restart() {
  index.value = 0;
  answer.value = "";
  right.value = wrong.value = 0;
}
function check(usi: string) {
  if (answer.value) return;
  answer.value = usi;
  if (ok.value) right.value++;
  else wrong.value++;
}
function next() {
  answer.value = "";
  index.value = (index.value + 1) % queue.value.length;
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
.seg {
  display: flex;
  gap: 4px;
}
.seg .on {
  border-color: var(--accent, #d9a441);
  color: var(--accent, #d9a441);
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
.box {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.spread {
  justify-content: space-between;
}
.prompt {
  font-family: var(--serif);
  font-size: 20px;
}
.verdict {
  font-family: var(--serif);
  font-size: 18px;
}
.verdict.good {
  color: var(--win);
}
.verdict.bad {
  color: var(--loss);
}
.mv {
  display: flex;
  gap: 10px;
  align-items: baseline;
  font-size: 15px;
}
.tag {
  font-size: 11px;
  color: var(--muted);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 0 6px;
}
.small {
  font-size: 12px;
}
label.small {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
</style>
