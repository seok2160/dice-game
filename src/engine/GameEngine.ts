import {
  GameConfig, GameState, Player, PipValue, PlayerId,
  RollResult, TeamId, PLAYER_COLORS, INITIAL_OWN_DICE, emptyBoard,
} from './types';
import { setupBoard } from './setup';
import { rollAndCount, fisherYates } from './rng';
import { settleRound, SettlementResult } from './settle';
import { v4 as uuidv4 } from 'uuid';

// ─── factory ─────────────────────────────────────────────────────────────────

export function createRoom(roomId: string, hostId: string, hostname: string): GameState {
  const host = makePlayer(hostId, hostname, PLAYER_COLORS[0], null);
  return {
    roomId,
    config: { mode: 'individual', useWhiteDice: false, totalRounds: 1, turnTimeMs: 30000 },
    players: [host],
    turnOrder: [],
    currentTurnIdx: 0,
    currentRound: 0,
    board: emptyBoard(),
    phase: 'WAITING',
    turnDeadline: null,
    currentRoll: null,
    meta: { turnSeq: 0, hostId, processedActions: [] },
    history: [],
  };
}

export function addPlayer(state: GameState, playerId: PlayerId, nickname: string): GameState {
  if (state.players.length >= 4) throw new GameError('ROOM_FULL', 'Room is full');
  if (state.phase !== 'WAITING')  throw new GameError('GAME_STARTED', 'Game already started');
  const color  = PLAYER_COLORS[state.players.length];
  const player = makePlayer(playerId, nickname, color, null);
  return { ...state, players: [...state.players, player] };
}

export function addBot(state: GameState, botId: PlayerId): GameState {
  if (state.players.length >= 4) throw new GameError('ROOM_FULL', 'Room is full');
  if (state.phase !== 'WAITING')  throw new GameError('GAME_STARTED', 'Game already started');
  const idx    = state.players.length;
  const color  = PLAYER_COLORS[idx];
  const botNum = state.players.filter(p => p.isBot).length + 1;
  const player = { ...makePlayer(botId, `AI-${botNum}`, color, null), isBot: true };
  return { ...state, players: [...state.players, player] };
}

export function removeBot(state: GameState): GameState {
  if (state.phase !== 'WAITING') throw new GameError('GAME_STARTED', 'Game already started');
  const lastBot = [...state.players].reverse().find(p => p.isBot);
  if (!lastBot) throw new GameError('NO_BOT', 'No bot to remove');
  return { ...state, players: state.players.filter(p => p.id !== lastBot.id) };
}

export function setConfig(state: GameState, config: Partial<GameConfig>): GameState {
  if (state.phase !== 'WAITING') throw new GameError('GAME_STARTED', 'Game already started');
  const next = { ...state, config: { ...state.config, ...config } };
  if (next.config.mode === '2v2' && next.players.length !== 4) {
    throw new GameError('INVALID_CONFIG', '2v2 팀전은 정확히 4인이 필요합니다');
  }
  if (next.config.mode === 'individual' && (next.players.length < 2 || next.players.length > 4)) {
    throw new GameError('INVALID_CONFIG', '개인전은 2~4인이 필요합니다');
  }
  return next;
}

export function assignTeams(state: GameState): GameState {
  if (state.config.mode !== '2v2') return state;
  const players = state.players.map((p, i) => ({
    ...p,
    team: (i % 2 === 0 ? 'A' : 'B') as TeamId,
  }));
  return { ...state, players };
}

// ─── round lifecycle ──────────────────────────────────────────────────────────

export function startGame(state: GameState): GameState {
  if (state.players.length < 2) throw new GameError('NOT_ENOUGH_PLAYERS', 'Need at least 2 players');
  let s = assignTeams(state);
  s = { ...s, currentRound: 1 };
  return beginRound(s);
}

export function resetGame(state: GameState): GameState {
  if (state.phase !== 'ENDED') throw new GameError('NOT_ENDED', 'Game is not ended yet');
  const players = state.players.map(p => ({ ...p, money: 0, ownDiceRemaining: 0, whiteDiceRemaining: 0 }));
  return {
    ...state,
    players,
    turnOrder: [],
    currentTurnIdx: 0,
    currentRound: 0,
    board: emptyBoard(),
    phase: 'WAITING',
    turnDeadline: null,
    currentRoll: null,
    history: [],
    meta: { ...state.meta, turnSeq: 0, processedActions: [] },
  };
}

