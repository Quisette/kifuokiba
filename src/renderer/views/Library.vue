<template>
  <div class="page">
    <div class="head">
      <h1>棋譜庫 Library <span class="muted" style="font-size: 16px">{{ games.length }} games</span></h1>
      <div class="actions">
        <button type="button" class="btn" @click="showImport = !showImport">Import</button>
        <a class="btn" href="#/record">Record a game</a>
        <button type="button" class="btn" :disabled="!games.length" @click="analyse(games.map((g) => g.id))">Analyse shown</button>
        <a class="btn" :class="{ disabled: !games.length }" :href="'/api/export/games' + qs({ ...f, utf8: '1' })" download title="Every game shown, as KIF files in a zip">Export shown (.zip)</a>
      </div>
    </div>
    <ImportPanel v-if="showImport" style="margin-bottom: 16px" />

    <div class="collections">
      <button type="button" class="chip" :class="{ on: !hasFilter }" @click="clear">全て All</button>
      <button
        v-for="c in collections"
        :key="c.id"
        type="button"
        class="chip"
        :class="{ on: JSON.stringify(c.filter) === JSON.stringify(cleanFilter) }"
        @click="applyCollection(c.filter)"
        @contextmenu.prevent="deleteCollection(c)"
        :title="'Right-click to delete'"
      >
        {{ c.name }}
      </button>
      <button v-if="hasFilter" type="button" class="chip" @click="saveCollection">＋ Save as collection</button>
    </div>

    <form class="filters" @submit.prevent>
      <label class="field grow">
        Search
        <input v-model="f.q" type="search" placeholder="Player, event, tag, comment, note…" />
      </label>
      <label class="field">
        My side
        <select v-model="f.side">
          <option value="">Any</option>
          <option value="black">☗ 先手</option>
          <option value="white">☖ 後手</option>
        </select>
      </label>
      <label class="field">
        Result
        <select v-model="f.result">
          <option value="">Any</option>
          <option value="win">勝 Win</option>
          <option value="loss">負 Loss</option>
          <option value="draw">分 Draw</option>
        </select>
      </label>
      <label class="field">
        戦型 Opening
        <select v-model="f.opening">
          <option value="">Any</option>
          <option v-for="o in facets?.openings ?? []" :key="o.value" :value="o.value">{{ o.value }} ({{ o.n }})</option>
        </select>
      </label>
      <label class="field">
        囲い Castle
        <select v-model="f.castle">
          <option value="">Any</option>
          <option v-for="o in facets?.castles ?? []" :key="o.value" :value="o.value">{{ o.value }} ({{ o.n }})</option>
        </select>
      </label>
      <label class="field">
        Shape
        <select v-model="f.matchup">
          <option value="">Any</option>
          <option v-for="o in facets?.matchups ?? []" :key="o.value" :value="o.value">{{ o.value }}</option>
        </select>
      </label>
      <label class="field">
        Opponent
        <input v-model="f.opponent" list="opponents" placeholder="Any" />
        <datalist id="opponents">
          <option v-for="o in facets?.players ?? []" :key="o.value" :value="o.value"></option>
        </datalist>
      </label>
      <label class="field">
        Tag
        <select v-model="f.tag">
          <option value="">Any</option>
          <option v-for="o in facets?.tags ?? []" :key="o.value" :value="o.value">{{ o.value }} ({{ o.n }})</option>
        </select>
      </label>
      <label class="field">
        Source
        <select v-model="f.source">
          <option value="">Any</option>
          <option v-for="o in facets?.sources ?? []" :key="o.value" :value="o.value">{{ o.value }}</option>
        </select>
      </label>
      <label class="field">
        From
        <input v-model="f.dateFrom" type="date" />
      </label>
      <label class="field">
        To
        <input v-model="f.dateTo" type="date" />
      </label>
      <label class="field">
        Analysis
        <select v-model="f.analysed">
          <option value="">Any</option>
          <option value="yes">Analysed</option>
          <option value="no">Not yet</option>
        </select>
      </label>
    </form>

    <div v-if="selected.size" class="bulk panel">
      <span>{{ selected.size }} selected</span>
      <button type="button" class="btn small" @click="analyse([...selected])">Analyse</button>
      <input v-model="bulkTag" placeholder="tag" style="min-height: 30px; width: 140px" />
      <button type="button" class="btn small" :disabled="!bulkTag" @click="tagSelected(false)">Add tag</button>
      <button type="button" class="btn small" :disabled="!bulkTag" @click="tagSelected(true)">Remove tag</button>
      <button type="button" class="btn small danger" @click="deleteSelected">Delete</button>
      <button type="button" class="btn small" @click="selected.clear()">Clear</button>
    </div>

    <div class="scroll-x">
      <table class="grid">
        <thead>
          <tr>
            <th><input type="checkbox" aria-label="Select all" :checked="allSelected" @change="toggleAll" /></th>
            <th v-for="c in columns" :key="c.key">
              <button type="button" @click="sortBy(c.key)">
                {{ c.label }}<span v-if="f.sort === c.key">{{ f.desc ? " ▾" : " ▴" }}</span>
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="g in games.slice(0, visible)" :key="g.id" class="row" @click="open(g.id)">
            <td @click.stop><input type="checkbox" :aria-label="`Select game ${g.id}`" :checked="selected.has(g.id)" @change="toggle(g.id)" /></td>
            <td>{{ g.date || "—" }}</td>
            <td>
              <span class="res" :class="g.myResult || 'none'" style="width: 24px; height: 24px; font-size: 13px">{{ resultChar(g.myResult) }}</span>
            </td>
            <td>
              <span :class="{ me: g.mySide === 'black' }">☗{{ g.black }}</span>
              <span class="muted"> vs </span>
              <span :class="{ me: g.mySide === 'white' }">☖{{ g.white }}</span>
            </td>
            <td>{{ g.strategy || "—" }}</td>
            <td class="muted">{{ g.black_castle || "—" }} / {{ g.white_castle || "—" }}</td>
            <td style="text-align: right">{{ g.move_count }}</td>
            <td class="muted">{{ g.time_control || "" }}</td>
            <td>
              <span v-if="g.analysis_status === 'done'" title="Analysed">{{ g.myAccuracy != null ? g.myAccuracy.toFixed(0) + "%" : "✓" }}</span>
              <span v-else-if="g.analysis_status === 'queued'" class="muted">queued</span>
              <span v-else-if="g.analysis_status === 'imported'" class="muted" title="Evals from the file">file</span>
              <span v-else class="muted">—</span>
            </td>
            <td><span v-if="g.mistakes" class="mark l3">{{ g.mistakes }}</span></td>
            <td>
              <span v-for="t in g.tags" :key="t" class="tag" style="margin-right: 4px">{{ t }}</span>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="games.length > visible" class="more">
        <button type="button" class="btn" @click="visible += PAGE">Show {{ Math.min(PAGE, games.length - visible) }} more</button>
        <span class="muted small">{{ visible }} of {{ games.length }} shown</span>
      </div>
      <div v-if="!games.length" class="empty" style="margin-top: 12px">No games match. <button type="button" class="btn small" @click="clear">Clear filters</button></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { api, GameListItem, live, qs, resultChar, toast } from "../api";
