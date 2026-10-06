<template>
  <div class="page">
    <div class="head">
      <h1>研究ドリル Study drill</h1>
      <span v-if="data" class="serif title">{{ data.title }}</span>
      <div class="seg" role="group" aria-label="Side to drill">
        <button type="button" class="btn small" :class="{ on: side === 'black' }" :aria-pressed="side === 'black'" @click="setSide('black')">☗ 先手</button>
        <button type="button" class="btn small" :class="{ on: side === 'white' }" :aria-pressed="side === 'white'" @click="setSide('white')">☖ 後手</button>
      </div>
      <label class="muted small"><input v-model="all" type="checkbox" @change="load" /> Practise all, not just due</label>
      <a class="btn small" :href="`#/board/${id}`">← Back to the study</a>
    </div>

    <div v-if="error" class="empty">{{ error }}</div>
    <div v-else-if="!data" class="empty">Loading…</div>
    <div v-else-if="!pos" class="empty">
      <div class="serif" style="font-size: 20px; margin-bottom: 6px">{{ data.total ? "Done for now" : "Nothing to drill for this side" }}</div>
      <template v-if="data.total">
        <div v-if="answered">This session: {{ right }} of {{ answered }} right first time.</div>
        <div>{{ data.total }} position{{ data.total === 1 ? "" : "s" }} in this study for {{ side === "black" ? "☗" : "☖" }}; none due now.</div>
        <button type="button" class="btn" style="margin-top: 10px" @click="practiseAll">Practise all anyway</button>
      </template>
      <div v-else>The study has no {{ side === "black" ? "☗" : "☖" }} moves to ask about. Try the other side.</div>
    </div>
    <div v-else class="layout">
      <div>
        <ShogiBoard
          :key="pos.key + ':' + round"
          :sfen="shownSfen"
          :last-move="result ? { prevSfen: pos.sfen, usi: played } : pos.lastMove"
          :arrows="result && !result.correct ? result.accepted.filter((a) => a.main).map((a) => ({ usi: a.usi })) : []"
          :allow-move="!result && !busy"
          :flip="side === 'white'"
          :max-height="620"
          @move="answer"
        />
      </div>
      <div class="side">
        <section class="panel box">
          <div class="row spread">
            <span class="serif">{{ index + 1 }} / {{ queue.length }}</span>
            <span class="muted small">{{ right }} right · {{ answered - right }} missed</span>
          </div>
          <div class="muted small">Move {{ pos.depth + 1 }} of the study{{ pos.isNew ? " · new" : "" }}</div>
          <div v-if="!result" class="prompt">Your move: what does the study play here?</div>
          <template v-else>
            <div class="verdict" :class="result.correct ? 'good' : 'bad'" role="status">
              {{ result.correct ? (result.main ? "✓ The study's move" : "✓ In the study as a variation") : "✗ Not in the study" }}
            </div>
            <div class="cap">The study's moves</div>
            <div v-for="a in result.accepted" :key="a.usi" class="mv">
              <span class="serif">{{ a.main ? "★ " : "" }}{{ a.text }}</span>
              <span v-if="a.usi === played" class="muted small">your move</span>
            </div>
            <p v-if="result.comment" class="comment">{{ result.comment }}</p>
            <div class="muted small">{{ result.correct ? `Next time in ${dueText(result.dueAt)}.` : "It comes back before the end of this session." }}</div>
            <div class="row">
              <button type="button" class="btn primary" @click="next">Next →</button>
              <a class="btn small" :href="`#/board/${id}?ply=${pos.depth}${pos.path.some((i) => i) ? '&path=' + pos.path.join('.') : ''}`">Open in the study</a>
            </div>
          </template>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// Drill a saved study: each position where the chosen side is to move, asking
// for the study's move. Answers are scheduled on the server (SM-2); a miss is
// asked again at the end of this session.
import { computed, onMounted, onUnmounted, ref } from "vue";
import { Position } from "tsshogi";
import { api, toast } from "../api";
import { route } from "../router";
import ShogiBoard from "../components/ShogiBoard.vue";

