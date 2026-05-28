export type PipValue = 1 | 2 | 3 | 4 | 5 | 6;
export type PlayerId = string;
export type OwnerId = PlayerId | 'WHITE';
export type TeamId = 'A' | 'B';
export type GameMode = 'individual' | '2v2';
export type Phase = 'WAITING' | 'ROLLING' | 'CHOOSING' | 'SETTLING' | 'ENDED';

export interface Player {
  id: PlayerId;
  nickname: string;
  color: string;
  team: TeamId | null;
  ownDiceRemaining: number;
  whiteDiceRemaining: number;
  money: number;
  connected: boolean;
  isBot: boolean;
}

export interface Bet {
  owner: OwnerId;
  count: number;
}

export interface Board {
  bills: Record<PipValue, number[]>;
  bets:  Record<PipValue, Bet[]>;
}

export interface RollResult {
  ownPips:   Record<PipValue, number>;
  whitePips: Record<PipValue, number>;
}

export interface GameConfig {
  mode: GameMode;
  useWhiteDice: boolean;
  totalRounds: 1 | 2 | 3 | 4;
  turnTimeMs: number;
}

export interface GameMeta {
  turnSeq: number;
  hostId: PlayerId;
  processedActions: string[];
}

export interface RoundSummary {
  round: number;
  moneyDelta: Record<PlayerId, number>;
  bankReturned: number;
  details: unknown;
}

export interface GameState {
  roomId: string;
  config: GameConfig;
  players: Player[];
  turnOrder: PlayerId[];
  currentTurnIdx: number;
  currentRound: number;
  board: Board;
  phase: Phase;
  turnDeadline: number | null;
  currentRoll: RollResult | null;
  meta: GameMeta;
  history: RoundSummary[];
}

export const PLAYER_COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12'];
export const INITIAL_OWN_DICE = 8;

export function emptyBoard(): Board {
  const empty = () => [] as number[];
  return {
    bills: { 1: empty(), 2: empty(), 3: empty(), 4: empty(), 5: empty(), 6: empty() },
    bets:  { 1: [],      2: [],      3: [],      4: [],      5: [],      6: []      },
  };
}
