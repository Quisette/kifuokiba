<template>
  <figure class="note-board panel">
    <div v-if="error" class="muted">{{ error }}</div>
    <template v-else-if="frames.length">
      <ShogiBoard
        :sfen="frames[idx].sfen"
        :last-move="idx > 0 ? { prevSfen: frames[idx - 1].sfen, usi: frames[idx].usi } : lastMove"
        :flip="attrs.flip === 'true'"
        :black-name="names[0]"
        :white-name="names[1]"
        :max-height="420"
      />
      <figcaption>
        <template v-if="frames.length > 1">
          <button type="button" class="btn small" aria-label="Previous move" :disabled="idx === 0" @click="idx--">◀</button>
          <button type="button" class="btn small" aria-label="Next move" :disabled="idx === frames.length - 1" @click="idx++">▶</button>
        </template>
        <span class="serif">{{ frames[idx].label }}</span>
        <a v-if="gameId" :href="`#/game/${gameId}?ply=${frames[idx].ply}`" class="muted">open game →</a>
      </figcaption>
      <ol v-if="kind === 'kifu'" class="excerpt">
        <li v-for="(f, i) in frames.slice(1)" :key="i" :class="{ on: idx === i + 1 }" @click="idx = i + 1">
          <span class="n">{{ f.ply }}</span>
          <span class="serif">{{ f.text }}</span>
          <span v-if="f.comment" class="c">{{ f.comment }}</span>
        </li>
      </ol>
    </template>
    <div v-else class="muted">Loading board…</div>
  </figure>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { Position, Record as KRecord, formatMove } from "tsshogi";
import { api, GameDetail } from "../api";
import ShogiBoard from "./ShogiBoard.vue";

const props = defineProps<{ kind: "board" | "kifu"; attrs: Record<string, string>; body?: string; refName?: string }>();

type Frame = { ply: number; sfen: string; usi: string; text: string; label: string; comment: string };
const frames = ref<Frame[]>([]);
const idx = ref(0);
const error = ref("");
const gameId = ref<number | null>(null);
const names = ref<[string, string]>(["先手", "後手"]);
const lastMove = ref<{ prevSfen: string; usi: string } | null>(null);

const gameCache = new Map<number, Promise<GameDetail>>();
function fetchGame(id: number) {
  if (!gameCache.has(id)) gameCache.set(id, api.get<GameDetail>(`/api/games/${id}`));
  return gameCache.get(id)!;
}

onMounted(async () => {
  try {
    const a = props.attrs;
    const ref = props.refName ?? a.game ?? "";
    const gid = Number(String(ref).replace(/^game:/, ""));
    if (gid) {
      const g = await fetchGame(gid);
      gameId.value = gid;
      names.value = [g.black || "先手", g.white || "後手"];
      const all: Frame[] = g.plies.map((p) => ({
        ply: p.ply,
        sfen: p.sfen,
        usi: p.usi,
        text: p.ply ? p.text : "開始局面",
        label: p.ply ? `${p.ply}手目 ${p.text}` : "開始局面",
        comment: p.comment.split("\n").filter((l) => !/^[#*]/.test(l)).join(" ").trim(),
      }));
      if (props.kind === "kifu") {
        const start = Math.max(1, Number(a.start ?? 1));
        const stop = Math.min(all.length - 1, Number(a.stop ?? all.length - 1));
        frames.value = all.slice(start - 1, stop + 1);
      } else {
        const ply = Math.min(all.length - 1, Number(a.ply ?? a.move ?? 0));
        frames.value = [all[ply]];
        if (ply > 0) lastMove.value = { prevSfen: all[ply - 1].sfen, usi: all[ply].usi };
      }
      return;
    }
    // Body: "position startpos moves …", "sfen … moves …", or bare USI moves.
    let body = (props.body ?? "").replace(/\s+/g, " ").trim();
    if (!body) body = "startpos";
    if (/^[1-9][a-i][1-9][a-i]|^[PLNSGBR]\*/.test(body)) body = "startpos moves " + body;
    const rec = KRecord.newByUSI(body.startsWith("position") ? body : "position " + body);
    if (rec instanceof Error) throw rec;
    const out: Frame[] = [{ ply: 0, sfen: rec.initialPosition.sfen, usi: "", text: "開始局面", label: "開始局面", comment: "" }];
    const pos = rec.initialPosition.clone() as Position;
    for (const n of rec.moves.slice(1)) {
      if (!("usi" in n.move)) break;
      const text = (pos.color === "black" ? "☗" : "☖") + formatMove(pos, n.move);
      pos.doMove(n.move);
      out.push({ ply: n.ply, sfen: pos.sfen, usi: n.move.usi, text, label: `${n.ply}手目 ${text}`, comment: "" });
    }
    frames.value = out;
    const at = a.move ?? a.moveNumber ?? a.turn ?? a.ply;
    idx.value = at !== undefined ? Math.min(out.length - 1, Number(at)) : out.length - 1;
  } catch (e) {
    error.value = "Board error: " + (e instanceof Error ? e.message : String(e));
  }
});
</script>

<style scoped>
.note-board {
  margin: 14px 0;
  padding: 12px;
  max-width: 760px;
}
figcaption {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 8px;
  flex-wrap: wrap;
}
.excerpt {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  max-height: 240px;
  overflow: auto;
  font-size: 14px;
}
.excerpt li {
  display: flex;
  gap: 8px;
  padding: 3px 6px;
  border-radius: 4px;
  cursor: pointer;
}
.excerpt li.on {
  background: var(--gold-bg);
}
.excerpt .n {
  width: 26px;
  text-align: right;
  color: var(--muted);
  font-size: 12px;
}
.excerpt .c {
  color: var(--muted);
  font-size: 12px;
}
</style>
