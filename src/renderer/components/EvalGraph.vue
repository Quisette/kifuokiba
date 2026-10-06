<template>
  <div class="eval-graph">
    <svg
      ref="svg"
      :viewBox="`0 0 ${W} ${H}`"
      preserveAspectRatio="none"
      role="img"
      :aria-label="`Evaluation graph over ${plies.length - 1} moves; click to jump`"
      @click="onClick"
      @mousemove="onHover"
      @mouseleave="hover = null"
    >
      <rect x="0" y="0" :width="W" :height="H / 2" fill="rgba(95,149,208,0.04)" />
      <line x1="0" :y1="H / 2" :x2="W" :y2="H / 2" stroke="#5a4630" stroke-width="1" vector-effect="non-scaling-stroke" />
      <line
        v-for="g in gridLines"
        :key="g"
        x1="0"
        :y1="g"
        :x2="W"
        :y2="g"
        stroke="#2c2219"
        stroke-width="1"
        vector-effect="non-scaling-stroke"
      />
      <polygon v-if="areaPts" :points="areaPts" fill="#5f95d0" fill-opacity="0.2" />
      <polyline
        v-for="(seg, i) in segments"
        :key="i"
        :points="seg"
        fill="none"
        stroke="#5f95d0"
        stroke-width="2"
        vector-effect="non-scaling-stroke"
        stroke-linejoin="round"
      />
      <line
        :x1="x(current)"
        y1="0"
        :x2="x(current)"
        :y2="H"
        stroke="#d4a24c"
        stroke-width="1.5"
        stroke-dasharray="4 3"
        vector-effect="non-scaling-stroke"
      />
      <line
        v-if="hover !== null"
        :x1="x(hover)"
        y1="0"
        :x2="x(hover)"
        :y2="H"
        stroke="#b7a68a"
        stroke-width="1"
        vector-effect="non-scaling-stroke"
      />
    </svg>
    <!-- Mistake markers as HTML so they stay round when the SVG stretches. -->
    <div class="markers">
      <button
        v-for="m in markers"
        :key="m.ply"
        type="button"
        class="marker"
        :class="'l' + m.level"
        :style="{ left: (m.ply / maxPly) * 100 + '%', top: (y(m.ply) / H) * 100 + '%' }"
        :title="`${m.ply}手 ${m.text} ${m.label}`"
        :aria-label="`Jump to move ${m.ply}, ${m.label}`"
        @click.stop="emit('jump', m.ply)"
      ></button>
    </div>
    <!-- Think time per move, under the graph: ☗ bars gold, ☖ bars grey, 悪手+ red. -->
    <svg v-if="times.max > 0" class="time" :viewBox="`0 0 ${W} ${TH}`" preserveAspectRatio="none" aria-hidden="true" @click="onClick" @mousemove="onHover" @mouseleave="hover = null">
      <rect
        v-for="b in times.bars"
        :key="b.ply"
        :x="x(b.ply) - barW / 2"
        :y="TH - b.h"
        :width="barW"
        :height="b.h"
        :fill="b.color"
      />
      <line :x1="x(current)" y1="0" :x2="x(current)" :y2="TH" stroke="#d4a24c" stroke-width="1.5" stroke-dasharray="4 3" vector-effect="non-scaling-stroke" />
    </svg>
    <div class="axis">
      <span>0</span>
      <span v-if="hover !== null">{{ hover }}手 {{ hoverText }}</span>
      <span>{{ maxPly }}手</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { Ply, evalText, winRate } from "../api";

const props = withDefaults(defineProps<{ plies: Ply[]; current: number; mode?: "winrate" | "cp" }>(), { mode: "winrate" });
const emit = defineEmits<{ jump: [ply: number] }>();

const W = 1000;
const H = 180;
const TH = 40;
const PAD = 8;
const svg = ref<SVGSVGElement | null>(null);
const hover = ref<number | null>(null);

