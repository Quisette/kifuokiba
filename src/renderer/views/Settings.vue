<template>
  <div class="page">
    <h1 style="margin-bottom: 16px">設定 Settings</h1>
    <div v-if="!s" class="empty">Loading…</div>
    <form v-else class="cols" @submit.prevent="save">
      <section class="panel box">
        <h3>あなた You</h3>
        <label class="field">
          My player names (one per line; Shogi Wars, 81Dojo, Lishogi, real name…)
          <textarea v-model="names" rows="4" placeholder="Q&#10;quisette"></textarea>
        </label>
        <div class="muted small">Decides which side is you in each game: wins, stats and which mistakes become cards. Rank suffixes like “三段” are ignored.</div>
      </section>

      <section class="panel box">
        <h3>対局サイト Online accounts</h3>
        <label class="field">
          Lishogi username
          <input v-model="s.accounts.lishogi" placeholder="your Lishogi name" autocomplete="off" />
        </label>
        <div class="row">
          <button type="button" class="btn" :disabled="!s.accounts.lishogi || syncing" @click="sync">{{ syncing ? "Fetching…" : "Save and fetch new games" }}</button>
          <span v-if="syncResult" class="small">{{ syncResult }}</span>
        </div>
        <div class="muted small">
          Pulls your finished standard games from lishogi.org (variants are skipped). Later fetches only ask for games since the last one. Add the same name under
          “My player names” so the app knows which side is you. Shogi Wars has no public API, so download its kifu and drop the files in instead.
        </div>
      </section>

      <section class="panel box">
        <h3>監視フォルダ Watched folders</h3>
        <label class="field">
          Import kifu saved into these folders (one full path per line; subfolders included)
          <textarea v-model="folders" rows="3" placeholder="/Users/q/Documents/ShogiGUI/kifu&#10;C:\Users\q\Documents\将棋ウォーズ"></textarea>
        </label>
        <div class="row">
          <button type="button" class="btn" :disabled="!folders.trim() || scanning" @click="scan">{{ scanning ? "Scanning…" : "Save and scan now" }}</button>
          <span v-if="scanResult" class="small">{{ scanResult }}</span>
        </div>
        <div class="muted small">New and changed .kif, .kifu, .ki2, .csa and .jkf files are picked up while the app is open.</div>
      </section>

      <section class="panel box">
        <h3>エンジン Engine</h3>
        <label class="field">
          USI engine executable (full path)
          <input v-model="s.engine.path" placeholder="/Applications/YaneuraOu/YaneuraOu_NNUE-normal-clang++-apple-m1" />
        </label>
        <div class="row">
          <button type="button" class="btn" :disabled="!s.engine.path || testing" @click="test">{{ testing ? "Testing…" : "Test engine" }}</button>
          <span v-if="testResult" :style="{ color: testResult.ok ? 'var(--good)' : 'var(--loss)' }">
            {{ testResult.ok ? `OK: ${testResult.name} (best ${testResult.bestmove})` : testResult.error }}
          </span>
        </div>
        <div class="row">
          <label class="field">
            Time per move (ms)
            <input v-model.number="s.engine.movetimeMs" type="number" min="50" step="50" />
          </label>
          <label class="field">
            or nodes per move (0 = use time)
            <input v-model.number="s.engine.nodes" type="number" min="0" step="100000" />
          </label>
        </div>
        <label class="field">
          Engine options (one per line, Name=Value)
          <textarea v-model="options" rows="4" placeholder="USI_Hash=1024&#10;Threads=4&#10;EvalDir=eval"></textarea>
        </label>
        <label class="field">
          Opening book (YaneuraOu .db, optional)
          <input v-model="s.bookPath" placeholder="/path/to/standard_book.db" />
        </label>
        <label class="check"><input v-model="s.autoAnalyze" type="checkbox" /> Analyse new imports automatically</label>
        <div class="muted small">
          A real engine is needed for meaningful analysis, for example YaneuraOu with a 水匠 NNUE eval. For testing, the bundled
          <code>tools/mock-usi-engine.mjs</code> speaks USI but only counts material.
        </div>
      </section>

      <section class="panel box">
        <h3>判定 Mistake grading</h3>
        <div class="muted small">Win-rate loss thresholds in percentage points, the same defaults as ShogiHome (sigmoid 600).</div>
        <div class="row">
          <label class="field" v-for="(l, i) in ['緩手', '疑問手', '悪手', '大悪手']" :key="l">
            {{ l }} ≥
            <input v-model.number="s.grading.thresholds[i]" type="number" min="0" max="100" step="1" style="width: 80px" />
          </label>
        </div>
        <label class="field">
          Sigmoid coefficient
          <input v-model.number="s.grading.coefficientInSigmoid" type="number" min="100" step="50" style="width: 120px" />
        </label>
      </section>

      <section class="panel box">
        <h3>カード Cards</h3>
        <label class="field">
          Make cards from my
          <select v-model.number="s.cardMinLevel">
            <option :value="2">疑問手 and worse</option>
            <option :value="3">悪手 and worse</option>
            <option :value="4">大悪手 only</option>
          </select>
        </label>
        <label class="field">
          A different move counts as correct within (win-rate points of the best)
          <input v-model.number="s.cardOkLoss" type="number" min="0" max="30" step="0.5" style="width: 100px" />
        </label>
        <label class="field">
          Scheduler
          <select v-model="s.scheduler">
            <option value="sm2">SM-2 (classic Anki)</option>
            <option value="fsrs">FSRS v4.5 (fewer reviews for the same recall)</option>
          </select>
        </label>
        <label v-if="s.scheduler === 'fsrs'" class="field">
          Target recall ({{ Math.round(s.desiredRetention * 100) }}%)
          <input v-model.number="s.desiredRetention" type="range" min="0.75" max="0.97" step="0.01" />
        </label>
      </section>

      <section class="panel box">
        <h3>保存 Backup</h3>
        <div class="muted small">Everything (games, analysis, cards, notes, settings) lives in one SQLite file. Download a copy now and then.</div>
        <div class="row"><a class="btn" href="/api/backup" download>Download library backup</a></div>
      </section>

      <div class="save-row">
        <button type="submit" class="btn primary">Save settings</button>
        <span class="muted small">Saving re-grades analysed games, so labels and cards follow the new settings.</span>
      </div>
    </form>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api, Settings, toast } from "../api";

