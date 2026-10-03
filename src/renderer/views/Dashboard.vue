<template>
  <div class="page">
    <div v-if="settings && !settings.myNames.length" class="banner panel">
      <span>Tell the app which player is you, so wins, stats and cards follow your side.</span>
      <a href="#/settings" class="btn small">Set my names</a>
    </div>
    <div v-if="settings && !settings.engine.path" class="banner panel">
      <span>No engine yet. Point Settings at a USI engine (YaneuraOu + 水匠, etc.) to analyse games and make mistake cards.</span>
      <a href="#/settings" class="btn small">Set engine</a>
    </div>

    <div class="tiles">
      <div class="tile">
        <div class="cap">対局数 Games</div>
        <div class="stat">{{ stats?.gamesInLibrary ?? "–" }}</div>
      </div>
      <div class="tile">
        <div class="cap">勝率 Win rate</div>
        <div class="stat">{{ pct(stats?.totals.winRate) }}<small v-if="stats?.totals.winRate != null">%</small></div>
        <div class="muted small">{{ stats?.totals.wins ?? 0 }}勝 {{ stats?.totals.losses ?? 0 }}敗</div>
      </div>
      <div class="tile">
        <div class="cap">先手 / 後手</div>
        <div class="stat">
          {{ pct(sideRate("先手")) }}<small>%</small>
          <span class="muted" style="font-size: 20px">/ {{ pct(sideRate("後手")) }}%</span>
        </div>
      </div>
      <div class="tile">
        <div class="cap">悪手 / game</div>
        <div class="stat">{{ stats?.meanMistakes != null ? stats.meanMistakes.toFixed(1) : "–" }}</div>
      </div>
      <div class="tile">
        <div class="cap">Accuracy</div>
        <div class="stat">{{ pct(stats?.meanAccuracy) }}<small v-if="stats?.meanAccuracy != null">%</small></div>
      </div>
      <a class="tile link" href="#/review">
        <div class="cap">今日の復習 Due cards</div>
        <div class="stat">{{ counts?.due ?? 0 }}</div>
        <div class="muted small">{{ counts?.total ?? 0 }} cards · {{ counts?.reviewedToday ?? 0 }} reviewed today</div>
      </a>
    </div>

    <div class="cols">
      <section class="main-col">
        <div class="head">
          <h2>最近の対局 Recent games</h2>
          <a href="#/library">Open library →</a>
        </div>
        <div v-if="!games.length" class="empty">No games yet. Drop kifu files below to start.</div>
        <div class="recent">
          <a v-for="g in games.slice(0, 10)" :key="g.id" :href="`#/game/${g.id}`" class="gc">
            <span class="res" :class="g.myResult || 'none'">{{ resultChar(g.myResult) }}</span>
            <span style="min-width: 0">
              <span class="name">{{ g.mySide ? "vs " + g.opponent : `${g.black} vs ${g.white}` }}</span>
              <span class="muted small">
                {{ g.mySide ? (g.mySide === "black" ? "☗ 先手" : "☖ 後手") : "" }} · {{ g.strategy || "—" }} · {{ g.move_count }}手
                <template v-if="g.mistakes"> · <span class="mark l3">悪手 {{ g.mistakes }}</span></template>
              </span>
            </span>
            <span class="muted small">{{ g.date.slice(5, 10) || "" }}</span>
          </a>
        </div>
        <ImportPanel style="margin-top: 20px" @imported="load" />
      </section>

      <aside class="side-col">
        <div class="panel box">
          <div class="cap" style="margin-bottom: 10px">戦型別 By my opening</div>
          <div v-if="!stats?.byOpening.length" class="muted small">Needs games where your side is known.</div>
          <div v-for="o in (stats?.byOpening ?? []).slice(0, 8)" :key="o.name" class="bar-row" :title="`${o.name}: ${o.wins}勝 ${o.losses}敗`">
            <a :href="`#/library?opening=${encodeURIComponent(o.name)}`" class="bar-label">{{ o.name }}</a>
            <span class="bar">
              <span :style="{ width: (o.wins / maxGames) * 100 + '%', background: 'var(--win)' }"></span>
              <span :style="{ width: (o.losses / maxGames) * 100 + '%', background: 'var(--loss)' }"></span>
            </span>
            <span class="num">{{ o.winRate != null ? Math.round(o.winRate) + "%" : "–" }}</span>
          </div>
        </div>
        <div class="panel box">
          <div class="cap" style="margin-bottom: 10px">エンジン Analysis queue</div>
          <template v-if="live.analysis?.running">
            <div>Analysing game {{ live.analysis.current?.gameId }} · ply {{ live.analysis.current?.ply }} / {{ live.analysis.current?.total }}</div>
            <div class="muted small">{{ live.analysis.queued.length }} queued · {{ live.analysis.engineName }}</div>
            <button type="button" class="btn small" style="margin-top: 8px" @click="stop">Stop</button>
          </template>
          <template v-else>
            <div class="muted small" style="margin-bottom: 8px">
              {{ unanalysed }} game{{ unanalysed === 1 ? "" : "s" }} not analysed yet.
              <span v-if="live.analysis?.error" style="color: var(--loss)"><br />{{ live.analysis.error }}</span>
            </div>
            <button type="button" class="btn small" :disabled="!unanalysed || !settings?.engine.path" @click="analyseAll">Analyse all</button>
          </template>
        </div>
        <div class="panel box">
          <div class="cap" style="margin-bottom: 10px">形勢の崩れ Where I lose points</div>
          <div v-for="p in stats?.phaseProfile ?? []" :key="p.phase" class="bar-row">
            <span class="bar-label">{{ phaseName(p.phase) }}</span>
            <span class="bar"><span :style="{ width: Math.min(100, (p.avgLoss ?? 0) * 10) + '%', background: 'var(--loss)' }"></span></span>
            <span class="num">{{ p.avgLoss != null ? p.avgLoss.toFixed(1) : "–" }}</span>
          </div>
          <div class="muted small" style="margin-top: 6px">Average win-rate loss per move (points), my moves only.</div>
        </div>
      </aside>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { api, GameListItem, live, resultChar, Settings, toast } from "../api";
