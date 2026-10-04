import { reactive } from "vue";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as { error?: string }).error ?? `${r.status} ${r.statusText}`);
  return j as T;
}

export const api = {
  get: <T>(p: string) => request<T>("GET", p),
  post: <T>(p: string, b?: unknown) => request<T>("POST", p, b ?? {}),
  put: <T>(p: string, b?: unknown) => request<T>("PUT", p, b ?? {}),
  patch: <T>(p: string, b?: unknown) => request<T>("PATCH", p, b ?? {}),
  del: <T>(p: string) => request<T>("DELETE", p),
};

export function qs(params: Record<string, unknown>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") u.set(k, String(v));
  }
  const s = u.toString();
  return s ? "?" + s : "";
}

// ---------------------------------------------------------------- types

export type GameListItem = {
  id: number;
  black: string;
  white: string;
  date: string;
  event: string;
  time_control: string;
  source: string;
  result: string;
  end_reason: string;
  move_count: number;
  strategy: string;
  opening: string;
  black_opening: string;
  white_opening: string;
  black_castle: string;
  white_castle: string;
  matchup: string;
  analysis_status: string;
  accuracy_black: number | null;
  accuracy_white: number | null;
  turning_ply: number | null;
  file_name: string;
  tags: string[];
  mySide: "black" | "white" | "";
  myResult: "win" | "loss" | "draw" | "";
  opponent: string;
  myOpening: string;
  myCastle: string;
  myAccuracy: number | null;
  mistakes: number;
};

export type Ply = {
  ply: number;
  usi: string;
  text: string;
  sfen: string;
  comment: string;
  elapsed_ms: number;
  score: number | null;
  mate: number | null;
  best_usi: string;
  pv: string;
  pvText: string;
  eval_source: string;
  loss: number | null;
  level: number;
  /** The move threw away a mate ("mate") or a won position ("win"), whatever its level. */
  missed: "" | "mate" | "win";
  label: string;
  situation: string;
  side: "black" | "white" | "";
  cardId: number | null;
};

export type Labelled = { name: string; ply: number };
export type GameDetail = GameListItem & {
  initial_sfen: string;
  notes: string;
  strategy_header: string;
  analysis_engine: string;
  classification: {
    opening: Labelled | null;
    sideOpening: { black: Labelled | null; white: Labelled | null };
    style: { black: string; white: string };
    castles: { black: Labelled[]; white: Labelled[] };
    mainCastle: { black: string; white: string };
    tactics: { black: Labelled[]; white: Labelled[] };
  };
  plies: Ply[];
};

export type Card = {
  id: number;
  game_id: number;
  ply: number;
  sfen: string;
  side: "black" | "white";
  played_usi: string;
  best_usi: string;
  pv: string;
  loss: number;
  level: number;
  kind: string;
  phase: string;
  repetitions: number;
  interval_days: number;
  ease: number;
  due_at: number;
  lapses: number;
  suspended: number;
  note: string;
  black: string;
  white: string;
  date: string;
  strategy: string;
  bestText: string;
  playedText: string;
  pvText: string;
  /** Failed often enough that drilling alone isn't working. */
  leech: boolean;
};

export type AnalysisStatus = {
  running: boolean;
  engineName: string;
  current: { gameId: number; ply: number; total: number } | null;
  queued: number[];
  done: number;
  error: string;
};

export type Settings = {
  myNames: string[];
  engine: { path: string; options: Record<string, string | number>; movetimeMs: number; nodes: number; multipv: number };
  grading: { coefficientInSigmoid: number; thresholds: [number, number, number, number] };
  cardMinLevel: number;
  cardOkLoss: number;
  autoAnalyze: boolean;
  accounts: { lishogi: string };
};

export type PageSummary = { id: number; notebook: string; title: string; excerpt: string; updated_at: number };
export type Page = { id: number; notebook: string; title: string; body: string; updated_at: number };

// ---------------------------------------------------------------- live state

export const live = reactive({
  analysis: null as AnalysisStatus | null,
  libraryVersion: 0,
  toast: "",
});

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(msg: string, ms = 3500) {
  live.toast = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (live.toast = ""), ms);
}

export function connectEvents() {
  const es = new EventSource("/api/events");
  es.addEventListener("analysis", (e) => {
    live.analysis = JSON.parse((e as MessageEvent).data);
  });
  es.addEventListener("gameDone", () => live.libraryVersion++);
  es.addEventListener("library", () => live.libraryVersion++);
}

// ---------------------------------------------------------------- helpers

export const SIGMOID = 600;
export function winRate(score: number | null, mate: number | null): number | null {
  if (mate !== null && mate !== 0) return mate > 0 ? 100 : 0;
  if (score === null) return null;
  return 100 / (1 + Math.exp(-score / SIGMOID));
}

export function evalText(score: number | null, mate: number | null): string {
  if (mate !== null && mate !== 0) {
    const n = Math.abs(mate);
    return (mate > 0 ? "▲" : "△") + (n >= 10000 ? "詰み" : `${n}手詰`);
  }
  if (score === null) return "—";
  return (score > 0 ? "+" : "") + score;
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function sideMark(side: string) {
  return side === "black" ? "☗" : side === "white" ? "☖" : "";
}

export function resultChar(r: string) {
  return r === "win" ? "勝" : r === "loss" ? "負" : r === "draw" ? "分" : "–";
}
