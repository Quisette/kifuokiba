<template>
  <div class="page">
    <div class="head">
      <h1>定跡 Explorer <span class="muted" style="font-size: 15px">moves from my own games</span></h1>
      <div class="chips" role="group" aria-label="My side">
        <button v-for="o in sides" :key="o.value" type="button" class="chip" :class="{ on: side === o.value }" @click="setSide(o.value)">{{ o.label }}</button>
      </div>
    </div>

    <div class="layout">
      <div class="board-col">
        <ShogiBoard :sfen="sfen" :last-move="lastMove" :arrows="arrows" :flip="side === 'white'" allow-move :max-height="620" @move="play" />
        <div class="nav-row">
          <button type="button" class="btn" :disabled="!moves.length" @click="setMoves([])">|◀ Start</button>
          <button type="button" class="btn" :disabled="!moves.length" @click="setMoves(moves.slice(0, -1))">◀ Back</button>
          <span class="muted small">Click a move in the table or play one on the board.</span>
        </div>
      </div>

      <div class="side-col">
        <div class="crumbs panel">
          <a href="#" :class="{ on: !moves.length }" @click.prevent="setMoves([])">開始局面</a>
          <a v-for="(c, i) in crumbs" :key="i" href="#" :class="{ on: i === crumbs.length - 1 }" @click.prevent="setMoves(moves.slice(0, i + 1))">
            <span class="muted">{{ i + 1 }}</span> {{ c }}
          </a>
        </div>

        <div v-if="!data" class="empty">Loading…</div>
        <template v-else>
          <div class="summary">
            <div>
              <div class="cap">Games here</div>
              <div class="stat">{{ data.games }}</div>
            </div>
            <div v-if="data.games">
              <div class="cap">My score</div>
              <div class="stat">{{ pct(data) }}<small>%</small></div>
              <div class="muted small">{{ data.wins }}勝 {{ data.losses }}敗 {{ data.draws }}分</div>
            </div>
            <div v-if="data.engine">
              <div class="cap">Engine</div>
              <div class="stat" style="font-size: 22px">{{ evalText(data.engine.score, data.engine.mate) }}</div>
              <div class="muted small">best {{ data.engine.bestText || "—" }}</div>
            </div>
          </div>

          <div v-if="!data.moves.length" class="empty">
            {{ data.games ? "The games that reached this position end here." : "None of your games reached this position." }}
          </div>
          <table v-else class="grid moves">
            <thead>
              <tr>
                <th>Move</th>
                <th style="text-align: right">Games</th>
                <th>My result</th>
                <th title="Average win-rate loss when I played it">My loss</th>
                <th>Last</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in data.moves" :key="m.usi" class="row" @click="play(m.usi)">
                <td class="serif mv">
                  {{ m.text }}
                  <span v-if="data.engine?.bestUsi === m.usi" class="tag" title="Engine's best move">最善</span>
                </td>
                <td style="text-align: right">{{ m.games }}<span v-if="m.mine && m.mine !== m.games" class="muted small"> ({{ m.mine }} mine)</span></td>
                <td>
                  <span class="score" :title="`${m.wins}勝 ${m.losses}敗 ${m.draws}分`">
                    <span class="w" :style="{ flex: m.wins }"></span><span class="d" :style="{ flex: m.draws }"></span><span class="l" :style="{ flex: m.losses }"></span>
                  </span>
                  <span class="small">{{ m.wins }}-{{ m.losses }}<template v-if="m.draws">-{{ m.draws }}</template></span>
                </td>
                <td :class="lossClass(m.myAvgLoss)">{{ m.myAvgLoss == null ? "—" : m.myAvgLoss.toFixed(1) }}</td>
                <td class="muted small">{{ m.lastDate || "" }}</td>
              </tr>
            </tbody>
          </table>

          <div v-if="gamesHere.length" class="here-games">
            <div class="cap" style="margin-bottom: 6px">Games through this position</div>
            <a v-for="g in gamesHere.slice(0, 30)" :key="g.gameId" :href="`#/game/${g.gameId}?ply=${g.ply}`" class="game-link">
              <span class="res" :class="g.game.myResult || 'none'" style="width: 22px; height: 22px; font-size: 12px">{{ resultChar(g.game.myResult) }}</span>
              <span>{{ g.game.date || "—" }}</span>
              <span class="muted">vs {{ g.game.opponent || `${g.game.black} – ${g.game.white}` }}</span>
              <span class="muted">{{ g.game.strategy }}</span>
            </a>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// Opening explorer: walk a tree built from the user's own games. State lives in
// the URL (#/explorer?sfen=…&moves=7g7f,3c3d&side=black) so positions can be linked.
import { computed, ref, watch } from "vue";
import { InitialPositionSFEN, Position, formatMove } from "tsshogi";
import { api, evalText, GameListItem, resultChar } from "../api";
import { go, route } from "../router";
import ShogiBoard from "../components/ShogiBoard.vue";

