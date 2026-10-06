// Streamed engine search over /api/live (server-sent events). The search runs
// until its time limit or until the returned stop function is called.
export type LiveLine = {
  multipv: number;
  pv: string[];
  text: string;
  depth?: number;
  nodes?: number;
  /** Black's view. */
  score?: number;
  mate?: number;
  /** Side to move's view (for board arrows). */
  scoreCP?: number;
};
export type LiveResult = { lines: LiveLine[]; elapsedMs: number; done: boolean; score?: number; mate?: number };

export function liveSearch(
  params: { sfen: string; moves?: string[]; multipv?: number; maxMs?: number },
  on: { update: (r: LiveResult) => void; error?: (message: string) => void },
): () => void {
  const q = new URLSearchParams({ sfen: params.sfen, multipv: String(params.multipv ?? 1), maxMs: String(params.maxMs ?? 10_000) });
  if (params.moves?.length) q.set("moves", params.moves.join(" "));
  const es = new EventSource("/api/live?" + q.toString());
  let finished = false;
  const close = () => {
    finished = true;
    es.close();
  };
  es.addEventListener("lines", (e) => {
    const d = JSON.parse((e as MessageEvent).data);
    on.update({ lines: d.lines, elapsedMs: d.elapsedMs, done: false });
  });
  es.addEventListener("done", (e) => {
    const d = JSON.parse((e as MessageEvent).data);
    // The server ends the stream after this; close so EventSource doesn't reconnect.
    close();
    on.update({ lines: d.lines, elapsedMs: d.elapsedMs, done: true, score: d.score, mate: d.mate });
  });
  es.addEventListener("failed", (e) => {
    close();
    on.error?.(JSON.parse((e as MessageEvent).data).error);
  });
  es.onerror = () => {
    if (finished) return;
    close();
    on.error?.("Lost the connection to the engine.");
  };
  return close;
}
