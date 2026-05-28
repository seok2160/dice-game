import { buildDeck, setupBoard } from '../src/engine/setup';

function seededRng(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('buildDeck', () => {
  it('9종 × 2장 = 18장으로 구성된다', () => {
    expect(buildDeck()).toHaveLength(18);
  });

  it('1만~9만권만 포함된다', () => {
    const deck = buildDeck();
    for (const v of deck) {
      expect(v).toBeGreaterThanOrEqual(10000);
      expect(v).toBeLessThanOrEqual(90000);
      expect(v % 10000).toBe(0);
    }
  });

  it('같은 시드로 생성한 두 덱은 동일하다', () => {
    const rng1 = seededRng(42);
    const rng2 = seededRng(42);
    expect(buildDeck(rng1)).toEqual(buildDeck(rng2));
  });
});

describe('setupBoard', () => {
  it('1~6 슬롯 모두 5만 원 이상이다', () => {
    const board = setupBoard(seededRng(1));
    for (const pos of [1, 2, 3, 4, 5, 6] as const) {
      const sum = board.bills[pos].reduce((a, b) => a + b, 0);
      expect(sum).toBeGreaterThanOrEqual(50000);
    }
  });

  it('각 슬롯은 내림차순 정렬된다', () => {
    const board = setupBoard(seededRng(7));
    for (const pos of [1, 2, 3, 4, 5, 6] as const) {
      const arr = board.bills[pos];
      for (let i = 1; i < arr.length; i++) {
        expect(arr[i - 1]).toBeGreaterThanOrEqual(arr[i]);
      }
    }
  });

  it('배팅은 모두 빈 배열로 초기화된다', () => {
    const board = setupBoard(seededRng(3));
    for (const pos of [1, 2, 3, 4, 5, 6] as const) {
      expect(board.bets[pos]).toEqual([]);
    }
  });

  it('여러 호출마다 서로 다른 덱이 나온다 (확률적)', () => {
    const b1 = setupBoard();
    const b2 = setupBoard();
    const same = [1, 2, 3, 4, 5, 6].every(
      pos => JSON.stringify(b1.bills[pos as 1]) === JSON.stringify(b2.bills[pos as 1]),
    );
    expect(same).toBe(false);
  });
});
