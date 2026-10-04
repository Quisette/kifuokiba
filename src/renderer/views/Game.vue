<template>
  <div v-if="!game" class="page"><div class="empty">{{ error || "Loading…" }}</div></div>
  <div v-else class="page game">
    <div class="title-row">
      <div style="min-width: 0">
        <h1>
          <span :class="{ me: game.mySide === 'black' }">☗{{ game.black || "先手" }}</span>
          <span class="muted" style="font-weight: 600"> 対 </span>
          <span :class="{ me: game.mySide === 'white' }">☖{{ game.white || "後手" }}</span>
        </h1>
        <div class="muted meta">
          {{ [game.date, game.event, game.time_control, game.strategy || "—", `${game.move_count}手`].filter(Boolean).join(" · ") }}
          {{ resultText }}
        </div>
      </div>
      <div class="tags">
        <span v-for="t in game.tags" :key="t" class="tag">
          #{{ t }}
          <button type="button" class="x" :aria-label="`Remove tag ${t}`" @click="removeTag(t)">×</button>
        </span>
        <form @submit.prevent="addTag">
          <label class="sr-only" for="newtag">New tag</label>
          <input id="newtag" v-model="newTag" placeholder="＋ tag" class="tag-input" />
        </form>
      </div>
      <div class="actions">
        <button type="button" class="btn" @click="notebookOpen = true">Add to notebook</button>
        <button type="button" class="btn" :disabled="cursor === 0 || variation.length > 0" @click="makeCard">Make card</button>
        <button type="button" class="btn" @click="flip = !flip">Flip 反転</button>
        <a class="btn" :href="`#/practice?sfen=${encodeURIComponent(cur.sfen)}&back=game/${id}`" title="Play this position out against the engine">Play it out</a>
        <a class="btn" :href="`#/guess?game=${id}&ply=${cursor}`" title="Replay the game from here and guess each move">Guess the moves</a>
        <button type="button" class="btn" @click="analyse">{{ game.analysis_status === "done" ? "Re-analyse" : "Analyse" }}</button>
        <button type="button" class="btn" @click="writeReview">Write review note</button>
        <details class="menu">
          <summary class="btn">Export ▾</summary>
          <div class="menu-list panel" @click="closeMenu">
            <a :href="`/api/games/${id}/export?format=kif`" download>KIF (with evals)</a>
            <a :href="`/api/games/${id}/export?format=csa`" download>CSA</a>
            <a :href="`/api/games/${id}/note?portable=1&download=1`" download title="Markdown with :::shogi-view boards for personal-shogi-note">Review note (.mdx)</a>
            <a :href="diagramHref" download>Diagram of this position (.svg)</a>
          </div>
        </details>
      </div>
    </div>

    <div class="layout">
      <section class="board-col">
        <div class="board-wrap">
          <div class="evalbar" role="img" :aria-label="`Evaluation bar: sente ${barPct.toFixed(0)}%`" :title="`☗ ${barPct.toFixed(0)}%`">
            <span class="w" :style="{ flex: flip ? barPct : 100 - barPct }"></span>
            <span class="b" :style="{ flex: flip ? 100 - barPct : barPct }"></span>
          </div>
          <div style="flex: 1; min-width: 0">
            <ShogiBoard
              :sfen="shownSfen"
              :last-move="shownLastMove"
              :arrows="arrows"
              :flip="flip"
              :allow-move="true"
              :black-name="game.black || '先手'"
              :white-name="game.white || '後手'"
              :max-height="560"
              @move="onBoardMove"
            />
          </div>
        </div>
        <div class="nav">
          <button type="button" class="btn" aria-label="First move" @click="jump(0)">|◀</button>
          <button type="button" class="btn" aria-label="Previous move" @click="step(-1)">◀</button>
          <button type="button" class="btn" aria-label="Next move" @click="step(1)">▶</button>
          <button type="button" class="btn" aria-label="Last move" @click="jump(game.plies.length - 1)">▶|</button>
          <button type="button" class="btn" :disabled="!prevMistake" title="Previous mistake ([)" @click="prevMistake && jump(prevMistake)">◀ 悪手</button>
          <button type="button" class="btn" :disabled="!nextMistake" title="Next mistake (])" @click="nextMistake && jump(nextMistake)">悪手 ▶</button>
          <span class="here serif">
            <template v-if="variation.length">変化 {{ variationText }}</template>
            <template v-else>{{ cursor }}手目 {{ cur.text }}</template>
          </span>
        </div>
        <div v-if="variation.length" class="var panel">
          <div v-if="activeBranch" class="branch-note">
            <b>変化 from the file</b>: {{ activeBranch.texts.join(" ") }}
            <div v-if="activeBranch.comment" class="muted">{{ activeBranch.comment }}</div>
          </div>
          <div>
            <b>{{ activeBranch ? "Engine on this line" : "Trying your own line" }}</b> from move {{ cursor }}.
            <span v-if="varEval">Engine: {{ evalText(varEval.score ?? null, varEval.mate ?? null) }} · best {{ varEval.bestText }}</span>
            <span v-else-if="varBusy" class="muted">evaluating…</span>
          </div>
          <div class="row">
            <button type="button" class="btn small" @click="variation.pop(); evalVariation()">Undo</button>
            <button type="button" class="btn small" @click="variation = []">Back to game</button>
          </div>
        </div>
      </section>

      <section class="panel moves-col">
        <div class="cap" style="padding: 12px 14px 6px">棋譜 Moves</div>
        <ol ref="moveList" class="moves" tabindex="0" aria-label="棋譜 Moves">
          <li
            v-for="p in game.plies"
            :key="p.ply"
            :class="{ on: p.ply === cursor }"
            :data-ply="p.ply"
            @click="jump(p.ply)"
          >
            <span class="n">{{ p.ply || "" }}</span>
            <span class="m serif">{{ p.ply === 0 ? "開始局面" : p.text }}</span>
            <span v-if="p.comment.trim() && p.ply" class="cm" title="Has comment">✎</span>
            <span v-if="p.level >= 2" class="mark" :class="'l' + p.level">{{ p.label }}</span>
            <span v-if="bookPlies.has(p.ply)" class="book-mark" title="Opening book move">定</span>
            <button
              v-for="(b, bi) in branchPlies.get(p.ply) ?? []"
              :key="'b' + bi"
              type="button"
              class="branch-mark"
              :title="`Variation in the file: ${b.texts.slice(0, 4).join(' ')}${b.texts.length > 4 ? ' …' : ''}`"
              @click.stop="showBranch(b)"
            >
              変{{ (branchPlies.get(p.ply)?.length ?? 0) > 1 ? bi + 1 : "" }}
            </button>
            <span v-if="p.missed" class="mark l4" :title="p.missed === 'mate' ? 'Missed a forced mate' : 'Threw away a won position'">{{ missedLabel(p.missed) }}</span>
            <span class="ev">{{ p.ply ? evalText(p.score, p.mate) : "" }}</span>
          </li>
        </ol>
        <div class="comment">
          <label class="cap" for="cmt">コメント Comment · move {{ cursor }}</label>
          <textarea id="cmt" v-model="commentDraft" rows="3" placeholder="Your note on this move (saved into the KIF)…" @blur="saveComment"></textarea>
        </div>
      </section>

      <section class="side-col">
        <div class="panel box">
          <div class="cap">検討 Engine {{ game.analysis_engine ? "· " + game.analysis_engine : "" }}</div>
          <template v-if="cur.score !== null || cur.mate !== null">
            <div class="big">
              <span class="serif">{{ moverWin }}%</span>
              <span class="muted" style="font-size: 13px">{{ evalText(cur.score, cur.mate) }} · {{ cur.situation }}</span>
            </div>
            <div v-if="next && (next.level || next.missed)" class="played">
              Next: <b class="serif">{{ next.text }}</b>
              <span v-if="next.level" class="mark" :class="'l' + next.level">{{ next.label }}</span>
              <span v-if="next.missed" class="mark l4">{{ missedLabel(next.missed) }}</span>
              <span class="muted">−{{ next.loss?.toFixed(1) }} pts</span>
            </div>
            <div v-if="cur.pvText" class="pv">最善 {{ cur.pvText }}</div>
          </template>
          <div v-else class="muted" style="margin-top: 6px">No evaluation for this position yet.</div>
          <div v-if="multi.length" class="multipv">
            <div v-for="l in multi" :key="l.multipv" class="mrow">
              <span>{{ l.multipv }}. {{ l.text.split(" ")[0] }}</span>
              <span class="muted">{{ evalText(l.score ?? null, l.mate ?? null) }}</span>
            </div>
          </div>
          <div class="row" style="margin-top: 10px">
            <button type="button" class="btn small" :disabled="multiBusy" @click="candidates">
              {{ multiBusy ? "Thinking…" : "Candidate moves" }}
            </button>
            <button type="button" class="btn small" :disabled="mateBusy" title="Ask the engine for a forced mate from this position" @click="mateCheck">
              {{ mateBusy ? "Searching…" : "詰みチェック Mate?" }}
            </button>
          </div>
          <div v-if="mateResult" class="mate-result" :class="mateResult.status">
            <template v-if="mateResult.status === 'mate'">
              <b>{{ mateResult.moves.length }}手詰</b> <span class="serif">{{ mateResult.text }}</span>
            </template>
            <template v-else-if="mateResult.status === 'nomate'">No forced mate found in {{ MATE_SECONDS }}s.</template>
            <template v-else-if="mateResult.status === 'timeout'">Ran out of time ({{ MATE_SECONDS }}s) without an answer.</template>
            <template v-else>This engine has no mate search.</template>
          </div>
        </div>

        <div class="panel box">
          <div class="cap">この局 Game summary</div>
          <div class="sum">
            <div><span class="muted">Accuracy</span> ☗ {{ fmtPct(game.accuracy_black) }} · ☖ {{ fmtPct(game.accuracy_white) }}</div>
            <div><span class="muted">悪手+</span> ☗ {{ mistakeCount("black") }} · ☖ {{ mistakeCount("white") }}</div>
            <div v-if="game.plies.some((p) => p.missed)">
              <span class="muted">詰み・勝ち逃し</span> ☗ {{ missedCount("black") }} · ☖ {{ missedCount("white") }}
            </div>
            <div v-if="game.turning_ply">
              <span class="muted">Turning point</span>
              <a href="#" @click.prevent="jump(game.turning_ply!)">{{ game.turning_ply }}手 {{ game.plies[game.turning_ply]?.text }}</a>
            </div>
            <div v-if="bookInfo?.configured && bookInfo.leftBookAt">
              <span class="muted">Left the book</span>
              <a href="#" @click.prevent="jump(bookInfo.leftBookAt)">{{ bookInfo.leftBookAt }}手 {{ game.plies[bookInfo.leftBookAt]?.text }}</a>
              <span v-if="bookInfo.alternatives.length" class="muted"> (book: {{ bookInfo.alternatives.map((a) => a.text).join(", ") }})</span>
            </div>
            <div><span class="muted">Time used</span> ☗ {{ fmtTime("black") }} · ☖ {{ fmtTime("white") }}</div>
          </div>
        </div>

        <div class="panel box">
          <div class="cap">戦型・囲い Opening and castles</div>
          <div class="sum">
            <div v-if="game.classification.opening"><span class="muted">戦型</span> {{ game.classification.opening.name }} ({{ game.classification.opening.ply }}手)</div>
            <div v-for="s in sides" :key="s">
              <span class="muted">{{ s === "black" ? "☗" : "☖" }}</span>
              {{ game.classification.sideOpening[s]?.name ?? game.classification.style[s] }}
              <div class="timeline">
                <a v-for="c in game.classification.castles[s]" :key="c.ply" href="#" class="tag" @click.prevent="jump(c.ply)">{{ c.name }} {{ c.ply }}</a>
                <a v-for="c in game.classification.tactics[s]" :key="'t' + c.ply + c.name" href="#" class="tag tactic" @click.prevent="jump(c.ply)">{{ c.name }}</a>
              </div>
            </div>
            <div v-if="game.strategy_header" class="muted">File says: {{ game.strategy_header }}</div>
          </div>
        </div>

        <div class="panel box">
          <label class="cap" for="gnotes">メモ Game notes</label>
          <textarea id="gnotes" v-model="notesDraft" rows="3" placeholder="What did you learn from this game?" @blur="saveNotes"></textarea>
          <a :href="`#/player/${encodeURIComponent(game.opponent || '')}`" v-if="game.opponent" style="font-size: 12px">My record vs {{ game.opponent }} →</a>
          <a href="#" style="font-size: 12px; margin-left: 10px" @click.prevent="findPosition">Other games with this position →</a>
          <a :href="explorerLink" style="font-size: 12px; margin-left: 10px">Explore from here →</a>
          <div v-if="posHits" class="hits">
            <div v-if="!posHits.length" class="muted">No other games reached it.</div>
            <a v-for="h in posHits" :key="h.gameId" :href="`#/game/${h.gameId}`" class="tag">#{{ h.gameId }} {{ h.game.black }} vs {{ h.game.white }} ({{ h.ply }}手)</a>
          </div>
        </div>

        <div v-if="similar.length" class="panel box">
          <div class="cap">似た対局 Similar games</div>
          <a v-for="g in similar" :key="g.id" :href="`#/game/${g.id}`" class="similar">
            <span class="res" :class="g.myResult || 'none'" style="width: 22px; height: 22px; font-size: 12px">{{ resultChar(g.myResult) }}</span>
            <span>{{ g.date.slice(0, 10) }}</span>
            <span class="muted">vs {{ g.opponent }}</span>
            <span class="muted">{{ g.strategy }}</span>
          </a>
        </div>
      </section>
    </div>

    <section class="panel graph">
      <div class="graph-head">
        <span class="cap">形勢グラフ · click to jump · ☗ above</span>
        <span class="row">
          <button type="button" class="btn small" :class="{ on: mode === 'winrate' }" @click="mode = 'winrate'">勝率 Win %</button>
          <button type="button" class="btn small" :class="{ on: mode === 'cp' }" @click="mode = 'cp'">評価値 cp</button>
        </span>
      </div>
      <EvalGraph :plies="game.plies" :current="cursor" :mode="mode" @jump="jump" />
      <div v-if="!hasEvals" class="muted" style="font-size: 12px">No evaluations yet. Analyse the game, or import a kifu that already has eval comments.</div>
    </section>

    <AddToNotebook
      v-if="notebookOpen"
      :snippet="notebookSnippet"
      :default-title="`${game.black} vs ${game.white} ${cursor}手`"
      @close="notebookOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { InitialPositionSFEN, Move, Position, formatPV } from "tsshogi";