import ImportPanel from "../components/ImportPanel.vue";

type StatRow = { name: string; games: number; wins: number; losses: number; winRate: number | null };
type Stats = {
  gamesInLibrary: number;
  totals: { games: number; wins: number; losses: number; winRate: number | null };
  bySide: StatRow[];
  byOpening: StatRow[];
  meanAccuracy: number | null;
  meanMistakes: number | null;
  phaseProfile: { phase: string; avgLoss: number | null }[];
};

const stats = ref<Stats | null>(null);
const games = ref<GameListItem[]>([]);
const counts = ref<{ due: number; total: number; reviewedToday: number } | null>(null);
const settings = ref<Settings | null>(null);

async function load() {
  [stats.value, games.value, counts.value, settings.value] = await Promise.all([
    api.get<Stats>("/api/stats"),
    api.get<GameListItem[]>("/api/games?sort=date&desc=true"),
    api.get<{ due: number; total: number; reviewedToday: number }>("/api/cards/counts"),
    api.get<Settings>("/api/settings"),
  ]);
}
onMounted(load);
watch(() => live.libraryVersion, load);

const pct = (v: number | null | undefined) => (v == null ? "–" : v.toFixed(0));
const sideRate = (name: string) => stats.value?.bySide.find((s) => s.name === name)?.winRate ?? null;
const maxGames = computed(() => Math.max(1, ...(stats.value?.byOpening ?? []).map((o) => o.games)));
const unanalysed = computed(() => games.value.filter((g) => g.analysis_status === "none").length);
const phaseName = (p: string) => ({ opening: "序盤 1–30", middlegame: "中盤 31–80", endgame: "終盤 81+" })[p] ?? p;

async function analyseAll() {
  try {
    await api.post("/api/analysis", { all: true });
  } catch (e) {
    toast(String(e));
  }
}
async function stop() {
  await api.post("/api/analysis/stop");
}
</script>

<style scoped>
.banner {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  margin-bottom: 12px;
  border-color: var(--gold);
  flex-wrap: wrap;
}
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 1px;
  background: var(--line);
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
  margin-bottom: 24px;
}
.tile {
  background: var(--bg);
  padding: 14px 18px;
  color: var(--text);
  text-decoration: none;
}
.tile.link:hover {
  background: #1f1812;
}
.small {
  font-size: 12px;
}
.cols {
  display: flex;
  flex-wrap: wrap;
  gap: 24px;
  align-items: flex-start;
}
.main-col {
  flex: 3 1 520px;
  min-width: 0;
}
.side-col {
  flex: 1 1 320px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 12px;
}
.recent {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.gc {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--text);
  text-decoration: none;
}
.gc:hover {
  border-color: #8a6a3a;
}
.name {
  display: block;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.box {
  padding: 14px 16px;
}
.bar-row {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr) 40px;
  gap: 8px;
  align-items: center;
  font-size: 12px;
  margin-bottom: 7px;
}
.bar-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
  text-decoration: none;
}
.bar {
  display: flex;
  gap: 2px;
  height: 10px;
}
.bar > span {
  border-radius: 3px;
}
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
</style>
