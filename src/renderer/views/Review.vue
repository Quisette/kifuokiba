<template>
  <div class="page">
    <div class="head">
      <h1>復習カード Mistake review</h1>
      <a class="btn small" href="#/puzzles">詰将棋 Mates from my games</a>
      <span v-if="queue.length" class="serif progress-label">{{ index + 1 }} / {{ queue.length }}</span>
      <div class="progress" v-if="queue.length"><span :style="{ width: (index / queue.length) * 100 + '%' }"></span></div>
      <label class="field">
        Deck
        <select v-model="deck" @change="load">
          <option value="">All cards</option>
          <option value="phase:opening">序盤 only</option>
          <option value="phase:middlegame">中盤 only</option>
          <option value="phase:endgame">終盤 only</option>
          <option value="kind:missed_mate">Missed mates</option>
          <option value="kind:manual">My own cards</option>
          <option value="kind:guess">From guess the move</option>
          <option value="leech:1">Leeches (missed 4+ times)</option>
          <optgroup v-if="decks.length" label="My decks">
            <option v-for="d in decks" :key="d.id" :value="`deck:${d.id}`">{{ d.name }} ({{ d.due }} due)</option>
          </optgroup>
          <option value="custom">Custom…</option>
        </select>
      </label>
      <button v-if="savedDeck" type="button" class="btn small" :title="`Delete the deck ${savedDeck.name} (its cards stay)`" @click="deleteDeck">Delete deck</button>
      <label class="field">
        Mode
        <select v-model="cram" @change="load">
          <option :value="false">Due today</option>
          <option :value="true">Practise all</option>
        </select>
      </label>
      <a class="btn small" :href="`/api/cards/export/anki${deckQuery()}`" download="kifu-study-cards.txt" title="Tab-separated file for Anki's File → Import (the chosen deck)">Export to Anki</a>
    </div>

    <form v-if="deck === 'custom'" class="builder panel" @submit.prevent="saveDeck">
      <label v-for="f in FACETS" :key="f.key" class="field">
        {{ f.label }}
        <select v-model="custom[f.key]" @change="load">
          <option value="">Any</option>
          <option v-for="o in facets?.[f.key] ?? []" :key="o.value" :value="o.value">{{ f.name(o.value) }} ({{ o.due }}/{{ o.total }})</option>
        </select>
      </label>
      <label class="field">
        Phase
        <select v-model="custom.phase" @change="load">
          <option value="">Any</option>
          <option value="opening">序盤</option>
          <option value="middlegame">中盤</option>
          <option value="endgame">終盤</option>
        </select>
      </label>
      <label class="field">
        Deck name
        <input v-model="deckName" placeholder="e.g. 四間飛車 drops" />
      </label>
      <button type="submit" class="btn" :disabled="!deckName.trim() || !Object.values(custom).some(Boolean)">Save as deck</button>
      <span class="muted small">Counts are due / total.</span>
    </form>

    <div v-if="loading" class="empty">Loading…</div>
    <div v-else-if="!card" class="empty">
      <div class="serif" style="font-size: 20px; margin-bottom: 6px">{{ total ? "今日の復習は完了 · All done for now" : "No cards yet" }}</div>
      <div v-if="!total">Cards are made automatically from your 悪手 and 大悪手 once games are analysed, or with “Make card” on any position.</div>
      <div v-if="session.reviewed" class="session">
        This session: {{ session.reviewed }} card{{ session.reviewed === 1 ? "" : "s" }}, {{ session.right }} right first time
        ({{ Math.round((session.right / session.reviewed) * 100) }}%) in {{ sessionMinutes }}.
        <template v-if="session.missedPhases.length"> Most misses in {{ session.missedPhases[0] }}.</template>
      </div>
      <div v-else-if="savedDeck">{{ savedDeck.total }} card{{ savedDeck.total === 1 ? "" : "s" }} in this deck.</div>
      <div v-else-if="total">{{ total }} card{{ total === 1 ? "" : "s" }} in all. Next one is due {{ nextDue }}.</div>
      <div v-if="session.reviewed" class="row" style="justify-content: center; margin-top: 10px">
        <a class="btn small" href="#/puzzles">Mates from my games</a>
        <a class="btn small" href="#/repertoire">Opening drill</a>
      </div>
      <button v-if="total" type="button" class="btn" style="margin-top: 12px" @click="cram = true; load()">Practise all anyway</button>
    </div>

    <div v-else class="layout">
      <section class="board-col">
        <div class="prompt serif">{{ card.side === "black" ? "☗" : "☖" }}番 · Find a better move</div>
        <div class="muted ctx">
          From {{ card.black }} vs {{ card.white }} {{ card.date ? "· " + card.date.slice(0, 10) : "" }} · before move {{ card.ply }} ·
          <a :href="`#/game/${card.game_id}?ply=${card.ply - 1}`">open game here</a>
          <span v-if="card.kind === 'missed_mate'" class="mark l4" style="margin-left: 6px">詰みあり</span>
          <span v-if="card.kind === 'guess'" class="mark l1" style="margin-left: 6px" title="Made from a guess in guess-the-move mode">次の一手</span>
          <span v-if="card.leech" class="mark l3" style="margin-left: 6px" :title="`Missed ${card.lapses} times`">leech</span>
        </div>
        <ShogiBoard
          :sfen="shownSfen"
          :last-move="shownLast"
          :arrows="answer ? arrows : []"
          :flip="card.side === 'white'"
          :allow-move="!answer && !checking"
          :black-name="card.black || '先手'"
          :white-name="card.white || '後手'"
          :max-height="600"
          @move="onMove"
        />
        <div class="row" style="margin-top: 10px">
          <span class="muted">{{ checking ? "Checking your move…" : answer ? "" : "Play your answer on the board." }}</span>
          <span style="margin-left: auto; display: flex; gap: 8px">
            <button type="button" class="btn" :disabled="!!answer" @click="hint = true">Hint</button>
            <button type="button" class="btn" :disabled="!!answer" @click="reveal">Show answer</button>
          </span>
        </div>
        <div v-if="hint && !answer" class="panel hint">Hint: move your {{ hintText }}.</div>
        <div v-if="card.note" class="panel hint">📝 {{ card.note }}</div>
      </section>

      <section class="side-col">
        <div v-if="answer" class="panel box">
          <div class="verdict serif" :class="answer.correct ? 'ok' : 'ng'">
            {{ answer.correct ? "Good ✓" : answer.revealed ? "Answer" : "Not quite ✗" }}
          </div>
          <div v-if="answer.checkedByEngine && answer.loss != null" class="muted" style="font-size: 13px">
            Your move loses {{ answer.loss.toFixed(1) }} pts of win rate against the best (≤ {{ okLoss }} counts as correct).
          </div>
          <div class="cmp">
            <template v-if="answer.answerText">
              <span class="cap">You</span><span class="serif">{{ answer.answerText }}</span>
            </template>
            <span class="cap">Best</span><span class="serif">{{ card.bestText }}</span>
            <span class="cap">In game</span>
            <span class="serif">
              {{ card.playedText }} <span v-if="card.level >= 1" class="mark" :class="'l' + card.level">{{ ["", "緩手", "疑問手", "悪手", "大悪手"][card.level] }}</span>
              <span class="muted" style="font-family: var(--sans); font-size: 12px"> −{{ card.loss.toFixed(1) }} pts</span>
            </span>
          </div>
          <div v-if="card.pvText" class="muted pv">読み筋 {{ card.pvText }}</div>
          <div class="row">
            <button type="button" class="btn small" @click="replay">{{ replaying ? "Stop" : "Replay line" }}</button>
            <button type="button" class="btn small" @click="notebookOpen = true">Add to notebook</button>
            <a class="btn small" :href="`#/practice?sfen=${encodeURIComponent(card.sfen)}&back=review`" title="Play this position out against the engine">Play it out</a>
            <button type="button" class="btn small" @click="suspend">Suspend card</button>
          </div>
        </div>
        <div v-if="answer && card.leech" class="panel box leech">
          <div class="cap">Missed {{ card.lapses }} times</div>
          <div style="font-size: 13px">Drilling alone isn't sticking. Write down the idea you keep missing (it shows on the card next time), study the game around it, or suspend the card.</div>
          <textarea v-model="noteDraft" rows="2" placeholder="e.g. 角の利きが通っている時は先に受ける" @blur="saveNote"></textarea>
          <div class="row">
            <a class="btn small" :href="`#/game/${card.game_id}?ply=${card.ply - 1}`">Study the game</a>
            <button type="button" class="btn small" @click="saveNote">Save note</button>
          </div>
        </div>
        <div v-if="answer" class="grades">
          <div class="cap" style="grid-column: 1 / -1">How well did you know it?</div>
          <button
            v-for="r in ratings"
            :key="r"
            type="button"
            class="grade"
            :class="{ on: answer.suggested === r }"
            @click="rate(r)"
          >
            {{ r[0].toUpperCase() + r.slice(1) }}
            <small>{{ preview(r) }}</small>
          </button>
        </div>
        <div class="panel box stats">
          <span><span class="cap">Due</span><br /><b class="serif">{{ counts?.due ?? 0 }}</b></span>
          <span><span class="cap">Cards</span><br /><b class="serif">{{ counts?.total ?? 0 }}</b></span>
          <span><span class="cap">Today</span><br /><b class="serif">{{ counts?.reviewedToday ?? 0 }}</b></span>
          <span title="Cards failed 4+ times"><span class="cap">Leeches</span><br /><b class="serif">{{ counts?.leeches ?? 0 }}</b></span>
        </div>
      </section>
    </div>

    <AddToNotebook
      v-if="notebookOpen && card"
      :snippet="`:::shogi-view{game=${card.game_id} ply=${card.ply - 1}}\n:::\n\nBest: ${card.bestText} · In game: ${card.playedText} (${card.pvText})`"
      :default-title="`Card: ${card.bestText}`"
      @close="notebookOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { Position } from "tsshogi";