import { api, evalText, GameDetail, live, resultChar, toast, winRate } from "../api";
import { go, route } from "../router";
import ShogiBoard from "../components/ShogiBoard.vue";
import EvalGraph from "../components/EvalGraph.vue";
import AddToNotebook from "../components/AddToNotebook.vue";

const props = defineProps<{ id: number }>();
const game = ref<GameDetail | null>(null);
const error = ref("");
const cursor = ref(Number(route.query.get("ply") ?? 0));
const explorerLink = computed(() => {
  if (!game.value) return "#/explorer";
  const p = new URLSearchParams();
  if (!game.value.initial_sfen.startsWith(InitialPositionSFEN.STANDARD.split(" ").slice(0, 3).join(" "))) p.set("sfen", game.value.initial_sfen);
  const ms = game.value.plies.slice(1, cursor.value + 1).map((x) => x.usi);
  if (ms.length) p.set("moves", ms.join(","));
  if (game.value.mySide) p.set("side", game.value.mySide);
  return "#/explorer?" + p.toString();
});
const flip = ref(false);
const mode = ref<"winrate" | "cp">("winrate");
const newTag = ref("");
const commentDraft = ref("");
const notesDraft = ref("");
const notebookOpen = ref(false);
const moveList = ref<HTMLElement | null>(null);
const sides = ["black", "white"] as const;