type Move = { usi: string; text: string; games: number; wins: number; losses: number; draws: number; mine: number; myAvgLoss: number | null; lastDate: string };
type Result = {
  sfen: string;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  engine: { score: number | null; mate: number | null; bestUsi: string; bestText: string } | null;
  moves: Move[];
};

const sides = [
  { value: "", label: "Any side" },
  { value: "black", label: "☗ as 先手" },
  { value: "white", label: "☖ as 後手" },
];

const startSfen = computed(() => route.query.get("sfen") || InitialPositionSFEN.STANDARD);
const moves = computed(() => (route.query.get("moves") ?? "").split(",").filter(Boolean));
const side = computed(() => route.query.get("side") ?? "");

// Replay the move list; stop at the first illegal move so a bad link still shows something.
const line = computed(() => {
  const pos = Position.newBySFEN(startSfen.value) ?? Position.newBySFEN(InitialPositionSFEN.STANDARD)!;
  const out: { sfen: string; text: string; usi: string; prevSfen: string }[] = [];
  for (const usi of moves.value) {
    const m = pos.createMoveByUSI(usi);
    if (!m || !pos.isValidMove(m)) break;
    const prevSfen = pos.sfen;
    const text = formatMove(pos, m);
    pos.doMove(m);
    out.push({ sfen: pos.sfen, text, usi, prevSfen });
  }
  return { start: Position.newBySFEN(startSfen.value)?.sfen ?? InitialPositionSFEN.STANDARD, steps: out };
});
const sfen = computed(() => line.value.steps.at(-1)?.sfen ?? line.value.start);
const lastMove = computed(() => {
  const s = line.value.steps.at(-1);
  return s ? { prevSfen: s.prevSfen, usi: s.usi } : null;
});

const data = ref<Result | null>(null);
const gamesHere = ref<{ gameId: number; ply: number; game: GameListItem }[]>([]);
const crumbs = computed(() => line.value.steps.map((s) => s.text));

let seq = 0;
watch(
  [sfen, side],
  async () => {
    const my = ++seq;
    const q = `sfen=${encodeURIComponent(sfen.value)}&side=${side.value}`;
    const [r, hits] = await Promise.all([
      api.get<Result>(`/api/explorer?${q}`),
      api.get<{ gameId: number; ply: number; game: GameListItem }[]>(`/api/position-search?sfen=${encodeURIComponent(sfen.value)}`),
    ]);
    if (my !== seq) return;
    data.value = r;
    gamesHere.value = hits.filter((h) => !side.value || h.game.mySide === side.value);
  },
  { immediate: true },
);

const arrows = computed(() => (data.value?.moves ?? []).slice(0, 3).map((m) => ({ usi: m.usi })));

function link(ms: string[], s = side.value) {
  const p = new URLSearchParams();
  if (route.query.get("sfen")) p.set("sfen", startSfen.value);
  if (ms.length) p.set("moves", ms.join(","));
  if (s) p.set("side", s);
  const q = p.toString();
  return "explorer" + (q ? "?" + q : "");
}
function setMoves(ms: string[]) {
  go(link(ms));
}
function setSide(s: string) {
  go(link(moves.value, s));
}
function play(usi: string) {
  setMoves([...moves.value.slice(0, line.value.steps.length), usi]);
}

function pct(t: { wins: number; losses: number; draws: number }) {
  const n = t.wins + t.losses + t.draws;
  return n ? Math.round(((t.wins + t.draws / 2) / n) * 100) : "–";
}
function lossClass(l: number | null) {
  if (l == null) return "muted";
  return l >= 10 ? "bad" : l >= 5 ? "meh" : "";
}
</script>

<style scoped>
.head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 16px;
}
.chips {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.layout {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
  gap: 24px;
  align-items: start;
}
@media (max-width: 1000px) {
  .layout {
    grid-template-columns: minmax(0, 1fr);
  }
}
.nav-row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 10px;
}
.small {
  font-size: 12px;
}
.crumbs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  padding: 10px 12px;
  margin-bottom: 14px;
  font-size: 13px;
}
.crumbs a {
  color: var(--text);
  text-decoration: none;
}
.crumbs a.on {
  color: var(--gold-soft);
  font-weight: 600;
}
.summary {
  display: flex;
  gap: 28px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.mv {
  font-size: 16px;
}
.score {
  display: inline-flex;
  width: 90px;
  height: 8px;
  border-radius: 4px;
  overflow: hidden;
  background: var(--line);
  vertical-align: middle;
  margin-right: 8px;
}
.score .w {
  background: var(--win);
}
.score .d {
  background: var(--draw);
}
.score .l {
  background: var(--loss);
}
td.bad {
  color: var(--loss);
  font-weight: 600;
}
td.meh {
  color: var(--gold);
}
.here-games {
  margin-top: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.game-link {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 6px 8px;
  border-radius: 6px;
  color: var(--text);
  text-decoration: none;
  font-size: 13px;
  flex-wrap: wrap;
}
.game-link:hover {
  background: var(--panel);
}
</style>