import { api, Card, qs, Settings, toast } from "../api";
import { route } from "../router";
import { Rating } from "../../core/sm2";
import { scheduleCard, SchedulerName } from "../../core/scheduler";
import ShogiBoard from "../components/ShogiBoard.vue";
import AddToNotebook from "../components/AddToNotebook.vue";

type Answer = {
  correct: boolean;
  loss: number | null;
  suggested: Rating;
  checkedByEngine: boolean;
  answerText?: string;
  revealed?: boolean;
  usi?: string;
};

const ratings: Rating[] = ["again", "hard", "good", "easy"];
const queue = ref<Card[]>([]);
const index = ref(0);
const loading = ref(true);
// The Today page links to a saved deck with ?deck=<id>.
// ?opponent=<name> (from a prep sheet) opens the deck builder with that opponent picked.
const deck = ref(route.query.get("deck") ? `deck:${route.query.get("deck")}` : route.query.get("opponent") ? "custom" : "");
// A prep sheet link practises all of that opponent's cards, not just the due ones.
const cram = ref(!!route.query.get("opponent"));
const answer = ref<Answer | null>(null);
const checking = ref(false);
const hint = ref(false);
const notebookOpen = ref(false);
const counts = ref<{ due: number; total: number; reviewedToday: number; leeches: number; nextDueAt: number | null } | null>(null);
const okLoss = ref(3);
const sched = ref<{ scheduler: SchedulerName; desiredRetention: number }>({ scheduler: "sm2", desiredRetention: 0.9 });
const userMove = ref<string | null>(null);
const replayLine = ref<string[]>([]);
const replaying = ref(false);
const total = computed(() => counts.value?.total ?? 0);
const card = computed(() => queue.value[index.value] ?? null);

