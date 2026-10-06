<template>
  <div class="page nb">
    <aside class="list">
      <div class="cap" style="margin-bottom: 8px">Notebooks</div>
      <div v-for="(ps, name) in grouped" :key="name" class="group">
        <div class="gname serif">{{ name }}</div>
        <a
          v-for="p in ps"
          :key="p.id"
          :href="`#/notes/${p.id}`"
          class="pg"
          :class="{ on: page?.id === p.id }"
        >{{ p.title }}</a>
      </div>
      <button type="button" class="btn" style="margin-top: 12px; width: 100%" @click="newPage">＋ New page</button>
      <button type="button" class="btn" style="margin-top: 8px; width: 100%" @click="weekly">週報 This week's report</button>
    </aside>

    <section v-if="page" class="editor-col">
      <div class="title-row">
        <input v-model="page.title" class="title-input serif" aria-label="Page title" @change="save" />
        <input v-model="page.notebook" class="nb-input" aria-label="Notebook" list="nb-names" @change="save" />
        <datalist id="nb-names"><option v-for="n in Object.keys(grouped)" :key="n" :value="n"></option></datalist>
        <div class="modes">
          <button type="button" class="btn small" :class="{ on: mode === 'edit' }" @click="mode = 'edit'">Edit</button>
          <button type="button" class="btn small" :class="{ on: mode === 'split' }" @click="mode = 'split'">Split</button>
          <button type="button" class="btn small" :class="{ on: mode === 'view' }" @click="mode = 'view'">Read</button>
          <button type="button" class="btn small danger" @click="remove">Delete</button>
        </div>
      </div>
      <div class="muted saved">{{ saving ? "Saving…" : dirty ? "Unsaved" : "Saved" }}</div>
      <div class="panes" :class="mode">
        <div v-if="mode !== 'view'" class="edit">
          <div class="insert">
            <span class="cap">Insert</span>
            <button type="button" class="btn small" @click="insert(':::shogi-view{game=1 ply=0}\n:::')">Board from game</button>
            <button type="button" class="btn small" @click="insert(':::shogi-view{move=0}\nposition startpos moves 7g7f 3c3d\n:::')">Board from moves</button>
            <button type="button" class="btn small" @click="insert(':kifu[game:1]{start=1 stop=20}')">Move excerpt</button>
          </div>
          <textarea ref="ta" v-model="page.body" spellcheck="false" @input="dirty = true" @blur="save"></textarea>
        </div>
        <article v-if="mode !== 'edit'" class="view">
          <template v-for="(b, i) in blocks" :key="i + ':' + blockKey(b)">
            <div v-if="b.type === 'md'" class="md" v-html="b.html"></div>
            <NoteBoard v-else-if="b.type === 'board'" kind="board" :attrs="b.attrs" :body="b.body" />
            <NoteBoard v-else kind="kifu" :attrs="b.attrs" :ref-name="b.ref" />
          </template>
          <div v-if="!blocks.length" class="empty">Empty page. Write Markdown, or use “Add to notebook” from a game or card.</div>
        </article>
      </div>
    </section>
    <section v-else class="editor-col">
      <div class="empty">Pick a page, or make a new one. Positions from games and cards land here via “Add to notebook”.</div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { api, Page, PageSummary, toast } from "../api";
import { go, route } from "../router";
import { Block, parseNotebook } from "../notebook";
import NoteBoard from "../components/NoteBoard.vue";

const pages = ref<PageSummary[]>([]);
const page = ref<Page | null>(null);
const mode = ref<"edit" | "split" | "view">("view");
const dirty = ref(false);
const saving = ref(false);
const ta = ref<HTMLTextAreaElement | null>(null);

const grouped = computed(() => {
  const g: Record<string, PageSummary[]> = {};
  for (const p of pages.value) (g[p.notebook] ??= []).push(p);
  return g;
});

async function loadList() {
  pages.value = await api.get<PageSummary[]>("/api/pages");
}
async function loadPage() {
  const id = Number(route.params[0]);
  if (!id) {
    page.value = null;
    if (pages.value.length) go(`notes/${pages.value[0].id}`);
    return;
  }
  page.value = await api.get<Page>(`/api/pages/${id}`);
  dirty.value = false;
}
onMounted(async () => {
  await loadList();
  await loadPage();
});
watch(() => route.params[0], loadPage);