const s = ref<Settings | null>(null);
const names = ref("");
const options = ref("");
const testing = ref(false);
const testResult = ref<{ ok: boolean; name?: string; bestmove?: string; error?: string } | null>(null);

onMounted(async () => {
  s.value = await api.get<Settings>("/api/settings");
  names.value = s.value.myNames.join("\n");
  folders.value = (s.value.watchFolders ?? []).join("\n");
  options.value = Object.entries(s.value.engine.options)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
});

function parseOptions(): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const line of options.value.split("\n")) {
    const m = /^\s*([^=]+?)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = /^-?\d+$/.test(m[2]) ? Number(m[2]) : m[2];
  }
  return out;
}

async function save() {
  if (!s.value) return;
  s.value.myNames = names.value.split("\n").map((x) => x.trim()).filter(Boolean);
  s.value.engine.options = parseOptions();
  s.value.watchFolders = folders.value.split("\n").map((x) => x.trim()).filter(Boolean);
  s.value = await api.put<Settings>("/api/settings", s.value);
  toast("Settings saved");
}
const folders = ref("");
const scanning = ref(false);
const scanResult = ref("");
async function scan() {
  scanning.value = true;
  scanResult.value = "";
  try {
    await save();
    const r = await api.post<{ scanned: number; added: number[]; duplicates: number; errors: unknown[]; missing: string[] }>("/api/watch/scan", {});
    scanResult.value =
      `${r.added.length} new, ${r.duplicates} already here` +
      (r.errors.length ? `, ${r.errors.length} unreadable` : "") +
      (r.missing.length ? `. Not found: ${r.missing.join(", ")}` : "");
  } catch (e) {
    scanResult.value = String(e);
  } finally {
    scanning.value = false;
  }
}

const syncing = ref(false);
const syncResult = ref("");
async function sync() {
  syncing.value = true;
  syncResult.value = "";
  try {
    await save();
    const r = await api.post<{ fetched: number; added: number[]; duplicates: number; skipped: number; errors: string[] }>("/api/sync/lishogi", {});
    syncResult.value = `${r.added.length} new, ${r.duplicates} already here` + (r.errors.length ? `, ${r.errors.length} failed` : "");
  } catch (e) {
    syncResult.value = String(e);
  } finally {
    syncing.value = false;
  }
}
async function test() {
  testing.value = true;
  testResult.value = null;
  try {
    testResult.value = await api.post("/api/engine/test", { path: s.value!.engine.path });
  } finally {
    testing.value = false;
  }
}
</script>

<style scoped>
.cols {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
  gap: 16px;
}
@media (max-width: 500px) {
  .cols {
    grid-template-columns: 1fr;
  }
}
.box {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.row {
  display: flex;
  gap: 12px;
  align-items: flex-end;
  flex-wrap: wrap;
}
.small {
  font-size: 12px;
}
.check {
  display: flex;
  gap: 8px;
  align-items: center;
}
.save-row {
  grid-column: 1 / -1;
  display: flex;
  gap: 12px;
  align-items: center;
}
</style>
