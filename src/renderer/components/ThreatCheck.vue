<template>
  <div class="threat">
    <button type="button" class="btn small" :disabled="busy" title="What would the opponent play if it were their move? Shows mate threats (詰めろ) too." @click="ask">
      {{ busy ? "Looking…" : "狙い Threat?" }}
    </button>
    <div v-if="result" class="threat-result" role="status">
      <template v-if="result.status === 'check'">In check: there is no passing here.</template>
      <template v-else>
        <div>
          If {{ mover }} passes: <b class="serif">{{ result.text || "—" }}</b><span class="muted"> · {{ evalText(result.score, result.mateScore) }}</span>
        </div>
        <div v-if="result.mate" class="mate"><b>詰めろ</b> · {{ result.mate.moves.length }}手詰 <span class="serif">{{ result.mate.text }}</span></div>
        <div v-else class="muted small">No mate threat found.</div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
// The null-move threat for a position: the opponent's best move if the side to
// move passed, and whether that is a forced mate (詰めろ). Emits the threat as
// an arrow in the passed position; clears when the position changes.
import { computed, ref, watch } from "vue";
import { api, evalText, toast } from "../api";

type Threat =
  | { status: "check" }
  | { status: "ok"; move: string; text: string; score: number | null; mateScore: number | null; mate: { moves: string[]; text: string } | null; passedSfen: string };

const props = defineProps<{ sfen: string }>();
const emit = defineEmits<{ arrow: [arrow: { usi: string; sfen: string } | null] }>();
const result = ref<Threat | null>(null);
const busy = ref(false);
const mover = computed(() => (props.sfen.split(" ")[1] === "w" ? "☖" : "☗"));

async function ask() {
  busy.value = true;
  const sfen = props.sfen;
  try {
    const r = await api.post<Threat>("/api/threat", { sfen });
    if (sfen !== props.sfen) return;
    result.value = r;
    emit("arrow", r.status === "ok" && r.move ? { usi: r.move, sfen: r.passedSfen } : null);
  } catch (e) {
    toast(String(e instanceof Error ? e.message : e));
  } finally {
    busy.value = false;
  }
}
watch(
  () => props.sfen,
  () => {
    if (!result.value) return;
    result.value = null;
    emit("arrow", null);
  },
);
</script>

<style scoped>
.threat {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
}
.threat-result {
  font-size: 13px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--panel-2);
  align-self: stretch;
}
.mate {
  color: var(--loss);
  margin-top: 2px;
}
.small {
  font-size: 12px;
}
</style>
