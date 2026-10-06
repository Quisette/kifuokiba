// From ShogiHome src/common/game/usi.ts (MIT, (c) 2022 Kubo Ryosuke).
// SCORE_MATE_INFINITE は詰みを発見したが手数までは確定していない場合に使用する値です。
export const SCORE_MATE_INFINITE = 10000;

export type USIInfoCommand = {
  depth?: number;
  seldepth?: number;
  timeMs?: number;
  nodes?: number;
  pv?: string[];
  multipv?: number;
  scoreCP?: number;
  scoreMate?: number;
  lowerbound?: boolean;
  upperbound?: boolean;
  currmove?: string;
  hashfullPerMill?: number;
  nps?: number;
  string?: string;
};