function beginRound(state: GameState): GameState {
  const whitePer = getWhiteAllocation(state.players.length);
  const players  = state.players.map(p => ({
    ...p,
    ownDiceRemaining:   INITIAL_OWN_DICE,
    whiteDiceRemaining: state.config.useWhiteDice ? whitePer : 0,
  }));

  const turnOrder = buildTurnOrder(players, state.config.mode);
  const board     = setupBoard();

  return {
    ...state,
    players,
    turnOrder,
    currentTurnIdx: 0,
    board,
    phase: 'ROLLING',
    turnDeadline: null,
    currentRoll: null,
    meta: { ...state.meta, turnSeq: state.meta.turnSeq + 1 },
  };
}

// ─── turn actions ─────────────────────────────────────────────────────────────

export function roll(state: GameState, playerId: PlayerId): { state: GameState; roll: RollResult } {
  assertPhase(state, 'ROLLING');
  assertCurrentTurn(state, playerId);
  const player = getPlayer(state, playerId);

  const result: RollResult = {
    ownPips:   rollAndCount(player.ownDiceRemaining),
    whitePips: rollAndCount(player.whiteDiceRemaining),
  };

  return {
    state: {
      ...state,
      currentRoll: result,
      phase: 'CHOOSING',
      turnDeadline: Date.now() + state.config.turnTimeMs,
    },
    roll: result,
  };
}

export function applyBet(
  state: GameState,
  playerId: PlayerId,
  pip: PipValue,
  ownCount: number,
  whiteCount: number,
): GameState {
  assertPhase(state, 'CHOOSING');
  assertCurrentTurn(state, playerId);
  if (!state.currentRoll) throw new GameError('NO_ROLL', 'No roll to bet on');
  if (ownCount + whiteCount === 0) throw new GameError('EMPTY_PIP', 'No dice on that pip');

  const players = state.players.map(p => {
    if (p.id !== playerId) return p;
    return {
      ...p,
      ownDiceRemaining:   p.ownDiceRemaining   - ownCount,
      whiteDiceRemaining: p.whiteDiceRemaining  - whiteCount,
    };
  });

  const bets = { ...state.board.bets };
  if (ownCount   > 0) bets[pip] = [...bets[pip], { owner: playerId, count: ownCount   }];
  if (whiteCount > 0) bets[pip] = [...bets[pip], { owner: 'WHITE',  count: whiteCount }];

  const next = {
    ...state,
    players,
    board: { ...state.board, bets },
    currentRoll: null,
    turnDeadline: null,
    meta: { ...state.meta, turnSeq: state.meta.turnSeq + 1 },
  };

  return advance(next);
}

export function pass(state: GameState): GameState {
  const next = {
    ...state,
    currentRoll: null,
    turnDeadline: null,
    meta: { ...state.meta, turnSeq: state.meta.turnSeq + 1 },
  };
  return advance(next);
}

// ─── settlement ───────────────────────────────────────────────────────────────

export function settle(state: GameState): { state: GameState; result: SettlementResult } {
  assertPhase(state, 'SETTLING');
  const result = settleRound(state);

  const players = state.players.map(p => ({
    ...p,
    money: p.money + (result.moneyDelta[p.id] ?? 0),
  }));

  const summary = {
    round: state.currentRound,
    moneyDelta: result.moneyDelta,
    bankReturned: result.totalBankReturned,
    details: result.perPosition,
  };

  const isLastRound = state.currentRound >= state.config.totalRounds;

  let next: GameState = {
    ...state,
    players,
    history: [...state.history, summary],
  };

  if (isLastRound) {
    next = { ...next, phase: 'ENDED' };
  } else {
    next = { ...next, currentRound: state.currentRound + 1 };
    next = beginRound(next);
  }

  return { state: next, result };
}

export function getWinner(state: GameState): string {
  if (state.config.mode === '2v2') {
    const teamA = state.players.filter(p => p.team === 'A').reduce((s, p) => s + p.money, 0);
    const teamB = state.players.filter(p => p.team === 'B').reduce((s, p) => s + p.money, 0);
    if (teamA > teamB) return 'Team A';
    if (teamB > teamA) return 'Team B';
    return 'Draw';
  }
  const sorted = [...state.players].sort((a, b) => b.money - a.money);
  if (sorted[0].money === sorted[1].money) return 'Draw';
  return sorted[0].nickname;
}

export interface WinnerDetails {
  isDraw: boolean;
  mode: GameConfig['mode'];
  winners: Player[];
  teamMoneys?: { A: number; B: number };
}

