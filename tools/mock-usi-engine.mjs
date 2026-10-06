#!/usr/bin/env node
// A tiny USI engine for tests and for trying the app without a real engine.
// Evaluation is material balance (side to move's view); the best move is the
// legal move that wins the most material in one ply. It is not a shogi engine,
// only enough to exercise the USI plumbing and produce believable numbers.
import { createInterface } from "node:readline";
import { Position, Square, PieceType, Color, handPieceTypes } from "tsshogi";

const VALUE = {
  pawn: 90, lance: 315, knight: 405, silver: 495, gold: 540, bishop: 855, rook: 990,
  promPawn: 540, promLance: 540, promKnight: 540, promSilver: 540, horse: 945, dragon: 1395, king: 0,
};

function material(pos) {
  let score = 0;
  for (const sq of Square.all) {
    const p = pos.board.at(sq);
    if (p) score += (p.color === Color.BLACK ? 1 : -1) * VALUE[p.type];
  }
  for (const t of handPieceTypes) {
    score += VALUE[t] * (pos.blackHand.count(t) - pos.whiteHand.count(t));
  }
  return pos.color === Color.BLACK ? score : -score;
}

function legalMoves(pos) {
  const moves = [];
  for (const from of Square.all) {
    const p = pos.board.at(from);
    if (!p || p.color !== pos.color) continue;
    for (const to of Square.all) {
      const m = pos.createMove(from, to);
      if (!m) continue;
      for (const cand of [m, m.withPromote()]) {
        if (pos.isValidMove(cand)) moves.push(cand);
      }
    }
  }
  const hand = pos.hand(pos.color);
  for (const t of handPieceTypes) {
    if (!hand.count(t)) continue;
    for (const to of Square.all) {
      const m = pos.createMove(t, to);
      if (m && pos.isValidMove(m)) moves.push(m);
    }
  }
  return moves;
}

let position = Position.newBySFEN("lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1");
let multipv = 1;
const delayMs = Number(process.env.MOCK_ENGINE_DELAY_MS ?? 0);

function send(line) {
  process.stdout.write(line + "\n");
}

function setPosition(args) {
  const tokens = args.split(" ");
  let i = 0;
  let pos;
  if (tokens[0] === "startpos") {
    pos = Position.newBySFEN("lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1");
    i = 1;
  } else if (tokens[0] === "sfen") {
    pos = Position.newBySFEN(tokens.slice(1, 5).join(" "));
    i = 5;
  }
  if (tokens[i] === "moves") {
    for (const u of tokens.slice(i + 1)) {
      const m = pos.createMoveByUSI(u);
      if (!m || !pos.doMove(m)) break;
    }
  }
  position = pos;
}

function go() {
  const moves = legalMoves(position);
  if (!moves.length) {
    send("info depth 1 score mate -0 pv");
    send("bestmove resign");
    return;
  }
  const scored = moves.map((m) => {
    const p = position.clone();
    p.doMove(m);
    // Opponent's best reply among "no capture" and its captures, one ply deep.
    let oppBest = material(p);
    for (const r of legalMoves(p).filter((x) => x.capturedPieceType)) {
      const q = p.clone();
      q.doMove(r);
      oppBest = Math.max(oppBest, -material(q));
    }
    return { m, score: -oppBest };
  });
  scored.sort((a, b) => b.score - a.score);
  for (let k = 0; k < Math.min(multipv, scored.length); k++) {
    const { m, score } = scored[k];
    send(`info depth 2 seldepth 2 multipv ${k + 1} score cp ${score} nodes ${moves.length * 40} pv ${m.usi}`);
  }
  send(`bestmove ${scored[0].m.usi}`);
}

// "go mate": finds mate in one only (a checking move that leaves no legal reply).
function goMate() {
  for (const m of legalMoves(position)) {
    const p = position.clone();
    p.doMove(m);
    if (p.checked && legalMoves(p).length === 0) {
      send(`checkmate ${m.usi}`);
      return;
    }
  }
  send("checkmate nomate");
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (raw) => {
  const line = raw.trim();
  const [cmd, ...rest] = line.split(" ");
  const args = rest.join(" ");
  switch (cmd) {
    case "usi":
      send("id name MockEngine 1.0");
      send("id author kifu-study");
      send("option name MultiPV type spin default 1 min 1 max 10");
      send("option name USI_Hash type spin default 16 min 1 max 1024");
      send("usiok");
      break;
    case "isready":
      send("readyok");
      break;
    case "setoption": {
      const m = /name (\S+) value (\S+)/.exec(args);
      if (m && m[1] === "MultiPV") multipv = Number(m[2]);
      break;
    }
    case "position":
      setPosition(args);
      break;
    case "go":
      if (args.startsWith("mate")) {
        goMate();
        break;
      }
      if (delayMs) setTimeout(go, delayMs);
      else go();
      break;
    case "quit":
      process.exit(0);
  }
});
