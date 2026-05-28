import { Bet, GameState, OwnerId, PipValue, PlayerId } from './types';

export interface PositionSettlement {
  position: PipValue;
  bills: number[];
  eliminated: Array<{ owners: OwnerId[]; count: number }>;
  ranking: Array<{ owner: OwnerId; count: number; awarded: number }>;
  whiteWonFirst: boolean;
  bankReturned: number;
}

export interface SettlementResult {
  perPosition: Record<PipValue, PositionSettlement>;
  moneyDelta:  Record<PlayerId, number>;
  totalBankReturned: number;
}

export function settleRound(state: GameState): SettlementResult {
  const moneyDelta: Record<PlayerId, number> = {};
  for (const p of state.players) moneyDelta[p.id] = 0;

  const perPosition = {} as Record<PipValue, PositionSettlement>;
  let totalBankReturned = 0;

  for (const pos of [1, 2, 3, 4, 5, 6] as PipValue[]) {
    const bills = [...state.board.bills[pos]].sort((a, b) => b - a);
    const result = settlePosition(pos, bills, state.board.bets[pos], moneyDelta);
    perPosition[pos] = result;
    totalBankReturned += result.bankReturned;
  }

  return { perPosition, moneyDelta, totalBankReturned };
}

function settlePosition(
  position: PipValue,
  bills: number[],
  bets: Bet[],
  moneyDelta: Record<PlayerId, number>,
): PositionSettlement {
  // 1. 같은 오너 합산
  const aggregated = new Map<OwnerId, number>();
  for (const b of bets) {
    if (!b.count || b.count <= 0) continue;
    aggregated.set(b.owner, (aggregated.get(b.owner) ?? 0) + b.count);
  }

  // 2. count 별 그룹화 → 동률 탈락
  const byCount = new Map<number, OwnerId[]>();
  for (const [owner, count] of aggregated) {
    if (!byCount.has(count)) byCount.set(count, []);
    byCount.get(count)!.push(owner);
  }

  const sortedCounts = [...byCount.keys()].sort((a, b) => b - a);
  const ranking: Array<{ owner: OwnerId; count: number }> = [];
  const eliminated: Array<{ owners: OwnerId[]; count: number }> = [];

  for (const c of sortedCounts) {
    const owners = byCount.get(c)!;
    if (owners.length > 1) {
      eliminated.push({ owners, count: c });  // 동률 → 전원 탈락
    } else {
      ranking.push({ owner: owners[0], count: c });
    }
  }

  // 3. 흰색 주사위 1등 특수룰 → 슬롯 전액 은행 환수
  const whiteWonFirst = ranking.length > 0 && ranking[0].owner === 'WHITE';
  if (whiteWonFirst) {
    const total = bills.reduce((s, v) => s + v, 0);
    return { position, bills, eliminated, ranking: [], whiteWonFirst: true, bankReturned: total };
  }

  // 4. 큰 지폐부터 순위별 분배
  const awards: Array<{ owner: OwnerId; count: number; awarded: number }> = [];
  let bankReturned = 0;

  for (let i = 0; i < bills.length; i++) {
    const bill   = bills[i];
    const winner = ranking[i];

    if (!winner) {
      bankReturned += bill;          // 후순위자 없음 → 은행
      continue;
    }
    if (winner.owner === 'WHITE') {
      bankReturned += bill;          // 흰색 몫 → 은행
      awards.push({ owner: 'WHITE', count: winner.count, awarded: bill });
      continue;
    }
    moneyDelta[winner.owner as PlayerId] += bill;
    awards.push({ owner: winner.owner, count: winner.count, awarded: bill });
  }

  return { position, bills, eliminated, ranking: awards, whiteWonFirst: false, bankReturned };
}