async function load() {
  try {
    game.value = await api.get<GameDetail>(`/api/games/${props.id}`);
    notesDraft.value = game.value.notes;
    if (cursor.value > game.value.plies.length - 1) cursor.value = 0;
    if (game.value.mySide === "white" && !route.query.get("flip")) flip.value = true;
    commentDraft.value = cur.value.comment;
  } catch (e) {
    error.value = String(e);
  }
}
onMounted(load);
type Similar = { id: number; date: string; opponent: string; myResult: string; strategy: string };
const similar = ref<Similar[]>([]);
onMounted(async () => {
  similar.value = await api.get<Similar[]>(`/api/games/${props.id}/similar`).catch(() => []);
});
type Branch = { ply: number; usis: string[]; texts: string[]; comment: string };
const branches = ref<Branch[]>([]);
const branchPlies = computed(() => {
  const m = new Map<number, Branch[]>();
  for (const b of branches.value) m.set(b.ply, [...(m.get(b.ply) ?? []), b]);
  return m;
});
const activeBranch = ref<Branch | null>(null);
onMounted(async () => {
  branches.value = await api.get<Branch[]>(`/api/games/${props.id}/branches`).catch(() => []);
});
// Show a stored variation: go to the position before it, then play it out as a line.
async function showBranch(b: Branch) {
  jump(b.ply - 1);
  await nextTick();
  variation.value = [...b.usis];
  activeBranch.value = b;
  void evalVariation();
}
type BookInfo = { configured: boolean; inBook: number[]; leftBookAt: number | null; alternatives: { usi: string; text: string }[] };
const bookInfo = ref<BookInfo | null>(null);
const bookPlies = computed(() => new Set(bookInfo.value?.inBook ?? []));
onMounted(async () => {
  try {
    bookInfo.value = await api.get<BookInfo>(`/api/games/${props.id}/book`);
  } catch {
    // An unreadable book shouldn't break the game view; Settings reports it.
  }
});
watch(
  () => live.libraryVersion,
  () => {
    if (game.value) void load();
  },
);