type Accepted = { usi: string; text: string; main: boolean };
type DrillPos = { sfen: string; key: string; depth: number; path: number[]; lastMove: { prevSfen: string; usi: string } | null; accepted: Accepted[]; comment: string; isNew: boolean };
type DrillData = { title: string; total: number; due: number; positions: DrillPos[] };
type Result = { correct: boolean; main: boolean; accepted: Accepted[]; comment: string; dueAt: number };

const id = Number(route.params[0]) || 0;
const side = ref<"black" | "white">(route.query.get("side") === "white" ? "white" : "black");
const all = ref(false);
const data = ref<DrillData | null>(null);
const error = ref("");
const queue = ref<DrillPos[]>([]);
const index = ref(0);
const round = ref(0);
const result = ref<Result | null>(null);
const played = ref("");
const busy = ref(false);
const answered = ref(0);
const right = ref(0);
const missed = new Set<string>();

const pos = computed(() => queue.value[index.value] ?? null);
const shownSfen = computed(() => {
  if (!pos.value) return "";
  if (!result.value) return pos.value.sfen;
  const p = Position.newBySFEN(pos.value.sfen)!;
  const m = p.createMoveByUSI(played.value);
  if (m) p.doMove(m);
  return p.sfen;
});

async function load() {
  error.value = "";
  try {
    data.value = await api.get<DrillData>(`/api/studies/${id}/drill?side=${side.value}${all.value ? "&all=1" : ""}`);
  } catch (e) {
    error.value = String(e instanceof Error ? e.message : e);
    return;
  }
  queue.value = [...data.value.positions];
  index.value = 0;
  result.value = null;
  missed.clear();
}
function setSide(s: "black" | "white") {
  side.value = s;
  history.replaceState(null, "", `#/drill/${id}?side=${s}`);
  void load();
}
function practiseAll() {
  all.value = true;
  void load();
}

async function answer(usi: string) {
  if (!pos.value || result.value) return;
  busy.value = true;
  played.value = usi;
  try {
    result.value = await api.post<Result>(`/api/studies/${id}/drill`, { side: side.value, sfen: pos.value.sfen, usi });
    // Count first tries only; a re-asked miss doesn't change the score.
    if (!missed.has(pos.value.key)) {
      answered.value++;
      if (result.value.correct) right.value++;
    }
    if (!result.value.correct && !missed.has(pos.value.key)) {
      missed.add(pos.value.key);
      queue.value.push(pos.value);
    }
  } catch (e) {
    toast(String(e instanceof Error ? e.message : e));
    played.value = "";
  } finally {
    busy.value = false;
  }
}
function next() {
  result.value = null;
  played.value = "";
  index.value++;
  round.value++;
}
const dueText = (t: number) => {
  const d = Math.round((t - Date.now()) / 86_400_000);
  return d <= 0 ? "a few minutes" : d === 1 ? "1 day" : `${d} days`;
};

function onKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT") return;
  if (result.value && (e.key === "Enter" || e.key === "ArrowRight" || e.key === " ")) {
    e.preventDefault();
    next();
  }
}
onMounted(() => {
  window.addEventListener("keydown", onKey);
  void load();
});
onUnmounted(() => window.removeEventListener("keydown", onKey));
</script>

<style scoped>
.head {
  display: flex;
  align-items: baseline;
  gap: 14px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.title {
  font-size: 18px;
}
.seg {
  display: inline-flex;
  gap: 4px;
}
.layout {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
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
  flex-wrap: wrap;
  align-items: center;
}
.spread {
  justify-content: space-between;
}
.prompt {
  font-family: var(--serif);
  font-size: 18px;
}
.verdict {
  font-family: var(--serif);
  font-size: 18px;
}
.verdict.good {
  color: var(--good);
}
.verdict.bad {
  color: var(--loss);
}
.mv {
  display: flex;
  gap: 10px;
  align-items: baseline;
}
.comment {
  margin: 0;
  white-space: pre-wrap;
  border-left: 3px solid var(--gold);
  padding-left: 10px;
}
.small {
  font-size: 12px;
}
</style>
