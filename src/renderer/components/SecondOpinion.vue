<template>
  <div v-if="status?.configured" class="panel box second">
    <div class="cap">セカンドオピニオン Second opinion{{ status.engine ? " · " + status.engine : "" }}</div>
    <template v-if="status.running">
      <div class="muted">Comparing… {{ status.done }} / {{ status.total }} positions</div>
      <div class="bar"><span :style="{ width: (status.total ? (status.done / status.total) * 100 : 0) + '%' }"></span></div>
    </template>
    <div v-else-if="status.error" class="error">{{ status.error }}</div>
    <template v-if="r && !status.running">
      <div class="sum">
        <div>
          <span class="muted">Agreement</span> {{ r.agreement != null ? Math.round(r.agreement) + "%" : "–" }} of {{ r.moves }} moves graded the same
        </div>
        <div><span class="muted">Different best move</span> in {{ r.bestMovesDiffer }} position{{ r.bestMovesDiffer === 1 ? "" : "s" }}</div>
      </div>
      <ol v-if="r.disagreements.length" class="dis">
        <li v-for="d in r.disagreements" :key="d.ply">
          <button type="button" class="row-btn" :title="`Go to move ${d.ply}`" @click="emit('jump', d.ply)">
            <span class="serif">{{ d.ply }}手 {{ d.text }}</span>
            <span v-if="d.main.level !== d.second.level" class="vs">
              <span :class="'lv l' + d.main.level">{{ d.main.label || "fine" }} −{{ d.main.loss }}</span>
              vs
              <span :class="'lv l' + d.second.level">{{ d.second.label || "fine" }} −{{ d.second.loss }}</span>
            </span>
            <span v-if="d.winBefore.main != null && d.winBefore.second != null && Math.abs(d.winBefore.main - d.winBefore.second) >= 15" class="muted small">
              ☗ {{ d.winBefore.main }}% vs {{ d.winBefore.second }}% before it
            </span>
            <span v-if="d.bestMain && d.bestSecond && d.bestMain !== d.bestSecond" class="muted small">best {{ d.bestMain }} vs {{ d.bestSecond }}</span>
          </button>
        </li>
      </ol>
      <div v-else class="muted">The engines agree on every move's grade.</div>
    </template>
    <button v-if="!status.running" type="button" class="btn small" @click="start">{{ r ? "Compare again" : `Compare with ${status.engine || "the second engine"}` }}</button>
  </div>
</template>

<script setup lang="ts">
// The second engine's view of this game: where it grades moves differently
// from the main analysis. The comparison runs on the server; this polls it.
import { computed, onMounted, onUnmounted, ref } from "vue";
import { api, toast } from "../api";

type Side = { level: number; label: string; loss: number };
type Disagreement = { ply: number; text: string; side: string; main: Side; second: Side; winBefore: { main: number | null; second: number | null }; bestMain: string; bestSecond: string };
type Status = {
  configured: boolean;
  running: boolean;
  done: number;
  total: number;
  engine: string;
  error: string;
  result: { engine: string; moves: number; agreement: number | null; bestMovesDiffer: number; disagreements: Disagreement[] } | null;
};

const props = defineProps<{ gameId: number }>();
const emit = defineEmits<{ jump: [ply: number] }>();
const status = ref<Status | null>(null);
const r = computed(() => status.value?.result ?? null);
let timer: ReturnType<typeof setTimeout> | undefined;

async function refresh() {
  status.value = await api.get<Status>(`/api/games/${props.gameId}/compare`).catch(() => null);
  clearTimeout(timer);
  if (status.value?.running) timer = setTimeout(refresh, 700);
}
async function start() {
  try {
    await api.post(`/api/games/${props.gameId}/compare`);
  } catch (e) {
    toast(String(e instanceof Error ? e.message : e));
  }
  await refresh();
}
onMounted(refresh);
onUnmounted(() => clearTimeout(timer));
</script>

<style scoped>
.box {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.sum {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}
.bar {
  height: 6px;
  border-radius: 3px;
  background: var(--line);
  overflow: hidden;
}
.bar span {
  display: block;
  height: 100%;
  background: var(--gold);
}
.error {
  color: var(--loss);
  font-size: 13px;
}
.dis {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 280px;
  overflow-y: auto;
}
.row-btn {
  all: unset;
  box-sizing: border-box;
  width: 100%;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  align-items: baseline;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: 6px;
  cursor: pointer;
}
.row-btn:hover,
.row-btn:focus-visible {
  border-color: var(--gold);
}
.vs {
  font-size: 12px;
}
.lv.l3,
.lv.l4 {
  color: var(--loss);
  font-weight: 600;
}
.small {
  font-size: 12px;
}
</style>