const cur = computed(() => game.value!.plies[cursor.value]);
const next = computed(() => game.value!.plies[cursor.value + 1]);
const hasEvals = computed(() => game.value!.plies.some((p) => p.score !== null || p.mate !== null));

watch(cursor, () => {
  commentDraft.value = cur.value?.comment ?? "";
  variation.value = [];
  multi.value = [];
  posHits.value = null;
  void nextTick(() => moveList.value?.querySelector(".on")?.scrollIntoView({ block: "nearest" }));
});

function jump(ply: number) {
  if (!game.value) return;
  cursor.value = Math.max(0, Math.min(game.value.plies.length - 1, ply));
}
function step(d: number) {
  if (variation.value.length && d < 0) {
    variation.value.pop();
    void evalVariation();
    return;
  }
  jump(cursor.value + d);
}

const mistakes = computed(() => game.value!.plies.filter((p) => (p.level >= 3 || p.missed) && (!game.value!.mySide || p.side === game.value!.mySide)).map((p) => p.ply));
const prevMistake = computed(() => [...mistakes.value].reverse().find((p) => p < cursor.value));
const nextMistake = computed(() => mistakes.value.find((p) => p > cursor.value));

function onKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT") return;
  if (e.key === "ArrowRight") step(1);
  else if (e.key === "ArrowLeft") step(-1);
  else if (e.key === "Home") jump(0);
  else if (e.key === "End") jump(game.value!.plies.length - 1);
  else if (e.key === "]" && nextMistake.value) jump(nextMistake.value);
  else if (e.key === "[" && prevMistake.value) jump(prevMistake.value);
  else if (e.key === "f") flip.value = !flip.value;
  else return;
  e.preventDefault();
}
onMounted(() => window.addEventListener("keydown", onKey));
onUnmounted(() => window.removeEventListener("keydown", onKey));

