<template>
  <figure class="note-board study-block panel">
    <div v-if="error" class="muted">{{ error }}</div>
    <template v-else-if="study">
      <div class="title serif">{{ study.title }}</div>
      <ShogiBoard :sfen="line[idx].sfen" :last-move="idx ? { prevSfen: line[idx].prevSfen, usi: line[idx].usi } : null" :max-height="420" />
      <figcaption>
        <button type="button" class="btn small" aria-label="Previous move" :disabled="idx === 0" @click="idx--">◀</button>
        <button type="button" class="btn small" aria-label="Next move" :disabled="idx === line.length - 1" @click="idx++">▶</button>
        <span class="serif">{{ idx ? `${line[idx].ply}手目 ${line[idx].text}` : "開始局面" }}</span>
        <button v-for="a in line[idx].alts" :key="a.index" type="button" class="alt" :title="`Switch to the variation ${a.text}`" @click="switchTo(idx, a.index)">
          変 {{ a.text }}
        </button>
        <a :href="`#/board/${id}?ply=${idx}${path.length ? '&path=' + path.join('.') : ''}`" class="muted">open study →</a>
      </figcaption>
      <p v-if="line[idx].comment" class="comment">{{ line[idx].comment }}</p>
    </template>
    <div v-else class="muted">Loading study…</div>
  </figure>
</template>

<script setup lang="ts">
// A saved study inside a notebook page: step through its lines, switch to
// variations at 変 chips, and read the comment on each move. Read-only.
import { computed, onMounted, ref } from "vue";
import { Position, formatMove } from "tsshogi";
import { api } from "../api";
import { MoveTree, selectedLine } from "../../core/movetree";
import ShogiBoard from "./ShogiBoard.vue";

const props = defineProps<{ id: number }>();
const study = ref<{ title: string; start_sfen: string; tree: MoveTree } | null>(null);
const error = ref("");
const path = ref<number[]>([]);
const idx = ref(0);

const line = computed(() => {
  const st = study.value!;
  const nodes = selectedLine(st.tree, path.value);
  const pos = Position.newBySFEN(st.start_sfen)!;
  const first = Number(st.start_sfen.split(" ")[3] ?? 1) - 1;
  const out = [{ sfen: pos.sfen, prevSfen: "", usi: "", text: "", ply: first, comment: st.tree.comment ?? "", alts: [] as { index: number; text: string }[] }];
  for (let d = 1; d < nodes.length; d++) {
    const parent = nodes[d - 1].node;
    const { node, index } = nodes[d];
    const alts = parent.children.flatMap((c, i) => {
      const m = i === index ? null : pos.createMoveByUSI(c.usi);
      return m ? [{ index: i, text: formatMove(pos, m) }] : [];
    });
    const m = pos.createMoveByUSI(node.usi);
    if (!m) break;
    const prevSfen = pos.sfen;
    const text = formatMove(pos, m);
    pos.doMove(m);
    out.push({ sfen: pos.sfen, prevSfen, usi: node.usi, text, ply: out[d - 1].ply + 1, comment: node.comment ?? "", alts });
  }
  return out;
});

function switchTo(depth: number, index: number) {
  path.value = [...selectedLine(study.value!.tree, path.value).slice(1, depth).map((n) => n.index), index];
}

onMounted(async () => {
  if (!props.id) {
    error.value = "This study block has no id.";
    return;
  }
  try {
    study.value = await api.get(`/api/studies/${props.id}`);
  } catch {
    error.value = `Study ${props.id} isn't in the library.`;
  }
});
</script>

<style scoped>
.note-board {
  margin: 14px 0;
  padding: 12px;
  max-width: 760px;
}
.title {
  font-size: 16px;
  margin-bottom: 8px;
}
figcaption {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 8px;
  flex-wrap: wrap;
}
.alt {
  font: inherit;
  font-size: 12px;
  color: var(--muted);
  background: var(--panel-2);
  border: 1px solid var(--line-2);
  border-radius: 4px;
  padding: 1px 6px;
  cursor: pointer;
}
.alt:hover {
  border-color: var(--gold);
  color: var(--text);
}
.comment {
  margin: 8px 0 0;
  white-space: pre-wrap;
  font-size: 14px;
}
</style>
