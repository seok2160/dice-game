import { Board, PipValue, emptyBoard } from './types';
import { fisherYates, secureRandom } from './rng';

const DENOMS  = [10000, 20000, 30000, 40000, 50000, 60000, 70000, 80000, 90000];
const COPIES  = 2;
const MIN_SUM = 50000;
const SLOTS   = [1, 2, 3, 4, 5, 6] as PipValue[];

export function buildDeck(rng: () => number = secureRandom): number[] {
  const deck: number[] = [];
  for (const d of DENOMS) for (let i = 0; i < COPIES; i++) deck.push(d);
  return fisherYates(deck, rng);
}

/**
 * 1~6번 눈금판에 지폐 배치.
 * 한 장씩 뽑아 누적 합산 >= 5만 원이 되는 순간 다음 슬롯으로 이동.
 */
export function setupBoard(rng: () => number = secureRandom): Board {
  const deck = buildDeck(rng);
  const board = emptyBoard();
  let cursor = 0;

  for (const slot of SLOTS) {
    let sum = 0;
    while (sum < MIN_SUM) {
      if (cursor >= deck.length) {
        throw new Error(`Deck exhausted at slot ${slot}. Increase COPIES.`);
      }
      const card = deck[cursor++];
      board.bills[slot].push(card);
      sum += card;
    }
    board.bills[slot].sort((a, b) => b - a);
  }

  return board;
}