// ---- variation ("try your own move")
const variation = ref<string[]>([]);
watch(variation, (v) => {
  // Leaving the stored line (undo past its start, back to game) clears the label.
  if (activeBranch.value && (v.length === 0 || v.some((u, i) => activeBranch.value!.usis[i] !== u))) activeBranch.value = null;
}, { deep: true });
const varEval = ref<{ score?: number; mate?: number; bestText: string } | null>(null);
const varBusy = ref(false);
const variationPositions = computed(() => {
  const pos = Position.newBySFEN(cur.value.sfen)!;
  const list: { sfen: string; prev: string; usi: string; text: string }[] = [];
  for (const u of variation.value) {
    const prev = pos.sfen;
    const m = pos.createMoveByUSI(u);
    if (!m) break;
    pos.doMove(m);
    list.push({ sfen: pos.sfen, prev, usi: u, text: "" });
  }
  return list;
});
const shownSfen = computed(() => variationPositions.value.at(-1)?.sfen ?? cur.value.sfen);
const shownLastMove = computed(() => {
  const v = variationPositions.value.at(-1);
  if (v) return { prevSfen: v.prev, usi: v.usi };
  if (cursor.value === 0) return null;
  return { prevSfen: game.value!.plies[cursor.value - 1].sfen, usi: cur.value.usi };
});
const variationText = computed(() => {
  const start = Position.newBySFEN(cur.value.sfen);
  if (!start) return "";
  const pos = start.clone();
  const moves: Move[] = [];
  for (const u of variation.value) {
    const m = pos.createMoveByUSI(u);
    if (!m || !pos.doMove(m)) break;
    moves.push(m);
  }
  return formatPV(start, moves);
});

