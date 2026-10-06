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
        <template v-if="live.analysis.current?.verifying">確認中 {{ live.analysis.current.verifying.done + 1 }}/{{ live.analysis.current.verifying.total }}</template>
        <template v-else>分析中 {{ live.analysis.current ? `${live.analysis.current.ply}/${live.analysis.current.total}` : "" }}</template>
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
    <Board v-else-if="route.name === 'board'" :key="route.params[0] ?? ''" />
    <RecordGame v-else-if="route.name === 'record'" />
    <Player v-else-if="route.name === 'player'" />
    <Repertoire v-else-if="route.name === 'repertoire'" />
    <Puzzles v-else-if="route.name === 'puzzles'" />
    <Practice v-else-if="route.name === 'practice'" :key="route.query.toString()" />
    <Guess v-else-if="route.name === 'guess'" :key="route.query.toString()" />
    <Notebooks v-else-if="route.name === 'notes'" />
    <Settings v-else-if="route.name === 'settings'" />
    <div v-else class="page"><div class="empty">Page not found. <a href="#/">Home</a></div></div>
  </main>
  <div v-if="live.toast" class="toast" role="status">{{ live.toast }}</div>
  <dialog ref="helpDialog" class="help panel" aria-labelledby="help-title" @click.self="helpDialog?.close()">
    <h2 id="help-title" class="serif">Keyboard shortcuts</h2>
    <div v-for="g in shortcuts" :key="g.title" class="help-group">
      <div class="cap">{{ g.title }}</div>
      <div v-for="[k, what] in g.keys" :key="k" class="help-row"><kbd>{{ k }}</kbd><span>{{ what }}</span></div>
    </div>
    <button type="button" class="btn small" @click="helpDialog?.close()">Close</button>
  </dialog>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { route } from "./router";
import { api, live, toast } from "./api";
import Dashboard from "./views/Dashboard.vue";
import Library from "./views/Library.vue";
import Game from "./views/Game.vue";
import Review from "./views/Review.vue";
import Stats from "./views/Stats.vue";
import Explorer from "./views/Explorer.vue";
import Board from "./views/Board.vue";
import RecordGame from "./views/RecordGame.vue";
import Player from "./views/Player.vue";
import Notebooks from "./views/Notebooks.vue";
import Practice from "./views/Practice.vue";
import Guess from "./views/Guess.vue";
import Puzzles from "./views/Puzzles.vue";
import Repertoire from "./views/Repertoire.vue";
import Settings from "./views/Settings.vue";

// On a phone (phone access), notes and settings can't be changed, so they're left out.
const remote = !["127.0.0.1", "localhost", "[::1]"].includes(location.hostname);
const nav = [
  { name: "home", label: "ホーム Home" },
  { name: "library", label: "棋譜庫 Library" },
  { name: "review", label: "復習 Review" },
  { name: "stats", label: "統計 Stats" },
  { name: "explorer", label: "定跡 Explorer" },
  { name: "board", label: "検討 Board" },
  { name: "notes", label: "研究 Notes" },
  { name: "settings", label: "設定 Settings" },
].filter((n) => !remote || (n.name !== "notes" && n.name !== "settings"));
const active = (name: string) => route.name === name || (name === "library" && (route.name === "game" || route.name === "record" || route.name === "guess")) || (name === "stats" && route.name === "player") || (name === "review" && (route.name === "puzzles" || route.name === "practice")) || (name === "explorer" && route.name === "repertoire");

const due = ref(0);
async function refreshDue() {
  try {
    due.value = (await api.get<{ due: number }>("/api/cards/counts")).due;
  } catch {
    /* server not up yet */
  }
}
onMounted(refreshDue);

