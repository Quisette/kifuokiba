<template>
  <div>
    <section class="panel box importer">
      <div class="cap">Import problems</div>
      <div class="muted small">
        Tsume KIF/KI2/CSA files (one problem each, the answer as the moves), SFEN lines with optional answer moves (<code>&lt;sfen&gt; moves G*1b</code>), or
        JSON/NDJSON with <code>sfen</code> and <code>answer</code>, as shogimap-crawler writes.
      </div>
      <div class="row">
        <input v-model="name" placeholder="Collection name (default: file name)" aria-label="Collection name" style="min-width: 260px" />
        <label class="btn" :class="{ disabled: importing }">
          {{ importing ? "Importing…" : "Choose files…" }}
          <input type="file" multiple hidden :disabled="importing" accept=".kif,.kifu,.ki2,.csa,.jkf,.txt,.sfen,.json,.ndjson,.jsonl" @change="importFiles" />
        </label>
      </div>
    </section>

    <div v-if="!collections.length" class="empty">No collections yet.</div>
    <div v-else class="cols">
      <button
        v-for="c in collections"
        :key="c.collection"
        type="button"
        class="chip"
        :class="{ on: c.collection === current }"
        @click="open(c.collection)"
      >
        {{ c.collection }} <span class="muted">{{ c.solved }}/{{ c.problems }}</span>
      </button>
    </div>

    <template v-if="current">
      <div class="row progress">
        <span class="muted small">{{ solvedCount }} of {{ problems.length }} solved · failed ones and new ones first</span>
        <button type="button" class="btn small danger" style="margin-left: auto" @click="remove">Delete collection</button>
      </div>
      <div class="grid">
        <div v-for="t in problems" :key="t.id" class="panel card">
          <ShogiBoard :sfen="t.sfen" compact :flip="t.sfen.split(' ')[1] === 'w'" />
          <div class="meta">
            <span class="serif mate">{{ t.mate_len ? `${t.mate_len}手詰` : "詰将棋" }}</span>
            <span v-if="t.last_result === 'solved'" class="mark found">solved</span>
            <span v-else-if="t.last_result === 'failed'" class="mark l3">failed</span>
            <span class="muted small title">{{ t.title }}</span>
          </div>
          <div class="row">
            <a class="btn small primary" :href="solveHref(t)">Solve</a>
            <button v-if="t.firstText" type="button" class="btn small" @click="shown.add(t.id)">{{ shown.has(t.id) ? t.firstText : "First move" }}</button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
// Mate problems imported from files (see src/server/tsume.ts), solved in Practice's mate mode.
import { computed, onMounted, reactive, ref } from "vue";
import { api, fileToBase64, toast } from "../api";
import { go, route } from "../router";
import ShogiBoard from "./ShogiBoard.vue";

type Collection = { collection: string; problems: number; solved: number; tried: number };
type Problem = { id: number; title: string; sfen: string; mate_len: number; last_result: string; firstText: string };

const name = ref("");
const importing = ref(false);
const collections = ref<Collection[]>([]);
const current = ref(route.query.get("collection") ?? "");
const problems = ref<Problem[]>([]);
const shown = reactive(new Set<number>());
const solvedCount = computed(() => problems.value.filter((p) => p.last_result === "solved").length);

async function refresh() {
  collections.value = await api.get<Collection[]>("/api/tsume");
  if (!collections.value.some((c) => c.collection === current.value)) current.value = collections.value[0]?.collection ?? "";
  problems.value = current.value ? await api.get<Problem[]>(`/api/tsume/problems?collection=${encodeURIComponent(current.value)}`) : [];
}
onMounted(refresh);

function open(c: string) {
  go(`puzzles?tab=tsume&collection=${encodeURIComponent(c)}`);
  current.value = c;
  void refresh();
}

async function importFiles(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = "";
  if (!files.length) return;
  importing.value = true;
  let added = 0;
  let found = 0;
  let last = "";
  try {
    for (const f of files) {
      const r = await api.post<{ collection: string; found: number; added: number }>("/api/tsume/import", {
        base64: await fileToBase64(f),
        fileName: f.name,
        collection: name.value,
      });
      added += r.added;
      found += r.found;
      last = r.collection;
    }
    toast(found ? `Imported ${added} problem${added === 1 ? "" : "s"}${found > added ? ` (${found - added} already there)` : ""}.` : "No problems found in those files.");
    if (last) current.value = last;
  } catch (err) {
    toast(String(err));
  } finally {
    importing.value = false;
    await refresh();
  }
}

async function remove() {
  if (!confirm(`Delete the collection “${current.value}” and its results?`)) return;
  await api.del(`/api/tsume?collection=${encodeURIComponent(current.value)}`);
  current.value = "";
  await refresh();
}

const solveHref = (t: Problem) =>
  `#/practice?sfen=${encodeURIComponent(t.sfen)}&goal=mate&mate=${t.mate_len}&tsume=${t.id}&back=${encodeURIComponent(`puzzles?tab=tsume&collection=${encodeURIComponent(current.value)}`)}`;
</script>

<style scoped>
.importer {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 16px;
}
.row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}
.cols {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.progress {
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
.title {
  margin-left: auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 50%;
}
.mark.found {
  background: var(--win);
}
</style>