function onBoardMove(usi: string) {
  // Playing the game's next move just steps forward.
  if (!variation.value.length && next.value && next.value.usi === usi) {
    jump(cursor.value + 1);
    return;
  }
  variation.value.push(usi);
  void evalVariation();
}
async function evalVariation() {
  varEval.value = null;
  if (!variation.value.length) return;
  varBusy.value = true;
  try {
    const r = await api.post<{ score?: number; mate?: number; best: string; lines: { text: string }[] }>("/api/analyze-position", {
      sfen: cur.value.sfen,
      moves: variation.value,
    });
    varEval.value = { score: r.score, mate: r.mate, bestText: r.lines[0]?.text ?? r.best };
  } catch (e) {
    varEval.value = null;
    toast(String(e).includes("No engine") ? "Set an engine in Settings to evaluate your own moves" : String(e));
  } finally {
    varBusy.value = false;
  }
}

// ---- engine panel
const barPct = computed(() => {
  const p = variation.value.length ? null : cur.value;
  const w = p ? winRate(p.score, p.mate) : varEval.value ? winRate(varEval.value.score ?? null, varEval.value.mate ?? null) : null;
  return w ?? 50;
});
// Win % for the side to move after this ply.
const moverWin = computed(() => {
  const w = winRate(cur.value.score, cur.value.mate) ?? 50;
  const toMove = cur.value.sfen.split(" ")[1] === "w" ? "white" : "black";
  return Math.round(toMove === "black" ? w : 100 - w);
});
const arrows = computed(() => {
  if (variation.value.length) return [];
  if (multi.value.length) return multi.value.map((l) => ({ usi: l.pv[0], score: l.scoreSide }));
  return cur.value.best_usi ? [{ usi: cur.value.best_usi }] : [];
});
type Line = { multipv: number; pv: string[]; text: string; score?: number; mate?: number; scoreSide?: number };
const multi = ref<Line[]>([]);
const multiBusy = ref(false);
const MATE_SECONDS = 5;
type MateResult = { status: "mate"; moves: string[]; text: string } | { status: "nomate" | "timeout" | "notimplemented" };
const mateBusy = ref(false);
const mateResult = ref<MateResult | null>(null);
watch(() => game.value?.plies[cursor.value]?.sfen, () => (mateResult.value = null));
async function mateCheck() {
  mateBusy.value = true;
  try {
    mateResult.value = await api.post<MateResult>("/api/mate", { sfen: cur.value.sfen, timeMs: MATE_SECONDS * 1000 });
  } catch (e) {
    toast(String(e));
  } finally {
    mateBusy.value = false;
  }
}