const helpDialog = ref<HTMLDialogElement | null>(null);
const shortcuts = [
  { title: "Anywhere", keys: [["?", "This list"], ["/", "Search the library"], ["Ctrl/⌘ V", "Import a copied kifu and open it"]] },
  {
    title: "Game",
    keys: [
      ["← →", "Previous / next move"],
      ["Home End", "Start / end of the game"],
      ["[ ]", "Previous / next mistake"],
      ["f", "Flip the board"],
    ],
  },
  { title: "Study board", keys: [["← →", "Previous / next move"], ["Home End", "Start / end of the line"], ["f", "Flip the board"]] },
  { title: "Review", keys: [["1 2 3 4", "Again / Hard / Good / Easy"], ["Space Enter", "The suggested grade"]] },
  { title: "Guess the move", keys: [["→ Enter", "Next move"], ["s", "Skip this move"], ["Backspace", "Take the last guess back"]] },
];
// Global keys, ignored while typing in a field.
function onGlobalKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "?") {
    e.preventDefault();
    if (helpDialog.value?.open) helpDialog.value.close();
    else helpDialog.value?.showModal();
  } else if (e.key === "/") {
    e.preventDefault();
    if (route.name !== "library") location.hash = "#/library";
    setTimeout(() => (document.querySelector('input[type="search"]') as HTMLInputElement | null)?.focus(), 50);
  }
}
// Ctrl/⌘+V outside a text field: a copied kifu (KIF, KI2, CSA, SFEN/USI) is imported and opened.
const KIFU_HINT = /手合割|先手：|^\s*1\s+\S+[（(]|^\s*[▲☗]|^V2|^PI|^[+-]\d{4}[A-Z]{2}|^position\s|^sfen\s|^[1-9lnsgkrbp+/]{17,}\s[bw]\s/im;
async function onGlobalPaste(e: ClipboardEvent) {
  const t = e.target as HTMLElement | null;
  if (remote || (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable))) return;
  const text = e.clipboardData?.getData("text") ?? "";
  if (text.trim().length < 8 || !KIFU_HINT.test(text)) return;
  e.preventDefault();
  try {
    const r = await api.post<{ results: { status: string; id: number }[] }>("/api/import", { text });
    const ok = r.results.filter((x) => x.status !== "error");
    const first = ok[0];
    if (!first) return toast("That doesn't look like a kifu.");
    live.libraryVersion++;
    if (r.results.length > 1) {
      // Several games: show them in the library rather than opening one.
      const added = ok.filter((x) => x.status === "added").length;
      const dups = ok.length - added;
      const failed = r.results.length - ok.length;
      toast(`Imported ${added} game${added === 1 ? "" : "s"}${dups ? `, ${dups} already there` : ""}${failed ? `, ${failed} unreadable` : ""}.`);
      location.hash = "#/library";
      return;
    }
    toast(first.status === "added" ? "Imported the kifu from the clipboard." : "Already in the library; opening it.");
    location.hash = `#/game/${first.id}`;
  } catch (err) {
    toast(String(err));
  }
}
onMounted(() => {
  window.addEventListener("keydown", onGlobalKey);
  window.addEventListener("paste", onGlobalPaste);
});
onUnmounted(() => {
  window.removeEventListener("keydown", onGlobalKey);
  window.removeEventListener("paste", onGlobalPaste);
});
watch(() => [live.libraryVersion, route.name], refreshDue);
</script>

<style scoped>
.help {
  color: var(--text);
  background: var(--panel);
  border: 1px solid var(--edge);
  border-radius: 10px;
  padding: 20px 24px;
  min-width: min(420px, 90vw);
}
.help::backdrop {
  background: rgb(0 0 0 / 55%);
}
.help h2 {
  margin: 0 0 12px;
}
.help-group {
  margin-bottom: 14px;
}
.help-row {
  display: grid;
  grid-template-columns: 110px 1fr;
  gap: 12px;
  font-size: 14px;
  padding: 3px 0;
}
kbd {
  font-family: var(--mono, monospace);
  font-size: 12px;
  border: 1px solid var(--line-2);
  border-radius: 4px;
  padding: 1px 6px;
  justify-self: start;
}
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
  color: var(--on-accent);
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