// ---- decks: built-in ("phase:opening"), saved ("deck:3") or custom
type Facet = { value: string; total: number; due: number };
type FacetKey = "myOpening" | "opponent" | "tag" | "moveKind" | "side";
type SavedDeck = { id: number; name: string; due: number; total: number };
const KIND_NAMES: Record<string, string> = { drop: "打 Drops", capture: "取る Captures", check: "王手 Checks", promotion: "成 Promotions", king: "玉 King moves", quiet: "他 Quiet moves" };
const FACETS: { key: FacetKey; label: string; name: (v: string) => string }[] = [
  { key: "myOpening", label: "My opening", name: (v) => v },
  { key: "opponent", label: "Opponent", name: (v) => v },
  { key: "tag", label: "Tag", name: (v) => "#" + v },
  { key: "moveKind", label: "Kind of move", name: (v) => KIND_NAMES[v] ?? v },
  { key: "side", label: "Side", name: (v) => (v === "black" ? "☗ 先手" : "☖ 後手") },
];
const decks = ref<SavedDeck[]>([]);
const facets = ref<Record<FacetKey, Facet[]> | null>(null);
const custom = reactive<Record<FacetKey | "phase", string>>({ myOpening: "", opponent: route.query.get("opponent") ?? "", tag: "", moveKind: "", side: "", phase: "" });
const deckName = ref("");
const savedDeck = computed(() => (deck.value.startsWith("deck:") ? decks.value.find((d) => `deck:${d.id}` === deck.value) : undefined));
function deckQuery(extra: Record<string, unknown> = {}) {
  if (deck.value === "custom") return qs({ ...custom, ...extra });
  const [k, v] = deck.value.split(":");
  return qs({ ...(k ? { [k]: v } : {}), ...extra });
}
async function saveDeck() {
  const d = await api.post<{ id: number; name: string }>("/api/decks", { name: deckName.value, filter: { ...custom } });
  decks.value = await api.get<SavedDeck[]>("/api/decks");
  deck.value = `deck:${d.id}`;
  deckName.value = "";
  toast(`Saved the deck ${d.name}.`);
  await load();
}
async function deleteDeck() {
  if (!savedDeck.value || !confirm(`Delete the deck ${savedDeck.value.name}? Its cards stay.`)) return;
  await api.del(`/api/decks/${savedDeck.value.id}`);
  deck.value = "";
  await load();
}

