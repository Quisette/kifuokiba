<template>
  <div class="page">
    <div class="head">
      <h1>詰将棋 Mate puzzles</h1>
      <div class="chips" role="tablist" aria-label="Puzzle source">
        <a class="chip" role="tab" :aria-selected="tab !== 'tsume'" :class="{ on: tab !== 'tsume' }" href="#/puzzles">From my games</a>
        <a class="chip" role="tab" :aria-selected="tab === 'tsume'" :class="{ on: tab === 'tsume' }" href="#/puzzles?tab=tsume">Collections</a>
      </div>
    </div>
    <TsumeCollections v-if="tab === 'tsume'" />
    <template v-else>
    <div class="head">
      <span class="muted">Every position in your analysed games where the side to move had a forced mate. Missed ones come first.</span>
      <label class="muted small"><input v-model="all" type="checkbox" /> Include the opponent's mates</label>
    </div>
    <div v-if="puzzles && total > puzzles.length" class="muted small more">
      Showing {{ puzzles.length }} of {{ total }} ({{ missed }} missed).
      <button type="button" class="btn small" @click="limit += 60">Show more</button>
    </div>
    <div v-if="puzzles === null" class="empty">Loading…</div>
    <div v-else-if="!puzzles.length" class="empty">No mates found yet. They show up once games are analysed and one side had a forced mate.</div>
    <div v-else class="grid">
      <div v-for="p in puzzles" :key="`${p.gameId}-${p.ply}`" class="panel card">
        <ShogiBoard :sfen="p.sfen" compact :flip="p.side === 'white'" />
        <div class="meta">
          <span class="serif mate">{{ p.mateIn }}手詰</span>
          <span v-if="p.missed" class="mark l3">missed in game</span>
          <span v-else-if="p.mine" class="mark found">found</span>
        </div>
        <div class="muted small">{{ p.side === "black" ? "☗" : "☖" }} to move · {{ p.date.slice(0, 10) }} · {{ p.black }} vs {{ p.white }}</div>
        <div class="row">
          <a class="btn small primary" :href="solveHref(p)">Solve</a>
          <a class="btn small" :href="`#/game/${p.gameId}?ply=${p.ply}`">Game</a>
          <button type="button" class="btn small" @click="reveal(p)">{{ shown.has(key(p)) ? p.bestText : "First move" }}</button>
        </div>
      </div>
    </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { api } from "../api";
import ShogiBoard from "../components/ShogiBoard.vue";
import TsumeCollections from "../components/TsumeCollections.vue";
import { route } from "../router";

type Puzzle = {
  gameId: number;
  ply: number;
  sfen: string;
  mateIn: number;
  side: "black" | "white";
  mine: boolean;
  missed: boolean;
  bestText: string;
  black: string;
  white: string;
  date: string;
};

const tab = computed(() => route.query.get("tab") ?? "");
const all = ref(false);
const limit = ref(60);
const puzzles = ref<Puzzle[] | null>(null);
const total = ref(0);
const missed = ref(0);
const shown = reactive(new Set<string>());
const key = (p: Puzzle) => `${p.gameId}-${p.ply}`;

watch(
  [all, limit],
  async () => {
    const r = await api.get<{ total: number; missed: number; puzzles: Puzzle[] }>(`/api/puzzles?mine=${all.value ? 0 : 1}&limit=${limit.value}`);
    puzzles.value = r.puzzles;
    total.value = r.total;
    missed.value = r.missed;
  },
  { immediate: true },
);

const solveHref = (p: Puzzle) => `#/practice?sfen=${encodeURIComponent(p.sfen)}&goal=mate&mate=${p.mateIn}&back=puzzles`;
function reveal(p: Puzzle) {
  shown.add(key(p));
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
.more {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-bottom: 12px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 16px;
}
.card {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.meta {
  display: flex;
  gap: 8px;
  align-items: center;
}
.mate {
  font-size: 18px;
}
.mark.found {
  background: var(--win);
  color: var(--on-accent);
}
.row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.small {
  font-size: 12px;
}
label.small {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.chips {
  display: flex;
  gap: 6px;
}
.chips a {
  text-decoration: none;
}
</style>