// Re-parse the preview at most a few times a second while typing.
const blocks = ref<Block[]>([]);
let parseTimer: ReturnType<typeof setTimeout> | undefined;
watch(
  () => page.value?.body,
  (body) => {
    clearTimeout(parseTimer);
    parseTimer = setTimeout(() => (blocks.value = parseNotebook(body ?? "")), blocks.value.length ? 300 : 0);
  },
  { immediate: true },
);
const blockKey = (b: Block) => (b.type === "md" ? b.html.length : JSON.stringify(b));

async function save() {
  if (!page.value) return;
  saving.value = true;
  try {
    await api.put(`/api/pages/${page.value.id}`, { title: page.value.title, notebook: page.value.notebook, body: page.value.body });
    dirty.value = false;
    await loadList();
  } finally {
    saving.value = false;
  }
}
// Autosave every few seconds while editing.
const autosave = setInterval(() => dirty.value && void save(), 4000);
onUnmounted(() => {
  clearInterval(autosave);
  if (dirty.value) void save();
});

async function newPage() {
  const p = await api.post<Page>("/api/pages", { title: "New page", notebook: page.value?.notebook ?? "Notes", body: "" });
  await loadList();
  mode.value = "split";
  go(`notes/${p.id}`);
}
// A report of the last seven days: games, accuracy, costliest moves and practice.
async function weekly() {
  const p = await api.post<Page>("/api/notes/weekly");
  await loadList();
  go(`notes/${p.id}`);
}
async function remove() {
  if (!page.value || !confirm(`Delete page "${page.value.title}"?`)) return;
  await api.del(`/api/pages/${page.value.id}`);
  toast("Page deleted");
  page.value = null;
  await loadList();
  go("notes");
}
function insert(text: string) {
  if (!page.value) return;
  const el = ta.value;
  const pos = el ? el.selectionStart : page.value.body.length;
  const before = page.value.body.slice(0, pos);
  const sep = before && !before.endsWith("\n\n") ? (before.endsWith("\n") ? "\n" : "\n\n") : "";
  page.value.body = before + sep + text + "\n" + page.value.body.slice(pos);
  dirty.value = true;
}
</script>

<style scoped>
.nb {
  display: flex;
  gap: 24px;
  align-items: flex-start;
  flex-wrap: wrap;
}
.list {
  flex: 0 1 240px;
  min-width: 200px;
}
.group {
  margin-bottom: 12px;
}
.gname {
  font-size: 15px;
  margin-bottom: 4px;
}
.pg {
  display: block;
  padding: 8px 10px;
  border-radius: 4px;
  color: var(--text);
  text-decoration: none;
  font-size: 14px;
}
.pg:hover {
  background: var(--line-soft);
}
.pg.on {
  background: var(--gold-bg);
  color: var(--gold-soft);
}
.editor-col {
  flex: 1 1 600px;
  min-width: 0;
}
.title-row {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
.title-input {
  font-size: 22px;
  flex: 1 1 300px;
  background: transparent;
  border-color: transparent;
}
.title-input:hover {
  border-color: var(--line-2);
}
.nb-input {
  width: 180px;
}
.modes {
  display: flex;
  gap: 6px;
}
.saved {
  font-size: 12px;
  margin: 4px 0 10px;
}
.panes {
  display: grid;
  gap: 18px;
}
.panes.split {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}
@media (max-width: 1000px) {
  .panes.split {
    grid-template-columns: 1fr;
  }
}
.edit {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.insert {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}
.edit textarea {
  min-height: 560px;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 13px;
}
.view {
  line-height: 1.75;
  font-size: 15px;
  max-width: 820px;
}
.md :deep(h1),
.md :deep(h2),
.md :deep(h3) {
  margin: 18px 0 8px;
}
.md :deep(code) {
  background: var(--panel-2);
  padding: 1px 5px;
  border-radius: 3px;
}
.md :deep(blockquote) {
  margin: 8px 0;
  padding-left: 12px;
  border-left: 3px solid var(--line-2);
  color: var(--muted);
}
</style>