async function candidates() {
  multiBusy.value = true;
  try {
    const r = await api.post<{ lines: (Line & { scoreCP?: number })[] }>("/api/analyze-position", { sfen: cur.value.sfen, multipv: 3 });
    multi.value = r.lines.map((l) => ({ ...l, scoreSide: l.scoreCP }));
  } catch (e) {
    toast(String(e));
  } finally {
    multiBusy.value = false;
  }
}

const resultText = computed(() => {
  const g = game.value!;
  const r = g.result === "black" ? "先手勝" : g.result === "white" ? "後手勝" : g.result === "draw" ? "引き分け" : "";
  return r ? `· ${r}` : "";
});
const fmtPct = (v: number | null) => (v == null ? "–" : v.toFixed(0) + "%");
const missedCount = (side: string) => game.value!.plies.filter((p) => p.side === side && p.missed).length;
const missedLabel = (m: string) => (m === "mate" ? "詰み逃し" : "勝ち逃し");
const mistakeCount = (side: string) => game.value!.plies.filter((p) => p.side === side && p.level >= 3).length;
const fmtTime = (side: string) => {
  const ms = game.value!.plies.filter((p) => p.side === side).reduce((a, p) => a + p.elapsed_ms, 0);
  if (!ms) return "–";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// ---- edits
async function saveComment() {
  if (!game.value || commentDraft.value === cur.value.comment) return;
  await api.put(`/api/games/${props.id}/comments/${cursor.value}`, { comment: commentDraft.value });
  cur.value.comment = commentDraft.value;
  toast("Comment saved");
}
async function saveNotes() {
  if (!game.value || notesDraft.value === game.value.notes) return;
  await api.patch(`/api/games/${props.id}`, { notes: notesDraft.value });
  game.value.notes = notesDraft.value;
}
async function addTag() {
  const t = newTag.value.trim();
  if (!t || !game.value) return;
  await api.patch(`/api/games/${props.id}`, { tags: [...game.value.tags, t] });
  game.value.tags = [...new Set([...game.value.tags, t])];
  newTag.value = "";
}
async function removeTag(t: string) {
  await api.patch(`/api/games/${props.id}`, { tags: game.value!.tags.filter((x) => x !== t) });
  game.value!.tags = game.value!.tags.filter((x) => x !== t);
}
async function analyse() {
  try {
    await api.post("/api/analysis", { ids: [props.id], force: true });
    toast("Analysis queued");
  } catch (e) {
    toast(String(e));
  }
}
async function makeCard() {
  try {
    await api.post("/api/cards", { gameId: props.id, ply: cursor.value });
    toast(`Card made from the position before move ${cursor.value}`);
    void load();
  } catch (e) {
    toast(String(e));
  }
}
function closeMenu(e: Event) {
  (e.currentTarget as HTMLElement).closest("details")?.removeAttribute("open");
}
// A notebook page with the game summary and each big mistake as a board, ready to annotate.
async function writeReview() {
  try {
    const page = await api.post<{ id: number }>(`/api/games/${props.id}/note`, {});
    go(`notes/${page.id}`);
  } catch (e) {
    toast(String(e));
  }
}
const diagramHref = computed(() => {
  const p = cur.value;
  const q = new URLSearchParams({ sfen: p.sfen, download: "1", flip: flip.value ? "1" : "0" });
  if (p.usi) q.set("last", p.usi);
  if (cursor.value > 0) q.set("caption", `${cursor.value}手目 ${p.text}`);
  return "/api/diagram.svg?" + q.toString();
});
const notebookSnippet = computed(() => {
  if (variation.value.length) {
    return `:::shogi-view\nsfen ${cur.value.sfen} moves ${variation.value.join(" ")}\n:::`;
  }
  return `:::shogi-view{game=${props.id} ply=${cursor.value}}\n:::`;
});

const posHits = ref<{ gameId: number; ply: number; game: { black: string; white: string } }[] | null>(null);
async function findPosition() {
  const hits = await api.get<typeof posHits.value>(`/api/position-search?sfen=${encodeURIComponent(cur.value.sfen)}`);
  posHits.value = (hits ?? []).filter((h) => h.gameId !== props.id);
}
</script>

<style scoped>
.similar {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 13px;
  padding: 4px 2px;
  color: var(--text);
  text-decoration: none;
  flex-wrap: wrap;
}
.similar:hover {
  background: var(--panel-2);
}
.book-mark {
  font-size: 10px;
  padding: 0 4px;
  border: 1px solid var(--line-2);
  border-radius: 3px;
  color: var(--muted);
  font-family: var(--serif);
}
.mate-result {
  margin-top: 8px;
  font-size: 13px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--panel-2);
}
.mate-result.mate {
  border: 1px solid var(--loss);
}
.title-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 18px;
  align-items: center;
  margin-bottom: 16px;
}
.title-row h1 {
  font-size: 24px;
}
.meta {
  font-size: 13px;
  margin-top: 2px;
}
.me {
  color: var(--gold-soft);
}
.tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
}
.tags .x {
  all: unset;
  cursor: pointer;
  margin-left: 4px;
}
.tag-input {
  min-height: 26px;
  width: 90px;
  font-size: 12px;
}
.actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.layout {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  align-items: flex-start;
}
.board-col {
  flex: 3 1 520px;
  min-width: 0;
}
.board-wrap {
  display: flex;
  gap: 8px;
  align-items: stretch;
}
.branch-mark {
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  padding: 0 5px;
  border-radius: 3px;
  border: 1px solid #6a8fb8;
  background: transparent;
  color: #9cc0e8;
  cursor: pointer;
}
.branch-mark:hover {
  background: #2a3a4d;
}
.branch-note {
  margin-bottom: 6px;
}
.menu {
  position: relative;
}
.menu summary {
  list-style: none;
}
.menu summary::-webkit-details-marker {
  display: none;
}
.menu-list {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 20;
  display: flex;
  flex-direction: column;
  min-width: 230px;
  padding: 6px;
}
.menu-list a {
  padding: 7px 10px;
  border-radius: 6px;
  color: var(--text);
  text-decoration: none;
  font-size: 13px;
}
.menu-list a:hover {
  background: var(--panel-2);
}
.evalbar {
  width: 14px;
  border: 1px solid var(--line-2);
  border-radius: 4px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.evalbar .w {
  background: #3a2c1a;
  transition: flex 0.3s;
}
.evalbar .b {
  background: var(--win);
  transition: flex 0.3s;
}
.nav {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 10px;
}
.here {
  margin-left: auto;
  font-size: 18px;
  font-weight: 700;
}
.var {
  margin-top: 10px;
  padding: 10px 12px;
  display: flex;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  border-color: var(--gold);
}
.row {
  display: flex;
  gap: 6px;
}
.moves-col {
  flex: 1 1 240px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  max-height: 640px;
}
.moves {
  list-style: none;
  margin: 0;
  padding: 0 6px;
  overflow-y: auto;
  flex: 1;
}
.moves li {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 5px 8px;
  border-radius: 4px;
  cursor: pointer;
}
.moves li:hover {
  background: #2a2017;
}
.moves li.on {
  background: var(--gold-bg);
  color: var(--gold-soft);
}
.moves .n {
  width: 26px;
  text-align: right;
  font-size: 12px;
  color: var(--muted);
}
.moves .m {
  flex: 1;
  font-weight: 700;
  font-size: 15px;
}
.moves .ev {
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  min-width: 44px;
  text-align: right;
}
.moves .cm {
  color: var(--gold);
  font-size: 12px;
}
.comment {
  padding: 10px 12px;
  border-top: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.side-col {
  flex: 1 1 280px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.box {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.big {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.big .serif {
  font-size: 30px;
}
.played {
  font-size: 13px;
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}
.pv {
  font-size: 13px;
  color: var(--muted);
  line-height: 1.6;
}
.multipv .mrow {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
}
.sum {
  font-size: 13px;
  line-height: 1.8;
}
.timeline {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 2px 0 6px;
}
.timeline .tag {
  text-decoration: none;
}
.timeline .tactic {
  border-style: dashed;
}
.hits {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  font-size: 12px;
}
.graph {
  margin-top: 18px;
  padding: 12px 16px;
}
.graph-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 6px;
}
</style>
