<template>
  <section
    class="import panel"
    :class="{ 'drop-active': dragging }"
    @dragover.prevent="dragging = true"
    @dragleave.prevent="dragging = false"
    @drop.prevent="onDrop"
  >
    <div class="drop">
      <div class="serif" style="font-size: 18px">棋譜を取り込む · Drop kifu files here</div>
      <div class="muted" style="font-size: 13px">.kif · .kifu · .ki2 · .csa · .jkf · USI/SFEN — Shift_JIS or UTF-8, detected automatically</div>
      <div class="row">
        <label class="btn primary">
          Choose files
          <input type="file" multiple accept=".kif,.kifu,.ki2,.ki2u,.csa,.jkf,.sfen,.txt" class="sr-only" @change="onPick" />
        </label>
        <button type="button" class="btn" @click="showPaste = !showPaste">Paste text</button>
      </div>
    </div>
    <div v-if="showPaste" class="paste">
      <label for="paste-box" class="cap">Paste a kifu (KIF, KI2, CSA, USI…)</label>
      <textarea id="paste-box" v-model="pasteText" rows="6" placeholder="手合割：平手&#10;１ ７六歩(77)&#10;…"></textarea>
      <div class="row">
        <button type="button" class="btn primary" :disabled="!pasteText.trim() || busy" @click="importPaste">Import pasted kifu</button>
        <button type="button" class="btn" @click="readClipboard">From clipboard</button>
      </div>
    </div>
    <div v-if="busy" class="muted">Importing…</div>
    <div v-if="results.length" class="results">
      <div class="cap">This import · {{ added }} new · {{ dups }} duplicate · {{ errors }} error</div>
      <table class="grid">
        <tbody>
          <tr v-for="(r, i) in results" :key="i">
            <td>{{ r.name }}</td>
            <td>
              <span v-if="r.status === 'added'" class="tag" style="border-color: var(--win); color: var(--win)">New</span>
              <span v-else-if="r.status === 'duplicate'" class="tag">Duplicate (merged)</span>
              <span v-else class="tag" style="border-color: var(--loss); color: var(--loss)">{{ r.error }}</span>
            </td>
            <td>
              <a v-if="r.id" :href="`#/game/${r.id}`">Open</a>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { api, fileToBase64, live, toast } from "../api";

type Result = { status: "added" | "duplicate" | "error"; name: string; id?: number; error?: string };
const emit = defineEmits<{ imported: [results: Result[]] }>();

const dragging = ref(false);
const busy = ref(false);
const showPaste = ref(false);
const pasteText = ref("");
const results = ref<Result[]>([]);
const added = computed(() => results.value.filter((r) => r.status === "added").length);
const dups = computed(() => results.value.filter((r) => r.status === "duplicate").length);
const errors = computed(() => results.value.filter((r) => r.status === "error").length);

async function send(body: unknown) {
  busy.value = true;
  try {
    const r = await api.post<{ results: Result[] }>("/api/import", body);
    results.value = [...r.results, ...results.value];
    live.libraryVersion++;
    emit("imported", r.results);
    const n = r.results.filter((x) => x.status === "added").length;
    toast(`${n} game${n === 1 ? "" : "s"} imported`);
  } catch (e) {
    toast(String(e));
  } finally {
    busy.value = false;
  }
}

async function importFiles(files: FileList | File[]) {
  const list = [...files];
  // Send in batches so a big folder does not make one huge request.
  for (let i = 0; i < list.length; i += 50) {
    const batch = await Promise.all(list.slice(i, i + 50).map(async (f) => ({ name: f.name, data: await fileToBase64(f) })));
    await send({ files: batch });
  }
}

function onDrop(e: DragEvent) {
  dragging.value = false;
  if (e.dataTransfer?.files.length) void importFiles(e.dataTransfer.files);
  else {
    const text = e.dataTransfer?.getData("text/plain");
    if (text) void send({ text });
  }
}
function onPick(e: Event) {
  const input = e.target as HTMLInputElement;
  if (input.files?.length) void importFiles(input.files);
  input.value = "";
}
async function importPaste() {
  await send({ text: pasteText.value });
  pasteText.value = "";
}
async function readClipboard() {
  try {
    pasteText.value = await navigator.clipboard.readText();
  } catch {
    toast("Clipboard is not readable here; paste with Ctrl/⌘+V instead");
  }
}
</script>

<style scoped>
.import {
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.drop {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 22px;
  border: 1px dashed var(--line-2);
  border-radius: 8px;
  text-align: center;
}
.row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 6px;
}
.paste {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.results {
  max-height: 260px;
  overflow: auto;
}
</style>
