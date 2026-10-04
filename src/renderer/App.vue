<template>
  <header class="top">
    <a href="#/" class="brand">
      <span class="koma-logo">譜</span>
      <span class="serif">棋譜帖</span>
    </a>
    <nav aria-label="Main">
      <a v-for="n in nav" :key="n.name" :href="`#/${n.name}`" :class="{ on: active(n.name) }">{{ n.label }}</a>
    </nav>
    <div class="right">
      <a v-if="live.analysis?.running" href="#/library?analysed=no" class="analysis-pill" :title="live.analysis.engineName">
        <span class="dot"></span>
        分析中 {{ live.analysis.current ? `${live.analysis.current.ply}/${live.analysis.current.total}` : "" }}
        <span class="muted">· {{ live.analysis.queued.length }} queued</span>
      </a>
      <span v-else-if="live.analysis?.error" class="analysis-pill err" :title="live.analysis.error">Engine error</span>
      <a href="#/review" class="btn small" :class="{ on: due > 0 }">復習 {{ due }}</a>
    </div>
  </header>
  <main>
    <Dashboard v-if="route.name === 'home'" />
    <Library v-else-if="route.name === 'library'" />
    <Game v-else-if="route.name === 'game'" :key="route.params[0]" :id="Number(route.params[0])" />
    <Review v-else-if="route.name === 'review'" />
    <Stats v-else-if="route.name === 'stats'" />
    <Explorer v-else-if="route.name === 'explorer'" />
    <RecordGame v-else-if="route.name === 'record'" />
    <Player v-else-if="route.name === 'player'" />
    <Repertoire v-else-if="route.name === 'repertoire'" />
    <Puzzles v-else-if="route.name === 'puzzles'" />
    <Practice v-else-if="route.name === 'practice'" :key="route.query.toString()" />
    <Notebooks v-else-if="route.name === 'notes'" />
    <Settings v-else-if="route.name === 'settings'" />
    <div v-else class="page"><div class="empty">Page not found. <a href="#/">Home</a></div></div>
  </main>
  <div v-if="live.toast" class="toast" role="status">{{ live.toast }}</div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { route } from "./router";
import { api, live } from "./api";
import Dashboard from "./views/Dashboard.vue";
import Library from "./views/Library.vue";
import Game from "./views/Game.vue";
import Review from "./views/Review.vue";
import Stats from "./views/Stats.vue";
import Explorer from "./views/Explorer.vue";
import RecordGame from "./views/RecordGame.vue";
import Player from "./views/Player.vue";
import Notebooks from "./views/Notebooks.vue";
import Practice from "./views/Practice.vue";
import Puzzles from "./views/Puzzles.vue";
import Repertoire from "./views/Repertoire.vue";
import Settings from "./views/Settings.vue";

const nav = [
  { name: "home", label: "ホーム Home" },
  { name: "library", label: "棋譜庫 Library" },
  { name: "review", label: "復習 Review" },
  { name: "stats", label: "統計 Stats" },
  { name: "explorer", label: "定跡 Explorer" },
  { name: "notes", label: "研究 Notes" },
  { name: "settings", label: "設定 Settings" },
];
const active = (name: string) => route.name === name || (name === "library" && (route.name === "game" || route.name === "record")) || (name === "stats" && route.name === "player") || (name === "review" && (route.name === "puzzles" || route.name === "practice")) || (name === "explorer" && route.name === "repertoire");

const due = ref(0);
async function refreshDue() {
  try {
    due.value = (await api.get<{ due: number }>("/api/cards/counts")).due;
  } catch {
    /* server not up yet */
  }
}
onMounted(refreshDue);
watch(() => [live.libraryVersion, route.name], refreshDue);
</script>

<style scoped>
.top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 24px;
  padding: 10px 28px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-deep);
  position: sticky;
  top: 0;
  z-index: 50;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--text);
  text-decoration: none;
  font-size: 22px;
  letter-spacing: 0.1em;
}
.koma-logo {
  width: 30px;
  height: 34px;
  clip-path: polygon(50% 0, 86% 16%, 100% 100%, 0 100%, 14% 16%);
  background: var(--gold);
  display: flex;
  align-items: center;
  justify-content: center;
  padding-top: 4px;
  font-family: var(--serif);
  font-weight: 900;
  color: var(--bg);
  font-size: 16px;
}
nav {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
}
nav a {
  padding: 10px 12px;
  color: var(--text);
  text-decoration: none;
  border-bottom: 2px solid transparent;
}
nav a.on {
  color: var(--gold-soft);
  border-bottom-color: var(--gold);
  font-weight: 600;
}
.right {
  margin-left: auto;
  display: flex;
  gap: 10px;
  align-items: center;
}
.analysis-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  padding: 6px 10px;
  border-radius: 14px;
  border: 1px solid var(--line-2);
  color: var(--text);
  text-decoration: none;
}
.analysis-pill.err {
  border-color: var(--loss);
  color: var(--loss);
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--gold);
  animation: pulse 1.2s infinite;
}
@keyframes pulse {
  50% {
    opacity: 0.3;
  }
}
</style>