import { go, route } from "../router";
import ImportPanel from "../components/ImportPanel.vue";

type Facet = { value: string; n: number };
type Facets = Record<"openings" | "castles" | "opponents" | "players" | "tags" | "sources" | "matchups", Facet[]>;
type Filter = Record<string, string | boolean>;

const blank = () => ({
  q: "",
  side: "",
  result: "",
  opening: "",
  castle: "",
  matchup: "",
  opponent: "",
  tag: "",
  source: "",
  dateFrom: "",
  dateTo: "",
  analysed: "",
  sort: "date",
  desc: true as boolean,
});
const f = reactive(blank());
// Filters arrive from links like #/library?opening=四間飛車.
for (const [k, v] of route.query.entries()) if (k in f) (f as Record<string, unknown>)[k] = k === "desc" ? v !== "false" : v;

const games = ref<GameListItem[]>([]);
const facets = ref<Facets | null>(null);
const collections = ref<{ id: number; name: string; filter: Filter }[]>([]);
const selected = reactive(new Set<number>());
const showImport = ref(false);
const bulkTag = ref("");

const columns = [
  { key: "date", label: "Date" },
  { key: "myResult", label: "Result" },
  { key: "black", label: "Players" },
  { key: "strategy", label: "戦型" },
  { key: "black_castle", label: "囲い ☗/☖" },
  { key: "move_count", label: "手数" },
  { key: "time_control", label: "Time" },
  { key: "myAccuracy", label: "Accuracy" },
  { key: "mistakes", label: "悪手" },
  { key: "tags", label: "Tags" },
];

