<template>
  <div class="panel box">
    <div class="cap">検討 Engine {{ engineName ? "· " + engineName : "" }}</div>
    <template v-if="ply.score !== null || ply.mate !== null">
      <div class="big">
        <span class="serif">{{ moverWin }}%</span>
        <span class="muted" style="font-size: 13px">{{ evalText(ply.score, ply.mate) }} · {{ ply.situation }}</span>
      </div>
      <div v-if="next && (next.level || next.missed)" class="played">
        Next: <b class="serif">{{ next.text }}</b>
        <span v-if="next.level" class="mark" :class="'l' + next.level">{{ next.label }}</span>
        <span v-if="next.missed" class="mark l4">{{ next.missed === "mate" ? "詰み逃し" : "勝ち逃し" }}</span>
        <span class="muted">−{{ next.loss?.toFixed(1) }} pts</span>
      </div>
      <div v-if="ply.pvText" class="pv">最善 {{ ply.pvText }}</div>
    </template>
    <div v-else class="muted" style="margin-top: 6px">No evaluation for this position yet.</div>
    <div v-if="multi.length" class="multipv">
      <div v-for="l in multi" :key="l.multipv" class="mrow">
        <span>{{ l.multipv }}. {{ l.text.split(" ")[0] }}</span>
        <span class="muted">{{ evalText(l.score ?? null, l.mate ?? null) }}</span>
      </div>
      <div v-if="multiDepth" class="muted mdepth">depth {{ multiDepth }}{{ multiBusy ? " · thinking…" : "" }}</div>
    </div>
    <div class="row" style="margin-top: 10px">
      <button v-if="multiBusy" type="button" class="btn small" @click="stopCandidates">Stop</button>
      <button v-else type="button" class="btn small" @click="candidates">Candidate moves</button>
      <button type="button" class="btn small" :disabled="mateBusy" title="Ask the engine for a forced mate from this position" @click="mateCheck">
        {{ mateBusy ? "Searching…" : "詰みチェック Mate?" }}
      </button>
    </div>
    <ThreatCheck :sfen="ply.sfen" @arrow="(a) => emit('threat', a)" />
    <div v-if="mateResult" class="mate-result" :class="mateResult.status">
      <template v-if="mateResult.status === 'mate'">
        <b>{{ mateResult.moves.length }}手詰</b> <span class="serif">{{ mateResult.text }}</span>
      </template>
      <template v-else-if="mateResult.status === 'nomate'">No forced mate found in {{ MATE_SECONDS }}s.</template>
      <template v-else-if="mateResult.status === 'timeout'">Ran out of time ({{ MATE_SECONDS }}s) without an answer.</template>
      <template v-else>This engine has no mate search.</template>
    </div>
  </div>
</template>

<script setup lang="ts">
// The game view's engine panel for one position: the stored evaluation, the
// streamed candidate moves (emitted as "lines" for the board's arrows) and a
// mate check. Moving to another position stops and clears both.
import { computed, onUnmounted, ref, watch } from "vue";
import { api, evalText, Ply, toast, winRate } from "../api";
import { liveSearch } from "../live";
import ThreatCheck from "./ThreatCheck.vue";

export type CandidateLine = { multipv: number; pv: string[]; text: string; score?: number; mate?: number; scoreSide?: number };

const props = defineProps<{ ply: Ply; next?: Ply; engineName?: string }>();
const emit = defineEmits<{ lines: [lines: CandidateLine[]]; threat: [arrow: { usi: string; sfen: string } | null] }>();

// Win % for the side to move in this position.
const moverWin = computed(() => {
  const w = winRate(props.ply.score, props.ply.mate) ?? 50;
  const toMove = props.ply.sfen.split(" ")[1] === "w" ? "white" : "black";
  return Math.round(toMove === "black" ? w : 100 - w);
});

// ---- candidate moves, streamed for up to CANDIDATE_MS or until Stop
const CANDIDATE_MS = 10_000;
const multi = ref<CandidateLine[]>([]);
const multiBusy = ref(false);
const multiDepth = ref(0);
watch(multi, (v) => emit("lines", v));
let stopMulti: (() => void) | null = null;
function stopCandidates() {
  stopMulti?.();
  stopMulti = null;
  multiBusy.value = false;
}
function candidates() {
  stopCandidates();
  multiBusy.value = true;
  const sfen = props.ply.sfen;
  stopMulti = liveSearch(
    { sfen, multipv: 3, maxMs: CANDIDATE_MS },
    {
      update: (r) => {
        if (props.ply.sfen !== sfen) return;
        multi.value = r.lines.map((l) => ({ ...l, scoreSide: l.scoreCP }));
        multiDepth.value = r.lines[0]?.depth ?? 0;
        if (r.done) stopCandidates();
      },
      error: (msg) => {
        toast(msg);
        stopCandidates();
      },
    },
  );
}

// ---- mate check
const MATE_SECONDS = 5;
type MateResult = { status: "mate"; moves: string[]; text: string } | { status: "nomate" | "timeout" | "notimplemented" };
const mateBusy = ref(false);
const mateResult = ref<MateResult | null>(null);
async function mateCheck() {
  mateBusy.value = true;
  try {
    mateResult.value = await api.post<MateResult>("/api/mate", { sfen: props.ply.sfen, timeMs: MATE_SECONDS * 1000 });
  } catch (e) {
    toast(String(e));
  } finally {
    mateBusy.value = false;
  }
}

watch(
  () => props.ply.sfen,
  () => {
    stopCandidates();
    multi.value = [];
    multiDepth.value = 0;
    mateResult.value = null;
  },
);
onUnmounted(stopCandidates);
</script>

<style scoped>
.box {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.row {
  display: flex;
  gap: 6px;
}
.big {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.big .serif {
  font-size: 30px;
}
.played {
  font-size: 13px;
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}
.pv {
  font-size: 13px;
  color: var(--muted);
  line-height: 1.6;
}
.mdepth {
  font-size: 12px;
}
.multipv .mrow {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
}
.mate-result {
  margin-top: 8px;
  font-size: 13px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--panel-2);
}
.mate-result.mate {
  border: 1px solid var(--loss);
}
</style>