async function load() {
  loading.value = true;
  [decks.value, facets.value] = await Promise.all([api.get<SavedDeck[]>("/api/decks"), deck.value === "custom" ? api.get<Record<FacetKey, Facet[]>>("/api/cards/facets") : facets.value]);
  queue.value = await api.get<Card[]>("/api/cards" + deckQuery({ due: cram.value ? "" : "1" }));
  queue.value = queue.value.filter((c) => !c.suspended);
  if (cram.value) queue.value.sort(() => Math.random() - 0.5);
  index.value = 0;
  resetCard();
  counts.value = await api.get("/api/cards/counts");
  const st = await api.get<Settings>("/api/settings");
  okLoss.value = st.cardOkLoss;
  sched.value = { scheduler: st.scheduler, desiredRetention: st.desiredRetention };
  loading.value = false;
}
onMounted(load);

function resetCard() {
  answer.value = null;
  hint.value = false;
  userMove.value = null;
  replayLine.value = [];
  stopReplay();
}

const shownPositions = computed(() => {
  if (!card.value) return [];
  const pos = Position.newBySFEN(card.value.sfen)!;
  const out: { sfen: string; prev: string; usi: string }[] = [];
  const line = replayLine.value.length ? replayLine.value : userMove.value ? [userMove.value] : [];
  for (const u of line) {
    const prev = pos.sfen;
    const m = pos.createMoveByUSI(u);
    if (!m || !pos.doMove(m)) break;
    out.push({ sfen: pos.sfen, prev, usi: u });
  }
  return out;
});
const shownSfen = computed(() => shownPositions.value.at(-1)?.sfen ?? card.value?.sfen ?? "");
const shownLast = computed(() => {
  const l = shownPositions.value.at(-1);
  return l ? { prevSfen: l.prev, usi: l.usi } : null;
});
const arrows = computed(() => (shownPositions.value.length ? [] : card.value ? [{ usi: card.value.best_usi }] : []));

