import { randomInt } from 'crypto';
import type { PipValue } from './types';

export const secureRandom = (): number => randomInt(0, 2 ** 32) / 2 ** 32;

export function rollDice(n: number): number[] {
  if (n <= 0) return [];
  return Array.from({ length: n }, () => randomInt(1, 7));
}

export function rollAndCount(n: number): Record<PipValue, number> {
  const counts: Record<PipValue, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (const pip of rollDice(n)) counts[pip as PipValue]++;
  return counts;
}

export function fisherYates<T>(arr: T[], rng: () => number = secureRandom): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
