import { GameState } from '../engine/types';

export class MemoryStore {
  private rooms = new Map<string, GameState>();
  private locks = new Map<string, Promise<unknown>>();

  async load(roomId: string): Promise<GameState | null> {
    const s = this.rooms.get(roomId);
    return s ? structuredClone(s) : null;
  }

  async save(state: GameState): Promise<void> {
    this.rooms.set(state.roomId, structuredClone(state));
  }

  async delete(roomId: string): Promise<void> {
    this.rooms.delete(roomId);
  }

  /**
   * 직렬화된 업데이트 — roomId별로 Queue를 유지해 동시 수정 충돌 방지.
   * mutator는 순수하게 새 state를 반환해야 함.
   */
  async update(
    roomId: string,
    mutator: (s: GameState) => GameState | Promise<GameState>,
  ): Promise<GameState> {
    const prev = this.locks.get(roomId) ?? Promise.resolve();
    let resolve!: () => void;
    const gate = new Promise<void>(r => { resolve = r; });
    this.locks.set(roomId, gate);

    try {
      await prev;
      const current = this.rooms.get(roomId);
      if (!current) throw new Error(`Room not found: ${roomId}`);
      const next = await mutator(structuredClone(current));
      this.rooms.set(roomId, structuredClone(next));
      return next;
    } finally {
      resolve();
      if (this.locks.get(roomId) === gate) this.locks.delete(roomId);
    }
  }

  listRooms(): string[] {
    return [...this.rooms.keys()];
  }
}
