<template>
  <dialog ref="dlg" class="dlg" @close="emit('close')">
    <form method="dialog" class="body" @submit.prevent="save">
      <h3>研究ノートに追加 · Add to notebook</h3>
      <label class="field">
        Page
        <select v-model="pageId">
          <option :value="0">＋ New page…</option>
          <option v-for="p in pages" :key="p.id" :value="p.id">{{ p.notebook }} / {{ p.title }}</option>
        </select>
      </label>
      <template v-if="pageId === 0">
        <label class="field">
          Notebook
          <input v-model="notebook" list="nb-list" />
          <datalist id="nb-list">
            <option v-for="n in notebooks" :key="n" :value="n"></option>
          </datalist>
        </label>
        <label class="field">
          Title
          <input v-model="title" required />
        </label>
      </template>
      <label class="field">
        Your note
        <textarea v-model="note" rows="4" placeholder="Why this position matters…"></textarea>
      </label>
      <div class="muted" style="font-size: 12px">Inserts: <code>{{ snippet.split("\n")[0] }}</code></div>
      <div class="row">
        <button type="submit" class="btn primary">Add</button>
        <button type="button" class="btn" @click="dlg?.close()">Cancel</button>
      </div>
    </form>
  </dialog>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api, PageSummary, toast } from "../api";

const props = defineProps<{ snippet: string; defaultTitle?: string }>();
const emit = defineEmits<{ close: [] }>();

const dlg = ref<HTMLDialogElement | null>(null);
const pages = ref<PageSummary[]>([]);
const pageId = ref(0);
const notebook = ref("Notes");
const title = ref(props.defaultTitle ?? "");
const note = ref("");
const notebooks = computed(() => [...new Set(pages.value.map((p) => p.notebook))]);

onMounted(async () => {
  dlg.value?.showModal();
  pages.value = await api.get<PageSummary[]>("/api/pages");
  const last = Number(localStorage.getItem("kifu.lastPage") ?? 0);
  if (pages.value.some((p) => p.id === last)) pageId.value = last;
});

async function save() {
  const text = props.snippet + (note.value.trim() ? "\n\n" + note.value.trim() : "");
  let id = pageId.value;
  if (!id) {
    const p = await api.post<{ id: number }>("/api/pages", { notebook: notebook.value, title: title.value || "Untitled", body: "" });
    id = p.id;
  }
  await api.post(`/api/pages/${id}/append`, { text });
  try {
    localStorage.setItem("kifu.lastPage", String(id));
  } catch {
    /* storage unavailable */
  }
  toast("Added to notebook");
  dlg.value?.close();
}
</script>

<style scoped>
.dlg {
  background: var(--panel);
  color: var(--text);
  border: 1px solid var(--gold);
  border-radius: 10px;
  padding: 0;
  width: min(520px, 92vw);
}
.dlg::backdrop {
  background: rgba(0, 0, 0, 0.6);
}
.body {
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.row {
  display: flex;
  gap: 8px;
}
</style>