const maxPly = computed(() => Math.max(1, props.plies.length - 1));
const x = (ply: number) => (ply / maxPly.value) * W;
const value = (p: Ply): number | null => {
  if (props.mode === "winrate") {
    const w = winRate(p.score, p.mate);
    return w === null ? null : (w - 50) / 50;
  }
  if (p.mate !== null && p.mate !== 0) return p.mate > 0 ? 1 : -1;
  if (p.score === null) return null;
  return Math.max(-1, Math.min(1, p.score / 2000));
};
const y = (ply: number) => {
  const p = props.plies[ply];
  const v = p ? value(p) : null;
  return H / 2 - (v ?? 0) * (H / 2 - PAD);
};
const gridLines = computed(() => [H / 2 - (H / 2 - PAD) * 0.5, H / 2 + (H / 2 - PAD) * 0.5]);

// Polylines break where a ply has no eval.
const segments = computed(() => {
  const segs: string[] = [];
  let cur: string[] = [];
  props.plies.forEach((p) => {
    if (value(p) === null) {
      if (cur.length > 1) segs.push(cur.join(" "));
      cur = [];
      return;
    }
    cur.push(`${x(p.ply).toFixed(1)},${y(p.ply).toFixed(1)}`);
  });
  if (cur.length > 1) segs.push(cur.join(" "));
  return segs;
});
const areaPts = computed(() => {
  const pts = props.plies.filter((p) => value(p) !== null);
  if (pts.length < 2) return "";
  return (
    `${x(pts[0].ply)},${H / 2} ` +
    pts.map((p) => `${x(p.ply).toFixed(1)},${y(p.ply).toFixed(1)}`).join(" ") +
    ` ${x(pts[pts.length - 1].ply)},${H / 2}`
  );
});
const barW = computed(() => Math.max(1, (W / maxPly.value) * 0.7));
// Bar height grows with the square root of the time so short moves stay visible next to long thinks.
const times = computed(() => {
  const max = Math.max(0, ...props.plies.map((p) => p.elapsed_ms));
  const bars = max
    ? props.plies
        .filter((p) => p.ply > 0 && p.elapsed_ms > 0)
        .map((p) => ({
          ply: p.ply,
          h: Math.max(1.5, Math.sqrt(p.elapsed_ms / max) * TH),
          color: p.level >= 3 ? "#d9773d" : p.side === "white" ? "#8a7a5c" : "#d4a24c",
        }))
    : [];
  return { max, bars };
});
const markers = computed(() =>
  props.plies.filter((p) => p.level >= 2 || p.missed).map((p) => ({ ...p, level: p.missed ? 4 : p.level, label: p.missed ? (p.missed === "mate" ? "詰み逃し" : "勝ち逃し") : p.label })),
);

function plyAt(ev: MouseEvent) {
  const r = svg.value!.getBoundingClientRect();
  return Math.max(0, Math.min(maxPly.value, Math.round(((ev.clientX - r.left) / r.width) * maxPly.value)));
}
function onClick(ev: MouseEvent) {
  emit("jump", plyAt(ev));
}
function onHover(ev: MouseEvent) {
  hover.value = plyAt(ev);
}
const hoverText = computed(() => {
  if (hover.value === null) return "";
  const p = props.plies[hover.value];
  if (!p) return "";
  const w = winRate(p.score, p.mate);
  const t = p.elapsed_ms > 0 ? ` · ${fmtSec(p.elapsed_ms)}` : "";
  return `${p.text} ${evalText(p.score, p.mate)}${w !== null ? ` (▲${w.toFixed(0)}%)` : ""}${t}`;
});
function fmtSec(ms: number) {
  const sec = Math.round(ms / 1000);
  return sec >= 60 ? `${Math.floor(sec / 60)}分${sec % 60}秒` : `${sec}秒`;
}
</script>

<style scoped>
.eval-graph {
  position: relative;
}
svg {
  width: 100%;
  height: 150px;
  display: block;
  cursor: crosshair;
}
svg.time {
  height: 34px;
  margin-top: 4px;
  border-top: 1px solid #2c2219;
}
.markers {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 150px;
  pointer-events: none;
}
.marker {
  position: absolute;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  border: 1.5px solid #17120d;
  padding: 0;
  pointer-events: auto;
  cursor: pointer;
}
.marker.l2 {
  background: var(--gold);
}
.marker.l3 {
  background: var(--loss);
}
.marker.l4 {
  background: #e0503a;
  width: 13px;
  height: 13px;
}
.axis {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--muted);
  margin-top: 4px;
}
</style>
