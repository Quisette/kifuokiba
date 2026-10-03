<template>
  <div class="page">
    <div class="head">
      <h1>統計 Statistics</h1>
      <label class="field">
        Source
        <select v-model="filter.source">
          <option value="">All</option>
          <option v-for="s in sources" :key="s" :value="s">{{ s }}</option>
        </select>
      </label>
      <label class="field">From <input v-model="filter.dateFrom" type="date" /></label>
      <label class="field">To <input v-model="filter.dateTo" type="date" /></label>
    </div>
    <div v-if="!s" class="empty">Loading…</div>
    <div v-else-if="!s.gamesWithMySide" class="empty">
      No games where your side is known. Add your player names in <a href="#/settings">Settings</a> ({{ s.gamesInLibrary }} games in the library).
    </div>
    <template v-else>
      <div class="tiles">
        <div class="tile"><div class="cap">Games</div><div class="stat">{{ s.totals.games }}</div></div>
        <div class="tile"><div class="cap">Win rate</div><div class="stat">{{ pct(s.totals.winRate) }}<small>%</small></div><div class="muted small">{{ s.totals.wins }}勝 {{ s.totals.losses }}敗 {{ s.totals.draws }}分</div></div>
        <div class="tile"><div class="cap">Mean accuracy</div><div class="stat">{{ pct(s.meanAccuracy) }}<small v-if="s.meanAccuracy != null">%</small></div></div>
        <div class="tile"><div class="cap">悪手 per game</div><div class="stat">{{ s.meanMistakes != null ? s.meanMistakes.toFixed(1) : "–" }}</div></div>
      </div>

      <div class="grid2">
        <section class="panel box wide">
          <div class="cap">勝率の推移 Win rate, last 20 games rolling</div>
          <svg v-if="s.rolling.length > 1" viewBox="0 0 1000 160" preserveAspectRatio="none" class="chart" role="img" aria-label="Rolling win rate">
            <line x1="0" y1="80" x2="1000" y2="80" stroke="#5a4630" vector-effect="non-scaling-stroke" stroke-dasharray="4 4" />
            <polyline :points="rollingPts" fill="none" stroke="var(--win)" stroke-width="2" vector-effect="non-scaling-stroke" />
          </svg>
          <div v-else class="muted small">Needs more decided games.</div>
          <div class="axis muted small"><span>{{ s.rolling[0]?.date.slice(0, 10) }}</span><span>50%</span><span>{{ s.rolling.at(-1)?.date.slice(0, 10) }}</span></div>
        </section>

        <section class="panel box wide">
          <div class="cap">Accuracy by game (dot colour = result)</div>
          <svg v-if="s.accuracyTrend.length" viewBox="0 0 1000 160" preserveAspectRatio="none" class="chart" role="img" aria-label="Accuracy per game">
            <line v-for="g in [40, 80, 120]" :key="g" x1="0" :y1="g" x2="1000" :y2="g" stroke="#2c2219" vector-effect="non-scaling-stroke" />
          </svg>
          <div v-if="s.accuracyTrend.length" class="dots">
            <a
              v-for="(a, i) in s.accuracyTrend"
              :key="a.id"
              :href="`#/game/${a.id}`"
              class="dot"
              :class="a.result || 'none'"
              :style="{ left: (s.accuracyTrend.length === 1 ? 50 : (i / (s.accuracyTrend.length - 1)) * 100) + '%', bottom: a.accuracy + '%' }"
              :title="`${a.date} · ${a.accuracy.toFixed(0)}%`"
            ></a>
          </div>
          <div v-else class="muted small">Analyse games to see accuracy.</div>
        </section>

        <BarTable title="戦型別 My opening" :rows="s.byOpening" link="opening" />
        <BarTable title="相手の戦型 Opponent's opening" :rows="s.byOpponentOpening" />
        <BarTable title="囲い別 My castle" :rows="s.byCastle" link="castle" />
        <BarTable title="先後 Side" :rows="s.bySide" />
        <BarTable title="形 Shape" :rows="s.byMatchup" link="matchup" />
        <BarTable title="持ち時間 Time control" :rows="s.byTimeControl" />
        <BarTable title="Source" :rows="s.bySource" link="source" />
        <BarTable title="相手 Opponents (2+ games)" :rows="s.byOpponent" link="opponent" />

        <section class="panel box">
          <div class="cap">形勢を損ねた局面 Loss by phase (my moves)</div>
          <table class="grid">
            <thead><tr><th>Phase</th><th>Avg loss / move</th><th>悪手+</th><th>Moves</th><th v-if="s.thinkTime.length">Avg think</th></tr></thead>
            <tbody>
              <tr v-for="p in s.phaseProfile" :key="p.phase">
                <td>{{ phaseName(p.phase) }}</td>
                <td>{{ p.avgLoss != null ? p.avgLoss.toFixed(2) : "–" }}</td>
                <td>{{ p.mistakes }}</td>
                <td>{{ p.moves }}</td>
                <td v-if="s.thinkTime.length">{{ p.avgSeconds != null ? p.avgSeconds.toFixed(1) + "s" : "–" }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section v-if="s.thinkTime.length" class="panel box">
          <div class="cap">考慮時間 Think time vs mistakes (my moves)</div>
          <table class="grid">
            <thead><tr><th>Think time</th><th>Moves</th><th>Avg loss</th><th>悪手+ rate</th></tr></thead>
            <tbody>
              <tr v-for="b in s.thinkTime" :key="b.label">
                <td>{{ b.label }}</td>
                <td>{{ b.moves }}</td>
                <td>{{ b.avgLoss != null ? b.avgLoss.toFixed(2) : "–" }}</td>
                <td>
                  <span v-if="b.mistakeRate != null" class="rate"><span :style="{ width: Math.min(100, b.mistakeRate * 4) + '%' }"></span></span>
                  {{ b.mistakeRate != null ? b.mistakeRate.toFixed(1) + "%" : "–" }}
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <section class="panel box wide">
          <div class="cap">Matchups: my opening (rows) vs theirs (columns), win %</div>
          <div class="scroll-x">
            <table class="grid matrix">
              <thead>
                <tr>
                  <th></th>
                  <th v-for="c in gridCols" :key="c">{{ c }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in s.matchupGrid" :key="r.mine">
                  <th>{{ r.mine }}</th>
                  <td v-for="c in gridCols" :key="c" :style="cellStyle(r.cells.find((x) => x.theirs === c))" :title="cellTitle(r.cells.find((x) => x.theirs === c))">
                    {{ cellText(r.cells.find((x) => x.theirs === c)) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, defineComponent, h, onMounted, reactive, ref, watch } from "vue";
import { api, qs } from "../api";

type Row = { name: string; games: number; wins: number; losses: number; draws: number; winRate: number | null };
type Cell = Row & { theirs: string };
type StatsT = {
  gamesInLibrary: number;
  gamesWithMySide: number;
  totals: Row;
  bySide: Row[];
  byOpening: Row[];
  byOpponentOpening: Row[];
  byCastle: Row[];
  byMatchup: Row[];
  byTimeControl: Row[];
  bySource: Row[];
  byOpponent: Row[];
  rolling: { date: string; winRate: number }[];
  accuracyTrend: { id: number; date: string; accuracy: number; result: string }[];
  meanAccuracy: number | null;
  meanMistakes: number | null;
  phaseProfile: { phase: string; avgLoss: number | null; moves: number; mistakes: number; avgSeconds: number | null }[];
  thinkTime: { label: string; moves: number; avgLoss: number | null; mistakes: number; mistakeRate: number | null }[];
  matchupGrid: { mine: string; cells: Cell[] }[];
};

const s = ref<StatsT | null>(null);
const filter = reactive({ source: "", dateFrom: "", dateTo: "" });
const sources = ref<string[]>([]);
async function load() {
  s.value = await api.get<StatsT>("/api/stats" + qs(filter));
  if (!sources.value.length) sources.value = s.value.bySource.map((x) => x.name);
}
onMounted(load);
watch(filter, load);

const pct = (v: number | null | undefined) => (v == null ? "–" : v.toFixed(0));
const phaseName = (p: string) => ({ opening: "序盤 1–30", middlegame: "中盤 31–80", endgame: "終盤 81+" })[p] ?? p;
const rollingPts = computed(() => {
  const r = s.value?.rolling ?? [];
  return r.map((p, i) => `${((i / Math.max(1, r.length - 1)) * 1000).toFixed(1)},${(160 - (p.winRate / 100) * 160).toFixed(1)}`).join(" ");
});
const gridCols = computed(() => [...new Set((s.value?.matchupGrid ?? []).flatMap((r) => r.cells.map((c) => c.theirs)))]);
const cellText = (c?: Cell) => (c ? `${c.winRate != null ? Math.round(c.winRate) + "%" : "–"} (${c.games})` : "");
const cellTitle = (c?: Cell) => (c ? `${c.wins}勝 ${c.losses}敗` : "");
const cellStyle = (c?: Cell) => {
  if (!c || c.winRate == null) return {};
  const a = Math.min(0.55, 0.12 + c.games * 0.05);
  return { background: c.winRate >= 50 ? `rgba(95,149,208,${a})` : `rgba(217,119,61,${a})` };
};

const BarTable = defineComponent({
  props: { title: String, rows: { type: Array as () => Row[], required: true }, link: String },
  setup(p) {
    return () => {
      const max = Math.max(1, ...p.rows.map((r) => r.games));
      return h("section", { class: "panel box" }, [
        h("div", { class: "cap", style: "margin-bottom:10px" }, p.title),
        p.rows.length
          ? p.rows.slice(0, 12).map((r) =>
              h("div", { class: "bar-row", title: `${r.name}: ${r.wins}勝 ${r.losses}敗 ${r.draws}分` }, [
                p.link
                  ? h("a", { class: "bar-label", href: `#/library?${p.link}=${encodeURIComponent(r.name)}` }, r.name)
                  : h("span", { class: "bar-label" }, r.name),
                h("span", { class: "bar" }, [
                  h("span", { style: { width: (r.wins / max) * 100 + "%", background: "var(--win)" } }),
                  h("span", { style: { width: (r.losses / max) * 100 + "%", background: "var(--loss)" } }),
                ]),
                h("span", { class: "num" }, `${r.winRate != null ? Math.round(r.winRate) + "%" : "–"} · ${r.games}`),
              ]),
            )
          : h("div", { class: "muted small" }, "No data"),
      ]);
    };
  },
});
</script>

<style scoped>
.rate {
  display: inline-block;
  width: 70px;
  height: 7px;
  border-radius: 4px;
  background: var(--line);
  overflow: hidden;
  vertical-align: middle;
  margin-right: 6px;
}
.rate span {
  display: block;
  height: 100%;
  background: var(--loss);
}
.head {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 18px;
  align-items: flex-end;
  margin-bottom: 16px;
}
.head h1 {
  margin-right: auto;
}
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 1px;
  background: var(--line);
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
  margin-bottom: 20px;
}
.tile {
  background: var(--bg);
  padding: 14px 18px;
}
.small {
  font-size: 12px;
}
.grid2 {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
  gap: 14px;
}
.wide {
  grid-column: 1 / -1;
}
:deep(.box) {
  padding: 14px 16px;
}
.chart {
  width: 100%;
  height: 160px;
  display: block;
  margin-top: 8px;
}
.axis {
  display: flex;
  justify-content: space-between;
}
.dots {
  position: relative;
  height: 160px;
  margin-top: -160px;
}
.dot {
  position: absolute;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  transform: translate(-50%, 50%);
}
.dot.win {
  background: var(--win);
}
.dot.loss {
  background: var(--loss);
}
.dot.draw,
.dot.none {
  background: var(--draw);
}
:deep(.bar-row) {
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr) 70px;
  gap: 8px;
  align-items: center;
  font-size: 12px;
  margin-bottom: 7px;
}
:deep(.bar-label) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
  text-decoration: none;
}
:deep(.bar) {
  display: flex;
  gap: 2px;
  height: 10px;
}
:deep(.bar > span) {
  border-radius: 3px;
}
:deep(.num) {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.matrix td {
  text-align: center;
  font-size: 12px;
}
.matrix th {
  font-size: 12px;
}
</style>
