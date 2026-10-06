<template>
  <div class="page">
    <div class="head">
      <h1>対局を記録 Record a game</h1>
      <span class="muted">Play both sides' moves on the board, then save it to the library.</span>
    </div>
    <div class="layout">
      <div>
        <ShogiBoard
          :sfen="current.sfen"
          :last-move="lastMove"
          allow-move
          :flip="flip"
          :black-name="meta.black || '先手'"
          :white-name="meta.white || '後手'"
          :max-height="640"
          @move="play"
        />
        <div class="row" style="margin-top: 10px">
          <button type="button" class="btn" :disabled="!moves.length" @click="undo">↶ Undo</button>
          <button type="button" class="btn" @click="flip = !flip">Flip 反転</button>
          <span class="muted small">{{ moves.length }}手 · {{ sideToMove }}番</span>
        </div>
      </div>

      <div class="side">
        <section class="panel box">
          <div class="grid2">
            <label class="field">☗ 先手 <input v-model="meta.black" placeholder="name" /></label>
            <label class="field">☖ 後手 <input v-model="meta.white" placeholder="name" /></label>
            <label class="field">Date <input v-model="meta.date" type="date" /></label>
            <label class="field">Event <input v-model="meta.event" placeholder="e.g. 支部対抗戦" /></label>
          </div>
          <label class="field">
            Result
            <select v-model="meta.end">
              <option value="resign">{{ sideToMove }} resigned (投了)</option>
              <option value="timeout">{{ sideToMove }} lost on time (切れ負け)</option>
              <option value="repetitionDraw">千日手 (draw)</option>
              <option value="enteringOfKing">{{ sideToMove }} declared 入玉 win</option>
              <option value="interrupt">Unfinished (中断)</option>
            </select>
          </label>
          <label class="field">Notes <textarea v-model="meta.notes" rows="2" placeholder="Anything to remember about this game"></textarea></label>
          <div class="row">
            <button type="button" class="btn primary" :disabled="!moves.length || saving" @click="save">Save to library</button>
            <button type="button" class="btn danger" :disabled="!moves.length" @click="reset">Clear</button>
          </div>
        </section>

        <section class="panel box moves">
          <div class="cap">棋譜 Moves</div>
          <ol v-if="moves.length">
            <li v-for="(m, i) in texts" :key="i"><span class="muted">{{ i + 1 }}</span> {{ m }}</li>
          </ol>
          <div v-else class="muted small">Drag or click pieces to make the first move.</div>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// Over-the-board games: play the moves in, then save as KIF through the normal import.
import { computed, reactive, ref, watch } from "vue";
import { Color, InitialPositionSFEN, Position, Record, RecordMetadataKey, SpecialMoveType, exportKIF, formatMove } from "tsshogi";
import { api, live, toast } from "../api";
import { go } from "../router";
import ShogiBoard from "../components/ShogiBoard.vue";

const DRAFT_KEY = "kifu-study.record-draft";
type Draft = { moves: string[]; meta: typeof meta };

// Local date, not UTC: a game played in Japan before 9am is still today's.
const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
const meta = reactive({ black: "", white: "", date: today, event: "", end: "resign", notes: "" });
const moves = ref<string[]>([]);
const flip = ref(false);
const saving = ref(false);

// An unsaved game survives a reload or an accidental tab switch.
try {
  const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null") as Draft | null;
  if (d) {
    moves.value = d.moves;
    Object.assign(meta, d.meta);
  }
} catch {
  /* storage unavailable */
}
watch(
  [moves, meta],
  () => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ moves: moves.value, meta }));
    } catch {
      /* storage unavailable */
    }
  },
  { deep: true },
);

const line = computed(() => {
  const pos = Position.newBySFEN(InitialPositionSFEN.STANDARD)!;
  const steps: { sfen: string; prevSfen: string; usi: string; text: string }[] = [];
  for (const usi of moves.value) {
    const m = pos.createMoveByUSI(usi);
    if (!m || !pos.isValidMove(m)) break;
    const prevSfen = pos.sfen;
    const text = formatMove(pos, m);
    pos.doMove(m);
    steps.push({ sfen: pos.sfen, prevSfen, usi, text });
  }
  return { pos, steps };
});
const current = computed(() => ({ sfen: line.value.pos.sfen }));
const lastMove = computed(() => {
  const s = line.value.steps.at(-1);
  return s ? { prevSfen: s.prevSfen, usi: s.usi } : null;
});
const texts = computed(() => line.value.steps.map((s) => s.text));
const sideToMove = computed(() => (line.value.pos.color === Color.BLACK ? "☗" : "☖"));

function play(usi: string) {
  moves.value = [...moves.value, usi];
}
function undo() {
  moves.value = moves.value.slice(0, -1);
}
function reset() {
  if (!confirm("Clear this game?")) return;
  moves.value = [];
  Object.assign(meta, { black: "", white: "", date: today, event: "", end: "resign", notes: "" });
}

async function save() {
  const rec = Record.newByUSI("position startpos moves " + moves.value.join(" "));
  if (rec instanceof Error) return toast(rec.message);
  const m = rec.metadata;
  if (meta.black) m.setStandardMetadata(RecordMetadataKey.BLACK_NAME, meta.black);
  if (meta.white) m.setStandardMetadata(RecordMetadataKey.WHITE_NAME, meta.white);
  if (meta.date) m.setStandardMetadata(RecordMetadataKey.START_DATETIME, meta.date.replaceAll("-", "/"));
  m.setStandardMetadata(RecordMetadataKey.TOURNAMENT, meta.event || "対面対局");
  rec.goto(Number.MAX_SAFE_INTEGER);
  rec.append(meta.end as SpecialMoveType);
  saving.value = true;
  try {
    const r = await api.post<{ results: { status: string; id?: number; error?: string }[] }>("/api/import", { text: exportKIF(rec) });
    const res = r.results[0];
    if (res.status === "error") return toast(res.error ?? "Could not save");
    if (meta.notes && res.id) await api.patch(`/api/games/${res.id}`, { notes: meta.notes });
    live.libraryVersion++;
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {
      /* storage unavailable */
    }
    moves.value = [];
    toast(res.status === "duplicate" ? "That game is already in the library" : "Game saved");
    if (res.id) go(`game/${res.id}`);
  } finally {
    saving.value = false;
  }
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
.layout {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
  gap: 24px;
  align-items: start;
}
@media (max-width: 1000px) {
  .layout {
    grid-template-columns: minmax(0, 1fr);
  }
}
.side {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.box {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.small {
  font-size: 12px;
}
.moves ol {
  margin: 0;
  padding: 0;
  list-style: none;
  columns: 3 120px;
  font-family: var(--serif);
  font-size: 15px;
}
.moves li {
  padding: 2px 0;
}
</style>