export function getWinnerDetails(state: GameState): WinnerDetails {
  if (state.config.mode === '2v2') {
    const teamA = state.players.filter(p => p.team === 'A').reduce((s, p) => s + p.money, 0);
    const teamB = state.players.filter(p => p.team === 'B').reduce((s, p) => s + p.money, 0);
    if (teamA === teamB) return { isDraw: true, mode: '2v2', winners: [], teamMoneys: { A: teamA, B: teamB } };
    const winTeam = teamA > teamB ? 'A' : 'B';
    return { isDraw: false, mode: '2v2', winners: state.players.filter(p => p.team === winTeam), teamMoneys: { A: teamA, B: teamB } };
  }
  const sorted = [...state.players].sort((a, b) => b.money - a.money);
  if (sorted[0].money === sorted[1]?.money) return { isDraw: true, mode: 'individual', winners: [] };
  return { isDraw: false, mode: 'individual', winners: [sorted[0]] };
}

// ─── views ───────────────────────────────────────────────────────────────────

/** 모든 클라이언트에 브로드캐스트 — currentRoll 제거 */
export function publicView(state: GameState): Omit<GameState, 'currentRoll'> & { currentRoll: null } {
  return { ...state, currentRoll: null };
}

/** 해당 플레이어에게만 전송 — 본인 턴이면 currentRoll 포함 */
export function privateView(state: GameState, playerId: PlayerId): GameState {
  const currentPlayer = state.turnOrder[state.currentTurnIdx];
  if (currentPlayer === playerId) return state;
  return { ...state, currentRoll: null };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

export class GameError extends Error {
  constructor(public code: string, msg: string) { super(msg); this.name = 'GameError'; }
}

function advance(state: GameState): GameState {
  const allDone = state.players.every(
    p => p.ownDiceRemaining === 0 && p.whiteDiceRemaining === 0,
  );
  if (allDone) return { ...state, phase: 'SETTLING' };

  let next = (state.currentTurnIdx + 1) % state.turnOrder.length;
  for (let i = 0; i < state.turnOrder.length; i++) {
    const pid = state.turnOrder[next];
    const p   = state.players.find(pp => pp.id === pid)!;
    if (p.ownDiceRemaining > 0 || p.whiteDiceRemaining > 0) break;
    next = (next + 1) % state.turnOrder.length;
  }

  return { ...state, currentTurnIdx: next, phase: 'ROLLING' };
}

function assertPhase(state: GameState, phase: GameState['phase']) {
  if (state.phase !== phase) throw new GameError('BAD_PHASE', `Expected phase ${phase}, got ${state.phase}`);
}

function assertCurrentTurn(state: GameState, playerId: PlayerId) {
  const expected = state.turnOrder[state.currentTurnIdx];
  if (expected !== playerId) throw new GameError('NOT_YOUR_TURN', 'Not your turn');
}

function getPlayer(state: GameState, playerId: PlayerId): Player {
  const p = state.players.find(pp => pp.id === playerId);
  if (!p) throw new GameError('PLAYER_NOT_FOUND', 'Player not found');
  return p;
}

function makePlayer(id: PlayerId, nickname: string, color: string, team: TeamId | null): Player {
  return { id, nickname, color, team, ownDiceRemaining: 0, whiteDiceRemaining: 0, money: 0, connected: true, isBot: false };
}

function buildTurnOrder(players: Player[], mode: GameConfig['mode']): PlayerId[] {
  if (mode === '2v2') {
    // 팀 교차(A-B-A-B) 유지, 팀 내 순서는 매 라운드 랜덤
    const a = fisherYates(players.filter(p => p.team === 'A').map(p => p.id));
    const b = fisherYates(players.filter(p => p.team === 'B').map(p => p.id));
    return [a[0], b[0], a[1], b[1]].filter(Boolean) as PlayerId[];
  }
  // 개인전: 전원 랜덤 셔플
  return fisherYates(players.map(p => p.id));
}

// 흰색 주사위는 모드가 아닌 인원수 기준 (기획서 §2)
function getWhiteAllocation(playerCount: number): number {
  return playerCount === 2 ? 4 : 2;
}

export function forceBet(roll: RollResult): { pip: PipValue; ownCount: number; whiteCount: number } | null {
  let best: PipValue | null = null;
  let bestTotal = 0;
  for (let p = 1; p <= 6; p++) {
    const pip   = p as PipValue;
    const total = roll.ownPips[pip] + roll.whitePips[pip];
    if (total > bestTotal) { bestTotal = total; best = pip; }
  }
  if (!best || bestTotal === 0) return null;
  return { pip: best, ownCount: roll.ownPips[best], whiteCount: roll.whitePips[best] };
}

export { uuidv4 as newId };
