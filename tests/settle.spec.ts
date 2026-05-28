import { settleRound } from '../src/engine/settle';
import { Bet, GameState, PipValue } from '../src/engine/types';
import { emptyBoard } from '../src/engine/types';

const P1 = 'p1', P2 = 'p2', P3 = 'p3', P4 = 'p4';

function makeState(slots: Partial<Record<PipValue, { bills: number[]; bets: Bet[] }>>): GameState {
  const board = emptyBoard();
  for (const pos of [1, 2, 3, 4, 5, 6] as PipValue[]) {
    if (slots[pos]) {
      board.bills[pos] = [...slots[pos]!.bills].sort((a, b) => b - a);
      board.bets[pos]  = slots[pos]!.bets;
    }
  }
  return {
    roomId: 'test',
    config:  { mode: 'individual', useWhiteDice: true, totalRounds: 1, turnTimeMs: 30000 },
    players: [P1, P2, P3, P4].map(id => ({
      id, nickname: id, color: '#000', team: null,
      ownDiceRemaining: 0, whiteDiceRemaining: 0, money: 0, connected: true,
    })),
    turnOrder: [P1, P2],
    currentTurnIdx: 0,
    currentRound: 1,
    board,
    phase: 'SETTLING',
    turnDeadline: null,
    currentRoll: null,
    meta: { turnSeq: 0, hostId: P1, processedActions: [] },
    history: [],
  } as GameState;
}

describe('settleRound — 기본 분배', () => {
  it('단일 1등이 가장 큰 지폐를 가져간다', () => {
    const r = settleRound(makeState({
      1: { bills: [80000], bets: [{ owner: P1, count: 3 }, { owner: P2, count: 1 }] },
    }));
    expect(r.moneyDelta[P1]).toBe(80000);
    expect(r.moneyDelta[P2]).toBe(0);
  });

  it('지폐 2장: 1등·2등이 차등 수령한다', () => {
    const r = settleRound(makeState({
      2: { bills: [90000, 30000], bets: [{ owner: P1, count: 4 }, { owner: P2, count: 2 }] },
    }));
    expect(r.moneyDelta[P1]).toBe(90000);
    expect(r.moneyDelta[P2]).toBe(30000);
  });

  it('배팅 없는 슬롯은 전액 은행 환수', () => {
    const r = settleRound(makeState({ 3: { bills: [60000], bets: [] } }));
    expect(r.moneyDelta[P1]).toBe(0);
    expect(r.perPosition[3].bankReturned).toBe(60000);
  });

  it('후순위자 없으면 남은 지폐는 은행 환수', () => {
    const r = settleRound(makeState({
      4: { bills: [70000, 50000, 20000], bets: [{ owner: P1, count: 5 }] },
    }));
    expect(r.moneyDelta[P1]).toBe(70000);
    expect(r.perPosition[4].bankReturned).toBe(70000); // 50k+20k
  });
});

describe('settleRound — 동률 탈락', () => {
  it('최다 동률 전원 탈락, 차순위가 1등 지폐를 받는다', () => {
    const r = settleRound(makeState({
      1: {
        bills: [90000, 40000],
        bets: [
          { owner: P1, count: 3 },
          { owner: P2, count: 3 },   // 동률 탈락
          { owner: P3, count: 2 },   // 실질 1등
          { owner: P4, count: 1 },   // 실질 2등
        ],
      },
    }));
    expect(r.moneyDelta[P3]).toBe(90000);
    expect(r.moneyDelta[P4]).toBe(40000);
    expect(r.moneyDelta[P1]).toBe(0);
    expect(r.moneyDelta[P2]).toBe(0);
    expect(r.perPosition[1].eliminated).toEqual([{ owners: [P1, P2], count: 3 }]);
  });

  it('전원 동률이면 전액 은행 환수', () => {
    const r = settleRound(makeState({
      2: {
        bills: [80000],
        bets: [{ owner: P1, count: 2 }, { owner: P2, count: 2 }],
      },
    }));
    expect(r.moneyDelta[P1]).toBe(0);
    expect(r.moneyDelta[P2]).toBe(0);
    expect(r.perPosition[2].bankReturned).toBe(80000);
  });
});

describe('settleRound — 흰색 주사위 특수룰', () => {
  it('흰색이 1등이면 슬롯 전액 은행 환수 (P1도 못 받음)', () => {
    const r = settleRound(makeState({
      5: {
        bills: [90000, 50000],
        bets: [{ owner: 'WHITE', count: 3 }, { owner: P1, count: 2 }],
      },
    }));
    expect(r.moneyDelta[P1]).toBe(0);
    expect(r.perPosition[5].whiteWonFirst).toBe(true);
    expect(r.perPosition[5].bankReturned).toBe(140000);
  });

  it('흰색이 2등이면 1등 플레이어는 정상 수령, 흰색 몫만 은행 환수', () => {
    const r = settleRound(makeState({
      6: {
        bills: [80000, 30000],
        bets: [
          { owner: P1,    count: 4 },
          { owner: 'WHITE', count: 2 },
          { owner: P2,    count: 1 },
        ],
      },
    }));
    expect(r.moneyDelta[P1]).toBe(80000);
    expect(r.moneyDelta[P2]).toBe(0);          // 3등 자리에 지폐 없음
    expect(r.perPosition[6].bankReturned).toBe(30000);
    expect(r.perPosition[6].whiteWonFirst).toBe(false);
  });

  it('흰색이 동률 탈락 후 1등이 되면 전액 환수', () => {
    const r = settleRound(makeState({
      3: {
        bills: [70000],
        bets: [
          { owner: P1,    count: 3 },
          { owner: P2,    count: 3 },   // 동률 탈락
          { owner: 'WHITE', count: 2 }, // 실질 1등
        ],
      },
    }));
    expect(r.perPosition[3].whiteWonFirst).toBe(true);
    expect(r.perPosition[3].bankReturned).toBe(70000);
  });
});

describe('settleRound — 같은 오너 분산 배팅', () => {
  it('동일 플레이어가 여러 번 배팅하면 합산해 처리된다', () => {
    const r = settleRound(makeState({
      1: {
        bills: [90000],
        bets: [
          { owner: P1, count: 2 },
          { owner: P1, count: 2 },   // 합산 4
          { owner: P2, count: 3 },
        ],
      },
    }));
    expect(r.moneyDelta[P1]).toBe(90000);
  });
});
