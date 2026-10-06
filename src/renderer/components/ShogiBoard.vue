<template>
  <div ref="host" class="shogi-board" role="group" :aria-label="label">
    <BoardView
      v-if="position && width > 0"
      :layout-type="layout"
      :board-image-type="BoardImageType.LIGHT"
      :piece-stand-image-type="PieceStandImageType.DARK_WOOD"
      :piece-image-url-template="'./piece/hitomoji_wood/${piece}.png'"
      :king-piece-type="KingPieceType.GYOKU_AND_OSHO"
      :board-label-type="BoardLabelType.STANDARD"
      :max-size="maxSize"
      :position="position"
      :last-move="lastMoveObj"
      :candidates="candidateMoves"
      :flip="flip"
      :allow-move="allowMove"
      :allow-edit="allowEdit"
      :hide-clock="true"
      :black-player-name="blackName"
      :white-player-name="whiteName"
      :highlight-movable-squares="allowMove && !allowEdit"
      @move="onMove"
      @edit="(changes: PositionChange[]) => emit('edit', changes)"
    >
      <template #left-control><slot name="left-control"></slot></template>
      <template #right-control><slot name="right-control"></slot></template>
    </BoardView>
  </div>
</template>

<script setup lang="ts">
// Thin wrapper around ShogiHome's BoardView (vendored, MIT): turns SFEN/USI
// props into tsshogi objects and sizes the board to its container.
import { computed, onMounted, onUnmounted, ref } from "vue";
import { Move, Position, PositionChange } from "tsshogi";
import BoardView from "@/renderer/view/primitive/BoardView.vue";
import { RectSize } from "@/common/assets/geometry";
import { BoardImageType, BoardLabelType, KingPieceType, PieceStandImageType } from "@/common/settings/app";
import { BoardLayoutType } from "@/common/settings/layout";

const props = withDefaults(
  defineProps<{
    sfen: string;
    lastMove?: { prevSfen: string; usi: string } | null;
    arrows?: { usi: string; score?: number }[];
    flip?: boolean;
    allowMove?: boolean;
    /** Position editing: pieces are dragged freely and double-clicked to rotate; emits "edit". */
    allowEdit?: boolean;
    blackName?: string;
    whiteName?: string;
    compact?: boolean;
    maxHeight?: number;
  }>(),
  { lastMove: null, arrows: () => [], flip: false, allowMove: false, allowEdit: false, blackName: "先手", whiteName: "後手", compact: false, maxHeight: 0 },
);
const emit = defineEmits<{ move: [usi: string, move: Move]; edit: [changes: PositionChange[]] }>();

const host = ref<HTMLElement | null>(null);
const width = ref(0);
let ro: ResizeObserver | null = null;
onMounted(() => {
  ro = new ResizeObserver(() => (width.value = host.value?.clientWidth ?? 0));
  if (host.value) ro.observe(host.value);
  width.value = host.value?.clientWidth ?? 0;
});
onUnmounted(() => ro?.disconnect());

// Narrow containers (phones) get ShogiHome's portrait layout: hands above and below the board.
const portrait = computed(() => !props.compact && width.value > 0 && width.value < 560);
const layout = computed(() => (props.compact ? BoardLayoutType.COMPACT : portrait.value ? BoardLayoutType.PORTRAIT : BoardLayoutType.STANDARD));
const maxSize = computed(() => {
  const ratio = props.compact ? 1015 / 1088 : portrait.value ? 1168 / 878 : 959 / 1471;
  let w = width.value;
  if (props.maxHeight && w * ratio > props.maxHeight) w = props.maxHeight / ratio;
  return new RectSize(w, w * ratio);
});
const position = computed(() => Position.newBySFEN(props.sfen));
// The board is drawn with images; screen readers get the position as SFEN.
const label = computed(() => {
  const p = position.value;
  if (!p) return "将棋盤 Shogi board";
  return `将棋盤 Shogi board, ${p.color === "black" ? "☗ sente" : "☖ gote"} to move. SFEN ${p.sfen}`;
});
const lastMoveObj = computed(() => {
  if (!props.lastMove?.usi) return null;
  const prev = Position.newBySFEN(props.lastMove.prevSfen);
  return prev?.createMoveByUSI(props.lastMove.usi) ?? null;
});
const candidateMoves = computed(() => {
  const pos = position.value;
  if (!pos) return [];
  return props.arrows
    .map((a) => ({ move: pos.createMoveByUSI(a.usi), score: a.score }))
    .filter((c): c is { move: Move; score: number | undefined } => !!c.move);
});

function onMove(move: Move) {
  emit("move", move.usi, move);
}
</script>

<style scoped>
.shogi-board {
  width: 100%;
  display: flex;
  justify-content: center;
}
</style>