const pieceNames: Record<string, string> = {
  pawn: "歩 pawn", lance: "香 lance", knight: "桂 knight", silver: "銀 silver", gold: "金 gold", bishop: "角 bishop",
  rook: "飛 rook", king: "玉 king", promPawn: "と", promLance: "成香", promKnight: "成桂", promSilver: "成銀", horse: "馬 horse", dragon: "龍 dragon",
};
const hintText = computed(() => {
  if (!card.value) return "";
  const m = Position.newBySFEN(card.value.sfen)?.createMoveByUSI(card.value.best_usi);
  if (!m) return "?";
  const name = pieceNames[m.pieceType] ?? m.pieceType;
  return typeof m.from === "string" ? `${name} from your hand (drop)` : name;
});

async function onMove(usi: string) {
  if (!card.value) return;
  userMove.value = usi;
  checking.value = true;
  try {
    const r = await api.post<Answer & { legal: boolean }>(`/api/cards/${card.value.id}/answer`, { usi });
    if (!r.legal) {
      userMove.value = null;
      toast("That move is not legal here");
      return;
    }
    answer.value = { ...r, usi };
  } catch (e) {
    toast(String(e));
    userMove.value = null;
  } finally {
    checking.value = false;
  }
}
function reveal() {
  answer.value = { correct: false, loss: null, suggested: "again", checkedByEngine: false, revealed: true };
}

function preview(r: Rating) {
  if (!card.value) return "";
  const c = card.value;
  const now = Date.now();
  const n = scheduleCard(
    {
      repetitions: c.repetitions,
      intervalDays: c.interval_days,
      ease: c.ease,
      dueAt: c.due_at,
      lapses: c.lapses,
      stability: c.stability,
      difficulty: c.difficulty,
      lastReviewAt: c.last_review_at,
    },
    r,
    now,
    sched.value,
  );
  const mins = (n.dueAt - now) / 60000;
  return mins < 60 ? `${Math.round(mins)}分` : `${n.intervalDays}日`;
}

const noteDraft = ref("");
watch(card, (c) => (noteDraft.value = c?.note ?? ""), { immediate: true });
async function saveNote() {
  const c = card.value;
  if (!c || noteDraft.value === c.note) return;
  await api.patch(`/api/cards/${c.id}`, { note: noteDraft.value });
  c.note = noteDraft.value;
  toast("Note saved to the card");
}

// Tally for the end-of-session summary; a card counts once, on its first rating.
const session = reactive({ reviewed: 0, right: 0, startedAt: Date.now(), seen: new Set<number>(), misses: {} as Record<string, number>, missedPhases: [] as string[] });
const PHASE_JA: Record<string, string> = { opening: "序盤", middlegame: "中盤", endgame: "終盤" };
const sessionMinutes = computed(() => {
  const m = Math.max(1, Math.round((Date.now() - session.startedAt) / 60000));
  return `${m} min`;
});
async function rate(r: Rating) {
  if (!card.value) return;
  if (!session.seen.has(card.value.id)) {
    session.seen.add(card.value.id);
    session.reviewed++;
    if (answer.value?.correct) session.right++;
    else {
      const ph = PHASE_JA[card.value.phase] ?? card.value.phase;
      session.misses[ph] = (session.misses[ph] ?? 0) + 1;
      session.missedPhases = Object.entries(session.misses).sort((a, b) => b[1] - a[1]).map(([k]) => k);
    }
  }
  const res = await api.post<{ becameLeech: boolean; lapses: number }>(`/api/cards/${card.value.id}/rate`, {
    rating: r,
    usi: answer.value?.usi ?? "",
    loss: answer.value?.loss ?? null,
  });
  if (res.becameLeech) toast(`Missed ${res.lapses} times, so this card is now a leech. Next time, write down the idea or study the game.`, 6000);
  card.value.lapses = res.lapses;
  card.value.leech = card.value.leech || res.becameLeech;
  counts.value = await api.get("/api/cards/counts");
  // "Again" comes back at the end of this session.
  if (r === "again" && !cram.value) queue.value.push({ ...card.value, repetitions: 0 });
  index.value++;
  resetCard();
}
async function suspend() {
  if (!card.value) return;
  await api.patch(`/api/cards/${card.value.id}`, { suspended: true });
  toast("Card suspended");
  index.value++;
  resetCard();
}