const cleanFilter = computed(() => {
  const out: Filter = {};
  for (const [k, v] of Object.entries(f)) if (v !== "" && k !== "sort" && k !== "desc") out[k] = v;
  return out;
});
const hasFilter = computed(() => Object.keys(cleanFilter.value).length > 0);

// Large libraries: render rows in pages; filters, sorting and bulk actions still cover every match.
const PAGE = 200;
const visible = ref(PAGE);

async function load() {
  games.value = await api.get<GameListItem[]>("/api/games" + qs(f));
  visible.value = PAGE;
  for (const id of [...selected]) if (!games.value.some((g) => g.id === id)) selected.delete(id);
}
async function loadMeta() {
  [facets.value, collections.value] = await Promise.all([api.get<Facets>("/api/facets"), api.get<{ id: number; name: string; filter: Filter }[]>("/api/collections")]);
}
onMounted(() => {
  void load();
  void loadMeta();
});
let t: ReturnType<typeof setTimeout> | undefined;
watch(f, () => {
  clearTimeout(t);
  t = setTimeout(load, 150);
});
watch(
  () => live.libraryVersion,
  () => {
    void load();
    void loadMeta();
  },
);

function sortBy(key: string) {
  if (f.sort === key) f.desc = !f.desc;
  else {
    f.sort = key;
    f.desc = true;
  }
}
function clear() {
  Object.assign(f, blank());
}
function applyCollection(filter: Filter) {
  Object.assign(f, blank(), filter);
}
async function saveCollection() {
  const name = prompt("Collection name", f.opening || f.tag || f.opponent || "My collection");
  if (!name) return;
  await api.post("/api/collections", { name, filter: cleanFilter.value });
  await loadMeta();
}
async function deleteCollection(c: { id: number; name: string }) {
  if (!confirm(`Delete collection "${c.name}"?`)) return;
  await api.del(`/api/collections/${c.id}`);
  await loadMeta();
}
function open(id: number) {
  go(`game/${id}`);
}
const allSelected = computed(() => games.value.length > 0 && games.value.every((g) => selected.has(g.id)));
function toggle(id: number) {
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
}
function toggleAll() {
  if (allSelected.value) selected.clear();
  else games.value.forEach((g) => selected.add(g.id));
}
async function analyse(ids: number[]) {
  try {
    await api.post("/api/analysis", { ids });
    toast(`Queued ${ids.length} game(s) for analysis`);
    void load();
  } catch (e) {
    toast(String(e));
  }
}
async function tagSelected(remove: boolean) {
  await api.post("/api/games/bulk-tag", { ids: [...selected], tag: bulkTag.value, remove });
  await load();
  await loadMeta();
}
async function deleteSelected() {
  if (!confirm(`Delete ${selected.size} game(s) from the library? Cards made from them go too.`)) return;
  for (const id of selected) await api.del(`/api/games/${id}`);
  selected.clear();
  await load();
  await loadMeta();
}
</script>

<style scoped>
.head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 14px;
}
.actions {
  display: flex;
  gap: 8px;
}
.collections {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 14px;
}
.filters .field {
  min-width: 120px;
}
.filters .grow {
  flex: 1 1 220px;
}
.more {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-top: 12px;
}
.bulk {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px 12px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.me {
  color: var(--gold-soft);
  font-weight: 600;
}
</style>
