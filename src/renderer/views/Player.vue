<template>
  <div class="page">
    <div v-if="error" class="empty">{{ error }} <a href="#/stats">Back to stats</a></div>
    <div v-else-if="!p" class="empty">Loading…</div>
    <template v-else>
      <div class="head">
        <h1>{{ p.name }}</h1>
        <span class="muted">
          {{ p.totals.games }} games · {{ p.firstPlayed.slice(0, 10) }} – {{ p.lastPlayed.slice(0, 10) }}<template v-if="p.theirRating"> · rating {{ p.theirRating }}</template>
        </span>
        <a class="btn small" :href="`#/library?opponent=${encodeURIComponent(p.name)}`">Open in library</a>
        <a class="btn small" :href="`#/explorer?opponent=${encodeURIComponent(p.name)}`">Openings against them</a>
        <button type="button" class="btn small" :disabled="writing" title="A notebook page to prepare for the next game against them" @click="writePrep">Write prep sheet</button>
      </div>

      <div class="tiles panel">
        <div>
          <div class="cap">My record</div>
          <div class="stat">{{ p.totals.wins }}<small>勝</small> {{ p.totals.losses }}<small>敗</small><template v-if="p.totals.draws"> {{ p.totals.draws }}<small>分</small></template></div>
        </div>
        <div>
          <div class="cap">Win rate</div>
          <div class="stat">{{ p.totals.winRate != null ? Math.round(p.totals.winRate) : "–" }}<small>%</small></div>
        </div>
        <div>
          <div class="cap">Recent form</div>
          <div class="form">
            <span v-for="(r, i) in p.form" :key="i" class="res" :class="{ W: 'win', L: 'loss', D: 'draw' }[r] ?? 'none'" style="width: 24px; height: 24px; font-size: 12px">{{ { W: "勝", L: "負", D: "分" }[r] ?? "–" }}</span>
          </div>
        </div>
        <div>
          <div class="cap">My accuracy vs them</div>
          <div class="stat">{{ p.meanAccuracy != null ? p.meanAccuracy.toFixed(0) : "–" }}<small v-if="p.meanAccuracy != null">%</small></div>
        </div>
      </div>

      <div class="cols">
        <section class="panel box">
          <div class="cap">What they play · my score</div>
          <ScoreRows :rows="p.theirOpenings" />
        </section>
        <section class="panel box">
          <div class="cap">Their castles · my score</div>
          <ScoreRows :rows="p.theirCastles" />
        </section>
        <section class="panel box">
          <div class="cap">What I played · my score</div>
          <ScoreRows :rows="p.myOpenings" />
        </section>
      </div>

      <section class="panel box">
        <div class="cap">Games</div>
        <a v-for="g in p.games" :key="g.id" :href="`#/game/${g.id}`" class="game">
          <span class="res" :class="g.myResult || 'none'" style="width: 24px; height: 24px; font-size: 12px">{{ resultChar(g.myResult) }}</span>
          <span>{{ g.date.slice(0, 10) }}</span>
          <span class="muted">{{ g.mySide === "black" ? "☗" : "☖" }}</span>
          <span>{{ g.strategy }}</span>
          <span class="muted">{{ g.move_count }}手</span>
          <span v-if="g.mistakes" class="mark l3">悪手 {{ g.mistakes }}</span>
        </a>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { defineComponent, h, ref, watch } from "vue";
import { api, GameListItem, resultChar, toast } from "../api";
import { go, route } from "../router";

const writing = ref(false);
async function writePrep() {
  if (!p.value) return;
  writing.value = true;
  try {
    const page = await api.post<{ id: number }>("/api/notes/prep", { opponent: p.value.name });
    go(`notes/${page.id}`);
  } catch (e) {
    toast(String(e instanceof Error ? e.message : e));
  } finally {
    writing.value = false;
  }
}

type Row = { name: string; games: number; wins: number; losses: number; draws: number; winRate: number | null };
type Profile = {
  name: string;
  totals: Row;
  firstPlayed: string;
  lastPlayed: string;
  theirOpenings: Row[];
  theirCastles: Row[];
  myOpenings: Row[];
  form: string;
  meanAccuracy: number | null;
  theirRating: number | null;
  games: GameListItem[];
};

const p = ref<Profile | null>(null);
const error = ref("");
watch(
  () => route.params[0],
  async (name) => {
    p.value = null;
    error.value = "";
    try {
      p.value = await api.get<Profile>(`/api/players/${encodeURIComponent(decodeURIComponent(name ?? ""))}`);
    } catch (e) {
      error.value = String(e);
    }
  },
  { immediate: true },
);

const ScoreRows = defineComponent({
  props: { rows: { type: Array as () => Row[], required: true } },
  setup(props) {
    return () =>
      props.rows.length
        ? h(
            "div",
            props.rows.map((r) =>
              h("div", { class: "srow", title: `${r.wins}勝 ${r.losses}敗 ${r.draws}分` }, [
                h("span", { class: "sname" }, r.name),
                h("span", { class: "sbar" }, [
                  h("span", { class: "w", style: { flex: r.wins } }),
                  h("span", { class: "d", style: { flex: r.draws } }),
                  h("span", { class: "l", style: { flex: r.losses } }),
                ]),
                h("span", { class: "snum" }, `${r.wins}-${r.losses}`),
              ]),
            ),
          )
        : h("div", { class: "muted small" }, "Not classified yet.");
  },
});
</script>

<style scoped>
.head {
  display: flex;
  align-items: baseline;
  gap: 14px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.tiles {
  display: flex;
  flex-wrap: wrap;
  gap: 28px;
  padding: 16px 18px;
  margin-bottom: 16px;
}
.form {
  display: flex;
  gap: 4px;
  margin-top: 6px;
}
.cols {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
  margin-bottom: 16px;
}
.box {
  padding: 16px;
}
.box .cap {
  margin-bottom: 10px;
}
:deep(.srow) {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 100px 40px;
  gap: 10px;
  align-items: center;
  font-size: 13px;
  padding: 3px 0;
}
:deep(.sbar) {
  display: flex;
  height: 8px;
  border-radius: 4px;
  overflow: hidden;
  background: var(--line);
}
:deep(.sbar .w) {
  background: var(--win);
}
:deep(.sbar .d) {
  background: var(--draw);
}
:deep(.sbar .l) {
  background: var(--loss);
}
:deep(.snum) {
  text-align: right;
  color: var(--muted);
}
.game {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 6px 4px;
  color: var(--text);
  text-decoration: none;
  font-size: 13px;
  flex-wrap: wrap;
  border-bottom: 1px solid #2a2017;
}
.game:hover {
  background: var(--panel-2);
}
.small {
  font-size: 12px;
}
</style>