let timer: ReturnType<typeof setInterval> | undefined;
function stopReplay() {
  clearInterval(timer);
  replaying.value = false;
}
function replay() {
  if (replaying.value) {
    stopReplay();
    replayLine.value = [];
    return;
  }
  const pv = (card.value?.pv || card.value?.best_usi || "").split(" ").filter(Boolean);
  replayLine.value = [];
  replaying.value = true;
  let i = 0;
  timer = setInterval(() => {
    if (i >= pv.length) return stopReplay();
    replayLine.value = pv.slice(0, ++i);
  }, 900);
}
onUnmounted(stopReplay);

function onKey(e: KeyboardEvent) {
  if (!answer.value) return;
  const k = { "1": "again", "2": "hard", "3": "good", "4": "easy" }[e.key] as Rating | undefined;
  if (k) void rate(k);
  else if (e.key === " " || e.key === "Enter") void rate(answer.value.suggested);
}
onMounted(() => window.addEventListener("keydown", onKey));
onUnmounted(() => window.removeEventListener("keydown", onKey));

const nextDue = computed(() => {
  const at = counts.value?.nextDueAt;
  if (at == null) return "when you make more cards";
  const mins = Math.max(1, Math.round((at - Date.now()) / 60000));
  if (mins < 60) return `in ${mins} min`;
  if (mins < 48 * 60) return `in ${Math.round(mins / 60)} h`;
  return `on ${new Date(at).toLocaleDateString()}`;
});
</script>

<style scoped>
.head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px 18px;
  margin-bottom: 16px;
}
.builder {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px 14px;
  padding: 12px 14px;
  margin-bottom: 16px;
}
.builder .small {
  font-size: 12px;
}
.leech {
  border-color: var(--loss);
}
.progress-label {
  font-size: 22px;
}
.progress {
  flex: 1 1 200px;
  height: 8px;
  background: var(--line);
  border-radius: 4px;
  margin-bottom: 8px;
  display: flex;
}
.progress span {
  background: var(--gold);
  border-radius: 4px;
}
.layout {
  display: flex;
  flex-wrap: wrap;
  gap: 24px;
  align-items: flex-start;
}
.board-col {
  flex: 3 1 480px;
  min-width: 0;
  max-width: 900px;
}
.prompt {
  font-size: 22px;
}
.ctx {
  font-size: 13px;
  margin: 4px 0 10px;
}
.row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.hint {
  margin-top: 10px;
  padding: 10px 12px;
}
.side-col {
  flex: 2 1 320px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.box {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.session {
  max-width: 520px;
  margin: 0 auto;
  line-height: 1.6;
}
.verdict {
  font-size: 22px;
}
.verdict.ok {
  color: var(--good);
}
.verdict.ng {
  color: var(--loss);
}
.cmp {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 12px;
  align-items: baseline;
  font-size: 15px;
}
.pv {
  font-size: 13px;
  line-height: 1.6;
}
.grades {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}
.grade {
  font: inherit;
  min-height: 60px;
  border: 1px solid var(--line-2);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
}
.grade.on {
  border-color: var(--gold);
  color: var(--gold-soft);
}
.grade small {
  font-size: 12px;
  font-weight: 400;
  color: var(--muted);
}
.stats {
  flex-direction: row;
  flex-wrap: wrap;
  gap: 22px;
  font-size: 13px;
}
.stats b {
  font-size: 20px;
}
</style>
